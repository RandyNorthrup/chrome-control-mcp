// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/windows_process_identity.h"

#include <QFileInfo>

#include <windows.h>

namespace chrome_control_mcp {
namespace {

// Room for a long image path: twice MAX_PATH wide characters.
constexpr DWORD kImagePathBufferChars = MAX_PATH * 2;

// One implementation for both questions. GetCurrentProcess() answers about us
// and a real handle answers about a peer, through the SAME call -- which is the
// whole point: two different calls gave two different names for one file.
QString imageOfProcess(HANDLE process) {
  wchar_t buffer[kImagePathBufferChars] = {0};
  DWORD size = kImagePathBufferChars;
  if (QueryFullProcessImageNameW(process, 0, buffer, &size) == FALSE) {
    return {};
  }
  // canonicalFilePath() resolves the reparse point a managed install is
  // reached through, and returns empty for a path that no longer names a file
  // -- which callers already treat as "could not identify", the safe answer.
  return QFileInfo(QString::fromWCharArray(buffer, static_cast<int>(size)))
      .canonicalFilePath();
}

} // namespace

QString processImage(quint32 pid) {
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                     static_cast<DWORD>(pid));
  if (process == nullptr) {
    return {};
  }
  const QString image = imageOfProcess(process);
  CloseHandle(process);
  return image;
}

QString ownProcessImage() {
  // A pseudo-handle: it is not a resource and must not be closed.
  return imageOfProcess(GetCurrentProcess());
}

bool isOwnExecutable(quint32 pid) {
  const QString peer = processImage(pid);
  const QString own = ownProcessImage();
  // Windows paths are case-insensitive, and the two sides can be spelled with
  // different case even after canonicalization.
  return !peer.isEmpty() && !own.isEmpty() &&
         peer.compare(own, Qt::CaseInsensitive) == 0;
}

} // namespace chrome_control_mcp
