// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QString>

/// @file error_out.h
/// @brief One spelling of "report a reason through an optional out parameter".
///
/// The bridge server, the relay, and the rendezvous record all hand a failure
/// reason back through a `QString *error` the caller may leave null, and each
/// had its own byte-identical copy of the null check. One definition means a
/// change to the convention -- or a bug in it -- has one place to live.
namespace chrome_control_mcp {

/// Assign @p message to @p error when the caller asked for a reason.
inline void setError(QString *error, const QString &message) {
  if (error != nullptr) {
    *error = message;
  }
}

} // namespace chrome_control_mcp
