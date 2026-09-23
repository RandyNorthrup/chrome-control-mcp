// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
#pragma once

#include <QString>
#include <QStringList>

/// @file install_layout.h
/// @brief The on-disk shape of a managed install, and the link swap that makes
/// updating one safe while it is running.
///
/// A running executable cannot be overwritten on Windows, and its Qt runtime
/// cannot be either. Rather than fight that lock, a managed install never
/// overwrites anything: every version lands in its own directory and a single
/// link is repointed at the one that should run next.
///
/// @verbatim
/// <root>/
///   current/            link -> versions/<active>
///   versions/
///     1.3.1/            chrome_control_mcp[.exe], Qt runtime, extension/
///     1.3.2/
/// @endverbatim
///
/// Everything that names this install from the outside -- the MCP client's
/// command, Chrome's unpacked-extension folder, and the native-messaging
/// registration -- names a path under `current/`, so none of them has to change
/// when a new version is installed. That is the whole point of the layout: an
/// update must not invalidate a registration the user cannot re-do without
/// clicking through Chrome again.
namespace chrome_control_mcp {

/// Directory name of the stable link every external registration points into.
inline constexpr char kInstallCurrentDirectoryName[] = "current";
/// Directory name holding one directory per installed version.
inline constexpr char kInstallVersionsDirectoryName[] = "versions";
/// Overrides the install root, so tests operate on a temporary tree and a user
/// can relocate an install without rebuilding.
inline constexpr char kInstallRootEnvironmentVariable[] =
    "CHROME_CONTROL_MCP_INSTALL_ROOT";

/// Resolved directories of one managed install. Paths are absolute and cleaned;
/// they are computed, not probed, so a layout for a tree that does not exist
/// yet is still well-formed.
struct InstallLayout {
  QString root;
  QString current;
  QString versions;

  /// The layout rooted at @p root. An empty @p root yields empty members rather
  /// than a layout rooted at the filesystem root.
  [[nodiscard]] static InstallLayout forRoot(const QString &root);

  /// The layout this process would manage: the root named by
  /// kInstallRootEnvironmentVariable, else the root inferred from the running
  /// executable when it already sits in a managed install, else the per-user
  /// default.
  [[nodiscard]] static InstallLayout resolved(const QString &executable_path);

  /// Directory a specific version occupies. Empty when @p version is empty or
  /// is not a plain directory name -- a version string is never allowed to
  /// escape the versions directory.
  [[nodiscard]] QString versionDirectory(const QString &version) const;

  [[nodiscard]] bool isEmpty() const { return root.isEmpty(); }
};

/// The per-user install root used when nothing overrides it.
///
/// Windows follows the per-user application convention
/// (`%LOCALAPPDATA%\Programs\ChromeControlMCP`); Linux and macOS place the
/// install under their generic data location beside the data this program
/// already writes. None of them needs administrator rights, which keeps
/// updating a user-level operation.
[[nodiscard]] QString defaultInstallRoot();

/// Whether @p name is usable as a version directory name: a non-empty string of
/// digits, dots, dashes, and ASCII alphanumerics only. Rejects `.`, `..`, and
/// anything carrying a separator, so a version taken from a remote release can
/// never be joined into a path outside the versions directory. Pure.
[[nodiscard]] bool isSafeVersionName(const QString &name);

/// The install root that @p executable_path belongs to, or an empty string when
/// it is not inside a managed install. Recognizes both a process launched
/// through `current/` and one launched from `versions/<version>/`, because the
/// second is what the operating system reports once a link has been resolved.
/// Pure: it inspects the path, not the filesystem.
[[nodiscard]] QString installRootForExecutable(const QString &executable_path);

/// The path under `current/` that names @p executable_path, for an executable
/// inside a managed install; @p executable_path unchanged otherwise.
///
/// The operating system can report the running image by its resolved location
/// (`versions/1.3.1/chrome_control_mcp.exe`) rather than the link the user
/// launched. Registering that resolved path would pin the registration to one
/// version and break it on the next update, so every registration is written
/// through this. Pure.
[[nodiscard]] QString stableExecutablePath(const QString &executable_path);

/// The server executable's file name on this platform.
[[nodiscard]] QString installedExecutableName();

/// The two paths every registration outside this program names: the server to
/// launch, and the folder Chrome loads. Both resolve through `current`, which
/// is what keeps them correct across an update, and both are spelled here once
/// so no caller can spell them differently.
[[nodiscard]] QString currentExecutable(const InstallLayout &layout);
[[nodiscard]] QString currentExtensionDirectory(const InstallLayout &layout);

/// Installed version directory names, sorted newest first by version-number
/// order rather than lexically, so 1.10.0 sorts above 1.9.0. Missing versions
/// directory yields an empty list.
[[nodiscard]] QStringList installedVersions(const InstallLayout &layout);

/// Where `current` currently points, as an absolute cleaned path, or an empty
/// string when it is absent or is not a link.
[[nodiscard]] QString currentLinkTarget(const InstallLayout &layout);

/// The installed version `current` resolves to, or an empty string.
[[nodiscard]] QString currentVersion(const InstallLayout &layout);

/// Point `current` at `versions/<version>`, replacing any existing link.
///
/// POSIX swaps atomically by renaming a freshly created link over the old one.
/// Windows has no atomic directory replace, so the junction is removed and
/// recreated; a process that resolves `current/` inside that window sees it
/// missing. Nothing in this program holds the link open -- an already-running
/// server keeps its own open file handles regardless -- so the window affects
/// only a launch racing the swap, and the caller reports the new version as
/// taking effect on the next start either way.
///
/// @param error receives a human-readable reason on failure when non-null.
[[nodiscard]] bool pointCurrentAtVersion(const InstallLayout &layout,
                                         const QString &version,
                                         QString *error);

/// Remove installed versions other than @p keep_version, keeping the
/// @p keep_recent most recent of the rest. Returns the number removed.
///
/// A version whose files are still locked by a running process is left alone
/// and not counted: pruning is housekeeping, and failing an update because an
/// old copy is busy would be the very failure this layout exists to avoid.
int pruneInstalledVersions(const InstallLayout &layout,
                           const QString &keep_version, int keep_recent);

} // namespace chrome_control_mcp
