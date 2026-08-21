// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
#pragma once

#include <QString>

namespace chrome_control_mcp {

// The public manifest key in browser/extension/manifest.json deterministically pins this id.
// It is public identity material, not a private signing key.
inline constexpr char kBrowserExtensionId[] = "iojehhmnaigcejfcpmilpclmeljhlkaa";
inline constexpr char kBrowserExtensionVersion[] = "1.0.0";
inline constexpr char kBrowserExtensionDirectoryName[] = "extension";
inline constexpr char kNativeHostName[] = "com.chromecontrolmcp.browser";

enum class ExtensionInstallState {
    NotPrepared,
    Prepared,
    Partial,
    Error,
};

// Paths are injectable so tests use temporary files and isolated HKCU keys. Empty fields are
// resolved to production defaults by the constructor.
struct ExtensionInstallConfig {
    QString extension_path;       // unpacked extension directory; default <appDir>/extension
    QString data_dir;             // generated host manifest; default %LOCALAPPDATA%\ChromeControlMCP
    QString host_exe_path;        // native host executable; default current executable
    QString native_host_key_path; // HKCU subkey; default Chrome NativeMessagingHosts\<host>
};

struct ExtensionInstallResult {
    bool ok = false;
    QString summary;
    QString detail;
};

// Prepares the native side of an unpacked Chrome extension without a package, private key,
// enterprise policy, or administrator access. Chrome requires the user to load the returned
// directory once from chrome://extensions.
class BrowserExtensionInstaller {
public:
    explicit BrowserExtensionInstaller(ExtensionInstallConfig config = {});

    ExtensionInstallResult install();
    ExtensionInstallResult uninstall() const;

    ExtensionInstallState state() const;
    QString stateString() const;
    bool extensionPresent() const;

    const ExtensionInstallConfig& config() const { return config_; }

private:
    ExtensionInstallConfig config_;
};

}  // namespace chrome_control_mcp
