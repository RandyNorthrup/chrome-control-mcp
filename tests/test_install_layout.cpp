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

// Every mutating call needs the lock, so every test that makes one starts
// here. An uncontended acquire is immediate; the wait only matters when
// something else holds it, which is what the lock tests exercise directly.
InstallLock lockFor(const InstallLayout &layout) {
  return InstallLock::acquire(layout, kInstallLockWaitMs, nullptr);
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
  void aFailedSwapLeavesThePreviousVersionReachable();
  void pruneKeepsCurrentAndTheRequestedRecentVersions();
  void installLockAdmitsOneHolderAtATime();
  void mutatingWithoutTheLockChangesNothing();
  void aLockOnAnotherRootDoesNotGuardThisOne();
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
  const InstallLock lock = lockFor(layout);
  QVERIFY(lock.held());
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));

  QString error;
  QVERIFY2(pointCurrentAtVersion(lock, layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(currentLinkTarget(layout),
           layout.versionDirectory(QStringLiteral("1.3.1")));
  // The link has to be usable as a path, not merely present: everything
  // external to this program reaches the install through it.
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));

  QVERIFY(
      !pointCurrentAtVersion(lock, layout, QStringLiteral("9.9.9"), &error));
  QVERIFY(!error.isEmpty());
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
}

void InstallLayoutTests::currentLinkRepointsWhileAFileIsHeldOpen() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  const InstallLock lock = lockFor(layout);
  QVERIFY(lock.held());
  QVERIFY(makeVersion(layout, QStringLiteral("1.0.0")));
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));

  QString error;
  QVERIFY2(pointCurrentAtVersion(lock, layout, QStringLiteral("1.0.0"), &error),
           qPrintable(error));

  // The whole reason this layout exists: a running server holds its own files
  // open, and the update still has to land. Hold one open across the swap.
  QFile busy(QDir(layout.versionDirectory(QStringLiteral("1.0.0")))
                 .filePath(executableName()));
  QVERIFY(busy.open(QIODevice::ReadOnly));

  QVERIFY2(pointCurrentAtVersion(lock, layout, QStringLiteral("1.3.1"), &error),
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
  const InstallLock lock = lockFor(layout);
  QVERIFY(lock.held());
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));
  QVERIFY(QDir().mkpath(layout.current));
  QFile precious(QDir(layout.current).filePath(QStringLiteral("mine.txt")));
  QVERIFY(precious.open(QIODevice::WriteOnly));
  precious.close();

  QString error;
  QVERIFY(
      !pointCurrentAtVersion(lock, layout, QStringLiteral("1.3.1"), &error));
  QVERIFY(error.contains(QStringLiteral("not a link")));
  QVERIFY(QFileInfo::exists(
      QDir(layout.current).filePath(QStringLiteral("mine.txt"))));
}

void InstallLayoutTests::aFailedSwapLeavesThePreviousVersionReachable() {
  // RED DRILL for the invariant the whole layout exists to hold: everything
  // outside this program -- the client's command, Chrome's extension folder,
  // the native-messaging registration -- reaches the install through `current`.
  // A swap that fails must leave that name pointing at the version that was
  // working, because losing it breaks all three at once and no amount of
  // retrying puts them back.
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  const InstallLock lock = lockFor(layout);
  QVERIFY(lock.held());
  QVERIFY(makeVersion(layout, QStringLiteral("1.0.0")));
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));
  QString error;
  QVERIFY2(pointCurrentAtVersion(lock, layout, QStringLiteral("1.0.0"), &error),
           qPrintable(error));

  // A non-empty directory where the new link is staged blocks its creation on
  // both platforms: Windows cannot remove or create over it, and POSIX cannot
  // unlink or symlink over it either.
  const QString staged = layout.current + QStringLiteral(".swap");
  QVERIFY(QDir().mkpath(staged));
  QFile blocker(QDir(staged).filePath(QStringLiteral("occupied.txt")));
  QVERIFY(blocker.open(QIODevice::WriteOnly));
  blocker.close();

  QVERIFY(
      !pointCurrentAtVersion(lock, layout, QStringLiteral("1.3.1"), &error));
  QVERIFY(!error.isEmpty());

  // The previous version is still the one `current` names, and still readable
  // through it.
  QCOMPARE(currentVersion(layout), QStringLiteral("1.0.0"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.0.0"));

  // With the obstruction gone the swap succeeds, so the failure was the staged
  // path and not a layout left in a state that cannot recover.
  QVERIFY(QDir(staged).removeRecursively());
  QVERIFY2(pointCurrentAtVersion(lock, layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));
}

void InstallLayoutTests::pruneKeepsCurrentAndTheRequestedRecentVersions() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  const InstallLock lock = lockFor(layout);
  QVERIFY(lock.held());
  for (const QString &version :
       {QStringLiteral("1.0.0"), QStringLiteral("1.2.2"),
        QStringLiteral("1.3.0"), QStringLiteral("1.3.1")}) {
    QVERIFY(makeVersion(layout, version));
  }
  QString error;
  QVERIFY2(pointCurrentAtVersion(lock, layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));

  QCOMPARE(pruneInstalledVersions(lock, layout, QStringLiteral("1.3.1"), 1), 2);
  const QStringList remaining = installedVersions(layout);
  const QStringList expected{QStringLiteral("1.3.1"), QStringLiteral("1.3.0")};
  QCOMPARE(remaining, expected);
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.3.1"));

  // Pruning again with nothing left to remove is not an error and removes
  // nothing.
  QCOMPARE(pruneInstalledVersions(lock, layout, QStringLiteral("1.3.1"), 1), 0);
}

void InstallLayoutTests::installLockAdmitsOneHolderAtATime() {
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());

  QString error;
  InstallLock first = InstallLock::acquire(layout, 0, &error);
  QVERIFY2(first.held(), qPrintable(error));
  QVERIFY(first.guards(layout));

  // The lock lives in the open handle, not in the process, so a second
  // acquire is refused here exactly as it would be from another installer.
  // That is what makes this testable without spawning one.
  const InstallLock second = InstallLock::acquire(layout, 0, &error);
  QVERIFY(!second.held());
  QVERIFY(!second.guards(layout));
  QVERIFY2(error.contains(QStringLiteral("in progress")), qPrintable(error));

  // Releasing hands it on; a lock nobody can ever take again would turn one
  // failed update into a permanently unupdatable install.
  first.release();
  QVERIFY(!first.held());
  const InstallLock third = InstallLock::acquire(layout, 0, &error);
  QVERIFY2(third.held(), qPrintable(error));
}

void InstallLayoutTests::mutatingWithoutTheLockChangesNothing() {
  // RED DRILL for the requirement itself. The lock is only worth having if
  // calling without it FAILS rather than proceeding: a mutating function that
  // quietly ran unlocked would reopen every window the lock closes, and would
  // do it invisibly, because the successful result would look identical.
  QTemporaryDir temporary;
  QVERIFY(temporary.isValid());
  const InstallLayout layout = InstallLayout::forRoot(temporary.path());
  QVERIFY(makeVersion(layout, QStringLiteral("1.0.0")));
  QVERIFY(makeVersion(layout, QStringLiteral("1.2.2")));
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));

  QString error;
  {
    const InstallLock lock = lockFor(layout);
    QVERIFY(lock.held());
    QVERIFY2(
        pointCurrentAtVersion(lock, layout, QStringLiteral("1.0.0"), &error),
        qPrintable(error));
  }

  // A default-constructed lock holds nothing -- the state a caller that simply
  // forgot to acquire one would be in.
  const InstallLock unheld;
  QVERIFY(!unheld.held());
  QVERIFY(!unheld.guards(layout));

  QVERIFY(
      !pointCurrentAtVersion(unheld, layout, QStringLiteral("1.3.1"), &error));
  QVERIFY2(error.contains(QStringLiteral("install lock")), qPrintable(error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.0.0"));
  QCOMPARE(readMarker(layout.current), QStringLiteral("1.0.0"));

  QCOMPARE(pruneInstalledVersions(unheld, layout, QStringLiteral("1.0.0"), 0),
           0);
  const QStringList expected{QStringLiteral("1.3.1"), QStringLiteral("1.2.2"),
                             QStringLiteral("1.0.0")};
  QCOMPARE(installedVersions(layout), expected);
}

void InstallLayoutTests::aLockOnAnotherRootDoesNotGuardThisOne() {
  // Holding SOME lock is not the same as holding THIS install's lock. Two
  // installs under one user are ordinary -- an override root beside the
  // default -- and a lock that counted for both would serialize unrelated work
  // while protecting neither.
  QTemporaryDir mine;
  QTemporaryDir theirs;
  QVERIFY(mine.isValid());
  QVERIFY(theirs.isValid());
  const InstallLayout layout = InstallLayout::forRoot(mine.path());
  const InstallLayout elsewhere = InstallLayout::forRoot(theirs.path());
  QVERIFY(makeVersion(layout, QStringLiteral("1.3.1")));

  const InstallLock foreign = lockFor(elsewhere);
  QVERIFY(foreign.held());
  QVERIFY(!foreign.guards(layout));

  QString error;
  QVERIFY(
      !pointCurrentAtVersion(foreign, layout, QStringLiteral("1.3.1"), &error));
  QVERIFY2(error.contains(QStringLiteral("install lock")), qPrintable(error));
  QVERIFY(currentVersion(layout).isEmpty());

  // And the install's own lock is still free to take, so the foreign holder
  // did not block it either.
  const InstallLock own = InstallLock::acquire(layout, 0, &error);
  QVERIFY2(own.held(), qPrintable(error));
  QVERIFY2(pointCurrentAtVersion(own, layout, QStringLiteral("1.3.1"), &error),
           qPrintable(error));
  QCOMPARE(currentVersion(layout), QStringLiteral("1.3.1"));
}

QTEST_MAIN(InstallLayoutTests)
#include "test_install_layout.moc"
