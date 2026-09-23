// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/mcp_tools.h"

#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/install_layout.h"
#include "chrome_control_mcp/updater.h"

#include <QCoreApplication>
#include <QDir>
#include <QJsonDocument>
#include <QLatin1String>

namespace chrome_control_mcp {
namespace {

constexpr char kServerName[] = "chrome-control-mcp";
// One version number for the whole build: the CMake project version, which
// the updater also compares against published releases.
constexpr char kServerVersion[] = CHROME_CONTROL_MCP_VERSION;

ToolResult jsonResult(const QJsonObject &object) {
  return {.text = QString::fromUtf8(
              QJsonDocument(object).toJson(QJsonDocument::Compact)),
          .is_error = false,
          .image_base64 = {},
          .image_mime = {}};
}

ToolResult errorResult(const QString &message) {
  return {.text = QString::fromUtf8(
              QJsonDocument(QJsonObject{{QStringLiteral("error"), message}})
                  .toJson(QJsonDocument::Compact)),
          .is_error = true,
          .image_base64 = {},
          .image_mime = {}};
}

QString installerError(const ExtensionInstallResult &result) {
  return result.detail.isEmpty()
             ? result.summary
             : result.summary + QStringLiteral(": ") + result.detail;
}

ToolResult installExtension() {
  BrowserExtensionInstaller installer;
  const ExtensionInstallResult result = installer.install();
  if (!result.ok) {
    return errorResult(installerError(result));
  }
  return jsonResult(
      QJsonObject{{QStringLiteral("ok"), true},
                  {QStringLiteral("summary"), result.summary},
                  {QStringLiteral("detail"), result.detail},
                  {QStringLiteral("state"), installer.stateString()}});
}

ToolResult uninstallExtension() {
  const BrowserExtensionInstaller installer;
  const ExtensionInstallResult result = installer.uninstall();
  if (!result.ok) {
    return errorResult(installerError(result));
  }
  return jsonResult(
      QJsonObject{{QStringLiteral("ok"), true},
                  {QStringLiteral("summary"), result.summary},
                  {QStringLiteral("detail"), result.detail},
                  {QStringLiteral("state"), installer.stateString()}});
}

ToolResult extensionStatus() {
  const BrowserExtensionInstaller installer;
  return jsonResult(QJsonObject{
      {QStringLiteral("state"), installer.stateString()},
      {QStringLiteral("extension_present"), installer.extensionPresent()},
      {QStringLiteral("extension_path"), installer.config().extension_path},
      {QStringLiteral("extension_id"),
       QString::fromLatin1(kBrowserExtensionId)}});
}

QJsonArray toJsonArray(const QStringList &values) {
  QJsonArray array;
  for (const QString &value : values) {
    array.append(value);
  }
  return array;
}

// Everything about where this build is installed that a person diagnosing an
// update needs, and nothing that requires the network.
QJsonObject installFacts() {
  const QString executable =
      QDir::cleanPath(QCoreApplication::applicationFilePath());
  const InstallLayout layout = InstallLayout::resolved(executable);
  const bool managed = !installRootForExecutable(executable).isEmpty();
  return QJsonObject{
      {QStringLiteral("version"), QString::fromLatin1(kServerVersion)},
      {QStringLiteral("managed_install"), managed},
      {QStringLiteral("install_root"), QDir::toNativeSeparators(layout.root)},
      {QStringLiteral("running_executable"),
       QDir::toNativeSeparators(executable)},
      {QStringLiteral("stable_executable"),
       QDir::toNativeSeparators(stableExecutablePath(executable))},
      {QStringLiteral("current_points_at"),
       QDir::toNativeSeparators(currentLinkTarget(layout))},
      {QStringLiteral("installed_versions"),
       toJsonArray(installedVersions(layout))}};
}

ToolResult updateStatus() { return jsonResult(installFacts()); }

ToolResult updateCheck() {
  const UpdateCheckResult check = checkForUpdate({});
  if (!check.ok) {
    return errorResult(check.error);
  }
  QJsonObject payload = installFacts();
  payload.insert(QStringLiteral("current_version"), check.current_version);
  payload.insert(QStringLiteral("latest_version"), check.latest_version);
  payload.insert(QStringLiteral("update_available"), check.update_available);
  payload.insert(QStringLiteral("release_notes_url"), check.notes_url);
  return jsonResult(payload);
}

ToolResult updateApply() {
  const QString executable =
      QDir::cleanPath(QCoreApplication::applicationFilePath());
  const bool managed = !installRootForExecutable(executable).isEmpty();

  // A copy launched from a build tree or an unpacked download cannot update
  // itself: the running executable is the file that would have to be
  // overwritten. Move it into the managed layout first, which is the one and
  // only time the path an MCP client names has to change.
  UpdateApplyResult applied =
      managed ? applyUpdate({}) : adoptRunningInstall({});
  if (!applied.ok) {
    return errorResult(applied.error);
  }
  // Having just gained a path that can be updated in place, use it: a person
  // who asked to update should not have to ask twice.
  QString upgrade_error;
  if (applied.adopted) {
    UpdaterConfig config;
    config.executable_path = applied.executable_path;
    const UpdateApplyResult upgraded = applyUpdate(config);
    if (!upgraded.ok) {
      // The adoption stands and is worth reporting, but the half that did not
      // happen must not be silent: a caller told only about the move would
      // believe it is on the newest release.
      upgrade_error = upgraded.error;
    } else if (upgraded.installed_version != applied.installed_version) {
      const QString adopted_from = applied.adopted_from;
      applied = upgraded;
      applied.adopted = true;
      applied.adopted_from = adopted_from;
    }
  }

  // Chrome launches whatever executable the native-messaging registration
  // names. After an adoption that is a path Chrome has never seen, and after an
  // update it may be a version directory that pruning is about to remove.
  // Rewrite it to the stable link in both cases rather than leaving a
  // registration that silently stops working.
  QJsonObject registration{{QStringLiteral("rewritten"), false}};
  if (applied.restart_required && !applied.executable_path.isEmpty()) {
    ExtensionInstallConfig installer_config;
    installer_config.host_exe_path = applied.executable_path;
    BrowserExtensionInstaller installer(installer_config);
    const QString registered = installer.registeredHostExecutable();
    const QString expected = installer.config().host_exe_path;
    if (!registered.isEmpty() &&
        registered.compare(expected, Qt::CaseInsensitive) != 0) {
      const ExtensionInstallResult result = installer.install();
      registration.insert(QStringLiteral("rewritten"), result.ok);
      registration.insert(QStringLiteral("now_points_at"), expected);
      if (!result.ok) {
        registration.insert(QStringLiteral("error"), installerError(result));
      }
    }
  }

  QString next_step;
  if (applied.adopted) {
    next_step =
        QStringLiteral(
            "Installed into the managed layout at %1. Point your MCP client at "
            "that path once -- it is the last path change -- then restart the "
            "server. Chrome must also be pointed at the extension folder %2 "
            "once from chrome://extensions. Every later update reuses both "
            "paths and needs no clicks.")
            .arg(QDir::toNativeSeparators(applied.executable_path),
                 QDir::toNativeSeparators(applied.extension_path));
  } else if (applied.restart_required) {
    next_step =
        QStringLiteral(
            "Version %1 is installed and the stable link now points at it. "
            "This process is still the old build; restart the MCP server in "
            "your client to pick it up. No path, registration, or Chrome "
            "setting changes.")
            .arg(applied.installed_version);
  } else {
    next_step = QStringLiteral("Already on the newest release; nothing "
                               "changed.");
  }

  return jsonResult(QJsonObject{
      {QStringLiteral("ok"), true},
      {QStringLiteral("adopted"), applied.adopted},
      {QStringLiteral("adopted_from"),
       QDir::toNativeSeparators(applied.adopted_from)},
      {QStringLiteral("previous_version"), applied.previous_version},
      {QStringLiteral("installed_version"), applied.installed_version},
      {QStringLiteral("executable_path"),
       QDir::toNativeSeparators(applied.executable_path)},
      {QStringLiteral("extension_path"),
       QDir::toNativeSeparators(applied.extension_path)},
      {QStringLiteral("pruned_versions"), applied.pruned_versions},
      {QStringLiteral("native_host_registration"), registration},
      {QStringLiteral("restart_required"), applied.restart_required},
      {QStringLiteral("newest_release_error"), upgrade_error},
      {QStringLiteral("next_step"),
       upgrade_error.isEmpty()
           ? next_step
           : next_step +
                 QStringLiteral(
                     " The newest release could not be installed on top of it: "
                     "%1 Run this tool again from the new path to retry.")
                     .arg(upgrade_error)}});
}

QJsonObject emptySchema() {
  return QJsonObject{{QStringLiteral("type"), QStringLiteral("object")},
                     {QStringLiteral("properties"), QJsonObject{}},
                     {QStringLiteral("required"), QJsonArray{}},
                     {QStringLiteral("additionalProperties"), false}};
}

QJsonObject toolEntry(const QString &name, const QString &description) {
  return QJsonObject{{QStringLiteral("name"), name},
                     {QStringLiteral("description"), description},
                     {QStringLiteral("inputSchema"), emptySchema()}};
}

} // namespace

QJsonArray toolCatalog() {
  return QJsonArray{
      toolEntry(
          QStringLiteral("browser_extension_install"),
          QStringLiteral(
              "Prepare the unpacked Chrome Control MCP browser extension by "
              "registering its current-user native messaging host, and return "
              "the exact folder to load. Loading that folder is a ONE-TIME "
              "MANUAL step the person at the keyboard must do in "
              "chrome://extensions; it cannot be automated, and no assistant "
              "should try. Branded Chrome 137 and later ignore "
              "--load-extension, policy installation needs a Web Store "
              "listing, and driving the browser's own windows is not a "
              "supported install path. Report the folder and the three clicks "
              "to the user instead: Developer mode on, Load unpacked, pick the "
              "folder. No package or private key is required.")),
      toolEntry(QStringLiteral("browser_extension_uninstall"),
                QStringLiteral("Remove the Chrome Control MCP native messaging "
                               "host registration. If the unpacked "
                               "extension is loaded, remove it manually from "
                               "chrome://extensions.")),
      toolEntry(QStringLiteral("browser_extension_status"),
                QStringLiteral("Report unpacked-extension availability, "
                               "native-host preparation state, its load "
                               "path, and pinned extension id.")),
      toolEntry(
          QStringLiteral("browser_update_status"),
          QStringLiteral(
              "Report where this server is installed: its version, whether it "
              "runs from a managed install that can update itself in place, "
              "the install root, the version the stable link points at, and "
              "every installed version. Touches no network.")),
      toolEntry(
          QStringLiteral("browser_update_check"),
          QStringLiteral(
              "Ask the project's GitHub releases which version is newest and "
              "report whether it is newer than this one. Read-only: it "
              "downloads nothing and changes nothing.")),
      toolEntry(
          QStringLiteral("browser_update_apply"),
          QStringLiteral(
              "Install the newest release and point this install's stable link "
              "at it. The running executable is never overwritten -- the new "
              "version is staged in its own directory, verified against the "
              "SHA-256 published with the release, and swapped in -- so the "
              "update cannot fail on a locked file. The MCP command path, the "
              "Chrome unpacked-extension folder, and the native-messaging "
              "registration all keep working unchanged. A copy that is not yet "
              "running from a managed install is first moved into one, which "
              "is the only time the client's command path has to change. The "
              "new build takes effect when the client next starts the server; "
              "this process keeps serving the old one until then.")),
  };
}

ToolResult invokeTool(const QString &name, const QJsonObject &arguments) {
  (void)arguments;
  if (name == QLatin1String("browser_extension_install")) {
    return installExtension();
  }
  if (name == QLatin1String("browser_extension_uninstall")) {
    return uninstallExtension();
  }
  if (name == QLatin1String("browser_extension_status")) {
    return extensionStatus();
  }
  if (name == QLatin1String("browser_update_status")) {
    return updateStatus();
  }
  if (name == QLatin1String("browser_update_check")) {
    return updateCheck();
  }
  if (name == QLatin1String("browser_update_apply")) {
    return updateApply();
  }
  return errorResult(QStringLiteral("Unknown tool: %1").arg(name));
}

QString serverName() { return QString::fromLatin1(kServerName); }

QString serverVersion() { return QString::fromLatin1(kServerVersion); }

} // namespace chrome_control_mcp
