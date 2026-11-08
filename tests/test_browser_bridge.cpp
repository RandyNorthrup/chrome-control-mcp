// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>
#include <QTemporaryDir>
#include <QtTest/QtTest>

using chrome_control_mcp::browser::BrowserBridgeSession;

namespace {

// A minimal raw snapshot capture payload (the shape the extension returns and
// renderSnapshot consumes) with one interactable button.
QJsonObject snapshotPayload(int backendNodeId, const QString &name) {
  return QJsonObject{
      {QStringLiteral("url"), QStringLiteral("https://example.com/")},
      {QStringLiteral("title"), QStringLiteral("Example")},
      {QStringLiteral("nodes"),
       QJsonArray{
           QJsonObject{{QStringLiteral("backendNodeId"), backendNodeId},
                       {QStringLiteral("role"), QStringLiteral("button")},
                       {QStringLiteral("name"), name},
                       {QStringLiteral("interactable"), true},
                       {QStringLiteral("visible"), true},
                       {QStringLiteral("depth"), 0},
                       {QStringLiteral("bounds"),
                        QJsonObject{{QStringLiteral("x"), 0},
                                    {QStringLiteral("y"), 0},
                                    {QStringLiteral("width"), 80},
                                    {QStringLiteral("height"), 20}}}}}}};
}

// A screenshot reply payload: base64 image bytes (the bridge reads dimensions
// from the PNG header itself, not from any payload-declared size).
QJsonObject screenshotPayload(const QString &data) {
  return QJsonObject{{QStringLiteral("data"), data},
                     {QStringLiteral("mimeType"), QStringLiteral("image/png")}};
}

// Base64 of a valid PNG header (8-byte signature + IHDR chunk with the given
// dimensions), enough for the bridge to read width/height from the image.
QString pngHeaderBase64(int width, int height) {
  QByteArray bytes;
  const unsigned char signature[8] = {0x89, 0x50, 0x4E, 0x47,
                                      0x0D, 0x0A, 0x1A, 0x0A};
  bytes.append(reinterpret_cast<const char *>(signature), 8);
  const unsigned char ihdr_len[4] = {0x00, 0x00, 0x00, 0x0D};
  bytes.append(reinterpret_cast<const char *>(ihdr_len), 4);
  bytes.append("IHDR", 4);
  const auto append_be32 = [&bytes](int value) {
    bytes.append(static_cast<char>((value >> 24) & 0xFF));
    bytes.append(static_cast<char>((value >> 16) & 0xFF));
    bytes.append(static_cast<char>((value >> 8) & 0xFF));
    bytes.append(static_cast<char>(value & 0xFF));
  };
  append_be32(width);
  append_be32(height);
  bytes.append(
      8, '\0'); // bit depth / color type / etc. -- unread, just pads the prefix
  return QString::fromLatin1(bytes.toBase64());
}

QJsonObject resultFrame(const QString &id, const QString &cmd,
                        const QJsonObject &payload) {
  return QJsonObject{{QStringLiteral("type"), QStringLiteral("result")},
                     {QStringLiteral("id"), id},
                     {QStringLiteral("cmd"), cmd},
                     {QStringLiteral("payload"), payload}};
}

// A result frame carrying the extension's per-reply DOM-generation marker
// (domEpoch).
QJsonObject resultFrameEpoch(const QString &id, const QString &cmd,
                             const QJsonObject &payload, int domEpoch) {
  QJsonObject frame = resultFrame(id, cmd, payload);
  frame.insert(QStringLiteral("domEpoch"), domEpoch);
  return frame;
}

// A result frame as bridge protocol 2 sends it for a command that touched a
// tab: the tab it acted on and that tab's DOM generation, always together.
QJsonObject tabFrame(const QString &id, const QString &cmd,
                     const QJsonObject &payload, int tabId, int domEpoch) {
  QJsonObject frame = resultFrameEpoch(id, cmd, payload, domEpoch);
  frame.insert(QStringLiteral("tabId"), tabId);
  return frame;
}

// The tab the single-tab tests below snapshot. Any positive id would do; one
// that is not 1 keeps a test from passing because something defaulted to 1.
constexpr int kTab = 7;

// A snapshot reply naming kTab but no DOM generation: what the tests that are
// not about generations use, so no baseline is set behind their backs.
QJsonObject snapshotFrame(const QString &id, const QJsonObject &payload) {
  QJsonObject frame = resultFrame(id, QStringLiteral("snapshot"), payload);
  frame.insert(QStringLiteral("tabId"), kTab);
  return frame;
}

QString frameId(const BrowserBridgeSession::Outgoing &out) {
  return out.frame.value(QStringLiteral("id")).toString();
}

// A capture with two buttons. Two tabs are two documents in two renderers, and
// backendNodeId is only unique within one, so the tests below deliberately give
// both tabs the SAME ids for different nodes: that is the case where carrying
// refs by backendNodeId across tabs would name the wrong element.
QJsonObject twoButtonPayload(int firstId, const QString &firstName,
                             int secondId, const QString &secondName) {
  QJsonObject capture = snapshotPayload(firstId, firstName);
  QJsonArray nodes = capture.value(QStringLiteral("nodes")).toArray();
  QJsonObject second = nodes.first().toObject();
  second.insert(QStringLiteral("backendNodeId"), secondId);
  second.insert(QStringLiteral("name"), secondName);
  nodes.append(second);
  capture.insert(QStringLiteral("nodes"), nodes);
  return capture;
}

// The ref a snapshot outline gave the element named @p name, or "" if none.
QString refFor(const QString &outline, const QString &name) {
  const QRegularExpression pattern(QStringLiteral("\"%1\" \\[ref=(e\\d+)\\]")
                                       .arg(QRegularExpression::escape(name)));
  return pattern.match(outline).captured(1);
}

// Snapshot whichever tab the extension reports, and return the outline.
QString snapshotTab(BrowserBridgeSession &session, const QJsonObject &payload,
                    int tabId, int domEpoch) {
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  if (!snap.ok) {
    return QString();
  }
  return session
      .onReply(tabFrame(snap.frame.value(QStringLiteral("id")).toString(),
                        QStringLiteral("snapshot"), payload, tabId, domEpoch))
      .text;
}

} // namespace

class BrowserBridgeTests : public QObject {
  Q_OBJECT

private slots:
  void beginCommand_refusedWhenNotConnected();
  void beginCommand_mintsCommandFrameWithTypeAndId();
  void beginCommand_refusesSecondWhileOutstanding();
  void onReply_nonMatchingIdIsDroppedKeepingOutstanding();
  void onReply_lateReplyAfterTimeoutIsDropped();
  void snapshot_populatesRefIndexAndClickResolvesBackendNodeId();
  void onReply_errorFrameSurfacesMessageAndRetires();
  void hostReconnect_clearsRefIndexSoStaleRefFails();
  void onDetached_refusesRefActionButAllowsSnapshot();
  void onDetached_refusesDragByToRefEndpoint();
  void externalNavigationViaDomEpochInvalidatesRefs();
  void onReply_unexpectedTypeIsError();
  void reply_forgedSnapshotCmdCannotInstallRefIndex();
  void detachDuringSnapshot_replyDoesNotInstallRefIndex();
  void navigationInvalidatesRefsFromPriorSnapshot();
  void screenshotReply_populatesImageChannelWithDimsFromPngHeader();
  void screenshotReply_presentationIsSavedNotShown();
  void screenshotReply_presentationThatIsNotPngIsRefused();
  void screenshotReply_zoomSaysWhatItShows();
  void screenshotReply_clippedFullPageSaysSo();
  void actionSnapshot_isShownAndItsRefsWork();
  void actionSnapshot_ofAReplacedPageIsNotBound();
  void ifChanged_saysUnchangedAndMarksOnlyNewRefs();
  void fillForm_refusesAStaleFieldRef();
  void screenshotReply_nonPngFallsBackToPlainSummary();
  void screenshotReply_emptyDataIsHonestError();
  void screenshotReply_oversizeBase64IsRejected();
  void onReply_resultWithOkFalseIsError();
  void onReply_okFalseSnapshotDoesNotInstallRefIndex();
  void screenshotReply_malformedBase64IsError();
  void reconcileDomEpoch_malformedEpochMarksRefsStale();
  void reconcileDomEpoch_omittedEpochAfterBaselineMarksRefsStale(); // R5-G10-9
  void printReply_nonPdfDataIsRefused();                            // R5-G10-9
  void printReply_oversizePayloadIsRefused();                       // R5-G10-9
  void screenshotReply_hostileMimeTypeCoercedToPng();
  void genericReply_oversizeTextIsRejected();
  void twoTabs_alternatingSnapshotsKeepIndependentRefs();
  void refBoundToOneTab_refusesAConflictingTabId();
  void drag_refusesEndpointsOnTwoTabs();
  void staleTab_leavesOtherTabsRefsLive();
  void tabSwitching_leavesRefsLiveAndRepliesNameTheirTab();
  void goneTabIds_dropRefsBoundToThoseTabs();
  void refsAreNeverReusedAfterNavigationOrReconnect();
  void snapshotWithoutTabId_installsNothingAndSaysExtensionIsOld();
  void domEpochWithoutTabId_marksEveryTabStale();
  void timeout_marksOnlyTheNamedTabStale();
  void closeAndRelease_dropTheirTabsRefs();
  void clientName_isSanitizedOntoEveryFrame();
};

void BrowserBridgeTests::beginCommand_refusedWhenNotConnected() {
  BrowserBridgeSession session;
  const auto out = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{
          {QStringLiteral("url"), QStringLiteral("https://example.com/")}});
  QVERIFY(!out.ok);
  QVERIFY(out.error.contains(QStringLiteral("not connected")));
  QVERIFY(!session.hasOutstanding());
}

void BrowserBridgeTests::beginCommand_mintsCommandFrameWithTypeAndId() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto out = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{
          {QStringLiteral("url"), QStringLiteral("https://example.com/")}});
  QVERIFY(out.ok);
  QCOMPARE(out.frame.value(QStringLiteral("type")).toString(),
           QStringLiteral("command"));
  QCOMPARE(out.frame.value(QStringLiteral("cmd")).toString(),
           QStringLiteral("navigate"));
  QCOMPARE(out.frame.value(QStringLiteral("url")).toString(),
           QStringLiteral("https://example.com/"));
  QCOMPARE(out.frame.value(QStringLiteral("id")).toString(),
           QStringLiteral("b-1"));
  QCOMPARE(session.outstandingId(), QStringLiteral("b-1"));
}

void BrowserBridgeTests::beginCommand_refusesSecondWhileOutstanding() {
  BrowserBridgeSession session;
  session.onHostConnected();
  QVERIFY(session.beginCommand(QStringLiteral("browser_snapshot"), {}).ok);
  const auto second =
      session.beginCommand(QStringLiteral("browser_reload"), {});
  QVERIFY(!second.ok);
  QVERIFY(second.error.contains(QStringLiteral("already in progress")));
}

void BrowserBridgeTests::onReply_nonMatchingIdIsDroppedKeepingOutstanding() {
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)session.beginCommand(QStringLiteral("browser_reload"),
                             {}); // b-1 outstanding
  const auto in = session.onReply(resultFrame(
      QStringLiteral("b-999"), QStringLiteral("reload"), QJsonObject{}));
  QVERIFY(!in.matched);
  QVERIFY(session.hasOutstanding()); // still waiting for b-1
  QCOMPARE(session.outstandingId(), QStringLiteral("b-1"));
}

void BrowserBridgeTests::onReply_lateReplyAfterTimeoutIsDropped() {
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)session.beginCommand(QStringLiteral("browser_reload"), {}); // b-1
  session.retireOutstanding(); // timeout fired
  QVERIFY(!session.hasOutstanding());
  // A late reply for the retired b-1 must not match.
  const auto late = session.onReply(resultFrame(
      QStringLiteral("b-1"), QStringLiteral("reload"), QJsonObject{}));
  QVERIFY(!late.matched);
}

void BrowserBridgeTests::
    snapshot_populatesRefIndexAndClickResolvesBackendNodeId() {
  BrowserBridgeSession session;
  session.onHostConnected();

  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  QVERIFY(snap.ok);
  const auto snapReply = session.onReply(snapshotFrame(
      frameId(snap), snapshotPayload(4242, QStringLiteral("Sign in"))));
  QVERIFY(snapReply.matched);
  QVERIFY(!snapReply.is_error);
  QVERIFY(snapReply.text.contains(QStringLiteral("[ref=e1]")));
  QVERIFY(snapReply.text.contains(QStringLiteral("Sign in")));
  // The outline says which tab its refs act on, right after the title.
  QVERIFY2(snapReply.text.contains(
               QStringLiteral("title: Example\ntab_id: 7\nelements: 1\n")),
           qPrintable(snapReply.text));
  QVERIFY(session.refIndex().contains(QStringLiteral("e1")));

  // Now a click by that ref resolves to the stored backendNodeId, on the tab
  // the ref came from.
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(click.ok);
  QCOMPARE(click.frame.value(QStringLiteral("cmd")).toString(),
           QStringLiteral("click"));
  QCOMPARE(click.frame.value(QStringLiteral("backendNodeId")).toInt(), 4242);
  QCOMPARE(click.frame.value(QStringLiteral("tab_id")).toInt(), kTab);
  QCOMPARE(click.frame.value(QStringLiteral("id")).toString(),
           QStringLiteral("b-2"));
}

void BrowserBridgeTests::externalNavigationViaDomEpochInvalidatesRefs() {
  // B13-04: the extension stamps a domEpoch on every reply; a later reply whose
  // epoch differs from the snapshot's baseline means the DOM navigated
  // externally (no navigation command from us), so ref_index must be
  // invalidated -- the production wiring of onDetached().
  BrowserBridgeSession session;
  session.onHostConnected();

  // Snapshot at DOM epoch 1 -> ref_index installed, baseline epoch 1, not
  // stale.
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(
      tabFrame(frameId(snap), QStringLiteral("snapshot"),
               snapshotPayload(4242, QStringLiteral("Sign in")), kTab, 1));
  QVERIFY(!session.tabStale(kTab));

  // A later NON-snapshot reply reports a HIGHER epoch for the same tab: the
  // page navigated out from under us.
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  (void)session.onReply(tabFrame(frameId(shot), QStringLiteral("screenshot"),
                                 screenshotPayload(pngHeaderBase64(10, 10)),
                                 kTab, 2));
  QVERIFY(session.tabStale(kTab));

  // A ref-based action is now refused until a fresh snapshot re-baselines the
  // DOM.
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok);
}

void BrowserBridgeTests::onReply_errorFrameSurfacesMessageAndRetires() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto out = session.beginCommand(QStringLiteral("browser_reload"), {});
  const auto in = session.onReply(QJsonObject{
      {QStringLiteral("type"), QStringLiteral("error")},
      {QStringLiteral("id"), out.frame.value(QStringLiteral("id"))},
      {QStringLiteral("message"), QStringLiteral("cdp_attach_failed")}});
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QCOMPARE(in.error, QStringLiteral("cdp_attach_failed"));
  QVERIFY(!session.hasOutstanding()); // retired on match
}

void BrowserBridgeTests::hostReconnect_clearsRefIndexSoStaleRefFails() {
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(snapshotFrame(
      QStringLiteral("b-1"), snapshotPayload(7, QStringLiteral("Go"))));
  QVERIFY(session.refIndex().contains(QStringLiteral("e1")));

  // A fresh host connect is a new CDP session: the old refs must be gone.
  session.onHostConnected();
  QVERIFY(session.refIndex().isEmpty());
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok);
  QVERIFY(click.error.contains(
      QStringLiteral("snapshot"))); // "call browser_snapshot to refresh"
}

void BrowserBridgeTests::onDetached_refusesRefActionButAllowsSnapshot() {
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(snapshotFrame(
      QStringLiteral("b-1"), snapshotPayload(7, QStringLiteral("Go"))));

  session.onDetached();
  QVERIFY(session.tabStale(kTab));
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok);
  QVERIFY(click.error.contains(QStringLiteral("page changed")));

  // A fresh snapshot is still allowed and clears the stale flag.
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  QVERIFY(snap.ok);
  (void)session.onReply(
      snapshotFrame(frameId(snap), snapshotPayload(9, QStringLiteral("Next"))));
  QVERIFY(!session.tabStale(kTab));
  QVERIFY(!session.refIndexStale());
}

void BrowserBridgeTests::onDetached_refusesDragByToRefEndpoint() {
  // browser_drag targets a second element via to_ref. onDetached() marks the
  // snapshot stale but leaves ref_index populated, so a drag carrying ONLY
  // to_ref would resolve against a now-dead DOM. The stale gate must refuse an
  // action carrying EITHER ref, not just ref.
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(snapshotFrame(
      QStringLiteral("b-1"), snapshotPayload(7, QStringLiteral("Go"))));
  QVERIFY(session.refIndex().contains(QStringLiteral("e1")));

  session.onDetached();
  QVERIFY(session.tabStale(kTab));
  // to_ref=e1 is still present in ref_index, but the page changed: refuse it.
  const auto drag = session.beginCommand(
      QStringLiteral("browser_drag"),
      QJsonObject{{QStringLiteral("to_ref"), QStringLiteral("e1")}});
  QVERIFY(!drag.ok);
  QVERIFY(drag.error.contains(QStringLiteral("page changed")));
}

void BrowserBridgeTests::onReply_unexpectedTypeIsError() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto out = session.beginCommand(QStringLiteral("browser_reload"), {});
  const auto in = session.onReply(QJsonObject{
      {QStringLiteral("type"), QStringLiteral("welcome")},
      {QStringLiteral("id"), out.frame.value(QStringLiteral("id"))}});
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY(in.error.contains(QStringLiteral("Unexpected reply type")));
}

void BrowserBridgeTests::reply_forgedSnapshotCmdCannotInstallRefIndex() {
  // A reply that self-declares cmd:"snapshot" for a command the session sent as
  // a NON-snapshot must not install ref_index -- state keys off the sent cmd,
  // not the untrusted reply frame. (Prompt-injection guard.)
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto nav = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{
          {QStringLiteral("url"), QStringLiteral("https://example.com/")}});
  QVERIFY(nav.ok);
  const auto in = session.onReply(
      resultFrame(nav.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("snapshot"),
                  snapshotPayload(9999, QStringLiteral("Cancel"))));
  QVERIFY(in.matched);
  QVERIFY(
      session.refIndex().isEmpty()); // forged snapshot payload NOT installed
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok); // no such ref exists
}

void BrowserBridgeTests::detachDuringSnapshot_replyDoesNotInstallRefIndex() {
  // A detach while a snapshot is in flight must invalidate that reply: it
  // captured a now-dead DOM, so its ref_index must not be installed and refs
  // stay refused.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  session.onDetached(); // DOM changed while the snapshot was being taken
  const auto in = session.onReply(
      snapshotFrame(frameId(snap), snapshotPayload(7, QStringLiteral("Go"))));
  QVERIFY(in.matched);
  QVERIFY(session.refIndex().isEmpty()); // dead-DOM snapshot not trusted
  QVERIFY(in.text.contains(QStringLiteral("changed")));
  // Staleness is per tab now and no tab was ever installed, so there is no
  // flag to check; what matters is that the ref it would have issued does not
  // resolve.
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok);
}

void BrowserBridgeTests::navigationInvalidatesRefsFromPriorSnapshot() {
  // Programmatic navigation keeps CDP attached (no onDetached), but refs from
  // the prior page must still be refused until the next snapshot.
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(snapshotFrame(
      QStringLiteral("b-1"), snapshotPayload(100, QStringLiteral("Old"))));
  QVERIFY(session.refIndex().contains(QStringLiteral("e1")));
  QVERIFY(!session.tabStale(kTab));

  const auto nav = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{
          {QStringLiteral("url"), QStringLiteral("https://other.example/")}});
  (void)session.onReply(
      tabFrame(frameId(nav), QStringLiteral("navigate"),
               QJsonObject{{QStringLiteral("url"),
                            QStringLiteral("https://other.example/")}},
               kTab, 2));
  QVERIFY(session.tabStale(kTab)); // navigation invalidated the old refs
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok);
  QVERIFY(click.error.contains(QStringLiteral("page changed")));
}

void BrowserBridgeTests::
    screenshotReply_populatesImageChannelWithDimsFromPngHeader() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  QVERIFY(shot.ok);
  QCOMPARE(shot.frame.value(QStringLiteral("cmd")).toString(),
           QStringLiteral("screenshot"));

  const QString png = pngHeaderBase64(1280, 720);
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), screenshotPayload(png)));
  QVERIFY(in.matched);
  QVERIFY(!in.is_error);
  // The image rides the dedicated channel, NOT the text field (which is only a
  // summary).
  QCOMPARE(in.image_base64, png);
  QCOMPARE(in.image_mime, QStringLiteral("image/png"));
  // Dimensions are read from the PNG's own IHDR, so they are the true device
  // pixels.
  QVERIFY(in.text.contains(QStringLiteral("1280x720")));
  QVERIFY(!in.text.contains(png)); // the base64 is never dumped into text
}

// purpose "presentation": the full-resolution PNG is written to a file under a
// name this side chooses, and only its path and size go back -- the image never
// enters the model's context. Whether to write is decided by what the server
// asked for, not by anything in the reply.
void BrowserBridgeTests::screenshotReply_presentationIsSavedNotShown() {
  QTemporaryDir out;
  QVERIFY(out.isValid());
  qputenv("CHROME_CONTROL_MCP_OUTPUT_DIR", out.path().toUtf8());
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot = session.beginCommand(
      QStringLiteral("browser_screenshot"),
      QJsonObject{{QStringLiteral("purpose"), QStringLiteral("presentation")}});
  QVERIFY2(shot.ok, qPrintable(shot.error));
  QCOMPARE(shot.frame.value(QStringLiteral("purpose")).toString(),
           QStringLiteral("presentation"));
  const QString png = pngHeaderBase64(2560, 1440);
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), screenshotPayload(png)));
  qunsetenv("CHROME_CONTROL_MCP_OUTPUT_DIR");
  QVERIFY(in.matched);
  QVERIFY2(!in.is_error, qPrintable(in.error));
  QVERIFY(in.image_base64.isEmpty());
  const QJsonObject reply = QJsonDocument::fromJson(in.text.toUtf8()).object();
  QCOMPARE(reply.value(QStringLiteral("width")).toInt(), 2560);
  QCOMPARE(reply.value(QStringLiteral("height")).toInt(), 1440);
  const QString saved = reply.value(QStringLiteral("saved")).toString();
  QVERIFY2(QDir::cleanPath(QFileInfo(saved).absolutePath()) ==
               QDir::cleanPath(out.path()),
           qPrintable(saved));
  QVERIFY(
      QFileInfo(saved).fileName().startsWith(QStringLiteral("screenshot-")));
  QVERIFY(saved.endsWith(QStringLiteral(".png")));
  QFile file(saved);
  QVERIFY(file.open(QIODevice::ReadOnly));
  QCOMPARE(file.readAll(), QByteArray::fromBase64(png.toLatin1()));
}

void BrowserBridgeTests::screenshotReply_presentationThatIsNotPngIsRefused() {
  QTemporaryDir out;
  QVERIFY(out.isValid());
  qputenv("CHROME_CONTROL_MCP_OUTPUT_DIR", out.path().toUtf8());
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot = session.beginCommand(
      QStringLiteral("browser_screenshot"),
      QJsonObject{{QStringLiteral("purpose"), QStringLiteral("presentation")}});
  const QString data = QString::fromLatin1(QByteArray("GIF89a...").toBase64());
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), screenshotPayload(data)));
  qunsetenv("CHROME_CONTROL_MCP_OUTPUT_DIR");
  QVERIFY(in.is_error);
  QVERIFY(in.error.contains(QStringLiteral("not a PNG")));
  QVERIFY(QDir(out.path()).entryList(QDir::Files).isEmpty());
}

// A zoom is a different image from the view browser_click_at reads, so the
// reply says what it shows and that click coordinates stay the view's.
void BrowserBridgeTests::screenshotReply_zoomSaysWhatItShows() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"),
                           QJsonObject{{QStringLiteral("x"), 100},
                                       {QStringLiteral("y"), 50},
                                       {QStringLiteral("width"), 200},
                                       {QStringLiteral("height"), 120}});
  QVERIFY2(shot.ok, qPrintable(shot.error));
  QJsonObject payload = screenshotPayload(pngHeaderBase64(400, 240));
  payload.insert(
      QStringLiteral("zoom"),
      QJsonObject{{QStringLiteral("x"), 100},
                  {QStringLiteral("y"), 50},
                  {QStringLiteral("width"), 200},
                  {QStringLiteral("height"), 120},
                  {QStringLiteral("pixels_per_screenshot_pixel"), 2}});
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), payload));
  QVERIFY(!in.is_error);
  QVERIFY(!in.image_base64.isEmpty());
  QVERIFY2(in.text.contains(QStringLiteral("100,50 200x120")),
           qPrintable(in.text));
  QVERIFY(in.text.contains(QStringLiteral("browser_click_at still takes")));
}

// A full-page capture of a document past the browser's raster limit holds only
// its top slice and looks whole. The extension says so; the reply must carry
// it, in the view's text and in a presentation's saved-file reply alike.
void BrowserBridgeTests::screenshotReply_clippedFullPageSaysSo() {
  const auto clippedPayload = [] {
    QJsonObject payload = screenshotPayload(pngHeaderBase64(1280, 16384));
    payload.insert(QStringLiteral("clipped"), true);
    payload.insert(QStringLiteral("content_width"), 1280);
    payload.insert(QStringLiteral("content_height"), 40000);
    payload.insert(QStringLiteral("captured_width"), 1280);
    payload.insert(QStringLiteral("captured_height"), 16384);
    return payload;
  };
  const QString note = QStringLiteral("1280x40000 CSS px");
  {
    BrowserBridgeSession session;
    session.onHostConnected();
    const auto shot =
        session.beginCommand(QStringLiteral("browser_screenshot"),
                             QJsonObject{{QStringLiteral("full_page"), true}});
    QVERIFY2(shot.ok, qPrintable(shot.error));
    const auto in = session.onReply(
        resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                    QStringLiteral("screenshot"), clippedPayload()));
    QVERIFY(!in.is_error);
    QVERIFY2(in.text.contains(note), qPrintable(in.text));
    QVERIFY2(in.text.contains(QStringLiteral("1280x16384")),
             qPrintable(in.text));
  }
  {
    QTemporaryDir out;
    QVERIFY(out.isValid());
    qputenv("CHROME_CONTROL_MCP_OUTPUT_DIR", out.path().toUtf8());
    BrowserBridgeSession session;
    session.onHostConnected();
    const auto shot =
        session.beginCommand(QStringLiteral("browser_screenshot"),
                             QJsonObject{{QStringLiteral("full_page"), true},
                                         {QStringLiteral("purpose"),
                                          QStringLiteral("presentation")}});
    QVERIFY2(shot.ok, qPrintable(shot.error));
    const auto in = session.onReply(
        resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                    QStringLiteral("screenshot"), clippedPayload()));
    qunsetenv("CHROME_CONTROL_MCP_OUTPUT_DIR");
    QVERIFY2(!in.is_error, qPrintable(in.error));
    const QJsonObject reply =
        QJsonDocument::fromJson(in.text.toUtf8()).object();
    QVERIFY2(reply.value(QStringLiteral("clipped")).toString().contains(note),
             qPrintable(in.text));
  }
  // And a capture that is whole says nothing of the kind.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"),
                           QJsonObject{{QStringLiteral("full_page"), true}});
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"),
                  screenshotPayload(pngHeaderBase64(1280, 3000))));
  QVERIFY(!in.text.contains(QStringLiteral("capture limit")));
}

// An action asked for a snapshot gets it in the same reply: the action's JSON,
// then the snapshot, whose refs are installed for the tab at once -- no
// browser_snapshot between the action and the next click.
void BrowserBridgeTests::actionSnapshot_isShownAndItsRefsWork() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto click =
      session.beginCommand(QStringLiteral("browser_click_at"),
                           QJsonObject{{QStringLiteral("x"), 10},
                                       {QStringLiteral("y"), 20},
                                       {QStringLiteral("snapshot"), true}});
  QVERIFY2(click.ok, qPrintable(click.error));
  QCOMPARE(click.frame.value(QStringLiteral("snapshot")).toBool(), true);
  QJsonObject capture = snapshotPayload(41, QStringLiteral("Next"));
  capture.insert(QStringLiteral("domEpoch"), 3);
  const auto in = session.onReply(tabFrame(
      frameId(click), QStringLiteral("clickAt"),
      QJsonObject{
          {QStringLiteral("ok"), true},
          {QStringLiteral("changes"),
           QJsonObject{{QStringLiteral("dom"), QStringLiteral("some")}}},
          {QStringLiteral("snapshot"), capture}},
      kTab, 3));
  QVERIFY2(!in.is_error, qPrintable(in.error));
  const QString first = in.text.section(QLatin1Char('\n'), 0, 0);
  const QJsonObject action = QJsonDocument::fromJson(first.toUtf8()).object();
  QCOMPARE(action.value(QStringLiteral("changes"))
               .toObject()
               .value(QStringLiteral("dom"))
               .toString(),
           QStringLiteral("some"));
  QVERIFY2(!action.contains(QStringLiteral("snapshot")), qPrintable(first));
  QVERIFY2(in.text.contains(QStringLiteral("- button \"Next\" [ref=e1]")),
           qPrintable(in.text));
  QVERIFY(session.refIndex().contains(QStringLiteral("e1")));
  QVERIFY(!session.tabStale(kTab));
  // And the next action by that ref goes out.
  const auto next = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY2(next.ok, qPrintable(next.error));
}

// A capture from a document the tab has since replaced would bind refs to nodes
// it no longer has: the reply still carries the action's result, says why no
// snapshot is shown, and installs nothing.
void BrowserBridgeTests::actionSnapshot_ofAReplacedPageIsNotBound() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto click =
      session.beginCommand(QStringLiteral("browser_click_at"),
                           QJsonObject{{QStringLiteral("x"), 10},
                                       {QStringLiteral("y"), 20},
                                       {QStringLiteral("snapshot"), true}});
  QJsonObject capture = snapshotPayload(41, QStringLiteral("Next"));
  capture.insert(QStringLiteral("domEpoch"), 3);
  const auto in = session.onReply(
      tabFrame(frameId(click), QStringLiteral("clickAt"),
               QJsonObject{{QStringLiteral("ok"), true},
                           {QStringLiteral("snapshot"), capture}},
               kTab, 4));
  QVERIFY2(!in.is_error, qPrintable(in.error));
  QVERIFY2(in.text.contains(QStringLiteral("none is shown")),
           qPrintable(in.text));
  QVERIFY(!in.text.contains(QStringLiteral("[ref=")));
  QVERIFY(session.refIndex().isEmpty());
}

// if_changed: a snapshot equal to the tab's last is one line; a changed one is
// whole, with only the refs it is the first to show marked; the first snapshot
// of a page, or the first after it navigated, has nothing to compare with and
// marks nothing.
void BrowserBridgeTests::ifChanged_saysUnchangedAndMarksOnlyNewRefs() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap = [&session](const QJsonObject &capture, int epoch) {
    const auto out =
        session.beginCommand(QStringLiteral("browser_snapshot"),
                             QJsonObject{{QStringLiteral("if_changed"), true}});
    return session.onReply(tabFrame(frameId(out), QStringLiteral("snapshot"),
                                    capture, kTab, epoch));
  };
  const auto first = snap(snapshotPayload(41, QStringLiteral("Save")), 1);
  QVERIFY2(first.text.contains(QStringLiteral("- button \"Save\" [ref=e1]")),
           qPrintable(first.text));
  QVERIFY(!first.text.contains(QStringLiteral("*[ref=")));
  const auto same = snap(snapshotPayload(41, QStringLiteral("Save")), 1);
  QVERIFY2(same.text.contains(QStringLiteral(
               "unchanged since snapshot 1 (1 elements); its refs still work")),
           qPrintable(same.text));
  QVERIFY(!same.text.contains(QStringLiteral("[ref=")));
  QVERIFY(session.refIndex().contains(QStringLiteral("e1")));
  const auto grown = snap(
      twoButtonPayload(41, QStringLiteral("Save"), 42, QStringLiteral("Undo")),
      1);
  QVERIFY2(grown.text.contains(QStringLiteral("- button \"Save\" [ref=e1]")),
           qPrintable(grown.text));
  QVERIFY2(grown.text.contains(QStringLiteral("- button \"Undo\" *[ref=e2]")),
           qPrintable(grown.text));
  // Without if_changed the same page reads as it always did.
  const auto plain =
      session.beginCommand(QStringLiteral("browser_snapshot"), QJsonObject{});
  const auto unmarked = session.onReply(tabFrame(
      frameId(plain), QStringLiteral("snapshot"),
      twoButtonPayload(41, QStringLiteral("Save"), 43, QStringLiteral("Redo")),
      kTab, 1));
  QVERIFY(!unmarked.text.contains(QStringLiteral("*[ref=")));
  // A navigation leaves nothing to compare with: whole, and nothing marked.
  const auto nav = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{
          {QStringLiteral("url"), QStringLiteral("https://other.example/")}});
  (void)session.onReply(
      tabFrame(frameId(nav), QStringLiteral("navigate"),
               QJsonObject{{QStringLiteral("url"),
                            QStringLiteral("https://other.example/")}},
               kTab, 2));
  const auto after = snap(snapshotPayload(9, QStringLiteral("Home")), 2);
  QVERIFY2(after.text.contains(QStringLiteral("- button \"Home\" [ref=")),
           qPrintable(after.text));
  QVERIFY(!after.text.contains(QStringLiteral("*[ref=")));
  QVERIFY(!after.text.contains(QStringLiteral("unchanged")));
}

// A form's fields are refs like any other: one on a tab whose page changed
// since its snapshot is refused before anything is sent.
void BrowserBridgeTests::fillForm_refusesAStaleFieldRef() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), QJsonObject{});
  (void)session.onReply(tabFrame(frameId(snap), QStringLiteral("snapshot"),
                                 snapshotPayload(41, QStringLiteral("Name")),
                                 kTab, 1));
  const auto nav = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{
          {QStringLiteral("url"), QStringLiteral("https://other.example/")}});
  (void)session.onReply(
      tabFrame(frameId(nav), QStringLiteral("navigate"),
               QJsonObject{{QStringLiteral("url"),
                            QStringLiteral("https://other.example/")}},
               kTab, 2));
  const auto fill = session.beginCommand(
      QStringLiteral("browser_fill_form"),
      QJsonObject{{QStringLiteral("fields"),
                   QJsonArray{QJsonObject{
                       {QStringLiteral("ref"), QStringLiteral("e1")},
                       {QStringLiteral("value"), QStringLiteral("Ada")}}}}});
  QVERIFY(!fill.ok);
  QVERIFY2(fill.error.contains(QStringLiteral("page changed")),
           qPrintable(fill.error));
}

void BrowserBridgeTests::screenshotReply_nonPngFallsBackToPlainSummary() {
  // A payload whose header is not a readable PNG still returns the image, but
  // the summary omits dimensions instead of inventing them.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  const QString data =
      QString::fromLatin1(QByteArray("not-a-real-png-payload").toBase64());
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), screenshotPayload(data)));
  QVERIFY(in.matched);
  QVERIFY(!in.is_error);
  QCOMPARE(in.image_base64, data);
  QCOMPARE(in.text,
           QStringLiteral("Captured a PNG screenshot of the active tab."));
}

void BrowserBridgeTests::screenshotReply_emptyDataIsHonestError() {
  // A capture that yields no bytes is a FAILED read, not an empty-success -- it
  // must surface as an error, never as a blank image the model would treat as
  // real.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), screenshotPayload(QString())));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY(in.image_base64.isEmpty());
  QVERIFY(in.error.contains(QStringLiteral("empty")));
}

void BrowserBridgeTests::screenshotReply_oversizeBase64IsRejected() {
  // A full-page capture is page-influenced in size; a payload over the cap is
  // refused with an honest error instead of flooding the transport / model
  // context.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  const QString huge(16 * 1024 * 1024 + 1, QLatin1Char('A'));
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), screenshotPayload(huge)));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY(in.image_base64.isEmpty());
  QVERIFY(in.error.contains(QStringLiteral("too large")));
}

void BrowserBridgeTests::screenshotReply_hostileMimeTypeCoercedToPng() {
  // R5-G10-9: the extension-supplied mimeType is untrusted (a page-influenced
  // reply could carry "text/html" or a script type). sanitizedImageMime must
  // coerce anything that is not one of the image types WE emit down to
  // image/png, so the returned image block can never be turned into an
  // arbitrary content type. The image itself still rides the dedicated channel.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  const QString png = pngHeaderBase64(10, 10);
  const QJsonObject hostile{
      {QStringLiteral("data"), png},
      {QStringLiteral("mimeType"), QStringLiteral("text/html")}};
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), hostile));
  QVERIFY(in.matched);
  QVERIFY(!in.is_error);
  QCOMPARE(in.image_base64, png);
  QCOMPARE(in.image_mime,
           QStringLiteral("image/png")); // coerced, not "text/html"

  // Non-vacuity: an image type we DO emit is preserved, so this is a targeted
  // coercion of the disallowed set, not a blanket rewrite-everything-to-png.
  const auto shot2 =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  const QJsonObject webp{
      {QStringLiteral("data"), png},
      {QStringLiteral("mimeType"), QStringLiteral("image/webp")}};
  const auto in2 = session.onReply(
      resultFrame(shot2.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"), webp));
  QVERIFY(!in2.is_error);
  QCOMPARE(in2.image_mime, QStringLiteral("image/webp"));
}

void BrowserBridgeTests::genericReply_oversizeTextIsRejected() {
  // R5-G10-9: a generic (non-image/PDF) reply is echoed verbatim into the model
  // context. A hostile/pathological page can inflate it up to the 64 MiB
  // decoder limit, so the 8 MiB text cap must refuse an oversized reply with an
  // honest error rather than flood the transport.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto out = session.beginCommand(QStringLiteral("browser_reload"), {});
  const QString flood(8 * 1024 * 1024 + 1, QLatin1Char('A'));
  const QJsonObject huge{{QStringLiteral("content"), flood}};
  const auto in = session.onReply(
      resultFrame(out.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("reload"), huge));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY(in.text.isEmpty());
  QVERIFY(in.error.contains(QStringLiteral("too large")));

  // Non-vacuity: a small generic reply passes through to the text channel, so
  // the cap is a size gate rather than an always-error.
  const auto out2 = session.beginCommand(QStringLiteral("browser_reload"), {});
  const QJsonObject small{{QStringLiteral("content"), QStringLiteral("hi")}};
  const auto in2 = session.onReply(
      resultFrame(out2.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("reload"), small));
  QVERIFY(!in2.is_error);
  QVERIFY(in2.text.contains(QStringLiteral("hi")));
}

void BrowserBridgeTests::onReply_resultWithOkFalseIsError() {
  // A result-typed frame is NOT implicitly success: a payload {ok:false,
  // error:...} is an operation-level failure and must surface as an error,
  // never pass through as a successful text result the model would trust.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto out = session.beginCommand(QStringLiteral("browser_reload"), {});
  const QJsonObject payload{
      {QStringLiteral("ok"), false},
      {QStringLiteral("error"), QStringLiteral("navigation_blocked")}};
  const auto in = session.onReply(
      resultFrame(out.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("reload"), payload));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QCOMPARE(in.error, QStringLiteral("navigation_blocked"));
  QVERIFY(!session.hasOutstanding());
}

void BrowserBridgeTests::onReply_okFalseSnapshotDoesNotInstallRefIndex() {
  // A snapshot reply that reports {ok:false} failed to capture: it must NOT
  // install a ref_index (which would let the model act by ref against a DOM we
  // never snapshotted).
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  QJsonObject failed = snapshotPayload(4242, QStringLiteral("Sign in"));
  failed.insert(QStringLiteral("ok"), false);
  const auto in = session.onReply(
      resultFrame(snap.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("snapshot"), failed));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY(session.refIndex().isEmpty());
}

void BrowserBridgeTests::screenshotReply_malformedBase64IsError() {
  // A screenshot whose "data" is not valid base64 is refused with an honest
  // error rather than forwarded to the client as an opaque, unrenderable image
  // block.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  const auto in = session.onReply(
      resultFrame(shot.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("screenshot"),
                  screenshotPayload(QStringLiteral("!!!not-base64!!!"))));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY(in.image_base64.isEmpty());
  QVERIFY(in.error.contains(QStringLiteral("malformed")));
}

void BrowserBridgeTests::
    reconcileDomEpoch_omittedEpochAfterBaselineMarksRefsStale() {
  // Once a snapshot has established a domEpoch baseline, a later reply that
  // OMITS the domEpoch field entirely is treated as an attempt to hide a
  // navigation (a relayed, page-influenced frame stripping the field to keep
  // stale refs live): refs must be invalidated so act-by-ref is refused until a
  // fresh snapshot re-baselines the DOM. The existing epoch tests always send a
  // later reply that STILL carries domEpoch, so the have_dom_epoch_ downgrade
  // branch was never driven.
  BrowserBridgeSession session;
  session.onHostConnected();

  // Snapshot at DOM epoch 1 -> ref_index installed, baseline epoch 1, not
  // stale.
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(
      tabFrame(frameId(snap), QStringLiteral("snapshot"),
               snapshotPayload(4242, QStringLiteral("Sign in")), kTab, 1));
  QVERIFY(!session.tabStale(kTab));

  // A later reply to a TAB-SCOPED command that OMITS both tabId and domEpoch
  // (resultFrame): it touched a tab and will not say which, so the change it
  // may hide cannot be placed and every tab's refs are invalidated.
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  (void)session.onReply(
      resultFrame(frameId(shot), QStringLiteral("screenshot"),
                  screenshotPayload(pngHeaderBase64(10, 10))));
  QVERIFY2(session.tabStale(kTab), "a reply that drops domEpoch after a "
                                   "baseline exists must invalidate refs");

  // A ref-based action is now refused until a fresh snapshot re-baselines the
  // DOM.
  const auto click = session.beginCommand(
      QStringLiteral("browser_click"),
      QJsonObject{{QStringLiteral("ref"), QStringLiteral("e1")}});
  QVERIFY(!click.ok);
}

void BrowserBridgeTests::printReply_nonPdfDataIsRefused() {
  // A browser_print reply's payload.data is untrusted, page-influenced base64
  // that the bridge writes to the user's output folder as a .pdf. A payload
  // that decodes to something that is not a "%PDF-" document (e.g. an
  // executable or HTML) must be refused BEFORE any filesystem write, never
  // saved under a .pdf name. No existing test drove a print reply at all.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto print = session.beginCommand(QStringLiteral("browser_print"), {});
  const QByteArray notPdf =
      QByteArray("MZ\x90\x00 this is a PE header, not a pdf").toBase64();
  const auto in = session.onReply(resultFrame(
      print.frame.value(QStringLiteral("id")).toString(),
      QStringLiteral("print"),
      QJsonObject{{QStringLiteral("data"), QString::fromLatin1(notPdf)}}));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY2(in.error.contains(QStringLiteral("not a valid PDF")),
           qPrintable(in.error));

  // Guard-isolation control: an EMPTY payload yields the DIFFERENT "empty PDF"
  // error, so the %PDF- magic guard is scoped to non-empty non-PDF content
  // rather than firing on every reply. (A real %PDF- payload is deliberately
  // not asserted here -- accepting it writes a file to the user's output
  // folder, an unwanted unit-test side effect.)
  const auto empty = session.beginCommand(QStringLiteral("browser_print"), {});
  const auto emptyIn = session.onReply(
      resultFrame(empty.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("print"),
                  QJsonObject{{QStringLiteral("data"), QString()}}));
  QVERIFY(emptyIn.is_error);
  QVERIFY(emptyIn.error.contains(QStringLiteral("empty PDF")));
  QVERIFY(!emptyIn.error.contains(QStringLiteral("not a valid PDF")));
}

void BrowserBridgeTests::printReply_oversizePayloadIsRefused() {
  // The print oversize cap (browser_bridge.cpp:355, kMaxPdfBase64 = 24 MiB)
  // fires BEFORE the base64 decode and the %PDF- magic check, so a pathological
  // / page-influenced print payload cannot force a huge decode + disk write.
  // This is the print sibling of the already-tested screenshot (16 MiB) and
  // generic-reply (8 MiB) oversize caps.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto print = session.beginCommand(QStringLiteral("browser_print"), {});
  // One byte over the 24 MiB base64 cap. The size check trips before any
  // decode, so the content need not be valid base64.
  const QString oversize(24 * 1024 * 1024 + 1, QLatin1Char('A'));
  const auto in = session.onReply(
      resultFrame(print.frame.value(QStringLiteral("id")).toString(),
                  QStringLiteral("print"),
                  QJsonObject{{QStringLiteral("data"), oversize}}));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY2(in.error.contains(QStringLiteral("too large")),
           qPrintable(in.error));
  // Guard-isolation: the oversize error is DISTINCT from the magic-check
  // message, so this is the size cap firing, not the %PDF- guard.
  QVERIFY(!in.error.contains(QStringLiteral("not a valid PDF")));
}

void BrowserBridgeTests::reconcileDomEpoch_malformedEpochMarksRefsStale() {
  // A present-but-malformed domEpoch (non-integer / out of the exact-integer
  // double range) cannot be trusted as a baseline; the bridge fails closed by
  // marking refs stale instead of casting a garbage double to quint64 (UB) and
  // silently re-baselining.
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  (void)session.onReply(
      tabFrame(frameId(snap), QStringLiteral("snapshot"),
               snapshotPayload(4242, QStringLiteral("Sign in")), kTab, 1));
  QVERIFY(!session.tabStale(kTab));

  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  QJsonObject frame =
      tabFrame(frameId(shot), QStringLiteral("screenshot"),
               screenshotPayload(pngHeaderBase64(10, 10)), kTab, 1);
  frame.insert(QStringLiteral("domEpoch"),
               1e18); // beyond the exact-integer double range
  (void)session.onReply(frame);
  QVERIFY(session.tabStale(kTab));
}

// Two agents sharing one server, each working its own tab, snapshot in turn.
// With one index per server the second snapshot carried the first tab's refs
// onto the second tab's nodes by backendNodeId -- which is only unique within
// one renderer -- so agent A's e1 silently became a button on agent B's page,
// and a click on it went to whichever tab the extension had current.
void BrowserBridgeTests::twoTabs_alternatingSnapshotsKeepIndependentRefs() {
  BrowserBridgeSession session;
  session.onHostConnected();

  const QString first =
      snapshotTab(session,
                  twoButtonPayload(10, QStringLiteral("Sign in"), 11,
                                   QStringLiteral("Help")),
                  101, 1);
  const QString signIn = refFor(first, QStringLiteral("Sign in"));
  const QString help = refFor(first, QStringLiteral("Help"));
  QVERIFY2(!signIn.isEmpty() && !help.isEmpty(), qPrintable(first));

  // Tab 202 hands out the same backendNodeIds for different elements.
  const QString second = snapshotTab(
      session,
      twoButtonPayload(10, QStringLiteral("Buy"), 11, QStringLiteral("Cancel")),
      202, 1);
  const QString buy = refFor(second, QStringLiteral("Buy"));
  const QString cancel = refFor(second, QStringLiteral("Cancel"));
  QVERIFY2(!buy.isEmpty() && !cancel.isEmpty(), qPrintable(second));
  // No name is shared between the two tabs' elements...
  const QSet<QString> names{signIn, help, buy, cancel};
  QCOMPARE(names.size(), 4);
  // ...and the first tab's refs survived the second tab's snapshot.
  QCOMPARE(session.refIndex().size(), qsizetype(4));

  // The first agent snapshots again: its elements keep the refs it holds.
  const QString again =
      snapshotTab(session,
                  twoButtonPayload(10, QStringLiteral("Sign in"), 11,
                                   QStringLiteral("Help")),
                  101, 1);
  QCOMPARE(refFor(again, QStringLiteral("Sign in")), signIn);
  QCOMPARE(refFor(again, QStringLiteral("Help")), help);

  // Each ref acts on the tab it came from, whatever tab is current.
  const auto clickA =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), signIn}});
  QVERIFY2(clickA.ok, qPrintable(clickA.error));
  QCOMPARE(clickA.frame.value(QStringLiteral("tab_id")).toInt(), 101);
  QCOMPARE(clickA.frame.value(QStringLiteral("backendNodeId")).toInt(), 10);
  (void)session.onReply(
      tabFrame(clickA.frame.value(QStringLiteral("id")).toString(),
               QStringLiteral("click"),
               QJsonObject{{QStringLiteral("ok"), true}}, 101, 1));

  const auto clickB =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), buy}});
  QVERIFY2(clickB.ok, qPrintable(clickB.error));
  QCOMPARE(clickB.frame.value(QStringLiteral("tab_id")).toInt(), 202);
  QCOMPARE(clickB.frame.value(QStringLiteral("backendNodeId")).toInt(), 10);
}

// A ref decides its own tab. A tab_id that names another one is two answers to
// "which tab", and neither is safe to pick: the call is refused naming both.
void BrowserBridgeTests::refBoundToOneTab_refusesAConflictingTabId() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString outline =
      snapshotTab(session, snapshotPayload(10, QStringLiteral("Go")), 101, 1);
  const QString go = refFor(outline, QStringLiteral("Go"));

  const auto wrong =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), go},
                                       {QStringLiteral("tab_id"), 202}});
  QVERIFY(!wrong.ok);
  QVERIFY2(wrong.error.contains(QStringLiteral("101")) &&
               wrong.error.contains(QStringLiteral("202")),
           qPrintable(wrong.error));
  QVERIFY(!session.hasOutstanding());

  const auto agreeing =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), go},
                                       {QStringLiteral("tab_id"), 101}});
  QVERIFY2(agreeing.ok, qPrintable(agreeing.error));
  QCOMPARE(agreeing.frame.value(QStringLiteral("tab_id")).toInt(), 101);
}

// One gesture, one page: a drag whose two refs came from two tabs is refused,
// and a drag given only to_ref goes to to_ref's tab.
void BrowserBridgeTests::drag_refusesEndpointsOnTwoTabs() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString source =
      refFor(snapshotTab(session, snapshotPayload(10, QStringLiteral("Source")),
                         101, 1),
             QStringLiteral("Source"));
  const QString target =
      refFor(snapshotTab(session, snapshotPayload(20, QStringLiteral("Target")),
                         202, 1),
             QStringLiteral("Target"));

  const auto across =
      session.beginCommand(QStringLiteral("browser_drag"),
                           QJsonObject{{QStringLiteral("ref"), source},
                                       {QStringLiteral("to_ref"), target}});
  QVERIFY(!across.ok);
  QVERIFY2(across.error.contains(QStringLiteral("cannot cross tabs")),
           qPrintable(across.error));

  const auto toOnly =
      session.beginCommand(QStringLiteral("browser_drag"),
                           QJsonObject{{QStringLiteral("to_ref"), target},
                                       {QStringLiteral("from_x"), 5},
                                       {QStringLiteral("from_y"), 5}});
  QVERIFY2(toOnly.ok, qPrintable(toOnly.error));
  QCOMPARE(toOnly.frame.value(QStringLiteral("tab_id")).toInt(), 202);
  QCOMPARE(toOnly.frame.value(QStringLiteral("to_backendNodeId")).toInt(), 20);
}

// Agent A's page navigating says nothing about agent B's nodes. Before tab
// binding, one navigation anywhere marked every ref on the server stale.
void BrowserBridgeTests::staleTab_leavesOtherTabsRefsLive() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString a = refFor(
      snapshotTab(session, snapshotPayload(10, QStringLiteral("A")), 101, 1),
      QStringLiteral("A"));
  const QString b = refFor(
      snapshotTab(session, snapshotPayload(20, QStringLiteral("B")), 202, 1),
      QStringLiteral("B"));

  const auto nav = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{{QStringLiteral("url"), QStringLiteral("https://a.example/")},
                  {QStringLiteral("tab_id"), 101}});
  QVERIFY2(nav.ok, qPrintable(nav.error));
  QCOMPARE(nav.frame.value(QStringLiteral("tab_id")).toInt(), 101);
  (void)session.onReply(tabFrame(frameId(nav), QStringLiteral("navigate"),
                                 QJsonObject{{QStringLiteral("ok"), true}}, 101,
                                 2));
  QVERIFY(session.tabStale(101));
  QVERIFY(!session.tabStale(202));

  const auto clickB = session.beginCommand(
      QStringLiteral("browser_click"), QJsonObject{{QStringLiteral("ref"), b}});
  QVERIFY2(clickB.ok, qPrintable(clickB.error));
  (void)session.onReply(tabFrame(frameId(clickB), QStringLiteral("click"),
                                 QJsonObject{{QStringLiteral("ok"), true}}, 202,
                                 1));
  QVERIFY(!session.tabStale(202));

  const auto clickA = session.beginCommand(
      QStringLiteral("browser_click"), QJsonObject{{QStringLiteral("ref"), a}});
  QVERIFY(!clickA.ok);
  QVERIFY2(clickA.error.contains(QStringLiteral("page changed in tab 101")),
           qPrintable(clickA.error));

  // An external change on tab 202, reported by its generation moving, marks
  // 202 and nothing else.
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"),
                           QJsonObject{{QStringLiteral("tab_id"), 202}});
  (void)session.onReply(tabFrame(frameId(shot), QStringLiteral("screenshot"),
                                 screenshotPayload(pngHeaderBase64(10, 10)),
                                 202, 5));
  QVERIFY(session.tabStale(202));
}

// Opening or selecting a tab changes which tab is CURRENT; refs are bound to
// their own tab, so neither invalidates any. And a reply that names its tab
// says so to the model -- it is how browser_new_tab hands over the tab_id.
void BrowserBridgeTests::tabSwitching_leavesRefsLiveAndRepliesNameTheirTab() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString go = refFor(
      snapshotTab(session, snapshotPayload(10, QStringLiteral("Go")), 101, 1),
      QStringLiteral("Go"));

  const auto opened =
      session.beginCommand(QStringLiteral("browser_new_tab"), {});
  const auto openedReply = session.onReply(
      tabFrame(frameId(opened), QStringLiteral("newTab"),
               QJsonObject{{QStringLiteral("ok"), true},
                           {QStringLiteral("url"), QStringLiteral("")}},
               303, 1));
  QVERIFY(!openedReply.is_error);
  QVERIFY2(openedReply.text.contains(QStringLiteral("\"tab_id\":303")),
           qPrintable(openedReply.text));
  QVERIFY(!session.tabStale(101));

  const auto selected =
      session.beginCommand(QStringLiteral("browser_select_tab"),
                           QJsonObject{{QStringLiteral("tab_id"), 101}});
  QVERIFY2(selected.ok, qPrintable(selected.error));
  // A payload that already names its tab is left as the extension wrote it.
  const auto selectedReply =
      session.onReply(tabFrame(frameId(selected), QStringLiteral("selectTab"),
                               QJsonObject{{QStringLiteral("ok"), true},
                                           {QStringLiteral("tab_id"), 101}},
                               101, 1));
  QCOMPARE(selectedReply.text.count(QStringLiteral("tab_id")), 1);
  QVERIFY(!session.tabStale(101));

  const auto click =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), go}});
  QVERIFY2(click.ok, qPrintable(click.error));
}

// goneTabIds is how the extension says a tab left this session (closed,
// released, handed back). Its refs are dropped, on any reply that carries the
// list -- a failed command included, since a closed tab is often WHY it failed.
void BrowserBridgeTests::goneTabIds_dropRefsBoundToThoseTabs() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString a = refFor(
      snapshotTab(session, snapshotPayload(10, QStringLiteral("A")), 101, 1),
      QStringLiteral("A"));
  const QString b = refFor(
      snapshotTab(session, snapshotPayload(20, QStringLiteral("B")), 202, 1),
      QStringLiteral("B"));

  const auto list = session.beginCommand(QStringLiteral("browser_tabs"), {});
  QJsonObject listReply =
      resultFrame(frameId(list), QStringLiteral("listTabs"), QJsonObject{});
  listReply.insert(QStringLiteral("goneTabIds"), QJsonArray{101});
  (void)session.onReply(listReply);
  QVERIFY(!session.refIndex().contains(a));
  QVERIFY(session.refIndex().contains(b));
  QVERIFY(!session.refIndexStale()); // dropped, not merely suspect
  const auto clickA = session.beginCommand(
      QStringLiteral("browser_click"), QJsonObject{{QStringLiteral("ref"), a}});
  QVERIFY(!clickA.ok);
  QVERIFY(clickA.error.contains(QStringLiteral("Unknown element ref")));

  const auto clickB = session.beginCommand(
      QStringLiteral("browser_click"), QJsonObject{{QStringLiteral("ref"), b}});
  (void)session.onReply(QJsonObject{
      {QStringLiteral("type"), QStringLiteral("error")},
      {QStringLiteral("id"), frameId(clickB)},
      {QStringLiteral("message"), QStringLiteral("No tab with id: 202")},
      {QStringLiteral("goneTabIds"), QJsonArray{202}}});
  QVERIFY(session.refIndex().isEmpty());

  // A list we cannot read still says SOME tab went: every tab is suspect.
  (void)snapshotTab(session, snapshotPayload(30, QStringLiteral("C")), 101, 1);
  const auto again = session.beginCommand(QStringLiteral("browser_tabs"), {});
  QJsonObject bad =
      resultFrame(frameId(again), QStringLiteral("listTabs"), QJsonObject{});
  bad.insert(QStringLiteral("goneTabIds"), QStringLiteral("101"));
  (void)session.onReply(bad);
  QVERIFY(session.tabStale(101));
}

// A ref name is issued once for the life of the server. Before, a navigation
// emptied the carry-over and the next snapshot numbered from e1 again, so a
// model still holding e1 from the old page clicked whatever was first on the
// new one -- and was told it succeeded.
void BrowserBridgeTests::refsAreNeverReusedAfterNavigationOrReconnect() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString before =
      snapshotTab(session,
                  twoButtonPayload(10, QStringLiteral("Sign in"), 11,
                                   QStringLiteral("Help")),
                  101, 1);
  const QString signIn = refFor(before, QStringLiteral("Sign in"));
  const QString help = refFor(before, QStringLiteral("Help"));

  const auto nav = session.beginCommand(
      QStringLiteral("browser_navigate"),
      QJsonObject{{QStringLiteral("url"), QStringLiteral("https://b.example/")},
                  {QStringLiteral("tab_id"), 101}});
  (void)session.onReply(tabFrame(frameId(nav), QStringLiteral("navigate"),
                                 QJsonObject{{QStringLiteral("ok"), true}}, 101,
                                 2));

  // The new document reuses the old backendNodeIds for different elements.
  const QString after = snapshotTab(
      session,
      twoButtonPayload(10, QStringLiteral("Buy"), 11, QStringLiteral("Cancel")),
      101, 2);
  const QString buy = refFor(after, QStringLiteral("Buy"));
  const QString cancel = refFor(after, QStringLiteral("Cancel"));
  QVERIFY2(!buy.isEmpty() && !cancel.isEmpty(), qPrintable(after));
  const QSet<QString> names{signIn, help, buy, cancel};
  QCOMPARE(names.size(), 4);

  const auto stale =
      session.beginCommand(QStringLiteral("browser_click"),
                           QJsonObject{{QStringLiteral("ref"), signIn}});
  QVERIFY(!stale.ok);
  QVERIFY2(stale.error.contains(QStringLiteral("Unknown element ref")),
           qPrintable(stale.error));

  // A reconnect clears every ref but not the count: the next name is new.
  const qint64 issued = session.highestRefIssued();
  QCOMPARE(issued, qint64(4));
  session.onHostConnected();
  const QString fresh =
      refFor(snapshotTab(session, snapshotPayload(10, QStringLiteral("Again")),
                         101, 1),
             QStringLiteral("Again"));
  QCOMPARE(fresh, QStringLiteral("e%1").arg(issued + 1));
}

// A snapshot that does not name its tab cannot have its refs bound, and
// unbound refs would act on whichever tab is current -- so nothing is
// installed, and the reply says the extension is out of date.
void BrowserBridgeTests::
    snapshotWithoutTabId_installsNothingAndSaysExtensionIsOld() {
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)snapshotTab(session, snapshotPayload(10, QStringLiteral("Kept")), 101,
                    1);
  const QJsonObject before = session.refIndex();

  const auto snap =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  const auto in = session.onReply(
      resultFrameEpoch(frameId(snap), QStringLiteral("snapshot"),
                       snapshotPayload(99, QStringLiteral("Orphan")), 3));
  QVERIFY(in.matched);
  QVERIFY(in.is_error);
  QVERIFY2(in.error.contains(QStringLiteral("older than this server")) &&
               in.error.contains(QStringLiteral("chrome://extensions")),
           qPrintable(in.error));
  QCOMPARE(session.refIndex(), before);
  QCOMPARE(session.highestRefIssued(), qint64(1));
  // It reported a DOM generation it would not attribute to a tab.
  QVERIFY(session.tabStale(101));
}

void BrowserBridgeTests::domEpochWithoutTabId_marksEveryTabStale() {
  BrowserBridgeSession session;
  session.onHostConnected();
  (void)snapshotTab(session, snapshotPayload(10, QStringLiteral("A")), 101, 1);
  (void)snapshotTab(session, snapshotPayload(20, QStringLiteral("B")), 202, 1);

  // A command that touches no tab replying with neither field is the protocol
  // working, and invalidates nothing.
  const auto list = session.beginCommand(QStringLiteral("browser_tabs"), {});
  (void)session.onReply(
      resultFrame(frameId(list), QStringLiteral("listTabs"), QJsonObject{}));
  QVERIFY(!session.refIndexStale());

  // A generation with no tab to pin it on could be any tab's.
  const auto shot =
      session.beginCommand(QStringLiteral("browser_screenshot"), {});
  (void)session.onReply(
      resultFrameEpoch(frameId(shot), QStringLiteral("screenshot"),
                       screenshotPayload(pngHeaderBase64(10, 10)), 4));
  QVERIFY(session.tabStale(101));
  QVERIFY(session.tabStale(202));
}

// A command that timed out may have changed the tab it was sent to, and only
// that tab -- unless it named none, when it ran on whichever was current.
void BrowserBridgeTests::timeout_marksOnlyTheNamedTabStale() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString a = refFor(
      snapshotTab(session, snapshotPayload(10, QStringLiteral("A")), 101, 1),
      QStringLiteral("A"));
  (void)snapshotTab(session, snapshotPayload(20, QStringLiteral("B")), 202, 1);

  QVERIFY(session
              .beginCommand(QStringLiteral("browser_click"),
                            QJsonObject{{QStringLiteral("ref"), a}})
              .ok);
  session.retireOutstanding();
  QVERIFY(session.tabStale(101));
  QVERIFY(!session.tabStale(202));

  QVERIFY(session.beginCommand(QStringLiteral("browser_reload"), {}).ok);
  session.retireOutstanding();
  QVERIFY(session.tabStale(202));
}

void BrowserBridgeTests::closeAndRelease_dropTheirTabsRefs() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const QString a = refFor(
      snapshotTab(session, snapshotPayload(10, QStringLiteral("A")), 101, 1),
      QStringLiteral("A"));
  const QString b = refFor(
      snapshotTab(session, snapshotPayload(20, QStringLiteral("B")), 202, 1),
      QStringLiteral("B"));

  const auto close =
      session.beginCommand(QStringLiteral("browser_close_tab"),
                           QJsonObject{{QStringLiteral("tab_id"), 101}});
  QVERIFY2(close.ok, qPrintable(close.error));
  (void)session.onReply(resultFrame(frameId(close), QStringLiteral("closeTab"),
                                    QJsonObject{{QStringLiteral("ok"), true}}));
  QVERIFY(!session.refIndex().contains(a));
  QVERIFY(session.refIndex().contains(b));

  const auto release =
      session.beginCommand(QStringLiteral("browser_release"),
                           QJsonObject{{QStringLiteral("tab_id"), 202},
                                       {QStringLiteral("keep_open"), true}});
  QVERIFY2(release.ok, qPrintable(release.error));
  QCOMPARE(release.frame.value(QStringLiteral("cmd")).toString(),
           QStringLiteral("release"));
  QCOMPARE(release.frame.value(QStringLiteral("keep_open")).toBool(), true);
  (void)session.onReply(resultFrame(frameId(release), QStringLiteral("release"),
                                    QJsonObject{{QStringLiteral("ok"), true}}));
  QVERIFY(session.refIndex().isEmpty());

  // Releasing without a tab lets go of every tab, and so of every ref.
  (void)snapshotTab(session, snapshotPayload(10, QStringLiteral("A")), 101, 1);
  (void)snapshotTab(session, snapshotPayload(20, QStringLiteral("B")), 202, 1);
  const auto all = session.beginCommand(QStringLiteral("browser_release"), {});
  (void)session.onReply(resultFrame(frameId(all), QStringLiteral("release"),
                                    QJsonObject{{QStringLiteral("ok"), true}}));
  QVERIFY(session.refIndex().isEmpty());
}

// clientInfo.name is whatever the connecting client chose to send; it becomes
// a tab-group title in the user's browser, so it is cut down to printable text
// of a bounded length, and left off entirely when nothing usable remains.
void BrowserBridgeTests::clientName_isSanitizedOntoEveryFrame() {
  BrowserBridgeSession session;
  session.onHostConnected();
  const auto unnamed =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  QVERIFY(!unnamed.frame.contains(QStringLiteral("client")));
  session.retireOutstanding();

  // The bidi override is built at run time: the compiler rightly refuses one
  // written into a literal, which is the same attack this sanitizer exists
  // for.
  const QChar rightToLeftOverride(0x202E);
  session.setClientName(QStringLiteral("  claude\u0007-code") +
                        rightToLeftOverride +
                        QStringLiteral("\n  extra   words that  run well "
                                       "past the limit  "));
  const QString expected = QStringLiteral("claude-code extra words that run");
  QCOMPARE(session.clientName(), expected);
  QVERIFY(expected.size() <= BrowserBridgeSession::kMaxClientNameChars);

  const auto named =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  QCOMPARE(named.frame.value(QStringLiteral("client")).toString(), expected);
  session.retireOutstanding();
  // The upload pieces are command frames too.
  const auto chunk = session.beginInternalCommand(
      QStringLiteral("uploadChunk"),
      QJsonObject{{QStringLiteral("upload_id"), QStringLiteral("u-1-0")}});
  QCOMPARE(chunk.frame.value(QStringLiteral("client")).toString(), expected);
  session.retireOutstanding();

  // Nothing printable left: unknown, so omitted rather than sent empty.
  // Built from a code point, not typed: a raw left-to-right mark in source is
  // what GCC's -Wbidi-chars rejects, and what a reviewer cannot see.
  session.setClientName(QStringLiteral("\u0001\u0002") + QChar(0x200E));
  QVERIFY(session.clientName().isEmpty());
  const auto blank =
      session.beginCommand(QStringLiteral("browser_snapshot"), {});
  QVERIFY(!blank.frame.contains(QStringLiteral("client")));
}

QTEST_MAIN(BrowserBridgeTests)
#include "test_browser_bridge.moc"
