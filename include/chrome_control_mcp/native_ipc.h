// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QtGlobal>

#ifdef Q_OS_WIN
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace chrome_control_mcp {

#ifdef Q_OS_WIN
using NativeIpcHandle = HANDLE;
inline const NativeIpcHandle kInvalidNativeIpcHandle = INVALID_HANDLE_VALUE;

inline void closeNativeIpcHandle(NativeIpcHandle handle) {
  if (handle != kInvalidNativeIpcHandle) {
    CloseHandle(handle);
  }
}
#else
using NativeIpcHandle = int;
inline constexpr NativeIpcHandle kInvalidNativeIpcHandle = -1;

inline void closeNativeIpcHandle(NativeIpcHandle handle) {
  if (handle != kInvalidNativeIpcHandle) {
    ::close(handle);
  }
}
#endif

[[nodiscard]] inline bool nativeIpcHandleIsValid(NativeIpcHandle handle) {
  return handle != kInvalidNativeIpcHandle;
}

} // namespace chrome_control_mcp
