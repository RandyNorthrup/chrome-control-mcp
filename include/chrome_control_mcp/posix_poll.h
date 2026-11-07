// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <poll.h>

/// @file posix_poll.h
/// @brief Reading what poll() reported, without signed bit arithmetic.
///
/// `pollfd::revents` is a `short` and the POLL* constants are `int`s, so
/// testing one against the other directly is bitwise arithmetic on signed
/// values. The bridge pipe server and the relay both read poll() results; they
/// test the bits here, as unsigned values.
namespace chrome_control_mcp {

/// Whether poll() reported any of the events in @p mask.
inline bool pollReported(short revents, int mask) {
  return (static_cast<unsigned int>(static_cast<unsigned short>(revents)) &
          static_cast<unsigned int>(mask)) != 0U;
}

/// Whether poll() reported the descriptor finished: an error, a hang-up, or a
/// descriptor that is not open.
inline bool pollReportedEnd(short revents) {
  return pollReported(revents, POLLERR) || pollReported(revents, POLLHUP) ||
         pollReported(revents, POLLNVAL);
}

} // namespace chrome_control_mcp
