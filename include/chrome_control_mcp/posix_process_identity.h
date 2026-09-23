// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QString>

#include <sys/types.h>

/// @file posix_process_identity.h
/// @brief Who is on the other end of a POSIX socket, and what program is it.
///
/// The bridge pipe server and the relay both answer the same two questions --
/// which process opened this socket, and is that process running our own
/// executable -- and both answers are spelled differently on Linux and macOS.
/// They lived twice, once per unit, in copies that had to be kept identical by
/// hand. There is no Windows counterpart: the equivalent calls there take a
/// pipe handle rather than a descriptor and return different things, so the two
/// platforms share the callers, not the implementation.
namespace chrome_control_mcp {

/// Credentials of the process on the other end of a connected AF_UNIX socket.
/// A default-constructed value (pid -1) means the peer could not be identified,
/// which every caller treats as a refusal rather than as permission.
struct PeerIdentity {
  pid_t pid{-1};
  uid_t uid{static_cast<uid_t>(-1)};
};

/// The executable image @p pid is running, or an empty string when it cannot be
/// read -- because the process is gone, or because this platform offers no way
/// to ask.
[[nodiscard]] QString processImage(pid_t pid);

/// The credentials of @p socket_fd's peer, or a default PeerIdentity when the
/// kernel will not name them.
[[nodiscard]] PeerIdentity peerIdentity(int socket_fd);

/// Whether @p pid is running the same executable image as this process.
/// An unreadable image on either side is false: a peer that cannot be
/// identified is never treated as one of ours.
[[nodiscard]] bool isOwnExecutable(pid_t pid);

} // namespace chrome_control_mcp
