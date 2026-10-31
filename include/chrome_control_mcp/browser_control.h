// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/browser_bridge.h"
#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/mcp_tools.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

#include <chrono>
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

  void syncSessionToConnection();

  /// One command round trip on an already-synced session: send @p frame and
  /// feed the reply back in. Shared by the ordinary single-command path and by
  /// the upload, which is several commands for one tool call.
  [[nodiscard]] ToolResult
  exchange(const browser::BrowserBridgeSession::Outgoing &outgoing);

  /// browser_upload: read the named files here, send their bytes as bridge-
  /// sized chunks, then the command that assigns them to the element. It is
  /// several round trips because Chrome accepts at most 1 MiB in one message
  /// from a native host, and a file is usually larger than the rest of a
  /// session's traffic put together.
  [[nodiscard]] ToolResult invokeUpload(const QJsonObject &arguments);

  BrowserBridgePipeServer pipe_;
  browser::BrowserBridgeSession session_;
  quint64 observed_generation_{0};
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
