// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
#pragma once

#include <QString>

#include <array>

namespace chrome_control_mcp {

// The public manifest key in browser/extension/manifest.json deterministically
// pins this id. It is public identity material, not a private signing key.
inline constexpr char kBrowserExtensionId[] =
    "iojehhmnaigcejfcpmilpclmeljhlkaa";
// The Chrome Web Store build's id, fixed by the store at the item's first
// upload (2026-11-07). The store signs that build with its own key, whose
// public half (browser/store-public-key.txt) derives this id.
inline constexpr char kStoreExtensionId[] = "mbkacllnbffbadcajpkkpelifdkfgcbd";
// Every extension this server answers to: the unpacked build and the store's.
inline constexpr std::array<const char *, 2> kAcceptedExtensionIds{
    kBrowserExtensionId, kStoreExtensionId};
inline constexpr char kBrowserExtensionVersion[] = "1.14.0";
inline constexpr char kBrowserExtensionDirectoryName[] = "extension";
inline constexpr char kNativeHostName[] = "com.chromecontrolmcp.browser";

enum class ExtensionInstallState {
  NotPrepared,
  Prepared,
  Partial,
  Error,
};

// Paths are injectable so tests use temporary files and isolated HKCU keys.
// Empty fields are resolved to production defaults by the constructor.
struct ExtensionInstallConfig {
  QString extension_path; // unpacked extension directory; default
                          // <appDir>/extension
  QString data_dir;       // generated host manifest; default
                          // %LOCALAPPDATA%\ChromeControlMCP
  QString host_exe_path;  // native host executable; default current executable
  QString native_host_key_path;     // HKCU subkey; default Chrome
                                    // NativeMessagingHosts\<host>
  QString native_host_manifest_dir; // Linux/macOS Chrome NativeMessagingHosts
                                    // directory; ignored on Windows.
};

struct ExtensionInstallResult {
  bool ok = false;
  QString summary;
  QString detail;
};

/// What to add to "the extension is not attached" when the registration is the
/// reason. Empty when @p registered_exe is empty (nothing registered says
/// nothing about a mismatch) or when it already names @p running_exe.
///
/// Needs no registry or manifest, so the wording and the comparison can be
/// tested directly. Paths are compared the way the platform compares them,
/// which on Windows means case-insensitively, after following links: a managed
/// install registers its stable link while the server reports the version it
/// resolves to, and those are one file. A path that does not exist is compared
/// as written.
[[nodiscard]] QString nativeHostRegistrationNote(const QString &registered_exe,
                                                 const QString &running_exe);

// Prepares the native side of an unpacked Chrome extension without a package,
// private key, enterprise policy, or administrator access. Chrome requires the
// user to load the returned directory once from chrome://extensions.
class BrowserExtensionInstaller {
public:
  explicit BrowserExtensionInstaller(ExtensionInstallConfig config = {});

  ExtensionInstallResult install();
  ExtensionInstallResult uninstall() const;

  ExtensionInstallState state() const;
  QString stateString() const;
  bool extensionPresent() const;

  /// The executable Chrome's native-messaging registration currently names for
  /// this user, or an empty string when nothing is registered or the
  /// registration cannot be read. Chrome starts THIS executable when the
  /// extension connects, so when it is not the one serving MCP, the relay it
  /// starts refuses the bridge and no browser tool can work -- a state worth
  /// being able to report rather than leaving as "not attached".
  [[nodiscard]] QString registeredHostExecutable() const;

  /// Rewrites a registration that names this executable but is not current --
  /// one written before the Chrome Web Store build lists only the unpacked
  /// build's origin -- and leaves alone a current one, a missing one, and one
  /// naming another copy of the program. True when it rewrote one. A server
  /// calls it as it starts: an update applied by an older server runs that
  /// server's code, which writes the older registration.
  bool refreshOwnRegistration();

  const ExtensionInstallConfig &config() const { return config_; }

private:
  ExtensionInstallConfig config_;
};

} // namespace chrome_control_mcp
