// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge.h"

#include "chrome_control_mcp/browser_contract.h"

#include <QByteArray>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QStandardPaths>

#include <algorithm>
#include <cstring>

namespace chrome_control_mcp::browser {

namespace {

QString compactJson(const QJsonObject &object) {
  return QString::fromUtf8(
      QJsonDocument(object).toJson(QJsonDocument::Compact));
}

// A screenshot payload is page-influenced in size (a full-page capture scales
// with the document height). Cap the base64 length so a pathological page
// cannot flood the model context or the transport; a rejected capture returns
// an honest error, not a silent truncation. 16 MiB of base64 is ~12 MiB of PNG
// -- ample for any real viewport.
constexpr int kMaxScreenshotBase64 = 16 * 1024 * 1024;

// A printed PDF scales with the page; cap the base64 so a pathological document
// cannot flood the transport. 24 MiB of base64 is ~18 MiB of PDF; a rejected
// print returns an honest error telling the caller to narrow it with
// page_ranges.
constexpr int kMaxPdfBase64 = 24 * 1024 * 1024;

// A generic (non-snapshot/screenshot/PDF) reply -- e.g. a browser_read of page
// content -- flows straight into the model's text context as compact JSON. The
// native-messaging decoder permits a frame up to kMaxNativeMessageBytes (64
// MiB), so without a response-side cap a hostile or pathological page could
// flood the transport and the model context. 8 MiB of JSON text is far beyond
// any real page read; a larger reply is refused with an honest error, matching
// the way screenshot/PDF replies are capped rather than passed through.
constexpr int kMaxReplyTextChars = 8 * 1024 * 1024;

// Where a browser_print PDF lands: the user's Downloads under a
// ChromeControlMCP subfolder -- the natural, visible place for a saved page.
// Falls back to the temp dir if Downloads is unavailable. The name is
// timestamped and the bytes are written by US (the extension only returns the
// payload), so a page can steer neither the path nor the filename.
QString printOutputPath() {
  QString dir =
      QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
  if (dir.isEmpty()) {
    dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
  }
  dir = QDir(dir).filePath(QStringLiteral("ChromeControlMCP"));
  const QString stamp = QDateTime::currentDateTime().toString(
      QStringLiteral("yyyyMMdd-hhmmss-zzz"));
  return QDir(dir).filePath(QStringLiteral("page-%1.pdf").arg(stamp));
}

// Only image types WE emit are honored; anything else is coerced to PNG so a
// tampered or unexpected mimeType can never turn the image block into an
// arbitrary content type.
QString sanitizedImageMime(const QString &mime) {
  if (mime == QLatin1String("image/png") ||
      mime == QLatin1String("image/jpeg") ||
      mime == QLatin1String("image/webp")) {
    return mime;
  }
  return QStringLiteral("image/png");
}

// PNG header field offsets/lengths (fixed by the PNG spec): the 8-byte
// signature, the IHDR chunk type at byte 12, and the big-endian width@16 /
// height@20. Reading height@20..23 needs at least 24 bytes present.
constexpr int kPngSignatureLength = 8;
constexpr int kPngChunkTypeLength = 4;
constexpr int kPngIhdrTypeOffset = 12;
constexpr int kPngWidthOffset = 16;
constexpr int kPngHeightOffset = 20;
constexpr int kPngMinHeaderBytes = 24;

// Read the true pixel dimensions from a PNG's IHDR chunk: 8-byte signature,
// then a chunk whose type at offset 12 is "IHDR" with big-endian width@16 and
// height@20. This is the authoritative image size regardless of
// devicePixelRatio / clip / emulation, and it is a bounded, fixed-offset read
// of the (untrusted) payload. Returns false unless it is a valid PNG header
// with positive dimensions.
bool pngDimensions(const QByteArray &png, int &width, int &height) {
  static const unsigned char kSignature[8] = {0x89, 0x50, 0x4E, 0x47,
                                              0x0D, 0x0A, 0x1A, 0x0A};
  if (png.size() < kPngMinHeaderBytes ||
      std::memcmp(png.constData(), kSignature, kPngSignatureLength) != 0 ||
      std::memcmp(png.constData() + kPngIhdrTypeOffset, "IHDR",
                  kPngChunkTypeLength) != 0) {
    return false;
  }
  const auto *bytes = reinterpret_cast<const unsigned char *>(png.constData());
  const auto be32 = [bytes](int offset) {
    return (static_cast<quint32>(bytes[offset]) << 24) |
           (static_cast<quint32>(bytes[offset + 1]) << 16) |
           (static_cast<quint32>(bytes[offset + 2]) << 8) |
           static_cast<quint32>(bytes[offset + 3]);
  };
  width = static_cast<int>(be32(kPngWidthOffset));
  height = static_cast<int>(be32(kPngHeightOffset));
  return width > 0 && height > 0;
}

// The summary line for a screenshot, using the PNG's own IHDR dimensions when
// they can be read from the base64 (a 64-char prefix decodes to ~48 bytes, past
// IHDR at offset 24).
QString screenshotSummary(const QString &base64) {
  int width = 0;
  int height = 0;
  const QByteArray head = QByteArray::fromBase64(base64.left(64).toLatin1());
  if (pngDimensions(head, width, height)) {
    return QStringLiteral("Captured a %1x%2 PNG screenshot of the active tab.")
        .arg(width)
        .arg(height);
  }
  return QStringLiteral("Captured a PNG screenshot of the active tab.");
}

// The tab_id line is what tells a model sharing this server with other agents
// which tab these refs act on, so it can pass the same tab_id to the calls
// that follow. One multi-argument arg() so the page-controlled url and title
// are substituted in a single pass: chained arg() calls would rescan them, and
// a title containing "%4" would have the outline spliced into it.
QString formatSnapshot(const SnapshotView &view, qint64 tab_id) {
  const QString body = view.outline.isEmpty()
                           ? QStringLiteral("(no interactable elements found)")
                           : view.outline;
  return QStringLiteral("url: %1\ntitle: %2\ntab_id: %3\nelements: %4\n%5")
      .arg(view.url, view.title, QString::number(tab_id),
           QString::number(view.element_count), body);
}

// Commands that land a tab on a new document, after which any ref from that
// tab's prior snapshot is meaningless. Programmatic navigation keeps CDP
// attached (no onDetached fires), so the bridge must invalidate refs itself.
// selectTab/newTab are no longer here: they change which tab is CURRENT, and a
// ref is bound to its own tab, not to whichever one is current, so they leave
// every ref valid.
bool isNavigationCmd(const QString &cmd) {
  return cmd == QLatin1String("navigate") || cmd == QLatin1String("back") ||
         cmd == QLatin1String("forward") || cmd == QLatin1String("reload");
}

// The tab a reply says it acted on, or 0 when it names none. A malformed id
// is read as naming none, so it fails closed wherever "no tab" does.
qint64 replyTabId(const QJsonObject &frame) {
  qint64 tab = 0;
  return tabIdFromJson(frame.value(QStringLiteral("tabId")), &tab) ? tab : 0;
}

// The tab a ref index entry is bound to, or 0 when it is unbound.
qint64 entryTabId(const QJsonValue &entry) {
  qint64 tab = 0;
  return tabIdFromJson(entry.toObject().value(QStringLiteral("tabId")), &tab)
             ? tab
             : 0;
}

// The tab a ref is bound to, or 0 when it is unknown or unbound.
qint64 refTabId(const QJsonObject &ref_index, const QString &ref) {
  return entryTabId(ref_index.value(ref));
}

// Why a snapshot reply that does not name its tab installs nothing. Refs it
// could not bind would act on whichever tab is current when they are used --
// the very cross-agent retargeting tab binding exists to stop -- and the only
// extension that omits the field is one older than this server.
QString snapshotWithoutTabError() {
  return QStringLiteral(
      "The browser extension did not say which tab this snapshot came from, "
      "so its refs cannot be bound to a tab and none were kept. The extension "
      "Chrome is running is older than this server: reload the Chrome Control "
      "MCP extension at chrome://extensions (or restart Chrome) so Chrome "
      "loads the copy installed with this server.");
}

// A result-typed frame is NOT implicitly a success: the extension may report an
// operation-level failure as {ok:false} inside the payload. When it does, fill
// `incoming` as an error (preferring the payload's own error/message text over
// a generic fallback) and report handled; otherwise leave `incoming` untouched
// so the caller proceeds to the success paths.
bool fillPayloadFailure(const QJsonObject &payload,
                        BrowserBridgeSession::Incoming &incoming) {
  if (!payload.value(QStringLiteral("ok")).isBool() ||
      payload.value(QStringLiteral("ok")).toBool()) {
    return false;
  }
  incoming.is_error = true;
  QString message = payload.value(QStringLiteral("error")).toString();
  if (message.isEmpty()) {
    message = payload.value(QStringLiteral("message")).toString();
  }
  incoming.error = message.isEmpty()
                       ? QStringLiteral("Browser command reported failure.")
                       : message;
  return true;
}

} // namespace

void BrowserBridgeSession::clearRefs() {
  ref_index_ = QJsonObject{};
  tabs_.clear(); // no tab has refs, so none has a staleness or a baseline
}

void BrowserBridgeSession::onHostConnected() {
  connected_ = true;
  clearRefs();
  outstanding_id_.clear();
  outstanding_cmd_.clear();
  outstanding_tab_id_ = 0;
  ++session_epoch_; // new browser session: any in-flight reply is for a dead
                    // one
}

void BrowserBridgeSession::onHostDisconnected() {
  connected_ = false;
  clearRefs();
  outstanding_id_.clear();
  outstanding_cmd_.clear();
  outstanding_tab_id_ = 0;
  ++session_epoch_;
}

void BrowserBridgeSession::onDetached() {
  markAllStale();
  // A snapshot already in flight was captured against the now-detached DOM;
  // move the epoch so its reply cannot install ref_index or clear the stale
  // flag.
  ++session_epoch_;
}

void BrowserBridgeSession::retireOutstanding() {
  const qint64 tab = outstanding_tab_id_;
  outstanding_id_.clear();
  outstanding_cmd_.clear();
  outstanding_tab_id_ = 0;
  if (tab != 0) {
    markTabStale(tab);
  } else {
    markAllStale();
  }
}

BrowserBridgeSession::TabRefState &
BrowserBridgeSession::trackTab(qint64 tab_id) {
  auto it = tabs_.find(tab_id);
  if (it == tabs_.end()) {
    it = tabs_.insert(tab_id, TabRefState{});
  }
  return it.value();
}

void BrowserBridgeSession::markTabStale(qint64 tab_id) {
  // A tab with no refs has nothing to invalidate, and its next snapshot starts
  // clean either way, so only a tab already tracked is marked.
  const auto it = tabs_.find(tab_id);
  if (it != tabs_.end()) {
    it->stale = true;
  }
}

void BrowserBridgeSession::markAllStale() {
  for (TabRefState &state : tabs_) {
    state.stale = true;
  }
}

void BrowserBridgeSession::eraseTabRefs(qint64 tab_id) {
  for (auto it = ref_index_.begin(); it != ref_index_.end();) {
    if (entryTabId(it.value()) == tab_id) {
      it = ref_index_.erase(it);
    } else {
      ++it;
    }
  }
}

void BrowserBridgeSession::dropTab(qint64 tab_id) {
  eraseTabRefs(tab_id);
  tabs_.remove(tab_id);
}

bool BrowserBridgeSession::refIndexStale() const {
  return std::ranges::any_of(
      tabs_, [](const TabRefState &state) { return state.stale; });
}

bool BrowserBridgeSession::tabStale(qint64 tab_id) const {
  return tabs_.value(tab_id).stale;
}

QString BrowserBridgeSession::sanitizeClientName(const QString &raw) {
  QString kept;
  kept.reserve(raw.size());
  for (const QChar ch : raw) {
    // isPrint already refuses every Other_* category: control characters,
    // format characters (bidi overrides that would reorder a tab-group
    // title), and lone surrogate halves. Line and paragraph separators are
    // "printable" by that rule and still break a one-line title, so they go
    // too.
    const QChar::Category category = ch.category();
    if (ch.isPrint() && category != QChar::Separator_Line &&
        category != QChar::Separator_Paragraph) {
      kept.append(ch);
    }
  }
  return kept.simplified().left(kMaxClientNameChars).trimmed();
}

void BrowserBridgeSession::setClientName(const QString &raw) {
  client_name_ = sanitizeClientName(raw);
}

QString
BrowserBridgeSession::staleRefError(const QJsonObject &arguments) const {
  // Both ref endpoints are gated: browser_drag targets a second element via
  // to_ref, so a stale tab must refuse an action carrying EITHER ref, not just
  // the primary one. Only the ref's OWN tab matters -- another agent's tab
  // navigating says nothing about this one's nodes.
  for (const char *key : {"ref", "to_ref"}) {
    const QJsonValue value = arguments.value(QLatin1String(key));
    if (!value.isString()) {
      continue; // absent, or wrong-typed and refused by the contract
    }
    const qint64 tab = refTabId(ref_index_, value.toString());
    if (tab != 0 && tabStale(tab)) {
      return QStringLiteral(
                 "The page changed in tab %1 since its last snapshot; call "
                 "browser_snapshot again (with tab_id %1) before acting on an "
                 "element.")
          .arg(tab);
    }
  }
  return QString();
}

BrowserBridgeSession::Outgoing
BrowserBridgeSession::refuse(const QString &reason) {
  return {.frame = QJsonObject{}, .ok = false, .error = reason};
}

BrowserBridgeSession::Outgoing
BrowserBridgeSession::beginCommand(const QString &tool,
                                   const QJsonObject &arguments) {
  if (!connected_) {
    return refuse(
        QStringLiteral("Browser not connected: the Chrome Control MCP "
                       "browser-control extension is not attached."));
  }
  if (!outstanding_id_.isEmpty()) {
    return refuse(QStringLiteral("A browser action is already in progress."));
  }
  const QString stale = staleRefError(arguments);
  if (!stale.isEmpty()) {
    return refuse(stale);
  }
  const ExtensionCommand command =
      buildExtensionCommand(tool, arguments, ref_index_);
  if (!command.ok) {
    return refuse(command.error);
  }
  const QString id = QStringLiteral("b-%1").arg(++counter_);
  Outgoing out;
  out.ok = true;
  out.frame = command.command;
  out.frame.insert(QStringLiteral("type"), QStringLiteral("command"));
  out.frame.insert(QStringLiteral("id"), id);
  if (!client_name_.isEmpty()) {
    out.frame.insert(QStringLiteral("client"), client_name_);
  }
  outstanding_id_ = id;
  // Record the cmd WE sent, the tab WE named, and the epoch it was issued
  // under; state mutations on the reply are keyed to these, never to the
  // untrusted reply frame's own claim about what it was.
  outstanding_cmd_ = command.command.value(QStringLiteral("cmd")).toString();
  outstanding_tab_id_ = 0;
  (void)tabIdFromJson(command.command.value(QStringLiteral("tab_id")),
                      &outstanding_tab_id_);
  outstanding_epoch_ = session_epoch_;
  return out;
}

BrowserBridgeSession::Outgoing
BrowserBridgeSession::beginInternalCommand(const QString &cmd,
                                           const QJsonObject &payload) {
  if (!connected_) {
    return refuse(
        QStringLiteral("Browser not connected: the Chrome Control MCP "
                       "browser-control extension is not attached."));
  }
  if (!outstanding_id_.isEmpty()) {
    return refuse(QStringLiteral("A browser action is already in progress."));
  }
  const QString id = QStringLiteral("b-%1").arg(++counter_);
  Outgoing out;
  out.ok = true;
  out.frame = payload;
  out.frame.insert(QStringLiteral("cmd"), cmd);
  out.frame.insert(QStringLiteral("type"), QStringLiteral("command"));
  out.frame.insert(QStringLiteral("id"), id);
  if (!client_name_.isEmpty()) {
    out.frame.insert(QStringLiteral("client"), client_name_);
  }
  outstanding_id_ = id;
  outstanding_cmd_ = cmd;
  outstanding_tab_id_ = 0; // an upload chunk fills a buffer, not a tab
  outstanding_epoch_ = session_epoch_;
  return out;
}

qint64 BrowserBridgeSession::fillResult(const QString &sent_cmd,
                                        quint64 sent_epoch, qint64 sent_tab,
                                        const QJsonObject &frame,
                                        Incoming &incoming) {
  const QJsonObject payload = frame.value(QStringLiteral("payload")).toObject();
  // A result-typed frame is NOT implicitly a success: the extension may report
  // an operation-level failure as {ok:false} inside the payload. Treat that as
  // an error rather than passing the failed payload through as a successful
  // text/ref/screenshot/PDF result.
  if (fillPayloadFailure(payload, incoming)) {
    return 0;
  }
  if (sent_cmd == QLatin1String("snapshot")) {
    return fillSnapshotResult(sent_epoch, frame, incoming);
  }
  if (sent_cmd == QLatin1String("screenshot")) {
    fillScreenshotResult(payload, incoming);
    return 0;
  }
  if (sent_cmd == QLatin1String("print")) {
    fillPrintResult(payload, incoming);
    return 0;
  }
  applyCommandEffect(sent_cmd, sent_tab, frame);
  fillGenericResult(frame, incoming);
  return 0;
}

qint64 BrowserBridgeSession::fillSnapshotResult(quint64 sent_epoch,
                                                const QJsonObject &frame,
                                                Incoming &incoming) {
  // Only a reply to a snapshot WE issued may install refs -- and only if the
  // browser session has not changed underneath it (no detach/reconnect since
  // we asked), so a snapshot of a now-dead DOM is never trusted for
  // act-by-ref.
  if (sent_epoch != session_epoch_) {
    incoming.text = QStringLiteral("The page changed while the snapshot was "
                                   "being taken; call browser_snapshot "
                                   "again.");
    return 0;
  }
  const qint64 tab = replyTabId(frame);
  if (tab == 0) {
    incoming.is_error = true;
    incoming.error = snapshotWithoutTabError();
    // The reply still reported a DOM generation it would not attribute to a
    // tab: whatever changed cannot be placed, so every tab is suspect.
    if (frame.contains(QStringLiteral("domEpoch"))) {
      markAllStale();
    }
    return 0;
  }
  // Carry THIS tab's previous refs so a node keeps the ref it was already
  // issued: a model holding e29 from an earlier snapshot must not have it
  // silently become a different element because something above it gained a
  // ref. Only this tab's -- a backendNodeId is unique within one renderer, so
  // another tab's node 42 is a different element. Never carried once the tab
  // is stale -- set when its document may have changed (a navigation), where a
  // backendNodeId from the old document does not name the same node in the
  // new one.
  QJsonObject carried;
  if (!tabStale(tab)) {
    for (auto it = ref_index_.constBegin(); it != ref_index_.constEnd(); ++it) {
      if (entryTabId(it.value()) == tab) {
        carried.insert(it.key(), it.value());
      }
    }
  }
  // New nodes are numbered above every ref this session has EVER issued, on
  // any tab: a ref that left the index must answer "Unknown element ref", not
  // come back naming a different node.
  const SnapshotView view =
      renderSnapshot(frame.value(QStringLiteral("payload")).toObject(), carried,
                     ref_high_water_ + 1);
  // This tab's previous refs are replaced wholesale: a node that is gone takes
  // its ref with it. Other tabs' refs are untouched.
  eraseTabRefs(tab);
  for (auto it = view.ref_index.constBegin(); it != view.ref_index.constEnd();
       ++it) {
    QJsonObject entry = it.value().toObject();
    entry.insert(QStringLiteral("tabId"), tab);
    ref_index_.insert(it.key(), entry);
  }
  ref_high_water_ = std::max(ref_high_water_, view.highest_ref);
  trackTab(tab).stale = false;
  incoming.text = formatSnapshot(view, tab);
  return tab;
}

void BrowserBridgeSession::applyCommandEffect(const QString &sent_cmd,
                                              qint64 sent_tab,
                                              const QJsonObject &frame) {
  // After a navigation lands, refs from that tab's prior snapshot no longer map
  // to live nodes; refuse act-by-ref there until its next snapshot. Both the
  // tab we named and the tab the reply names are marked, so a reply that
  // disagrees with the command cannot leave either one live; a reply that
  // names no tab cannot be placed at all, so every tab is marked.
  if (isNavigationCmd(sent_cmd)) {
    const qint64 acted = replyTabId(frame);
    if (sent_tab != 0) {
      markTabStale(sent_tab);
    }
    if (acted != 0) {
      markTabStale(acted);
    } else {
      markAllStale();
    }
    return;
  }
  // A closed tab's refs can never act again. The tab we named is the one the
  // extension closed; without one it closed the tab its reply names.
  if (sent_cmd == QLatin1String("closeTab")) {
    const qint64 closed = sent_tab != 0 ? sent_tab : replyTabId(frame);
    if (closed != 0) {
      dropTab(closed);
    }
    return;
  }
  // A released tab is no longer this session's to act on, whether it was
  // closed or handed back to the user. Releasing without a tab_id lets go of
  // every tab, so every ref goes.
  if (sent_cmd == QLatin1String("release")) {
    if (sent_tab != 0) {
      dropTab(sent_tab);
    } else {
      clearRefs();
    }
  }
}

void BrowserBridgeSession::fillGenericResult(const QJsonObject &frame,
                                             Incoming &incoming) {
  QJsonObject payload = frame.value(QStringLiteral("payload")).toObject();
  // Say which tab the command acted on when the payload does not already: it
  // is how browser_new_tab hands the model the tab_id to pass to every later
  // call, and how any reply confirms which tab it touched.
  const qint64 tab = replyTabId(frame);
  if (tab != 0 && !payload.contains(QStringLiteral("tab_id")) &&
      !payload.contains(QStringLiteral("tabId"))) {
    payload.insert(QStringLiteral("tab_id"), tab);
  }
  // A generic reply is echoed verbatim into the model context. Cap its size the
  // way screenshot/PDF replies are capped so a hostile/pathological page reply
  // (up to the 64 MiB decoder limit) cannot flood the transport; refuse an
  // oversized reply with an honest error.
  const QString reply_text = compactJson(payload);
  if (reply_text.size() > kMaxReplyTextChars) {
    incoming.is_error = true;
    incoming.error = QStringLiteral(
        "The browser reply is too large to return; narrow the request.");
    return;
  }
  incoming.text = reply_text;
}

void BrowserBridgeSession::reconcileDomEpoch(const QString &sent_cmd,
                                             qint64 installed_tab,
                                             const QJsonObject &frame) {
  const qint64 tab = replyTabId(frame);
  if (!frame.contains(QStringLiteral("domEpoch"))) {
    if (tab != 0) {
      // tabId and domEpoch travel together. Once a tab has a baseline, a reply
      // that names the tab but DROPS its marker is a downgrade that would
      // silently disable external-change detection there (a relayed,
      // web-page-influenced frame could strip it to hide a navigation) --
      // fail closed for that tab.
      const auto it = tabs_.constFind(tab);
      if (it != tabs_.constEnd() && it->have_dom_epoch) {
        markTabStale(tab);
      }
    } else if (frame.contains(QStringLiteral("tabId")) ||
               commandIsTabScoped(sent_cmd)) {
      // A tabId we cannot read, or a command that acted on a tab replying as
      // if it touched none: what changed cannot be placed on one tab, so
      // every tab is suspect. Neither field on a command that never touches a
      // tab (listing tabs or windows) is the protocol working as intended.
      markAllStale();
    }
    return;
  }
  // A present marker must be a non-negative integer within the exact-integer
  // double range. A malformed value (string, negative, NaN, or beyond 2^53)
  // cannot be trusted as a baseline, and casting it straight to quint64 is UB
  // -- fail closed by marking refs stale.
  const QJsonValue epoch_value = frame.value(QStringLiteral("domEpoch"));
  const double epoch_raw = epoch_value.toDouble(-1.0);
  // Upper bound for a trustworthy epoch: at or below the exact-integer range of
  // a double (2^53); a larger value cannot be represented losslessly and is
  // treated as malformed.
  constexpr double kMaxTrustworthyDomEpoch = 9.0e15;
  if (!epoch_value.isDouble() || epoch_raw < 0.0 ||
      epoch_raw > kMaxTrustworthyDomEpoch) {
    if (tab != 0) {
      markTabStale(tab);
    } else {
      markAllStale();
    }
    return;
  }
  // A DOM generation with no tab to attribute it to: the change it reports
  // could be on any tab, so fail closed on all of them.
  if (tab == 0) {
    markAllStale();
    return;
  }
  const auto epoch = static_cast<quint64>(epoch_raw);
  // A snapshot just installed for this tab re-baselines it: its refs match
  // THIS DOM generation.
  if (installed_tab == tab) {
    TabRefState &state = trackTab(tab);
    state.dom_epoch = epoch;
    state.have_dom_epoch = true;
    return;
  }
  // Any other reply whose epoch differs from the tab's baseline means that
  // tab's DOM changed underneath its refs -- an EXTERNAL navigation or CDP
  // detach we did not command. Mark that tab, and only that tab, stale until
  // its next snapshot: another agent's tab navigating says nothing about this
  // one.
  const auto it = tabs_.find(tab);
  if (it != tabs_.end() && it->have_dom_epoch && epoch != it->dom_epoch) {
    it->stale = true;
  }
}

void BrowserBridgeSession::dropGoneTabs(const QJsonObject &frame) {
  if (!frame.contains(QStringLiteral("goneTabIds"))) {
    return;
  }
  const QJsonValue gone = frame.value(QStringLiteral("goneTabIds"));
  if (!gone.isArray()) {
    // The reply says some tabs are gone but not in a shape we can read; which
    // ones is unknown, so every tab is suspect.
    markAllStale();
    return;
  }
  bool unreadable = false;
  const QJsonArray ids = gone.toArray();
  for (const auto &entry : ids) {
    qint64 tab = 0;
    if (tabIdFromJson(entry, &tab)) {
      dropTab(tab);
    } else {
      unreadable = true;
    }
  }
  // One entry we cannot read still names SOME tab this session lost.
  if (unreadable) {
    markAllStale();
  }
}

void BrowserBridgeSession::fillScreenshotResult(const QJsonObject &payload,
                                                Incoming &incoming) {
  const QString data = payload.value(QStringLiteral("data")).toString();
  if (data.isEmpty()) {
    incoming.is_error = true;
    incoming.error =
        QStringLiteral("The browser returned an empty screenshot.");
    return;
  }
  if (data.size() > kMaxScreenshotBase64) {
    incoming.is_error = true;
    incoming.error = QStringLiteral("The screenshot is too large to return; "
                                    "capture the viewport instead of the "
                                    "full page.");
    return;
  }
  // Strictly decode the payload before handing it to the client: a frame whose
  // "data" is not valid base64 is refused with an honest error rather than
  // forwarded as an opaque, unusable image block. AbortOnBase64DecodingErrors
  // rejects any stray non-base64 byte.
  const auto decoded = QByteArray::fromBase64Encoding(
      data.toLatin1(),
      QByteArray::Base64Encoding | QByteArray::AbortOnBase64DecodingErrors);
  if (!decoded) {
    incoming.is_error = true;
    incoming.error =
        QStringLiteral("The browser returned a malformed screenshot payload.");
    return;
  }
  incoming.image_base64 = data;
  incoming.image_mime =
      sanitizedImageMime(payload.value(QStringLiteral("mimeType")).toString());
  incoming.text = screenshotSummary(data);
}

// Decode the printed PDF, verify it is a real PDF, and write it to the output
// folder. The extension never touches the filesystem: it returns base64, and
// the bytes land on disk only here, at a path WE choose. A payload that is
// empty, oversized, or not a "%PDF-" document is refused with an honest error
// rather than written out.
void BrowserBridgeSession::fillPrintResult(const QJsonObject &payload,
                                           Incoming &incoming) {
  const QString data = payload.value(QStringLiteral("data")).toString();
  if (data.isEmpty()) {
    incoming.is_error = true;
    incoming.error = QStringLiteral("The browser returned an empty PDF.");
    return;
  }
  if (data.size() > kMaxPdfBase64) {
    incoming.is_error = true;
    incoming.error = QStringLiteral(
        "The PDF is too large to save; narrow it with page_ranges.");
    return;
  }
  const QByteArray pdf = QByteArray::fromBase64(data.toLatin1());
  if (!pdf.startsWith("%PDF-")) {
    incoming.is_error = true;
    incoming.error =
        QStringLiteral("The browser returned data that is not a valid PDF.");
    return;
  }
  const QString path = printOutputPath();
  const QFileInfo info(path);
  if (!QDir().mkpath(info.absolutePath())) {
    incoming.is_error = true;
    incoming.error = QStringLiteral("Cannot create the output folder %1.")
                         .arg(info.absolutePath());
    return;
  }
  QFile file(path);
  // flush() forces the buffered bytes to the OS and surfaces a write error
  // (disk full, quota) that a bare write()==size check would miss because Qt
  // buffers -- fail closed on any of the three so a truncated/half-written PDF
  // is never reported as a successful save.
  if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) ||
      file.write(pdf) != pdf.size() || !file.flush()) {
    incoming.is_error = true;
    incoming.error = QStringLiteral("Cannot write the PDF to %1.").arg(path);
    return;
  }
  file.close();
  incoming.text = compactJson(
      QJsonObject{{QStringLiteral("ok"), true},
                  {QStringLiteral("saved"), QDir::toNativeSeparators(path)},
                  {QStringLiteral("bytes"), static_cast<int>(pdf.size())}});
}

BrowserBridgeSession::Incoming
BrowserBridgeSession::onReply(const QJsonObject &frame) {
  Incoming incoming;
  const QString id = frame.value(QStringLiteral("id")).toString();
  // A frame that does not carry the outstanding id is a late reply from a
  // retired op, an unsolicited event, or a stray -- drop it, never mis-pair it.
  if (outstanding_id_.isEmpty() || id != outstanding_id_) {
    return incoming; // matched == false
  }
  const QString sent_cmd = outstanding_cmd_;
  const quint64 sent_epoch = outstanding_epoch_;
  const qint64 sent_tab = outstanding_tab_id_;
  outstanding_id_.clear(); // single-winner retire
  outstanding_cmd_.clear();
  outstanding_tab_id_ = 0;
  incoming.matched = true;

  const QString type = frame.value(QStringLiteral("type")).toString();
  if (type == QLatin1String("result")) {
    const qint64 installed_tab =
        fillResult(sent_cmd, sent_epoch, sent_tab, frame, incoming);
    // Only reconcile the DOM-generation baseline for a result we actually
    // accepted; an {ok:false}/failed result must not re-baseline the epoch off
    // a DOM we never snapshotted.
    if (!incoming.is_error) {
      reconcileDomEpoch(sent_cmd, installed_tab, frame);
    }
  } else {
    incoming.is_error = true;
    if (type == QLatin1String("error")) {
      QString message = frame.value(QStringLiteral("message")).toString();
      if (message.isEmpty()) {
        message = frame.value(QStringLiteral("error")).toString();
      }
      incoming.error = message.isEmpty()
                           ? QStringLiteral("Browser command failed.")
                           : message;
    } else {
      incoming.error = QStringLiteral("Unexpected reply type '%1'.").arg(type);
    }
  }
  // Tabs the session lost are reported on whatever reply happens to follow
  // the loss, success or failure -- a command can fail precisely because its
  // tab was closed -- so the list is honoured on every matched reply, and
  // last, so a snapshot just installed for a tab reported gone is dropped too.
  dropGoneTabs(frame);
  return incoming;
}

} // namespace chrome_control_mcp::browser
