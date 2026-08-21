// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QJsonObject>
#include <QString>

/// @file native_host.h
/// @brief Native-messaging host protocol helpers for the MCP executable.
///
/// When the same executable is launched by Chrome as a native messaging host
/// (the Chrome-passed `chrome-extension://<id>/` origin argument selects this
/// mode, or the explicit `--native-host` flag for testing) it runs a
/// length-prefixed stdio loop instead of the MCP JSON-RPC loop, bridging the
/// Chrome Control MCP browser-control extension to the assistant. This unit is
/// the scaffold + handshake: it answers a `ping` with server identity so the
/// extension can confirm the host is alive. The message dispatcher is split out
/// as a pure function so it is unit-testable with no process I/O.
namespace chrome_control_mcp {

/// Handle one decoded native-messaging request and produce the reply object.
/// Pure: no stdio, no globals. A `ping` yields a `pong` carrying the server
/// name, version, protocol, and pid; any other type yields a typed error the
/// extension can log and recover from. A present `id` is echoed back for
/// correlation.
[[nodiscard]] QJsonObject handleNativeMessage(const QJsonObject &request,
                                              const QString &server_name,
                                              const QString &server_version);

} // namespace chrome_control_mcp
