// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/mcp_entry.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QTemporaryDir>
#include <QtTest/QtTest>

#ifdef Q_OS_WIN
#include <windows.h>
#include <vector>
#endif

using namespace chrome_control_mcp;

namespace {

#ifdef Q_OS_WIN
QString testBase() {
  return QStringLiteral(
             "Software\\ChromeControlMCP_Test\\ExtensionInstaller_%1")
      .arg(QCoreApplication::applicationPid());
}

std::wstring wide(const QString &value) { return value.toStdWString(); }

bool registryKeyExists(const QString &path) {
  HKEY key = nullptr;
  const std::wstring name = wide(path);
  const LSTATUS status =
      RegOpenKeyExW(HKEY_CURRENT_USER, name.c_str(), 0, KEY_READ, &key);
  if (key != nullptr) {
    RegCloseKey(key);
  }
  return status == ERROR_SUCCESS;
}

QString registryDefault(const QString &path) {
  HKEY key = nullptr;
  const std::wstring name = wide(path);
  if (RegOpenKeyExW(HKEY_CURRENT_USER, name.c_str(), 0, KEY_QUERY_VALUE,
                    &key) != ERROR_SUCCESS) {
    return {};
  }
  DWORD type = 0;
  DWORD bytes = 0;
  if (RegQueryValueExW(key, nullptr, nullptr, &type, nullptr, &bytes) !=
      ERROR_SUCCESS) {
    RegCloseKey(key);
    return {};
  }
  std::vector<wchar_t> data(bytes / sizeof(wchar_t) + 1, L'\0');
  const LSTATUS status =
      RegQueryValueExW(key, nullptr, nullptr, &type,
                       reinterpret_cast<BYTE *>(data.data()), &bytes);
  RegCloseKey(key);
  return status == ERROR_SUCCESS ? QString::fromWCharArray(data.data())
                                 : QString();
}

void seedRegistryDefault(const QString &path, const QString &value) {
  HKEY key = nullptr;
  const std::wstring name = wide(path);
  QCOMPARE(RegCreateKeyExW(HKEY_CURRENT_USER, name.c_str(), 0, nullptr,
                           REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr,
                           &key, nullptr),
           static_cast<LSTATUS>(ERROR_SUCCESS));
  const std::wstring data = wide(value);
  QCOMPARE(
      RegSetValueExW(key, nullptr, 0, REG_SZ,
                     reinterpret_cast<const BYTE *>(data.c_str()),
                     static_cast<DWORD>((data.size() + 1) * sizeof(wchar_t))),
      static_cast<LSTATUS>(ERROR_SUCCESS));
  RegCloseKey(key);
}
#endif

QString makeFile(const QString &path, const QByteArray &bytes) {
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) {
    return {};
  }
  file.close();
  QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner |
                                  QFileDevice::ExeOwner);
  return path;
}

QString makeExtension(const QString &root) {
  const QString path = QDir(root).filePath(QStringLiteral("extension"));
  QDir().mkpath(path);
  makeFile(QDir(path).filePath(QStringLiteral("manifest.json")), "{}");
  makeFile(QDir(path).filePath(QStringLiteral("background.js")), "// worker");
  return path;
}

ExtensionInstallConfig configFor(const QString &root, const QString &extension,
                                 const QString &executable) {
  ExtensionInstallConfig config;
  config.extension_path = extension;
  config.data_dir = QDir(root).filePath(QStringLiteral("data"));
  config.host_exe_path = executable;
#ifdef Q_OS_WIN
  config.native_host_key_path = testBase() + QStringLiteral("\\NativeHost");
#else
  config.native_host_manifest_dir =
      QDir(root).filePath(QStringLiteral("native-hosts"));
#endif
  return config;
}

QString registeredManifestPath(const BrowserExtensionInstaller &installer) {
#ifdef Q_OS_WIN
  return registryDefault(installer.config().native_host_key_path);
#else
  return QDir(installer.config().native_host_manifest_dir)
      .filePath(QString::fromLatin1(kNativeHostName) + QStringLiteral(".json"));
#endif
}

QString extensionIdFromPublicKey(const QByteArray &der) {
  const QByteArray digest =
      QCryptographicHash::hash(der, QCryptographicHash::Sha256);
  QString id;
  id.reserve(32);
  for (int i = 0; i < 16; ++i) {
    const unsigned char byte = static_cast<unsigned char>(digest.at(i));
    id.append(QChar(u'a' + ((byte >> 4) & 0x0f)));
    id.append(QChar(u'a' + (byte & 0x0f)));
  }
  return id;
}

// The two origins a current registration lists, in the order it lists them.
QJsonArray expectedOrigins() {
  return QJsonArray{
      QStringLiteral("chrome-extension://") +
          QString::fromLatin1(kBrowserExtensionId) + QStringLiteral("/"),
      QStringLiteral("chrome-extension://") +
          QString::fromLatin1(kStoreExtensionId) + QStringLiteral("/")};
}

// Overwrites a registered host manifest with @p origins, keeping every other
// field as the installer writes it.
bool writeRegistration(const QString &path, const QString &executable,
                       const QJsonArray &origins) {
  const QJsonObject manifest{
      {QStringLiteral("name"), QString::fromLatin1(kNativeHostName)},
      {QStringLiteral("description"),
       QStringLiteral(
           "Chrome Control MCP browser-control native messaging host")},
      {QStringLiteral("path"), QDir::toNativeSeparators(executable)},
      {QStringLiteral("type"), QStringLiteral("stdio")},
      {QStringLiteral("allowed_origins"), origins},
  };
  return !makeFile(path, QJsonDocument(manifest).toJson()).isEmpty();
}

} // namespace

class BrowserExtensionInstallerTests : public QObject {
  Q_OBJECT

private slots:
  void init();
  void cleanupTestCase();
  void publicManifestIdentityIsPinned();
  void presenceRequiresBothExtensionFiles();
  void prepareRegistersValidatedNativeHost();
  void storePublicKeyDerivesStoreId();
  void singleOriginRegistrationIsRewritten();
  void foreignOriginRegistrationIsNotCurrent();
  void refreshRewritesOnlyItsOwnStaleRegistration();
  void extensionOriginAcceptsBothBuilds();
  void missingExtensionFailsClosed();
  void uninstallRemovesOnlyOwnedRegistration();
  void registrationNote_namesBothExecutablesAndTheFix();
  void registrationNote_silentWhenNothingToSay();
  void registrationNote_followsLinksToTheSameFile();
  void registeredHostExecutable_readsTheManifest();
};

void BrowserExtensionInstallerTests::init() {
#ifdef Q_OS_WIN
  const std::wstring base = wide(testBase());
  RegDeleteTreeW(HKEY_CURRENT_USER, base.c_str());
#endif
}

void BrowserExtensionInstallerTests::cleanupTestCase() {
#ifdef Q_OS_WIN
  const std::wstring base = wide(testBase());
  RegDeleteTreeW(HKEY_CURRENT_USER, base.c_str());
#endif
}

void BrowserExtensionInstallerTests::publicManifestIdentityIsPinned() {
  const QString manifestPath =
      QDir(QStringLiteral(CHROME_CONTROL_MCP_REPO_ROOT))
          .filePath(QStringLiteral("browser/extension/manifest.json"));
  QFile file(manifestPath);
  QVERIFY2(file.open(QIODevice::ReadOnly), qPrintable(manifestPath));
  const QJsonObject manifest = QJsonDocument::fromJson(file.readAll()).object();
  const QByteArray publicKey = QByteArray::fromBase64(
      manifest.value(QStringLiteral("key")).toString().toLatin1());
  QVERIFY(!publicKey.isEmpty());
  QCOMPARE(extensionIdFromPublicKey(publicKey),
           QString::fromLatin1(kBrowserExtensionId));
  QCOMPARE(manifest.value(QStringLiteral("version")).toString(),
           QString::fromLatin1(kBrowserExtensionVersion));
}

void BrowserExtensionInstallerTests::presenceRequiresBothExtensionFiles() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension =
      QDir(dir.path()).filePath(QStringLiteral("extension"));
  QDir().mkpath(extension);
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  BrowserExtensionInstaller installer(
      configFor(dir.path(), extension, executable));
  QVERIFY(!installer.extensionPresent());
  makeFile(QDir(extension).filePath(QStringLiteral("manifest.json")), "{}");
  QVERIFY(!installer.extensionPresent());
  makeFile(QDir(extension).filePath(QStringLiteral("background.js")),
           "// worker");
  QVERIFY(installer.extensionPresent());
}

void BrowserExtensionInstallerTests::prepareRegistersValidatedNativeHost() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension = makeExtension(dir.path());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  BrowserExtensionInstaller installer(
      configFor(dir.path(), extension, executable));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Partial));

  const ExtensionInstallResult result = installer.install();
  QVERIFY2(result.ok, qPrintable(result.detail));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Prepared));
  QVERIFY(result.detail.contains(QDir::toNativeSeparators(extension)));
  // The other way to add the extension: the user's own install from the
  // Chrome Web Store, named by its listing.
  QVERIFY(result.detail.contains(
      QStringLiteral("https://chromewebstore.google.com/detail/")));
  QVERIFY(result.detail.contains(QString::fromLatin1(kStoreExtensionId)));

  const QString registeredManifest = registeredManifestPath(installer);
  QVERIFY(QFileInfo(registeredManifest).isFile());
  QFile file(registeredManifest);
  QVERIFY(file.open(QIODevice::ReadOnly));
  const QJsonObject manifest = QJsonDocument::fromJson(file.readAll()).object();
  QCOMPARE(manifest.value(QStringLiteral("name")).toString(),
           QString::fromLatin1(kNativeHostName));
  QCOMPARE(QDir::cleanPath(manifest.value(QStringLiteral("path")).toString()),
           QDir::cleanPath(executable));
  // Both builds of the extension may launch the host -- the unpacked one and
  // the Chrome Web Store one -- and no other extension.
  QCOMPARE(manifest.value(QStringLiteral("allowed_origins")).toArray(),
           expectedOrigins());
}

void BrowserExtensionInstallerTests::storePublicKeyDerivesStoreId() {
  // The store build's id is fixed by the key the store signs it with; the
  // public half is kept in the repository so this pin can be checked.
  const QString keyPath =
      QDir(QStringLiteral(CHROME_CONTROL_MCP_REPO_ROOT))
          .filePath(QStringLiteral("browser/store-public-key.txt"));
  QFile file(keyPath);
  QVERIFY2(file.open(QIODevice::ReadOnly), qPrintable(keyPath));
  const QByteArray publicKey = QByteArray::fromBase64(file.readAll().trimmed());
  QVERIFY(!publicKey.isEmpty());
  QCOMPARE(extensionIdFromPublicKey(publicKey),
           QString::fromLatin1(kStoreExtensionId));
  QVERIFY(QString::fromLatin1(kStoreExtensionId) !=
          QString::fromLatin1(kBrowserExtensionId));
}

void BrowserExtensionInstallerTests::singleOriginRegistrationIsRewritten() {
  // A registration written before the store build names one origin. Chrome
  // would refuse the store build's connection under it, so it must not count
  // as current, and the next install must replace it with both.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension = makeExtension(dir.path());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  BrowserExtensionInstaller installer(
      configFor(dir.path(), extension, executable));
  QVERIFY(installer.install().ok);
  const QString registered = registeredManifestPath(installer);

  QVERIFY(
      writeRegistration(registered, executable,
                        QJsonArray{QStringLiteral("chrome-extension://") +
                                   QString::fromLatin1(kBrowserExtensionId) +
                                   QStringLiteral("/")}));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Partial));

  const ExtensionInstallResult result = installer.install();
  QVERIFY2(result.ok, qPrintable(result.detail));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Prepared));
  QFile file(registeredManifestPath(installer));
  QVERIFY(file.open(QIODevice::ReadOnly));
  QCOMPARE(QJsonDocument::fromJson(file.readAll())
               .object()
               .value(QStringLiteral("allowed_origins"))
               .toArray(),
           expectedOrigins());
}

void BrowserExtensionInstallerTests::foreignOriginRegistrationIsNotCurrent() {
  // Exactly our two origins: one more, or one of ours swapped for another
  // extension's, is a registration this server did not write.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension = makeExtension(dir.path());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  BrowserExtensionInstaller installer(
      configFor(dir.path(), extension, executable));
  QVERIFY(installer.install().ok);
  const QString registered = registeredManifestPath(installer);
  const QString foreign =
      QStringLiteral("chrome-extension://abcdefghijklmnopabcdefghijklmnop/");

  QJsonArray extra = expectedOrigins();
  extra.append(foreign);
  QVERIFY(writeRegistration(registered, executable, extra));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Partial));

  QJsonArray swapped{expectedOrigins().first(), foreign};
  QVERIFY(writeRegistration(registered, executable, swapped));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Partial));

  // The same two origins in the other order are still ours.
  QJsonArray reversed{expectedOrigins().last(), expectedOrigins().first()};
  QVERIFY(writeRegistration(registered, executable, reversed));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Prepared));
}

void BrowserExtensionInstallerTests::
    refreshRewritesOnlyItsOwnStaleRegistration() {
  // What a server does as it starts. An update applied by a 1.12 server runs
  // 1.12's code and leaves a one-origin registration naming the updated
  // executable; the new server rewrites that -- and nothing else.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension = makeExtension(dir.path());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  const QString other =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("other.exe")), "exe");
  BrowserExtensionInstaller installer(
      configFor(dir.path(), extension, executable));
  const QJsonArray oneOrigin{expectedOrigins().first()};

  // Nothing registered: nothing is created.
  QVERIFY(!installer.refreshOwnRegistration());
  QVERIFY(installer.registeredHostExecutable().isEmpty());

  // A current registration is left as it is.
  QVERIFY(installer.install().ok);
  const QString registered = registeredManifestPath(installer);
  QVERIFY(!installer.refreshOwnRegistration());

  // Its own, from before the store build: rewritten with both origins.
  QVERIFY(writeRegistration(registered, executable, oneOrigin));
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Partial));
  QVERIFY(installer.refreshOwnRegistration());
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Prepared));
  QFile rewritten(registeredManifestPath(installer));
  QVERIFY(rewritten.open(QIODevice::ReadOnly));
  QCOMPARE(QJsonDocument::fromJson(rewritten.readAll())
               .object()
               .value(QStringLiteral("allowed_origins"))
               .toArray(),
           expectedOrigins());
  rewritten.close();

  // Another copy's, however out of date: not this server's to change.
  QVERIFY(writeRegistration(registered, other, oneOrigin));
  QFile before(registered);
  QVERIFY(before.open(QIODevice::ReadOnly));
  const QByteArray foreignBytes = before.readAll();
  before.close();
  QVERIFY(!installer.refreshOwnRegistration());
  QFile after(registered);
  QVERIFY(after.open(QIODevice::ReadOnly));
  QCOMPARE(after.readAll(), foreignBytes);
  QCOMPARE(QDir::cleanPath(installer.registeredHostExecutable()),
           QDir::cleanPath(other));
}

void BrowserExtensionInstallerTests::extensionOriginAcceptsBothBuilds() {
  // The relay's own check on the origin Chrome passes the host: either build
  // of this extension, exactly, and nothing that only starts like one.
  for (const char *id : {kBrowserExtensionId, kStoreExtensionId}) {
    const std::string origin = std::string("chrome-extension://") + id;
    QVERIFY2(isOurExtensionOrigin(origin.c_str()), id);
    QVERIFY2(isOurExtensionOrigin((origin + "/").c_str()), id);
    QVERIFY2(isOurExtensionOrigin((origin + "/background.js").c_str()), id);
    // A longer id that begins with ours is another extension.
    QVERIFY2(!isOurExtensionOrigin((origin + "a").c_str()), id);
    QVERIFY2(!isOurExtensionOrigin((origin + "a/").c_str()), id);
  }
  QVERIFY(!isOurExtensionOrigin(nullptr));
  QVERIFY(!isOurExtensionOrigin(""));
  QVERIFY(!isOurExtensionOrigin("chrome-extension://"));
  QVERIFY(!isOurExtensionOrigin(
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"));
  // Ours with its last letter cut is not ours.
  const std::string truncated = std::string("chrome-extension://") +
                                std::string(kStoreExtensionId).substr(0, 31) +
                                "/";
  QVERIFY(!isOurExtensionOrigin(truncated.c_str()));
  QVERIFY(!isOurExtensionOrigin(
      (std::string("https://") + kStoreExtensionId + "/").c_str()));
}

void BrowserExtensionInstallerTests::missingExtensionFailsClosed() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  BrowserExtensionInstaller installer(configFor(
      dir.path(), QDir(dir.path()).filePath(QStringLiteral("missing")),
      executable));
  const ExtensionInstallResult result = installer.install();
  QVERIFY(!result.ok);
#ifdef Q_OS_WIN
  QVERIFY(!registryKeyExists(installer.config().native_host_key_path));
#else
  QVERIFY(!QFileInfo(registeredManifestPath(installer)).exists());
#endif
}

void BrowserExtensionInstallerTests::uninstallRemovesOnlyOwnedRegistration() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension = makeExtension(dir.path());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  BrowserExtensionInstaller installer(
      configFor(dir.path(), extension, executable));
  QVERIFY(installer.install().ok);

  QString foreign;
#ifdef Q_OS_WIN
  foreign = testBase() + QStringLiteral("\\ForeignHost");
  seedRegistryDefault(foreign, QStringLiteral("C:\\foreign.json"));
#else
  foreign = QDir(installer.config().native_host_manifest_dir)
                .filePath(QStringLiteral("foreign-host.json"));
  QVERIFY(!makeFile(foreign, "{}").isEmpty());
#endif
  const ExtensionInstallResult result = installer.uninstall();
  QVERIFY2(result.ok, qPrintable(result.detail));
#ifdef Q_OS_WIN
  QVERIFY(!registryKeyExists(installer.config().native_host_key_path));
  QVERIFY(registryKeyExists(foreign));
#else
  QVERIFY(!QFileInfo(registeredManifestPath(installer)).exists());
  QVERIFY(QFileInfo(foreign).isFile());
#endif
  QCOMPARE(static_cast<int>(installer.state()),
           static_cast<int>(ExtensionInstallState::Partial));
}

void BrowserExtensionInstallerTests::
    registrationNote_namesBothExecutablesAndTheFix() {
  // The failure this exists for: Chrome starts the executable its registration
  // names, that copy's relay refuses a bridge served by a different copy, and
  // the operator is told only "the extension is not attached" -- true, and
  // useless. The note has to name both paths and say what to run.
  const QString note = nativeHostRegistrationNote(
      QStringLiteral("C:/Users/x/AppData/Local/Programs/ccm/ccm.exe"),
      QStringLiteral("C:/Users/x/code/ccm/build/Release/ccm.exe"));
  QVERIFY(!note.isEmpty());
  QVERIFY(note.contains(QDir::toNativeSeparators(
      QStringLiteral("C:/Users/x/AppData/Local/Programs/ccm/ccm.exe"))));
  QVERIFY(note.contains(QDir::toNativeSeparators(
      QStringLiteral("C:/Users/x/code/ccm/build/Release/ccm.exe"))));
  QVERIFY(note.contains(QStringLiteral("browser_extension_install")));
}

void BrowserExtensionInstallerTests::registrationNote_silentWhenNothingToSay() {
  // Same executable: there is no mismatch to report, and appending a paragraph
  // to every "not attached" error would bury the one case that matters.
  QVERIFY(nativeHostRegistrationNote(QStringLiteral("/opt/ccm/ccm"),
                                     QStringLiteral("/opt/ccm/ccm"))
              .isEmpty());
  // Differing only by a redundant path segment is the same file.
  QVERIFY(nativeHostRegistrationNote(QStringLiteral("/opt/ccm/./ccm"),
                                     QStringLiteral("/opt/ccm/ccm"))
              .isEmpty());
  // Nothing registered says nothing about a mismatch; that is a different
  // problem, with its own message from the installer's state.
  QVERIFY(nativeHostRegistrationNote(QString(), QStringLiteral("/opt/ccm/ccm"))
              .isEmpty());
#ifdef Q_OS_WIN
  // Windows compares paths without case, so a drive letter or a folder in
  // another case is the same executable, not a mismatch to shout about.
  QVERIFY(nativeHostRegistrationNote(QStringLiteral("C:/CCM/ccm.exe"),
                                     QStringLiteral("c:/ccm/CCM.EXE"))
              .isEmpty());
#endif
}

void BrowserExtensionInstallerTests::
    registrationNote_followsLinksToTheSameFile() {
  // A managed install registers the stable `current` link, while a running
  // server reports the version directory the link resolves to. Those are one
  // file, and the relay compares resolved images, so calling them a mismatch
  // sends the operator to a re-registration that writes the same link again.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QDir root(dir.path());
  QVERIFY(root.mkpath(QStringLiteral("versions/1.0.0")));
  const QString versioned = makeFile(
      root.filePath(QStringLiteral("versions/1.0.0/host")), "the program");
  const QString current = root.filePath(QStringLiteral("current"));
#ifdef Q_OS_WIN
  // On Windows a managed install's `current` is a directory junction, which
  // needs no privilege to make; QFile::link would make a .lnk shortcut, which
  // nothing resolves through.
  QProcess mklink;
  mklink.start(QStringLiteral("cmd.exe"),
               {QStringLiteral("/c"), QStringLiteral("mklink"),
                QStringLiteral("/J"), QDir::toNativeSeparators(current),
                QDir::toNativeSeparators(
                    root.filePath(QStringLiteral("versions/1.0.0")))});
  QVERIFY(mklink.waitForFinished(10000));
  QCOMPARE(mklink.exitCode(), 0);
#else
  QVERIFY(
      QFile::link(root.filePath(QStringLiteral("versions/1.0.0")), current));
#endif
  const QString stable = QDir(current).filePath(QStringLiteral("host"));

  QVERIFY(nativeHostRegistrationNote(stable, versioned).isEmpty());
  QVERIFY(nativeHostRegistrationNote(versioned, stable).isEmpty());

  // Resolving links must not hide a real mismatch: a second copy with the same
  // bytes is a different image, and the relay refuses it.
  const QString copy =
      makeFile(root.filePath(QStringLiteral("copy")), "the program");
  QVERIFY(!nativeHostRegistrationNote(stable, copy).isEmpty());

  // A registration naming a file that is gone cannot be resolved, and it is
  // still a mismatch worth reporting, under the path the registration names.
  const QString missing = root.filePath(QStringLiteral("gone/host"));
  const QString note = nativeHostRegistrationNote(missing, versioned);
  QVERIFY(note.contains(QDir::toNativeSeparators(missing)));
}

void BrowserExtensionInstallerTests::
    registeredHostExecutable_readsTheManifest() {
  // What the accessor is for: reporting the executable Chrome would actually
  // start, read from the registration this config points at.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString extension = makeExtension(dir.path());
  const QString executable =
      makeFile(QDir(dir.path()).filePath(QStringLiteral("host.exe")), "exe");
  const ExtensionInstallConfig config =
      configFor(dir.path(), extension, executable);
  BrowserExtensionInstaller installer(config);

  // Nothing registered yet: an empty answer, not a guess at the default.
  QVERIFY(installer.registeredHostExecutable().isEmpty());

  const ExtensionInstallResult installed = installer.install();
  QVERIFY2(installed.ok, qPrintable(installed.detail));
  QCOMPARE(QDir::cleanPath(installer.registeredHostExecutable()),
           QDir::cleanPath(config.host_exe_path));

  const ExtensionInstallResult removed = installer.uninstall();
  QVERIFY2(removed.ok, qPrintable(removed.detail));
  QVERIFY(installer.registeredHostExecutable().isEmpty());
}

QTEST_MAIN(BrowserExtensionInstallerTests)
#include "test_browser_extension_installer.moc"
