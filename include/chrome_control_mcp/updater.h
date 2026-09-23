// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
#pragma once

#include "chrome_control_mcp/install_layout.h"

#include <QString>
#include <QUrl>

/// @file updater.h
/// @brief Checking for, fetching, and installing a newer release of this
/// program without overwriting the copy that is running.
///
/// The update never writes into the directory the running executable occupies.
/// It stages a verified copy of the new release into its own version directory
/// and repoints the stable link (see install_layout.h), so no file the
/// operating system has locked is touched. The new version takes effect the
/// next time the MCP client starts the server; nothing here tries to restart a
/// process the client owns.
///
/// Integrity boundary: the archive is checked against the SHA-256 published
/// beside it in the same GitHub release. That detects a truncated or corrupted
/// download and a mismatch between the two assets. It is not a signature -- the
/// checksum and the archive come from the same origin over the same transport,
/// so it proves transport integrity, not authorship. This project ships no
/// signing key and this function does not pretend otherwise.
namespace chrome_control_mcp {

/// Where release metadata and assets are fetched from. The defaults name this
/// project; tests point them at a local server so no test reaches the network.
struct UpdaterConfig {
  QString api_base_url;    // default https://api.github.com
  QString repository;      // default RandyNorthrup/chrome-control-mcp
  QString current_version; // default the compiled-in server version
  QString executable_path; // default the running executable
  InstallLayout layout;    // default resolved from executable_path
  int timeout_ms{60000};
  int keep_recent_versions{1};

  /// Fill every empty field with its production default.
  [[nodiscard]] static UpdaterConfig withDefaults(UpdaterConfig config);
};

/// One release as the update path needs to see it.
struct ReleaseInfo {
  QString tag;        // v1.3.2
  QString version;    // 1.3.2
  QString asset_name; // chrome-control-mcp-v1.3.2-windows-x64.zip
  QUrl asset_url;
  QUrl checksums_url;
  QString notes_url;
  [[nodiscard]] bool isEmpty() const { return version.isEmpty(); }
};

/// Result of asking which release is newest.
struct UpdateCheckResult {
  bool ok{false};
  QString error;
  QString current_version;
  QString latest_version;
  bool update_available{false};
  QString notes_url;
  QString install_root;
  bool managed_install{false};
};

/// Result of installing a release.
struct UpdateApplyResult {
  bool ok{false};
  QString error;
  QString previous_version;
  QString installed_version;
  QString executable_path; // the stable path, unchanged by the update
  QString extension_path;  // the stable unpacked-extension folder
  bool restart_required{false};
  int pruned_versions{0};
  // True when the running copy was moved into the managed layout by this call
  // rather than an newer release being fetched. The client's command path has
  // to be repointed once when this happens, and never again.
  bool adopted{false};
  QString adopted_from;
};

/// The release-asset base name this build needs, for @p version: the operating
/// system and CPU this binary was compiled for, and the archive format that
/// platform is packaged in. Pure, so packaging and the updater can be proven to
/// agree without downloading anything.
[[nodiscard]] QString releaseAssetName(const QString &version);

/// The SHA-256 recorded for @p asset_name in the text of a SHA256SUMS file, or
/// an empty string when the file does not list it. Accepts the two spellings
/// sha256sum writes (`hash  name` and `hash *name`). Pure.
[[nodiscard]] QString checksumForAsset(const QString &sums_text,
                                       const QString &asset_name);

/// Whether @p candidate is a strictly newer release than @p current, compared
/// as version numbers so 1.10.0 beats 1.9.0. A version that cannot be parsed
/// never counts as newer: an update must not be triggered by a string nobody
/// can order. Pure.
[[nodiscard]] bool isNewerVersion(const QString &candidate,
                                  const QString &current);

/// Ask the release host which version is newest. Performs one HTTPS request.
[[nodiscard]] UpdateCheckResult checkForUpdate(const UpdaterConfig &config);

/// Download, verify, and install the newest release, then point the stable link
/// at it. A no-op returning ok with restart_required false when the newest
/// release is already installed.
[[nodiscard]] UpdateApplyResult applyUpdate(const UpdaterConfig &config);

/// Copy the running copy of this program into the managed layout and point the
/// stable link at it, so a build that was launched from a download folder, a
/// build tree, or an unpacked archive gains a path that updates in place.
///
/// This is the one step that changes the path an MCP client names, and it
/// happens once. Afterwards the client, Chrome, and the native-messaging
/// registration all point through the stable link, and no later update moves
/// them again. Copying is safe while the copy is running: reading an executable
/// is allowed on every platform this ships to, and nothing in the source
/// directory is written or deleted.
[[nodiscard]] UpdateApplyResult
adoptRunningInstall(const UpdaterConfig &config);

/// Install an already-downloaded, already-verified release directory as
/// @p version and point the stable link at it. Exposed because it is the whole
/// lock-sensitive half of an update and is worth testing without a network.
///
/// @param staged_directory a directory holding the new release's files; it is
///        moved, not copied, so it must sit on the same volume as the install.
[[nodiscard]] UpdateApplyResult
installStagedRelease(const UpdaterConfig &config, const QString &version,
                     const QString &staged_directory);

} // namespace chrome_control_mcp
