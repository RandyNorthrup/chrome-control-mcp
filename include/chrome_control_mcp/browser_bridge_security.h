// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QString>

#ifdef Q_OS_WIN
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

/// @file browser_bridge_security.h
/// @brief Security + discovery primitives for the browser-control bridge pipe.
///
/// The bridge pipe carries LLM-driven browser commands and web-page-derived
/// replies between the long-lived MCP process (server) and the Chrome-spawned
/// relay (client). The design panels made the pipe DACL the load-bearing
/// control, so these are kept in one small, separately-reviewed unit. Unlike
/// the app's elevated-helper pipe (which grants BUILTIN\Users and sets no
/// integrity label), the bridge pipe is scoped to the CURRENT USER's SID only
/// and floored at Medium integrity, so a lower-integrity process (a compromised
/// browser renderer -- the real injection-to-local-escalation vector) cannot
/// open it.
///
/// Honest boundary: a same-user, same-integrity process is INSIDE this boundary
/// (it can read the rendezvous record, OpenProcess our processes, or drive
/// Chrome's own debugging directly). These primitives enforce the OS boundaries
/// that DO exist (other users, other sessions, lower integrity, remote) and
/// fail closed on squatting; the real control against a hostile page is the
/// downstream confirmation gate, not this pipe.
namespace chrome_control_mcp {

/// The rendezvous record the server publishes and the relay reads to find +
/// greet the server (the Chrome-launched relay cannot receive the pipe name on
/// argv).
struct RendezvousRecord {
  QString pipe_name;
  QString token;
  int protocol{0};
  qint64 app_pid{0};
};

/// Current process user identity. Windows returns its SID; POSIX returns its
/// numeric effective uid. Empty on failure with @p error set.
[[nodiscard]] QString currentUserSidString(QString *error = nullptr);

/// A fresh, unguessable local IPC endpoint. Windows uses a session-scoped named
/// pipe; Linux and macOS use a Unix-domain socket inside a private runtime
/// directory. Empty on failure with @p error set.
[[nodiscard]] QString browserBridgePipeName(QString *error = nullptr);

/// A cryptographically-random 128-bit hex token for the rendezvous handshake.
/// Layered defense only: any same-user process can read the record, so this is
/// not a security boundary -- the DACL and peer code-identity checks are.
[[nodiscard]] QString generateBridgeToken();

/// Absolute path of the rendezvous record file under the user's local app data.
[[nodiscard]] QString browserBridgeRendezvousPath();

/// Write / read the rendezvous record as JSON at @p path. The file-I/O core is
/// split out (path-parameterized) so it is unit-testable without touching the
/// real per-user location.
[[nodiscard]] bool writeRendezvousRecord(const QString &path,
                                         const RendezvousRecord &record,
                                         QString *error = nullptr);
[[nodiscard]] bool readRendezvousRecord(const QString &path,
                                        RendezvousRecord *out,
                                        QString *error = nullptr);

#ifdef Q_OS_WIN
/// Build hardened SECURITY_ATTRIBUTES for the Windows bridge pipe. The DACL is
/// PROTECTED (no inherited ACEs) and grants GENERIC_ALL to the current user SID
/// and local SYSTEM only -- no BUILTIN\Users, no Everyone, no NETWORK -- plus a
/// Medium mandatory-integrity label with NO_READ_UP | NO_WRITE_UP, so a
/// below-Medium process cannot open the pipe for read or write. On success @p
/// descriptor receives the security descriptor, which the caller MUST LocalFree
/// after CreateNamedPipe returns.
[[nodiscard]] bool buildBridgePipeSecurity(SECURITY_ATTRIBUTES *attributes,
                                           PSECURITY_DESCRIPTOR *descriptor,
                                           QString *error = nullptr);
#endif

} // namespace chrome_control_mcp
