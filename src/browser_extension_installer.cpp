// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_extension_installer.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QStandardPaths>

#ifdef Q_OS_WIN
#include <windows.h>
#endif

#include <memory>
#include <string>
#include <type_traits>
#include <vector>

namespace chrome_control_mcp {
namespace {

QString currentExecutablePath() {
#ifdef Q_OS_WIN
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                          static_cast<DWORD>(buffer.size()));
  if (length > 0 && length < static_cast<DWORD>(buffer.size())) {
    return QDir::cleanPath(
        QString::fromWCharArray(buffer.data(), static_cast<qsizetype>(length)));
  }
#endif
  return QDir::cleanPath(QCoreApplication::applicationFilePath());
}

QString defaultDataDirectory() {
  QString base =
      QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
  if (base.isEmpty()) {
    base = QDir::homePath();
  }
  return QDir::cleanPath(
      QDir(base).filePath(QStringLiteral("ChromeControlMCP")));
}

QString defaultNativeHostManifestDirectory() {
  const QString configured =
      qEnvironmentVariable("CHROME_CONTROL_MCP_NATIVE_HOST_DIR");
  if (!configured.isEmpty()) {
    return QDir::cleanPath(QFileInfo(configured).absoluteFilePath());
  }
#ifdef Q_OS_MACOS
  const QString base =
      QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
  return QDir(base).filePath(
      QStringLiteral("Google/Chrome/NativeMessagingHosts"));
#elif defined(Q_OS_LINUX)
  const QString base =
      QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
  return QDir(base).filePath(
      QStringLiteral("google-chrome/NativeMessagingHosts"));
#else
  return {};
#endif
}

QString resolveExtensionPath(const QString &configured,
                             const QString &executable) {
  if (!configured.isEmpty()) {
    return QDir::cleanPath(QFileInfo(configured).absoluteFilePath());
  }
  const QDir appDir(QFileInfo(executable).absolutePath());
  const QString staged =
      appDir.filePath(QString::fromLatin1(kBrowserExtensionDirectoryName));
  if (QFileInfo(staged).isDir()) {
    return QDir::cleanPath(staged);
  }
  const QString source = appDir.filePath(QStringLiteral("browser/extension"));
  return QDir::cleanPath(source);
}

QString hostManifestPath(const ExtensionInstallConfig &config) {
#ifdef Q_OS_WIN
  return QDir(config.data_dir)
      .filePath(QString::fromLatin1(kNativeHostName) + QStringLiteral(".json"));
#else
  return QDir(config.native_host_manifest_dir)
      .filePath(QString::fromLatin1(kNativeHostName) + QStringLiteral(".json"));
#endif
}

QByteArray hostManifestBytes(const ExtensionInstallConfig &config) {
  const QJsonObject manifest{
      {QStringLiteral("name"), QString::fromLatin1(kNativeHostName)},
      {QStringLiteral("description"),
       QStringLiteral(
           "Chrome Control MCP browser-control native messaging host")},
      {QStringLiteral("path"), QDir::toNativeSeparators(config.host_exe_path)},
      {QStringLiteral("type"), QStringLiteral("stdio")},
      {QStringLiteral("allowed_origins"),
       QJsonArray{QStringLiteral("chrome-extension://") +
                  QString::fromLatin1(kBrowserExtensionId) +
                  QStringLiteral("/")}},
  };
  return QJsonDocument(manifest).toJson(QJsonDocument::Indented);
}

bool writeFileAtomic(const QString &path, const QByteArray &bytes,
                     QString *error) {
  QSaveFile file(path);
  if (!file.open(QIODevice::WriteOnly)) {
    *error = file.errorString();
    return false;
  }
  if (file.write(bytes) != bytes.size()) {
    *error = file.errorString();
    file.cancelWriting();
    return false;
  }
  if (!file.commit()) {
    *error = file.errorString();
    return false;
  }
#ifndef Q_OS_WIN
  if (!QFile::setPermissions(path, QFileDevice::ReadOwner |
                                       QFileDevice::WriteOwner)) {
    *error =
        QStringLiteral("Could not secure native host manifest: %1").arg(path);
    return false;
  }
#endif
  return true;
}

bool manifestMatches(const QString &path,
                     const ExtensionInstallConfig &config) {
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly)) {
    return false;
  }
  QJsonParseError parseError;
  const QJsonDocument document =
      QJsonDocument::fromJson(file.readAll(), &parseError);
  if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
    return false;
  }
  const QJsonObject object = document.object();
  const QString expectedOrigin = QStringLiteral("chrome-extension://") +
                                 QString::fromLatin1(kBrowserExtensionId) +
                                 QStringLiteral("/");
  const QString manifestExe =
      QDir::cleanPath(object.value(QStringLiteral("path")).toString());
  const QString expectedExe = QDir::cleanPath(config.host_exe_path);
#ifdef Q_OS_WIN
  constexpr Qt::CaseSensitivity pathCase = Qt::CaseInsensitive;
#else
  constexpr Qt::CaseSensitivity pathCase = Qt::CaseSensitive;
#endif
  return object.value(QStringLiteral("name")).toString() ==
             QString::fromLatin1(kNativeHostName) &&
         object.value(QStringLiteral("type")).toString() ==
             QStringLiteral("stdio") &&
         manifestExe.compare(expectedExe, pathCase) == 0 &&
         object.value(QStringLiteral("allowed_origins"))
             .toArray()
             .contains(expectedOrigin);
}

#ifdef Q_OS_WIN

std::wstring wide(const QString &value) { return value.toStdWString(); }

struct RegCloser {
  void operator()(HKEY key) const {
    if (key != nullptr) {
      RegCloseKey(key);
    }
  }
};
using UniqueRegKey = std::unique_ptr<std::remove_pointer_t<HKEY>, RegCloser>;

bool writeRegistryDefault(const QString &subkey, const QString &value,
                          QString *error) {
  HKEY raw = nullptr;
  DWORD disposition = 0;
  const std::wstring keyName = wide(subkey);
  LSTATUS status = RegCreateKeyExW(HKEY_CURRENT_USER, keyName.c_str(), 0,
                                   nullptr, REG_OPTION_NON_VOLATILE,
                                   KEY_SET_VALUE, nullptr, &raw, &disposition);
  Q_UNUSED(disposition);
  UniqueRegKey key(raw);
  if (status != ERROR_SUCCESS) {
    *error = QStringLiteral("registry create failed (%1): %2")
                 .arg(status)
                 .arg(subkey);
    return false;
  }
  const std::wstring data = wide(value);
  status =
      RegSetValueExW(key.get(), nullptr, 0, REG_SZ,
                     reinterpret_cast<const BYTE *>(data.c_str()),
                     static_cast<DWORD>((data.size() + 1) * sizeof(wchar_t)));
  if (status != ERROR_SUCCESS) {
    *error = QStringLiteral("registry write failed (%1): %2")
                 .arg(status)
                 .arg(subkey);
    return false;
  }
  return true;
}

// 0 = absent, 1 = present and valid, 2 = present but invalid, -1 = registry
// read error.
int nativeHostPresence(const ExtensionInstallConfig &config) {
  HKEY raw = nullptr;
  const std::wstring keyName = wide(config.native_host_key_path);
  const LSTATUS opened = RegOpenKeyExW(HKEY_CURRENT_USER, keyName.c_str(), 0,
                                       KEY_QUERY_VALUE, &raw);
  UniqueRegKey key(raw);
  if (opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND) {
    return 0;
  }
  if (opened != ERROR_SUCCESS) {
    return -1;
  }

  DWORD type = 0;
  DWORD bytes = 0;
  LSTATUS status =
      RegQueryValueExW(key.get(), nullptr, nullptr, &type, nullptr, &bytes);
  if (status != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ) ||
      bytes < sizeof(wchar_t)) {
    return 2;
  }
  std::vector<wchar_t> value(bytes / sizeof(wchar_t) + 1, L'\0');
  status = RegQueryValueExW(key.get(), nullptr, nullptr, &type,
                            reinterpret_cast<BYTE *>(value.data()), &bytes);
  if (status != ERROR_SUCCESS) {
    return -1;
  }
  const QString path = QString::fromWCharArray(value.data());
  return manifestMatches(path, config) ? 1 : 2;
}

bool removeNativeHostKey(const QString &subkey, QString *error) {
  const std::wstring keyName = wide(subkey);
  const LSTATUS status = RegDeleteTreeW(HKEY_CURRENT_USER, keyName.c_str());
  if (status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND ||
      status == ERROR_PATH_NOT_FOUND) {
    return true;
  }
  *error = QStringLiteral("registry removal failed (%1): %2")
               .arg(status)
               .arg(subkey);
  return false;
}

#endif

#ifndef Q_OS_WIN
int nativeHostPresence(const ExtensionInstallConfig &config) {
  const QString path = hostManifestPath(config);
  if (!QFileInfo::exists(path)) {
    return 0;
  }
  return manifestMatches(path, config) ? 1 : 2;
}
#endif

} // namespace

BrowserExtensionInstaller::BrowserExtensionInstaller(
    ExtensionInstallConfig config)
    : config_(std::move(config)) {
  if (config_.host_exe_path.isEmpty()) {
    config_.host_exe_path = currentExecutablePath();
  } else {
    config_.host_exe_path =
        QDir::cleanPath(QFileInfo(config_.host_exe_path).absoluteFilePath());
  }
  config_.extension_path =
      resolveExtensionPath(config_.extension_path, config_.host_exe_path);
  if (config_.data_dir.isEmpty()) {
    config_.data_dir = defaultDataDirectory();
  } else {
    config_.data_dir =
        QDir::cleanPath(QFileInfo(config_.data_dir).absoluteFilePath());
  }
  if (config_.native_host_key_path.isEmpty()) {
    config_.native_host_key_path =
        QStringLiteral("Software\\Google\\Chrome\\NativeMessagingHosts\\") +
        QString::fromLatin1(kNativeHostName);
  }
  if (config_.native_host_manifest_dir.isEmpty()) {
    config_.native_host_manifest_dir = defaultNativeHostManifestDirectory();
  } else {
    config_.native_host_manifest_dir = QDir::cleanPath(
        QFileInfo(config_.native_host_manifest_dir).absoluteFilePath());
  }
}

bool BrowserExtensionInstaller::extensionPresent() const {
  const QDir dir(config_.extension_path);
  return QFileInfo(dir.filePath(QStringLiteral("manifest.json"))).isFile() &&
         QFileInfo(dir.filePath(QStringLiteral("background.js"))).isFile();
}

ExtensionInstallResult BrowserExtensionInstaller::install() {
  if (!extensionPresent()) {
    return {false, QStringLiteral("Unpacked extension files not found"),
            config_.extension_path};
  }
  if (!QFileInfo(config_.host_exe_path).isFile()) {
    return {false, QStringLiteral("Native host executable not found"),
            config_.host_exe_path};
  }
#ifndef Q_OS_WIN
  if (!QFileInfo(config_.host_exe_path).isExecutable()) {
    return {false, QStringLiteral("Native host is not executable"),
            config_.host_exe_path};
  }
#endif
#ifdef Q_OS_WIN
  if (!QDir().mkpath(config_.data_dir)) {
    return {false, QStringLiteral("Could not create data directory"),
            config_.data_dir};
  }

  const QString manifestPath = hostManifestPath(config_);
  QString error;
  if (!writeFileAtomic(manifestPath, hostManifestBytes(config_), &error)) {
    return {false, QStringLiteral("Could not write native host manifest"),
            error};
  }
  if (!writeRegistryDefault(config_.native_host_key_path, manifestPath,
                            &error)) {
    return {false, QStringLiteral("Could not register native host"), error};
  }
#else
  if (config_.native_host_manifest_dir.isEmpty() ||
      !QDir().mkpath(config_.native_host_manifest_dir)) {
    return {false,
            QStringLiteral("Could not create Chrome native host directory"),
            config_.native_host_manifest_dir};
  }
  const QString manifestPath = hostManifestPath(config_);
  QString error;
  if (!writeFileAtomic(manifestPath, hostManifestBytes(config_), &error)) {
    return {false, QStringLiteral("Could not register native host"), error};
  }
#endif

  return {true, QStringLiteral("Browser extension bridge prepared"),
          QStringLiteral("Load unpacked in chrome://extensions from %1, then "
                         "reload or restart Chrome")
              .arg(QDir::toNativeSeparators(config_.extension_path))};
}

ExtensionInstallResult BrowserExtensionInstaller::uninstall() const {
#ifdef Q_OS_WIN
  QString error;
  if (!removeNativeHostKey(config_.native_host_key_path, &error)) {
    return {false, QStringLiteral("Could not remove native host registration"),
            error};
  }
  const QString manifestPath = hostManifestPath(config_);
  if (QFileInfo(manifestPath).isFile() && !QFile::remove(manifestPath)) {
    return {false,
            QStringLiteral(
                "Native host registration removed; manifest cleanup failed"),
            manifestPath};
  }
  return {true, QStringLiteral("Browser extension bridge unregistered"),
          QStringLiteral("Remove Chrome Control MCP manually from "
                         "chrome://extensions if it is loaded")};
#else
  const QString manifestPath = hostManifestPath(config_);
  if (QFileInfo(manifestPath).isFile() && !QFile::remove(manifestPath)) {
    return {false, QStringLiteral("Could not remove native host registration"),
            manifestPath};
  }
  return {true, QStringLiteral("Browser extension bridge unregistered"),
          QStringLiteral("Remove Chrome Control MCP manually from "
                         "chrome://extensions if it is loaded")};
#endif
}

ExtensionInstallState BrowserExtensionInstaller::state() const {
  const bool extension = extensionPresent();
  const int host = nativeHostPresence(config_);
  if (host < 0) {
    return ExtensionInstallState::Error;
  }
  if (extension && host == 1) {
    return ExtensionInstallState::Prepared;
  }
  if (!extension && host == 0) {
    return ExtensionInstallState::NotPrepared;
  }
  return ExtensionInstallState::Partial;
}

QString BrowserExtensionInstaller::stateString() const {
  switch (state()) {
  case ExtensionInstallState::NotPrepared:
    return QStringLiteral("not_prepared");
  case ExtensionInstallState::Prepared:
    return QStringLiteral("prepared");
  case ExtensionInstallState::Partial:
    return QStringLiteral("partial");
  case ExtensionInstallState::Error:
    return QStringLiteral("error");
  }
  return QStringLiteral("error");
}

} // namespace chrome_control_mcp
