// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_control.h"

#include "chrome_control_mcp/browser_contract.h"

namespace chrome_control_mcp {

bool BrowserControl::start(QString *error) {
  started_ = pipe_.start(error);
  return started_;
}

void BrowserControl::stop() {
  pipe_.stop();
  started_ = false;
}

QJsonArray BrowserControl::toolCatalog() {
  return browser::browserToolCatalog();
}

bool BrowserControl::handles(const QString &name) {
  // The browser_* tools drive the live extension through the bridge. The
  // browser_extension_* tools are native installer tools (they set Chrome up)
  // and must NOT be routed here -- they are served by invokeTool, and routing
  // them to the bridge would fail with "browser not connected" before Chrome is
  // even set up.
  return name.startsWith(QStringLiteral("browser_")) &&
         !name.startsWith(QStringLiteral("browser_extension_"));
}

// Reconcile the single-threaded session with the pipe server's async connection
// state. The server bumps its generation on every newly verified relay;
// observing a new generation means a fresh browser session (the old ref_index
// is dead), and losing the connection means no browser is reachable. Called on
// the MCP thread immediately before each tool call, so the session never acts
// on a connection it has not accounted for.
void BrowserControl::syncSessionToConnection() {
  const bool connected = pipe_.clientConnected();
  const quint64 generation = pipe_.connectionGeneration();
  if (connected && generation != observed_generation_) {
    session_.onHostConnected();
    observed_generation_ = generation;
  } else if (!connected && session_.connected()) {
    session_.onHostDisconnected();
  }
}

ToolResult BrowserControl::invoke(const QString &name,
                                  const QJsonObject &arguments) {
  // A server that stood down at launch (another instance owned the bridge at
  // that instant) tries again on demand: the owner may have been a short-lived
  // tool listing that has long since exited, and a browser tool call is the
  // moment the bridge is wanted.
  if (!started_) {
    QString why;
    if (!start(&why)) {
      return {.text = QStringLiteral("Browser control is unavailable: %1")
                          .arg(why.isEmpty()
                                   ? QStringLiteral(
                                         "the bridge pipe failed to start.")
                                   : why),
              .is_error = true,
              .image_base64 = {},
              .image_mime = {}};
    }
  }
  // No relay yet: make sure the extension can still find this server. The
  // rendezvous record can be lost to a concurrent short-lived instance that
  // wrote it last and removed it on exit; re-publishing it here means the
  // extension's next reconnect lands on this session without a restart.
  if (!pipe_.clientConnected()) {
    QString why;
    if (!pipe_.ensurePublished(&why)) {
      return {.text = QStringLiteral("Browser not connected: %1").arg(why),
              .is_error = true,
              .image_base64 = {},
              .image_mime = {}};
    }
  }
  syncSessionToConnection();
  const browser::BrowserBridgeSession::Outgoing outgoing =
      session_.beginCommand(name, arguments);
  if (!outgoing.ok) {
    return {.text = outgoing.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  const BrowserBridgePipeServer::Exchange exchange =
      pipe_.sendCommandAwaitReply(outgoing.frame);
  if (!exchange.ok) {
    // The transport failed (no relay, or a deadline/reset). Retire the
    // outstanding op so a late-arriving reply for it can never be mis-paired to
    // the next call.
    session_.retireOutstanding();
    return {.text = exchange.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  const browser::BrowserBridgeSession::Incoming incoming =
      session_.onReply(exchange.reply);
  if (!incoming.matched) {
    return {.text = QStringLiteral(
                "The browser reply did not correlate to the request."),
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  if (incoming.is_error) {
    return {.text = incoming.error,
            .is_error = true,
            .image_base64 = {},
            .image_mime = {}};
  }
  return {.text = incoming.text,
          .is_error = false,
          .image_base64 = incoming.image_base64,
          .image_mime = incoming.image_mime};
}

} // namespace chrome_control_mcp
