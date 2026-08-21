// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_extension_installer.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QtTest/QtTest>

#include <windows.h>

#include <vector>

using namespace chrome_control_mcp;

namespace {

QString testBase() {
    return QStringLiteral("Software\\ChromeControlMCP_Test\\ExtensionInstaller_%1")
        .arg(QCoreApplication::applicationPid());
}

std::wstring wide(const QString& value) {
    return value.toStdWString();
}

bool registryKeyExists(const QString& path) {
    HKEY key = nullptr;
    const std::wstring name = wide(path);
    const LSTATUS status = RegOpenKeyExW(HKEY_CURRENT_USER, name.c_str(), 0, KEY_READ, &key);
    if (key != nullptr) {
        RegCloseKey(key);
    }
    return status == ERROR_SUCCESS;
}

QString registryDefault(const QString& path) {
    HKEY key = nullptr;
    const std::wstring name = wide(path);
    if (RegOpenKeyExW(HKEY_CURRENT_USER, name.c_str(), 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) {
        return {};
    }
    DWORD type = 0;
    DWORD bytes = 0;
    if (RegQueryValueExW(key, nullptr, nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS) {
        RegCloseKey(key);
        return {};
    }
    std::vector<wchar_t> data(bytes / sizeof(wchar_t) + 1, L'\0');
    const LSTATUS status = RegQueryValueExW(
        key, nullptr, nullptr, &type, reinterpret_cast<BYTE*>(data.data()), &bytes);
    RegCloseKey(key);
    return status == ERROR_SUCCESS ? QString::fromWCharArray(data.data()) : QString();
}

void seedRegistryDefault(const QString& path, const QString& value) {
    HKEY key = nullptr;
    const std::wstring name = wide(path);
    QCOMPARE(RegCreateKeyExW(HKEY_CURRENT_USER,
                             name.c_str(),
                             0,
                             nullptr,
                             REG_OPTION_NON_VOLATILE,
                             KEY_SET_VALUE,
                             nullptr,
                             &key,
                             nullptr),
             static_cast<LSTATUS>(ERROR_SUCCESS));
    const std::wstring data = wide(value);
    QCOMPARE(RegSetValueExW(key,
                            nullptr,
                            0,
                            REG_SZ,
                            reinterpret_cast<const BYTE*>(data.c_str()),
                            static_cast<DWORD>((data.size() + 1) * sizeof(wchar_t))),
             static_cast<LSTATUS>(ERROR_SUCCESS));
    RegCloseKey(key);
}

QString makeFile(const QString& path, const QByteArray& bytes) {
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) {
        return {};
    }
    file.close();
    return path;
}

QString makeExtension(const QString& root) {
    const QString path = QDir(root).filePath(QStringLiteral("extension"));
    QDir().mkpath(path);
    makeFile(QDir(path).filePath(QStringLiteral("manifest.json")), "{}");
    makeFile(QDir(path).filePath(QStringLiteral("background.js")), "// worker");
    return path;
}

ExtensionInstallConfig configFor(const QString& root,
                                 const QString& extension,
                                 const QString& executable) {
    ExtensionInstallConfig config;
    config.extension_path = extension;
    config.data_dir = QDir(root).filePath(QStringLiteral("data"));
    config.host_exe_path = executable;
    config.native_host_key_path = testBase() + QStringLiteral("\\NativeHost");
    return config;
}

QString extensionIdFromPublicKey(const QByteArray& der) {
    const QByteArray digest = QCryptographicHash::hash(der, QCryptographicHash::Sha256);
    QString id;
    id.reserve(32);
    for (int i = 0; i < 16; ++i) {
        const unsigned char byte = static_cast<unsigned char>(digest.at(i));
        id.append(QChar(u'a' + ((byte >> 4) & 0x0f)));
        id.append(QChar(u'a' + (byte & 0x0f)));
    }
    return id;
}

}  // namespace

class BrowserExtensionInstallerTests : public QObject {
    Q_OBJECT

private slots:
    void init();
    void cleanupTestCase();
    void publicManifestIdentityIsPinned();
    void presenceRequiresBothExtensionFiles();
    void prepareRegistersValidatedNativeHost();
    void missingExtensionFailsClosed();
    void uninstallRemovesOnlyOwnedRegistration();
};

void BrowserExtensionInstallerTests::init() {
    const std::wstring base = wide(testBase());
    RegDeleteTreeW(HKEY_CURRENT_USER, base.c_str());
}

void BrowserExtensionInstallerTests::cleanupTestCase() {
    const std::wstring base = wide(testBase());
    RegDeleteTreeW(HKEY_CURRENT_USER, base.c_str());
}

void BrowserExtensionInstallerTests::publicManifestIdentityIsPinned() {
    const QString manifestPath = QDir(QStringLiteral(CHROME_CONTROL_MCP_REPO_ROOT))
                                     .filePath(QStringLiteral("browser/extension/manifest.json"));
    QFile file(manifestPath);
    QVERIFY2(file.open(QIODevice::ReadOnly), qPrintable(manifestPath));
    const QJsonObject manifest = QJsonDocument::fromJson(file.readAll()).object();
    const QByteArray publicKey =
        QByteArray::fromBase64(manifest.value(QStringLiteral("key")).toString().toLatin1());
    QVERIFY(!publicKey.isEmpty());
    QCOMPARE(extensionIdFromPublicKey(publicKey), QString::fromLatin1(kBrowserExtensionId));
    QCOMPARE(manifest.value(QStringLiteral("version")).toString(),
             QString::fromLatin1(kBrowserExtensionVersion));
}

void BrowserExtensionInstallerTests::presenceRequiresBothExtensionFiles() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString extension = QDir(dir.path()).filePath(QStringLiteral("extension"));
    QDir().mkpath(extension);
    const QString executable = makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
    BrowserExtensionInstaller installer(configFor(dir.path(), extension, executable));
    QVERIFY(!installer.extensionPresent());
    makeFile(QDir(extension).filePath(QStringLiteral("manifest.json")), "{}");
    QVERIFY(!installer.extensionPresent());
    makeFile(QDir(extension).filePath(QStringLiteral("background.js")), "// worker");
    QVERIFY(installer.extensionPresent());
}

void BrowserExtensionInstallerTests::prepareRegistersValidatedNativeHost() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString extension = makeExtension(dir.path());
    const QString executable = makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
    BrowserExtensionInstaller installer(configFor(dir.path(), extension, executable));
    QCOMPARE(static_cast<int>(installer.state()), static_cast<int>(ExtensionInstallState::Partial));

    const ExtensionInstallResult result = installer.install();
    QVERIFY2(result.ok, qPrintable(result.detail));
    QCOMPARE(static_cast<int>(installer.state()), static_cast<int>(ExtensionInstallState::Prepared));
    QVERIFY(result.detail.contains(QDir::toNativeSeparators(extension)));

    const QString registeredManifest = registryDefault(installer.config().native_host_key_path);
    QVERIFY(QFileInfo(registeredManifest).isFile());
    QFile file(registeredManifest);
    QVERIFY(file.open(QIODevice::ReadOnly));
    const QJsonObject manifest = QJsonDocument::fromJson(file.readAll()).object();
    QCOMPARE(manifest.value(QStringLiteral("name")).toString(), QString::fromLatin1(kNativeHostName));
    QCOMPARE(QDir::cleanPath(manifest.value(QStringLiteral("path")).toString()),
             QDir::cleanPath(executable));
    QCOMPARE(manifest.value(QStringLiteral("allowed_origins")).toArray().first().toString(),
             QStringLiteral("chrome-extension://") + QString::fromLatin1(kBrowserExtensionId) +
                 QStringLiteral("/"));
}

void BrowserExtensionInstallerTests::missingExtensionFailsClosed() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString executable = makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
    BrowserExtensionInstaller installer(
        configFor(dir.path(), QDir(dir.path()).filePath(QStringLiteral("missing")), executable));
    const ExtensionInstallResult result = installer.install();
    QVERIFY(!result.ok);
    QVERIFY(!registryKeyExists(installer.config().native_host_key_path));
}

void BrowserExtensionInstallerTests::uninstallRemovesOnlyOwnedRegistration() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString extension = makeExtension(dir.path());
    const QString executable = makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
    BrowserExtensionInstaller installer(configFor(dir.path(), extension, executable));
    QVERIFY(installer.install().ok);

    const QString foreign = testBase() + QStringLiteral("\\ForeignHost");
    seedRegistryDefault(foreign, QStringLiteral("C:\\foreign.json"));
    const ExtensionInstallResult result = installer.uninstall();
    QVERIFY2(result.ok, qPrintable(result.detail));
    QVERIFY(!registryKeyExists(installer.config().native_host_key_path));
    QVERIFY(registryKeyExists(foreign));
    QCOMPARE(static_cast<int>(installer.state()), static_cast<int>(ExtensionInstallState::Partial));
}

QTEST_MAIN(BrowserExtensionInstallerTests)
#include "test_browser_extension_installer.moc"
