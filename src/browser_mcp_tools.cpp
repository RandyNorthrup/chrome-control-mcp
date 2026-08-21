// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/mcp_tools.h"

#include "chrome_control_mcp/browser_extension_installer.h"

#include <QJsonDocument>
#include <QLatin1String>

namespace chrome_control_mcp {
namespace {

constexpr char kServerName[] = "chrome-control-mcp";
constexpr char kServerVersion[] = "1.0.0";

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
              "registering its "
              "current-user native messaging host. Returns the exact folder to "
              "load once from "
              "chrome://extensions; no package or private key is required.")),
      toolEntry(QStringLiteral("browser_extension_uninstall"),
                QStringLiteral("Remove the Chrome Control MCP native messaging "
                               "host registration. If the unpacked "
                               "extension is loaded, remove it manually from "
                               "chrome://extensions.")),
      toolEntry(QStringLiteral("browser_extension_status"),
                QStringLiteral("Report unpacked-extension availability, "
                               "native-host preparation state, its load "
                               "path, and pinned extension id.")),
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
  return errorResult(QStringLiteral("Unknown tool: %1").arg(name));
}

QString serverName() { return QString::fromLatin1(kServerName); }

QString serverVersion() { return QString::fromLatin1(kServerVersion); }

} // namespace chrome_control_mcp
