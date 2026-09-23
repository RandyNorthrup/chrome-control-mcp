// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

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

// A version directory with enough in it to be worth not corrupting: the
// executable name the install path looks for and one extra file, so a partial
// deletion would be visible.
bool makeVersion(const InstallLayout &layout, const QString &version) {
  const QString directory = layout.versionDirectory(version);
  if (directory.isEmpty() || !QDir().mkpath(directory)) {
    return false;
  }
  for (const QString &name : {executableName(), QStringLiteral("marker.txt")}) {
    QFile file(QDir(directory).filePath(name));
    if (!file.open(QIODevice::WriteOnly)) {
      return false;
    }
    file.write(version.toUtf8());
    file.close();
  }
  return true;
}

QString readMarker(const QString &directory) {
  QFile file(QDir(directory).filePath(QStringLiteral("marker.txt")));
  if (!file.open(QIODevice::ReadOnly)) {
    return {};
  }
  return QString::fromUtf8(file.readAll());
}

} // namespace

class InstallLayoutTests : public QObject {
  Q_OBJECT

private slots:
  void safeVersionNamesRejectTraversal();
  void versionDirectoryRefusesUnsafeNames();
  void installRootRecognizesBothLaunchShapes();
  void stableExecutablePathRewritesVersionedLaunch();
  void stableExecutablePathLeavesForeignPathsAlone();
  void installedVersionsSortByNumberNotText();
  void currentLinkPointsAtRequestedVersion();
  void currentLinkRepointsWhileAFileIsHeldOpen();
  void currentLinkRefusesToReplaceARealDirectory();
  void pruneKeepsCurrentAndTheRequestedRecentVersions();
};

void InstallLayoutTests::safeVersionNamesRejectTraversal() {
  QVERIFY(isSafeVersionName(QStringLiteral("1.3.1")));
  QVERIFY(isSafeVersionName(QStringLiteral("1.3.1-rc.2")));
  QVERIFY(!isSafeVersionName(QString{}));
  QVERIFY(!isSafeVersionName(QStringLiteral("..")));
  QVERIFY(!isSafeVersionName(QStringLiteral(".")));
  QVERIFY(!isSafeVersionName(QStringLiteral("../1.3.1")));
  QVERIFY(!isSafeVersionName(QStringLiteral("1.3.1/evil")));
  QVERIFY(!isSafeVersionName(QStringLiteral("1.3.1\\evil")));
  QVERIFY(!isSafeVersionName(QStringLiteral("C:1.3.1")));
}

void InstallLayoutTests::versionDirectoryRefusesUnsafeNames() {
  const InstallLayout layout =
      InstallLayout::forRoot(QStringLiteral("/tmp/ccmcp-root"));
  QVERIFY(!layout.versionDirectory(QStringLiteral("1.3.1")).isEmpty());
  QVERIFY(layout.versionDirectory(QStringLiteral("../escape")).isEmpty());
  QVERIFY(layout.versionDirectory(QString{}).isEmpty());
}

void InstallLayoutTests::installRootRecognizesBothLaunchShapes() {
  const QString root = QDir::cleanPath(QStringLiteral("/opt/ccmcp"));
  const InstallLayout layout = InstallLayout::forRoot(root);

  const QString through_link = QDir(layout.current).filePath(executableName());
  QCOMPARE(installRootForExecutable(through_link), layout.root);

  const QString resolved =
      QDir(layout.versionDirectory(QStringLiteral("1.3.1")))
          .filePath(executableName());
  QCOMPARE(installRootForExecutable(resolved), layout.root);

  QVERIFY(
      installRootForExecutable(
          QDir::cleanPath(QStringLiteral("/opt/elsewhere/") + executableName()))
          .isEmpty());
  QVERIFY(installRootForExecutable(QString{}).isEmpty());
}

void InstallLayoutTests::stableExecutablePathRewritesVersionedLaunch() {
  const InstallLayout layout =
      InstallLayout::forRoot(QDir::cleanPath(QStringLiteral("/opt/ccmcp")));
  const QString resolved =
      QDir(layout.versionDirectory(QStringLiteral("1.3.1")))
          .filePath(executableName());
  const QString expected =
      QDir::cleanPath(QDir(layout.current).filePath(executableName()));
  // This is the rewrite Chrome's registration depends on: what the operating
  // system reports is the versioned copy, and what gets registered has to be
  // the link that survives the next update.
  QCOMPARE(stableExecutablePath(resolved), expected);
  QCOMPARE(stableExecutablePath(expected), expected);
}

void InstallLayoutTests::stableExecutablePathLeavesForeignPathsAlone() {
  const QString outside = QDir::cleanPath(
      QStringLiteral("/home/someone/build/") + executableName());
  QCOMPARE(stableExecutablePath(outside), outside);
}

void InstallLayoutTests::installedVersionsSortByNumberNotText() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  for (const QString &version :
       {QStringLiteral("1.9.0"), QStringLiteral("1.10.0"),
        QStringLiteral("1.3.1"), QStringLiteral("2.0.0")}) {
    QVERIFY(makeVersion(layout, version));
  }
  // A directory that is not a version must not be mistaken for one.
  QVERIFY(
      QDir().mkpath(QDir(layout.versions).filePath(QStringLiteral(".tmp"))));

  const QStringList versions = installedVersions(layout);
  const QStringList expected{QStringLiteral("2.0.0"), QStringLiteral("1.10.0"),
                             QStringLiteral("1.9.0"), QStringLiteral("1.3.1")};
  QCOMPARE(versions, expected);
}

void InstallLayoutTests::currentLinkPointsAtRequestedVersion() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));

  QString error;
  QVERIFY2(pointCurrentAtVersion(layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(currentLinkTarget(layout),
           layout.versionDirectory(QStringLiteral("1.3.1")));
  // The link has to be usable as a path, not merely present: everything
  // external to this program reaches the install through it.
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));

  QVERIFY(!pointCurrentAtVersion(layout, QStringLiteral("9.9.9"), &error));
  QVERIFY(!error.isEmpty());
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
}

void InstallLayoutTests::currentLinkRepointsWhileAFileIsHeldOpen() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  QVERIFY(makeVersion(layout, QStringLiteral("1.0.0")));
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));

  QString error;
  QVERIFY2(pointCurrentAtVersion(layout, QStringLiteral("1.0.0"), &error),
           qPrintable(error));

  // The whole reason this layout exists: a running server holds its own files
  // open, and the update still has to land. Hold one open across the swap.
  QFile busy(QDir(layout.versionDirectory(QStringLiteral("1.0.0")))
                 .filePath(executableName()));
  QVERIFY(busy.open(QIODevice::ReadOnly));

  QVERIFY2(pointCurrentAtVersion(layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));
  // The old version is untouched, so the process still reading it keeps
  // working.
  QVERIFY(busy.isOpen());
  QCOMPARE(QString::fromUtf8(busy.readAll()), QStringLiteral("1.0.0"));
  busy.close();
}

void InstallLayoutTests::currentLinkRefusesToReplaceARealDirectory() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));
  QVERIFY(QDir().mkpath(layout.current));
  QFile precious(QDir(layout.current).filePath(QStringLiteral("mine.txt")));
  QVERIFY(precious.open(QIODevice::WriteOnly));
  precious.close();

  QString error;
  QVERIFY(!pointCurrentAtVersion(layout, QStringLiteral("1.3.1"), &error));
  QVERIFY(error.contains(QStringLiteral("not a link")));
  QVERIFY(QFileInfo::exists(
      QDir(layout.current).filePath(QStringLiteral("mine.txt"))));
}

void InstallLayoutTests::pruneKeepsCurrentAndTheRequestedRecentVersions() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  for (const QString &version :
       {QStringLiteral("1.0.0"), QStringLiteral("1.2.2"),
        QStringLiteral("1.3.0"), QStringLiteral("1.3.1")}) {
    QVERIFY(makeVersion(layout, version));
  }
  QString error;
  QVERIFY2(pointCurrentAtVersion(layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));

  QCOMPARE(pruneInstalledVersions(layout, QStringLiteral("1.3.1"), 1), 2);
  const QStringList remaining = installedVersions(layout);
  const QStringList expected{QStringLiteral("1.3.1"), QStringLiteral("1.3.0")};
  QCOMPARE(remaining, expected);
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));

  // Pruning again with nothing left to remove is not an error and removes
  // nothing.
  QCOMPARE(pruneInstalledVersions(layout, QStringLiteral("1.3.1"), 1), 0);
}

QTEST_MAIN(InstallLayoutTests)
#include "test_install_layout.moc"
