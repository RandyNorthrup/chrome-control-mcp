// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/updater.h"

#include "chrome_control_mcp/install_layout.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QTemporaryDir>
#include <QtTest/QtTest>

using namespace chrome_control_mcp;

namespace {

QString executableName() {
#ifdef Q_OS_WIN
  return QStringLiteral("chrome_control_mcp.exe");
#else
  return QStringLiteral("chrome_control_mcp");
#endif
}

bool writeFile(const QString &path, const QString &contents) {
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
    return false;
  }
  file.write(contents.toUtf8());
  file.close();
  return true;
}

// What an unpacked release archive looks like by the time the lock-sensitive
// half of the update takes over: a directory holding the executable, the
// staged extension, and a marker proving which build it is.
QString stageRelease(const QString &parent, const QString &version) {
  const QString directory = QDir::cleanPath(
      QDir(parent).filePath(QStringLiteral("staged-%1").arg(version)));
  if (!QDir().mkpath(QDir(directory).filePath(QStringLiteral("extension")))) {
    return {};
  }
  if (!writeFile(QDir(directory).filePath(executableName()), version) ||
      !writeFile(QDir(directory).filePath(QStringLiteral("marker.txt")),
                 version)) {
    return {};
  }
  return directory;
}

QString readMarker(const QString &directory) {
  QFile file(QDir(directory).filePath(QStringLiteral("marker.txt")));
  if (!file.open(QIODevice::ReadOnly)) {
    return {};
  }
  return QString::fromUtf8(file.readAll());
}

UpdaterConfig configFor(const InstallLayout &layout,
                        const QString &current_version) {
  UpdaterConfig config;
  config.layout = layout;
  config.current_version = current_version;
  config.executable_path =
      QDir::cleanPath(QDir(layout.current).filePath(executableName()));
  config.keep_recent_versions = 1;
  return config;
}

} // namespace

class UpdaterTests : public QObject {
  Q_OBJECT

private slots:
  void assetNameMatchesThePublishedPackageName();
  void checksumIsReadForBothSha256sumSpellings();
  void checksumIsRefusedWhenMalformedOrMissing();
  void newerVersionComparesNumericallyAndRefusesGarbage();
  void stagedReleaseInstallsAndRepointsTheLink();
  void stagedReleaseLandsWhileTheOldBuildIsHeldOpen();
  void stagedReleaseRefusesAnUnsafeVersionName();
  void stagedReleaseRefusesAnEmptyStagingDirectory();
  void stagedReleaseRefusesWithoutTheInstallLock();
};

void UpdaterTests::assetNameMatchesThePublishedPackageName() {
  const QString name = releaseAssetName(QStringLiteral("1.3.2"));
  QVERIFY(name.startsWith(QStringLiteral("chrome-control-mcp-v1.3.2-")));
#if defined(Q_OS_WIN)
  QCOMPARE(name, QStringLiteral("chrome-control-mcp-v1.3.2-windows-x64.zip"));
#elif defined(Q_OS_MACOS)
  QVERIFY(name.endsWith(QStringLiteral(".tar.gz")));
  QVERIFY(name.contains(QStringLiteral("macos-")));
#else
  QCOMPARE(name, QStringLiteral("chrome-control-mcp-v1.3.2-linux-x64.tar.gz"));
#endif
  QVERIFY(releaseAssetName(QString{}).isEmpty());
}

void UpdaterTests::checksumIsReadForBothSha256sumSpellings() {
  const QString hash =
      QStringLiteral("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15"
                     "b0f00a08");
  const QString sums =
      QStringLiteral(
          "0000000000000000000000000000000000000000000000000000000000"
          "000000  other.zip\n") +
      hash + QStringLiteral("  wanted.zip\n") + hash +
      QStringLiteral(" *binary.zip\n");
  QCOMPARE(checksumForAsset(sums, QStringLiteral("wanted.zip")), hash);
  QCOMPARE(checksumForAsset(sums, QStringLiteral("binary.zip")), hash);
}

void UpdaterTests::checksumIsRefusedWhenMalformedOrMissing() {
  const QString sums = QStringLiteral("deadbeef  short.zip\n"
                                      "not-a-line\n");
  // A truncated hash must not be accepted and then compared successfully
  // against a truncated hash of the download.
  QVERIFY(checksumForAsset(sums, QStringLiteral("short.zip")).isEmpty());
  QVERIFY(checksumForAsset(sums, QStringLiteral("absent.zip")).isEmpty());
  QVERIFY(checksumForAsset(QString{}, QStringLiteral("absent.zip")).isEmpty());
  QVERIFY(checksumForAsset(sums, QString{}).isEmpty());
}

void UpdaterTests::newerVersionComparesNumericallyAndRefusesGarbage() {
  QVERIFY(isNewerVersion(QStringLiteral("1.10.0"), QStringLiteral("1.9.0")));
  QVERIFY(isNewerVersion(QStringLiteral("2.0.0"), QStringLiteral("1.99.99")));
  QVERIFY(!isNewerVersion(QStringLiteral("1.3.1"), QStringLiteral("1.3.1")));
  QVERIFY(!isNewerVersion(QStringLiteral("1.2.0"), QStringLiteral("1.3.1")));
  // An unparseable tag must never look like an upgrade.
  QVERIFY(!isNewerVersion(QStringLiteral("nightly"), QStringLiteral("1.3.1")));
  QVERIFY(!isNewerVersion(QStringLiteral("1.3.2"), QString{}));
}

void UpdaterTests::stagedReleaseInstallsAndRepointsTheLink() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(
      QDir(temporary.path()).filePath(QStringLiteral("root")));
  const InstallLock lock =
      InstallLock::acquire(layout, kInstallLockWaitMs, nullptr);
  QVERIFY(lock.held());
  QVERIFY(QDir().mkpath(layout.versions));

  const QString first = stageRelease(layout.versions, QStringLiteral("1.0.0"));
  QVERIFY(!first.isEmpty());
  const UpdateApplyResult installed =
      installStagedRelease(lock, configFor(layout, QStringLiteral("1.0.0")),
                           QStringLiteral("1.0.0"), first);
  QVERIFY2(installed.ok, qPrintable(installed.error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.0.0"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.0.0"));
  // Installing the version already running is not a restart-worthy event.
  QVERIFY(!installed.restart_required);

  const QString second = stageRelease(layout.versions, QStringLiteral("1.3.1"));
  QVERIFY(!second.isEmpty());
  const UpdateApplyResult upgraded =
      installStagedRelease(lock, configFor(layout, QStringLiteral("1.0.0")),
                           QStringLiteral("1.3.1"), second);
  QVERIFY2(upgraded.ok, qPrintable(upgraded.error));
  QCOMPARE(upgraded.previous_version, QStringLiteral("1.0.0"));
  QCOMPARE(upgraded.installed_version, QStringLiteral("1.3.1"));
  QVERIFY(upgraded.restart_required);
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));

  // The paths every external registration names must be the stable ones, and
  // they must not have moved.
  QCOMPARE(upgraded.executable_path,
           QDir::cleanPath(QDir(layout.current).filePath(executableName())));
  QCOMPARE(upgraded.extension_path,
           QDir::cleanPath(
               QDir(layout.current).filePath(QStringLiteral("extension"))));
  QVERIFY(QFileInfo::exists(upgraded.executable_path));
  QVERIFY(QFileInfo(upgraded.extension_path).isDir());
}

void UpdaterTests::stagedReleaseLandsWhileTheOldBuildIsHeldOpen() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(
      QDir(temporary.path()).filePath(QStringLiteral("root")));
  const InstallLock lock =
      InstallLock::acquire(layout, kInstallLockWaitMs, nullptr);
  QVERIFY(lock.held());
  QVERIFY(QDir().mkpath(layout.versions));

  const QString first = stageRelease(layout.versions, QStringLiteral("1.0.0"));
  QVERIFY(!first.isEmpty());
  QVERIFY(installStagedRelease(lock, configFor(layout, QStringLiteral("1.0.0")),
                               QStringLiteral("1.0.0"), first)
              .ok);

  // Stand in for the server that is serving this very call: its own executable
  // is open, and the update still has to succeed.
  QFile running(QDir(layout.versionDirectory(QStringLiteral("1.0.0")))
                    .filePath(executableName()));
  QVERIFY(running.open(QIODevice::ReadOnly));

  const QString second = stageRelease(layout.versions, QStringLiteral("1.3.1"));
  QVERIFY(!second.isEmpty());
  UpdaterConfig config = configFor(layout, QStringLiteral("1.0.0"));
  // Keep nothing but the new version, so pruning is forced to meet the busy
  // directory rather than skipping it for being recent.
  config.keep_recent_versions = 0;
  const UpdateApplyResult upgraded =
      installStagedRelease(lock, config, QStringLiteral("1.3.1"), second);
  QVERIFY2(upgraded.ok, qPrintable(upgraded.error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));

  // Pruning must leave a busy version whole rather than half-deleting it under
  // the process that is still running from it.
  QVERIFY(running.isOpen());
  QCOMPARE(QString::fromUtf8(running.readAll()), QStringLiteral("1.0.0"));
  running.close();
}

void UpdaterTests::stagedReleaseRefusesAnUnsafeVersionName() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(
      QDir(temporary.path()).filePath(QStringLiteral("root")));
  const InstallLock lock =
      InstallLock::acquire(layout, kInstallLockWaitMs, nullptr);
  QVERIFY(lock.held());
  QVERIFY(QDir().mkpath(layout.versions));
  const QString staged = stageRelease(layout.versions, QStringLiteral("1.3.1"));
  QVERIFY(!staged.isEmpty());

  const UpdateApplyResult result =
      installStagedRelease(lock, configFor(layout, QStringLiteral("1.0.0")),
                           QStringLiteral("../escape"), staged);
  QVERIFY(!result.ok);
  QVERIFY(result.error.contains(QStringLiteral("unsafe version")));
  QVERIFY(!QFileInfo::exists(
      QDir(temporary.path()).filePath(QStringLiteral("escape"))));
}

void UpdaterTests::stagedReleaseRefusesAnEmptyStagingDirectory() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(
      QDir(temporary.path()).filePath(QStringLiteral("root")));
  const InstallLock lock =
      InstallLock::acquire(layout, kInstallLockWaitMs, nullptr);
  QVERIFY(lock.held());
  const UpdateApplyResult result = installStagedRelease(
      lock, configFor(layout, QStringLiteral("1.0.0")), QStringLiteral("1.3.1"),
      QDir(temporary.path()).filePath(QStringLiteral("absent")));
  QVERIFY(!result.ok);
  QVERIFY(result.error.contains(QStringLiteral("Nothing staged")));
  QVERIFY(currentVersion(layout).isEmpty());
}

void UpdaterTests::stagedReleaseRefusesWithoutTheInstallLock() {
  // RED DRILL. This is the step that moves a directory into `versions/` and
  // then repoints `current` at it. Two of them running at once is exactly the
  // collision the lock exists to prevent, so running without one must fail --
  // and must fail before anything is moved, or a refusal would still have left
  // the install half-changed.
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(
      QDir(temporary.path()).filePath(QStringLiteral("root")));
  QVERIFY(QDir().mkpath(layout.versions));
  const QString staged = stageRelease(layout.versions, QStringLiteral("1.3.1"));
  QVERIFY(!staged.isEmpty());

  const InstallLock unheld;
  const UpdateApplyResult result =
      installStagedRelease(unheld, configFor(layout, QStringLiteral("1.0.0")),
                           QStringLiteral("1.3.1"), staged);
  QVERIFY(!result.ok);
  QVERIFY2(result.error.contains(QStringLiteral("install lock")),
           qPrintable(result.error));
  QVERIFY(currentVersion(layout).isEmpty());
  QVERIFY(!QFileInfo::exists(layout.versionDirectory(QStringLiteral("1.3.1"))));
  // The staged tree is still whole, so a caller that takes the lock and
  // retries has something to install.
  QCOMPARE(readMarker(staged), QStringLiteral("1.3.1"));
}

QTEST_MAIN(UpdaterTests)
#include "test_updater.moc"
