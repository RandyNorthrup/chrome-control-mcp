// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Identity across a junction.
//
// A managed install is launched through `current`, a directory junction onto
// `versions/<v>`. The bridge refuses any peer that is not running our own
// binary, so "is that process me" has to survive the same file being reachable
// by two names. It did not: the relay asked about ITSELF with
// GetModuleFileNameW (which reports the path it was launched through) and about
// its PEER with QueryFullProcessImageNameW (which reports what that resolves
// to), so a managed install called its own server a foreign image and the
// bridge never attached.
//
// The drill therefore cannot run entirely in this process: the asymmetry only
// bites the side that was itself launched through the junction. This test
// builds a real junction, re-launches ITSELF through it, and has that child --
// standing where the relay stands -- decide whether the parent is the same
// binary. Against the old two-call implementation that answer is "no".

#include "chrome_control_mcp/windows_process_identity.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QString>
#include <QStringList>
#include <QtTest>

#include <cstdio>
#include <cstring>
#include <utility>

#include <windows.h>

using namespace chrome_control_mcp;

namespace {

constexpr char kChildFlag[] = "--print-identity";

// Holds the scratch directory for the junction test and takes it down again
// without ever descending through the junction: the link is removed as a link,
// and only then is the directory that held it removed, non-recursively.
//
// QTemporaryDir cannot do this job. Its cleanup is recursive and DOES follow a
// junction -- the first run of this test deleted the contents of the build
// directory the junction pointed at. A destructor is what makes the teardown
// survive a failing QVERIFY, which returns early.
class JunctionScratch {
public:
  explicit JunctionScratch(QString dir) : dir_(std::move(dir)) {}
  ~JunctionScratch() {
    if (!link_.isEmpty()) {
      const QString native = QDir::toNativeSeparators(link_);
      RemoveDirectoryW(reinterpret_cast<const wchar_t *>(native.utf16()));
    }
    QDir().rmdir(dir_);
  }
  JunctionScratch(const JunctionScratch &) = delete;
  JunctionScratch &operator=(const JunctionScratch &) = delete;
  JunctionScratch(JunctionScratch &&) = delete;
  JunctionScratch &operator=(JunctionScratch &&) = delete;

  // Called once the junction exists, so a failure before that leaves nothing
  // to undo.
  void holds(const QString &link) { link_ = link; }

private:
  QString dir_;
  QString link_;
};

// What the process was LAUNCHED through, which is what the old implementation
// compared against. Kept here, in the test, precisely because production no
// longer has a copy.
QString launchPath() {
  wchar_t buffer[MAX_PATH * 2] = {0};
  const DWORD length = GetModuleFileNameW(nullptr, buffer, MAX_PATH * 2);
  return QString::fromWCharArray(buffer, static_cast<int>(length));
}

bool containsJunctionComponent(const QString &path) {
  return path.contains(QStringLiteral("\\link\\"), Qt::CaseInsensitive);
}

} // namespace

class WindowsProcessIdentityTest : public QObject {
  Q_OBJECT

private slots:
  void ownImageIsThisBinary();
  void ourOwnPidIsUs();
  void anUnreachablePidIsNotUs();
  void anotherProgramIsNotUs();
  void aChildLaunchedThroughAJunctionStillSeesUsAsItself();
};

void WindowsProcessIdentityTest::ownImageIsThisBinary() {
  const QString own = ownProcessImage();
  QVERIFY(!own.isEmpty());
  QCOMPARE(QFileInfo(own).fileName().compare(
               QFileInfo(QCoreApplication::applicationFilePath()).fileName(),
               Qt::CaseInsensitive),
           0);
}

void WindowsProcessIdentityTest::ourOwnPidIsUs() {
  QVERIFY(isOwnExecutable(static_cast<quint32>(GetCurrentProcessId())));
}

void WindowsProcessIdentityTest::anUnreachablePidIsNotUs() {
  // An image that cannot be read is a refusal, never a match. 0 is the System
  // Idle pseudo-process: it is always "there" and never queryable, so it is the
  // stable way to ask for an answer we must not get.
  QVERIFY(!isOwnExecutable(0));
}

void WindowsProcessIdentityTest::anotherProgramIsNotUs() {
  QProcess stranger;
  stranger.start(QStringLiteral("cmd.exe"),
                 {QStringLiteral("/c"), QStringLiteral("ping"),
                  QStringLiteral("-n"), QStringLiteral("10"),
                  QStringLiteral("127.0.0.1")});
  QVERIFY2(stranger.waitForStarted(5000), "could not start a stranger process");
  QVERIFY(!isOwnExecutable(static_cast<quint32>(stranger.processId())));
  stranger.kill();
  stranger.waitForFinished(5000);
}

void WindowsProcessIdentityTest::
    aChildLaunchedThroughAJunctionStillSeesUsAsItself() {
  const QString scratch_dir =
      QDir(QDir::tempPath())
          .filePath(QStringLiteral("ccmcp-junction-%1")
                        .arg(static_cast<quint32>(GetCurrentProcessId())));
  QVERIFY(QDir().mkpath(scratch_dir));
  JunctionScratch scratch(scratch_dir);

  const QString real_dir =
      QFileInfo(QCoreApplication::applicationFilePath()).absolutePath();
  const QString link = QDir(scratch_dir).filePath(QStringLiteral("link"));

  // mklink /J needs no elevation; a policy that forbids it is an environment
  // limit, not a failure of the code under test.
  QProcess mklink;
  mklink.start(QStringLiteral("cmd.exe"),
               {QStringLiteral("/c"), QStringLiteral("mklink"),
                QStringLiteral("/J"), QDir::toNativeSeparators(link),
                QDir::toNativeSeparators(real_dir)});
  QVERIFY(mklink.waitForFinished(10000));
  if (mklink.exitCode() != 0) {
    QSKIP("this environment will not create a directory junction");
  }
  scratch.holds(link);

  const QString child_exe = QDir(link).filePath(
      QFileInfo(QCoreApplication::applicationFilePath()).fileName());

  QProcess child;
  child.start(child_exe, {QString::fromLatin1(kChildFlag),
                          QString::number(GetCurrentProcessId())});
  QVERIFY2(child.waitForStarted(10000), "could not start through the junction");

  QString out;
  while (out.count(QLatin1Char('\n')) < 3 &&
         child.state() != QProcess::NotRunning) {
    if (!child.waitForReadyRead(10000)) {
      break;
    }
    out += QString::fromLocal8Bit(child.readAllStandardOutput());
  }
  child.kill();
  child.waitForFinished(5000);

  QString launched;
  QString resolved;
  QString verdict;
  for (const QString &line : out.split(QLatin1Char('\n'))) {
    const QString trimmed = line.trimmed();
    if (trimmed.startsWith(QStringLiteral("launched="))) {
      launched = trimmed.mid(9);
    } else if (trimmed.startsWith(QStringLiteral("resolved="))) {
      resolved = trimmed.mid(9);
    } else if (trimmed.startsWith(QStringLiteral("parent_is_us="))) {
      verdict = trimmed.mid(13);
    }
  }
  QVERIFY2(
      !verdict.isEmpty(),
      qPrintable(QStringLiteral("child produced no verdict; output was: ") +
                 out));

  // The premise: the child really did come up through the junction, so its own
  // launch path is spelled differently from where the file lives. Without this
  // the rest of the test would pass for the wrong reason.
  QVERIFY2(containsJunctionComponent(launched),
           qPrintable(QStringLiteral("child was not launched through the "
                                     "junction; launch path was ") +
                      launched));

  // What the fix buys: asked the same way as about a peer, the child's own
  // image resolves to the real file rather than to the name it was entered by.
  QVERIFY2(
      !containsJunctionComponent(resolved),
      qPrintable(QStringLiteral("own image did not resolve: ") + resolved));
  QCOMPARE(resolved.compare(ownProcessImage(), Qt::CaseInsensitive), 0);

  // The property the bridge depends on, decided from where the relay stands.
  QCOMPARE(verdict, QStringLiteral("true"));
}

int main(int argc, char *argv[]) {
  if (argc >= 3 && std::strcmp(argv[1], kChildFlag) == 0) {
    QCoreApplication app(argc, argv);
    const quint32 parent = QString::fromLatin1(argv[2]).toUInt();
    std::printf("launched=%s\n", qPrintable(launchPath()));
    std::printf("resolved=%s\n", qPrintable(ownProcessImage()));
    std::printf("parent_is_us=%s\n",
                isOwnExecutable(parent) ? "true" : "false");
    std::fflush(stdout);
    // Stay alive so the parent can query us while we exist.
    Sleep(30000);
    return 0;
  }
  QCoreApplication app(argc, argv);
  WindowsProcessIdentityTest test;
  return QTest::qExec(&test, argc, argv);
}

#include "test_windows_process_identity.moc"
