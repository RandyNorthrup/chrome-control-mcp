// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include <QString>

#include <QtGlobal>

/// @file windows_process_identity.h
/// @brief What program a Windows process is running, and whether it is ours.
///
/// The Windows counterpart of posix_process_identity.h. The bridge pipe server
/// and the relay both ask the same question -- does the process on the other
/// end run our own executable -- and both used to answer it with their own copy
/// of the same two calls.
///
/// Those copies disagreed, which is why this file exists. Asking a process for
/// its image path FROM INSIDE IT (GetModuleFileNameW(nullptr)) returns the path
/// it was LAUNCHED through; asking about it FROM OUTSIDE
/// (QueryFullProcessImageNameW) returns the path the filesystem resolves that
/// to. A managed install is launched through the `current` junction, so one
/// binary answered `...\current\chrome_control_mcp.exe` about itself and
/// `...\versions\1.5.0\chrome_control_mcp.exe` about its peer -- the same file,
/// two names. Each side then refused the other as a foreign image and the
/// bridge never attached.
///
/// Both answers here come from the same call and are canonicalized, so a
/// junction, a short (8.3) component or a difference in case cannot make one
/// file look like two.
namespace chrome_control_mcp {

/// The executable image @p pid is running, canonicalized, or an empty string
/// when it cannot be read -- because the process is gone, or because this
/// process may not query it.
[[nodiscard]] QString processImage(quint32 pid);

/// This process's own executable image, canonicalized, or an empty string.
/// Asked the same way as processImage() rather than through
/// GetModuleFileNameW, so the path a junction was entered by cannot differ from
/// the path it resolves to.
[[nodiscard]] QString ownProcessImage();

/// Whether @p pid is running the same executable image as this process.
/// An unreadable image on either side is false: a peer that cannot be
/// identified is never treated as one of ours.
[[nodiscard]] bool isOwnExecutable(quint32 pid);

} // namespace chrome_control_mcp
