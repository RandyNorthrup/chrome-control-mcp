// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QString>
#include <QStringList>

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

/// Names another directory for the bridge's rendezvous record (and, off
/// Windows, its socket). A server and the relay of a browser started with the
/// same value pair with each other and with nothing else -- a dedicated browser
/// beside the user's own, each with its own bridge.
inline constexpr char kBrowserBridgeRuntimeDirVariable[] =
    "CHROME_CONTROL_MCP_RUNTIME_DIR";

/// Absolute path of THIS process's rendezvous record: in the directory
/// kBrowserBridgeRuntimeDirVariable names when it is set, else under the
/// user's local app data. Empty on failure with @p error set.
///
/// The file carries the publishing pid in its name --
/// `browser_bridge-<pid>.json`
/// -- so several servers can advertise at once without overwriting each other.
/// The identity is in the name rather than in a subdirectory because the same
/// directory holds the POSIX socket, whose path has to fit `sockaddr_un`, and a
/// nesting level spends that budget for nothing.
[[nodiscard]] QString browserBridgeRendezvousPath(QString *error = nullptr);

/// Absolute paths of every rendezvous record present, most recently published
/// first. Empty when the directory holds none, or on failure with @p error set
/// -- callers distinguish the two by whether @p error was written.
///
/// This is a listing of files, not of live servers: a record naming a process
/// that has exited looks exactly like one naming a running server here.
/// Deciding which is which needs the pid-to-image check that lives with the
/// bridge server, so the caller does it.
[[nodiscard]] QStringList
browserBridgeRendezvousRecords(QString *error = nullptr);

/// The same listing for one named @p directory, so a caller that already knows
/// where its own record sits looks for its peers beside it rather than in the
/// default location. That is also what lets a test point a server at a
/// temporary directory and have it see only what the test put there.
[[nodiscard]] QStringList
browserBridgeRendezvousRecordsIn(const QString &directory);

/// Write / read the rendezvous record as JSON at @p path. The file-I/O core is
/// split out (path-parameterized) so it is unit-testable without touching the
/// real per-user location.
[[nodiscard]] bool writeRendezvousRecord(const QString &path,
                                         const RendezvousRecord &record,
                                         QString *error = nullptr);
/// The message a relay reports when the process serving the bridge is not this
/// relay's own executable image.
///
/// The check itself is a security check and stays fail-closed, but its
/// commonest cause is mundane: two copies of this same program. Chrome starts
/// whichever executable its native-messaging registration names, and that need
/// not be the copy serving MCP -- a build directory beside an installed one is
/// enough. A message that says only "not the Chrome Control MCP binary" sends
/// the reader hunting for an impostor when what they have is the wrong path in
/// a registration, so both images are named and the fix is stated.
///
/// @p server_image may be empty when the process is gone or unreadable, which
/// is reported as such rather than as a mismatch of paths.
[[nodiscard]] QString bridgeImageMismatchText(const QString &server_image,
                                              qint64 server_pid,
                                              const QString &own_image);

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
