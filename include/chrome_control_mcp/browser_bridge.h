// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QHash>
#include <QJsonObject>
#include <QString>

/// @file browser_bridge.h
/// @brief The browser-control session state machine that lives in the
/// long-lived MCP process (the pipe-server / authority side of the bridge).
///
/// Topology (settled by the design panel): the long-lived MCP process owns the
/// browser state and drives commands; the Chrome-spawned native host is a thin,
/// id-transparent relay; the extension holds the live CDP session. This class
/// is the pure "brain" on the MCP side -- it mints correlation ids, enforces
/// one outstanding op, matches replies single-winner (so a late reply from a
/// timed-out op can never be mis-paired to the next one), and owns the
/// ref_index produced by renderSnapshot so a later act-by-ref resolves in the
/// process that outlives the ephemeral relay. It performs no I/O and knows
/// nothing about named pipes or Chrome, so the whole protocol is unit-testable
/// with JSON frames.
///
/// Refs are bound to tabs. One server serves one MCP client, but several
/// agents can share that client (sub-agents, parallel tasks), each in its own
/// tab. With one index per server, agent B snapshotting its tab replaced agent
/// A's refs -- or worse, carried them onto B's nodes by backendNodeId, which is
/// only unique within one renderer. So the one combined index records, for
/// every ref, the tab its snapshot came from (bridge protocol 2 replies say
/// which tab with a top-level `tabId`), and staleness, DOM-generation baselines
/// and carry-over are all kept per tab. Ref NAMES are global and never reused
/// for the life of the server, so a ref that left the index -- its tab
/// navigated, closed, or was re-snapshotted without that node -- answers
/// "Unknown element ref" instead of naming whatever took its number.
namespace chrome_control_mcp::browser {

class BrowserBridgeSession {
public:
  /// A command frame to send to the extension (via the relay), or a refusal.
  struct Outgoing {
    QJsonObject
        frame; ///< The `{type:"command", id, cmd, ...}` frame (valid iff ok).
    bool ok{false};
    QString
        error; ///< Why the call was refused (not connected / busy / bad ref).
  };

  /// The outcome of feeding a reply frame back in.
  struct Incoming {
    bool matched{false};  ///< True iff this frame answered the outstanding op.
    bool is_error{false}; ///< True iff the matched reply was an error.
    QString
        text; ///< Tool-facing result text (snapshot outline or payload JSON).
    QString error;        ///< Error message when is_error.
    QString image_base64; ///< Base64 image for a screenshot reply (empty
                          ///< otherwise).
    QString image_mime;   ///< MIME type for image_base64 (e.g. "image/png").
  };

  /// A new relay has connected: this is a fresh browser/CDP session, so any
  /// stored ref_index is from a dead session and is cleared, and any
  /// outstanding op is abandoned. The ref-name high-water mark survives: a
  /// model still holding e7 from before the reconnect must be told it is
  /// unknown, not handed a new node that happens to be numbered 7.
  void onHostConnected();

  /// The relay disconnected (Chrome closed, extension unloaded): no browser is
  /// reachable until a new host connects. Same clearing as onHostConnected.
  void onHostDisconnected();

  /// The DOM may have changed under every tab's refs at once (a CDP detach we
  /// cannot attribute to one tab): mark every tab stale, so act-by-ref is
  /// refused until that tab's next snapshot, and move the session epoch so a
  /// snapshot already in flight cannot install against the old DOM.
  void onDetached();

  [[nodiscard]] bool connected() const { return connected_; }

  /// Record the MCP client's name (`clientInfo.name` from `initialize`), sent
  /// as `client` on every command frame so the extension can title the tab
  /// group it marks this session's tabs with. Sanitized here; an empty result
  /// means unknown, and the field is then omitted.
  void setClientName(const QString &raw);
  [[nodiscard]] const QString &clientName() const { return client_name_; }

  /// What setClientName keeps of @p raw: printable characters only (no
  /// control, format or line-separator characters, so nothing in it can
  /// break a tab-group title or reorder its text), whitespace collapsed, at
  /// most kMaxClientNameChars. The name comes from whatever client connected,
  /// so it is treated as untrusted text.
  [[nodiscard]] static QString sanitizeClientName(const QString &raw);
  static constexpr int kMaxClientNameChars = 32;

  /// Build the command frame for a browser_* tool call, minting and recording
  /// the outstanding correlation id. Refuses (ok == false) when no browser is
  /// connected, an op is already in flight, the snapshot is stale for a
  /// ref-based action, or buildExtensionCommand rejects the arguments.
  [[nodiscard]] Outgoing beginCommand(const QString &tool,
                                      const QJsonObject &arguments);

  /// The refusal beginCommand would give this call's arguments -- a stale ref,
  /// or one buildExtensionCommand rejects -- without starting anything. A call
  /// that carries files asks first, so a call refused after its files had gone
  /// cannot leave them stranded in the extension's buffer. Empty when the
  /// arguments are acceptable.
  [[nodiscard]] QString argumentsError(const QString &tool,
                                       const QJsonObject &arguments) const;

  /// Build a command frame for an internal command the model never calls:
  /// today, the upload chunks that carry a file's bytes to the extension
  /// before the upload itself names the element to assign them to. It takes
  /// the same connection and one-op-in-flight guarantees as beginCommand and
  /// mints from the same id sequence, but skips contract translation --
  /// there is no tool here, and no ref to resolve, only bytes already read and
  /// bounded by the caller. Not reachable from tools/call: MCP dispatch only
  /// knows the catalog, and @p cmd is never in it.
  [[nodiscard]] Outgoing beginInternalCommand(const QString &cmd,
                                              const QJsonObject &payload);

  /// Feed a reply frame from the extension. A frame whose id does not match the
  /// outstanding op is dropped (matched == false) -- this is how a late reply
  /// from a previously timed-out op is discarded rather than mis-paired. On a
  /// match the op is retired and, for a snapshot result, the ref_index is
  /// refreshed.
  [[nodiscard]] Incoming onReply(const QJsonObject &frame);

  [[nodiscard]] bool hasOutstanding() const {
    return !outstanding_id_.isEmpty();
  }
  [[nodiscard]] QString outstandingId() const { return outstanding_id_; }

  /// Abandon the outstanding op (called by the I/O layer on a read timeout). A
  /// subsequent reply carrying the retired id will no longer match. A timed-out
  /// op left the browser in an UNCONFIRMED state -- a click/navigation may have
  /// mutated or navigated the DOM before we gave up waiting -- so refs it could
  /// have touched are now suspect: the tab the command named, or every tab when
  /// it named none (it then acted on whichever tab was current, which this
  /// side cannot know). Fail closed: a fresh snapshot is required before
  /// acting by ref there.
  void retireOutstanding();

  /// Every live ref, `eN -> {backendNodeId, role, name, tabId}`, across tabs.
  [[nodiscard]] const QJsonObject &refIndex() const { return ref_index_; }
  /// True iff any tab's refs are stale.
  [[nodiscard]] bool refIndexStale() const;
  /// True iff @p tab_id has refs that are stale.
  [[nodiscard]] bool tabStale(qint64 tab_id) const;
  /// The largest ref number ever issued by this session (0 before the first).
  [[nodiscard]] qint64 highestRefIssued() const { return ref_high_water_; }

private:
  // What one tab's refs are valid against. The baseline is that tab's DOM
  // generation when its refs were captured; a reply reporting another
  // generation for the tab means the page changed underneath them.
  struct TabRefState {
    bool stale{false};
    quint64 dom_epoch{0};
    bool have_dom_epoch{false};
  };

  static Outgoing refuse(const QString &reason);
  // Returns the tab a snapshot reply was installed under, or 0 when nothing
  // was installed (not a snapshot, failed, or refused).
  qint64 fillResult(const QString &sent_cmd, quint64 sent_epoch,
                    qint64 sent_tab, const QJsonObject &frame,
                    Incoming &incoming);
  qint64 fillSnapshotResult(quint64 sent_epoch, const QJsonObject &frame,
                            Incoming &incoming);
  static void fillGenericResult(const QJsonObject &frame, Incoming &incoming);
  static void fillScreenshotResult(const QJsonObject &payload,
                                   Incoming &incoming);
  static void fillPrintResult(const QJsonObject &payload, Incoming &incoming);
  // Invalidate refs a command's own effect made meaningless: a navigation
  // marks its tab stale, a closed or released tab loses its refs.
  void applyCommandEffect(const QString &sent_cmd, qint64 sent_tab,
                          const QJsonObject &frame);
  // Detect an EXTERNAL DOM change (user navigation / CDP detach) reported by
  // the extension via a per-reply tabId + domEpoch: a fresh snapshot
  // re-baselines that tab; any later reply carrying a different epoch for the
  // tab means its refs are stale.
  void reconcileDomEpoch(const QString &sent_cmd, qint64 installed_tab,
                         const QJsonObject &frame);
  // Drop every ref bound to a tab the reply's goneTabIds says this session no
  // longer holds.
  void dropGoneTabs(const QJsonObject &frame);
  void markTabStale(qint64 tab_id);
  void markAllStale();
  // The state for @p tab_id, created clean on first use -- the one place a tab
  // starts being tracked, so no lookup elsewhere has to default-construct one.
  TabRefState &trackTab(qint64 tab_id);
  // Remove the refs bound to @p tab_id, keeping its state (a re-snapshot).
  void eraseTabRefs(qint64 tab_id);
  // Remove the refs AND the state: the tab is no longer this session's.
  void dropTab(qint64 tab_id);
  void clearRefs();
  // Refuse an act-by-ref whose ref (or drag's to_ref) is bound to a stale
  // tab. Empty when the call may proceed.
  [[nodiscard]] QString staleRefError(const QJsonObject &arguments) const;

  bool connected_{false};
  quint64 counter_{0};
  QHash<qint64, TabRefState> tabs_;
  // Every ref number issued since this object was created. Never lowered --
  // not by a reconnect, not by a navigation -- because it is what keeps a ref
  // name from ever being reused for a different node.
  qint64 ref_high_water_{0};
  QString client_name_;
  // Bumped whenever the browser/DOM identity changes underneath an in-flight op
  // (host connect, host disconnect, CDP detach). A command records the epoch it
  // was issued under; a reply that arrives after the epoch moved cannot install
  // snapshot state, so a snapshot captured against a now-dead DOM is not
  // trusted.
  quint64 session_epoch_{0};
  quint64 outstanding_epoch_{0};
  QString outstanding_id_;
  // The cmd the session authoritatively sent for the outstanding op. State
  // mutations (snapshot install, navigation invalidation) branch on THIS, never
  // on the reply frame's self-declared cmd, which is untrusted
  // (web-page-derived).
  QString outstanding_cmd_;
  // The tab_id the outstanding command was sent with, 0 when it named none.
  qint64 outstanding_tab_id_{0};
  QJsonObject ref_index_;
};

} // namespace chrome_control_mcp::browser
