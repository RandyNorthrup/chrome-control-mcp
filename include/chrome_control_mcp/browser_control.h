// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/browser_bridge.h"
#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/mcp_tools.h"

#include <QJsonArray>
#include <QHash>
#include <QJsonObject>
#include <QString>

#include <chrono>
#include <map>
#include <optional>
#include <utility>

/// @file browser_control.h
/// @brief The MCP-process facade that binds the browser-control session brain
/// (BrowserBridgeSession) to the pipe transport (BrowserBridgePipeServer) and
/// exposes them to the JSON-RPC dispatch as a set of `browser_*` tools.
///
/// It lives in the long-lived MCP process and is driven entirely from the
/// single MCP thread. The pipe server runs its own I/O thread and only
/// publishes a connection generation counter + a connected flag; this facade
/// reconciles the single-threaded session with that async connection state
/// right before each tool call (a new generation means a fresh browser, so the
/// session drops any stale ref_index). One browser tool call becomes: sync
/// session <- connection, session.beginCommand (mint id / enforce one-op /
/// resolve refs), pipe.sendCommandAwaitReply (blocking transport),
/// session.onReply (single-winner correlation + snapshot install), then a
/// ToolResult.
namespace chrome_control_mcp {

/// A browser call that finds no relay attached waits for one only while one is
/// plausibly on its way: this server published its rendezvous record, or last
/// saw a relay, less than this long ago. The extension finds a new server from
/// a 30 s alarm when its worker is asleep and retries every 2 s when awake, so
/// three alarm periods covers a server that just started or a relay that just
/// dropped (an extension reload, a worker restart) -- and past it, a missing
/// browser is a missing browser, and the call should say so at once.
inline constexpr std::chrono::milliseconds kRelayAttachGrace{90'000};

/// How long such a call waits before refusing. Long enough for an awake
/// extension's 2 s retry plus the relay's handshake, with room for a loaded
/// machine; short enough that the first call of a newly started agent is a
/// pause rather than a hang when the extension is not coming.
inline constexpr std::chrono::milliseconds kRelayAttachWait{8'000};

/// How often that wait looks. Attachment is a flag the pipe thread sets, so
/// this is only the latency between it landing and the call noticing.
inline constexpr std::chrono::milliseconds kRelayAttachPoll{100};

/// What to tell an agent about a connection whose versions disagree with this
/// server's @p server version, or empty when they agree: which versions are
/// running and the one thing that fixes it. Chosen from all three together,
/// because the fix depends on which is behind -- reloading the extension does
/// nothing when the installed copy it would load is itself older than the
/// server. See docs/plans/extension-version.md.
[[nodiscard]] QString bridgeVersionNotice(const QString &server,
                                          const BridgePeerVersions &peer);

class BrowserControl {
public:
  /// Production uses the default options (real per-user rendezvous path, Chrome
  /// ancestry required). Tests inject a temp rendezvous path and relax the
  /// ancestor check via the pipe server's Options.
  explicit BrowserControl(BrowserBridgePipeServer::Options options = {})
      : pipe_(std::move(options)) {}

  BrowserControl(const BrowserControl &) = delete;
  BrowserControl &operator=(const BrowserControl &) = delete;

  /// Start the pipe server (create the hardened pipe + publish the rendezvous
  /// record). Returns false with @p error set on failure; the MCP server then
  /// runs with browser control degraded (browser_* calls report "unavailable")
  /// while its other tools keep working.
  [[nodiscard]] bool start(QString *error);
  void stop();

  /// The browser tool definitions to merge into `tools/list`.
  [[nodiscard]] static QJsonArray toolCatalog();

  /// True iff @p name is one of the browser_* tools this facade owns.
  [[nodiscard]] static bool handles(const QString &name);

  /// True while a verified relay is connected (a browser is reachable).
  [[nodiscard]] bool clientConnected() const { return pipe_.clientConnected(); }

  /// Record the MCP client's `clientInfo.name` from `initialize`. It rides on
  /// every command frame as `client` (sanitized by the session), which the
  /// extension uses to title the tab group marking this session's tabs.
  void setClientName(const QString &name) { session_.setClientName(name); }
  [[nodiscard]] const QString &clientName() const {
    return session_.clientName();
  }

  /// Override kRelayAttachWait. Production never calls this; a test that
  /// expects a refusal shortens it so the refusal does not cost the full wait,
  /// and a test that attaches a relay mid-wait can bound how long it gives it.
  void setRelayAttachWait(std::chrono::milliseconds wait) {
    relay_attach_wait_ = wait;
  }

  /// Execute one browser tool call end-to-end and return the MCP text result.
  /// Any refusal (not connected / busy / stale ref / bad args) or transport
  /// failure comes back as an is_error ToolResult the model can read, never a
  /// throw.
  [[nodiscard]] ToolResult invoke(const QString &name,
                                  const QJsonObject &arguments);

  /// The version notice of every connection not yet told, the first time it
  /// is asked for after that connection was made, and empty every other time
  /// -- so each connection (each Chrome profile) tells its agent once, on
  /// whichever browser call comes first, naming the profile when there are
  /// several, and a connection whose versions agree never does.
  [[nodiscard]] QString takeVersionNotice();

  /// The running versions as browser_extension_status reports them: whether
  /// an extension is connected and how many connections there have been, this
  /// server's version, the newest connection's extension and installed
  /// versions (null when not said), its notice (empty when they agree), and
  /// under `profiles` every connected Chrome profile with its name, email,
  /// versions and notice. Read from the connections as they are now.
  [[nodiscard]] QJsonObject connectionVersions() const;

private:
  using Clock = std::chrono::steady_clock;

  /// invoke() without the error-text guidance it appends.
  [[nodiscard]] ToolResult dispatch(const QString &name,
                                    const QJsonObject &arguments);

  /// True when no relay is attached but one plausibly is about to be: see
  /// kRelayAttachGrace.
  [[nodiscard]] bool relayPlausiblyAttaching() const;

  /// Wait up to relay_attach_wait_ for a relay to attach.
  void awaitAttachingRelay() const;

  /// What this side knows of one connection -- one Chrome profile -- beyond
  /// what the pipe reports: its current name and email (the hello's, then the
  /// latest any reply said), and whether its version notice is still to be
  /// told.
  struct Known {
    BridgeConnectionInfo info;
    QString name;
    QString email;
    bool notice_due{true};
  };

  /// Reconcile with the pipe's connections: new ones are recorded, and a
  /// departed one takes the refs and routing of its own tabs with it -- and of
  /// any tab no remaining connection is known to hold. Called on the MCP thread
  /// before each tool call.
  void syncConnections();

  /// The connection a one-command call goes to, or 0 with @p error set.
  [[nodiscard]] quint64 routeOne(const QString &name,
                                 const QJsonObject &arguments, QString *error);
  /// Whether this call goes to every connection and its replies are merged.
  [[nodiscard]] bool fansOut(const QString &name,
                             const QJsonObject &arguments) const;
  /// The connection holding tab @p tab_id, asking each one whose tab it is
  /// when no reply has said; 0 when none has it.
  [[nodiscard]] quint64 ownerOfTab(qint64 tab_id);
  /// The same for a window, by listing each connection's windows.
  [[nodiscard]] quint64 ownerOfWindow(qint64 window_id);
  /// The connection whose profile is named @p profile (a name or an email,
  /// ignoring case), or 0 with @p error listing the names that are connected.
  [[nodiscard]] quint64 connectionForProfile(const QString &profile,
                                             QString *error);
  /// The profile whose window the user last focused: one focused now, else
  /// the most recently focused, else the oldest connection.
  [[nodiscard]] quint64 lastFocusedConnection();
  /// Ask connection @p id which profile it is (profileState); refreshes its
  /// name. Empty when it cannot say (an extension older than profiles).
  [[nodiscard]] QJsonObject askProfile(quint64 id);
  /// The connection a call naming no tab goes to: the agent's current one.
  [[nodiscard]] quint64 currentConnection();
  /// A connection's name as agents see it.
  [[nodiscard]] QString profileName(quint64 id) const;
  /// Record which connection holds the tabs and windows a reply mentions,
  /// and any newer profile name it carries.
  void learnFromReply(quint64 id, const QJsonObject &reply);
  /// Run @p name on every connection and merge the replies, each entry naming
  /// its profile; a connection that fails is named in the result.
  [[nodiscard]] ToolResult fanOut(const QString &name,
                                  const QJsonObject &arguments);

  /// One command round trip on an already-synced session, to connection @p id:
  /// send the frame and feed the reply back in, learning what it says about
  /// tabs, windows and the profile. Shared by every path, including the
  /// upload, which is several commands for one tool call.
  [[nodiscard]] ToolResult
  exchange(quint64 id, const browser::BrowserBridgeSession::Outgoing &outgoing,
           QJsonObject *reply_payload = nullptr);

  /// A tool call that carries files -- browser_upload, and browser_clipboard
  /// writing files: read the named files here, send their bytes as bridge-
  /// sized chunks, then the tool's own command naming them. It is several
  /// round trips because Chrome accepts at most 1 MiB in one message from a
  /// native host, and a file is usually larger than the rest of a session's
  /// traffic put together.
  [[nodiscard]] ToolResult invokeWithFiles(quint64 id, const QString &name,
                                           const QJsonObject &arguments);

  BrowserBridgePipeServer pipe_;
  browser::BrowserBridgeSession session_;
  /// Every connection this side has accounted for, by id, and which of them
  /// holds each tab and window a reply has named.
  std::map<quint64, Known> known_;
  QHash<qint64, quint64> tab_owner_;
  QHash<qint64, quint64> window_owner_;
  /// The connection the agent's last routed call went to: where a call naming
  /// no tab goes, since that is where its current tab is.
  quint64 current_connection_{0};
  /// The connection the call now being made went to, for the guidance an
  /// unknown command from an older extension gets.
  quint64 last_route_{0};
  /// Distinguishes one call's files from another's in the extension's buffer.
  quint64 upload_counter_{0};
  bool started_{false};
  /// When this server last published its rendezvous record (start()), and
  /// when a tool call last found a relay attached. The relay can drop between
  /// calls without this side hearing of it, so the second is an upper bound
  /// on how long ago the connection was lost -- which errs toward NOT waiting
  /// when it cannot tell.
  std::optional<Clock::time_point> published_at_;
  std::optional<Clock::time_point> last_connected_at_;
  std::chrono::milliseconds relay_attach_wait_{kRelayAttachWait};
};

} // namespace chrome_control_mcp
