// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_security.h"

#include <QFile>
#include <QTemporaryDir>
#include <QtTest/QtTest>

#ifdef Q_OS_WIN
#include <sddl.h>
#else
#include <unistd.h>
#endif

using chrome_control_mcp::browserBridgePipeName;
using chrome_control_mcp::currentUserSidString;
using chrome_control_mcp::generateBridgeToken;
using chrome_control_mcp::readRendezvousRecord;
using chrome_control_mcp::RendezvousRecord;
using chrome_control_mcp::writeRendezvousRecord;

namespace {

#ifdef Q_OS_WIN
bool aclContainsSidWithMask(PACL acl, BYTE ace_type, PSID expected_sid,
                            ACCESS_MASK required_mask) {
  if (acl == nullptr || expected_sid == nullptr) {
    return false;
  }
  for (DWORD index = 0; index < acl->AceCount; ++index) {
    void *raw_ace = nullptr;
    if (GetAce(acl, index, &raw_ace) == FALSE || raw_ace == nullptr) {
      return false;
    }
    const auto *header = static_cast<const ACE_HEADER *>(raw_ace);
    if (header->AceType != ace_type) {
      continue;
    }
    // ACCESS_ALLOWED_ACE and SYSTEM_MANDATORY_LABEL_ACE share the same
    // Header/Mask/SidStart layout.
    const auto *ace = static_cast<const ACCESS_ALLOWED_ACE *>(raw_ace);
    auto *ace_sid = reinterpret_cast<PSID>(const_cast<DWORD *>(
        &ace->SidStart)); // Windows API is not const-correct.
    if (EqualSid(ace_sid, expected_sid) != FALSE &&
        (ace->Mask & required_mask) == required_mask) {
      return true;
    }
  }
  return false;
}
#endif

} // namespace

class BrowserBridgeSecurityTests : public QObject {
  Q_OBJECT

private slots:
  void currentUserSid_isAWellFormedUserSid();
  void pipeName_isScopedNoncedAndUnique();
  void token_is128BitHexAndUnique();
  void rendezvous_roundTripsAllFields();
  void rendezvous_readMissingFileFails();
  void rendezvous_invalidAppPidFailsClosed();
  void rendezvous_overCapFileFailsClosed();   // R5-G10-9
  void rendezvous_malformedJsonFailsClosed(); // R5-G10-9
  void security_daclIsCurrentUserOnlyWithMediumLabel();
};

void BrowserBridgeSecurityTests::currentUserSid_isAWellFormedUserSid() {
  QString error;
  const QString sid = currentUserSidString(&error);
  QVERIFY2(!sid.isEmpty(), qPrintable(error));
#ifdef Q_OS_WIN
  QVERIFY(sid.startsWith(QStringLiteral("S-1-")));
#else
  QCOMPARE(sid, QString::number(geteuid()));
#endif
}

void BrowserBridgeSecurityTests::pipeName_isScopedNoncedAndUnique() {
  QString error;
  const QString sid = currentUserSidString(&error);
  const QString a = browserBridgePipeName(&error);
  const QString b = browserBridgePipeName(&error);
  QVERIFY2(!a.isEmpty(), qPrintable(error));
#ifdef Q_OS_WIN
  QVERIFY(a.startsWith(
      QStringLiteral("\\\\.\\pipe\\ChromeControlMCP_BrowserBridge_")));
#else
  QVERIFY(QFileInfo(a).fileName().startsWith(QStringLiteral("bridge-")));
  QVERIFY(a.endsWith(QStringLiteral(".sock")));
#endif
  QVERIFY(a.contains(sid)); // scoped to this user
  QVERIFY(a != b);          // nonce makes each name unique
}

void BrowserBridgeSecurityTests::token_is128BitHexAndUnique() {
  const QString a = generateBridgeToken();
  const QString b = generateBridgeToken();
  QCOMPARE(a.size(), 32); // 128 bits as hex
  QVERIFY(a != b);
  for (const QChar c : a) {
    QVERIFY(c.isDigit() || (c >= QLatin1Char('a') && c <= QLatin1Char('f')));
  }
}

void BrowserBridgeSecurityTests::rendezvous_roundTripsAllFields() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString path =
      dir.filePath(QStringLiteral("sub/browser_bridge.json")); // nested: mkpath
  const RendezvousRecord in{
      QStringLiteral("\\\\.\\pipe\\ChromeControlMCP_BrowserBridge_x"),
      QStringLiteral("deadbeefdeadbeefdeadbeefdeadbeef"), 1, 4242};
  QString error;
  QVERIFY2(writeRendezvousRecord(path, in, &error), qPrintable(error));

  RendezvousRecord out;
  QVERIFY2(readRendezvousRecord(path, &out, &error), qPrintable(error));
  QCOMPARE(out.pipe_name, in.pipe_name);
  QCOMPARE(out.token, in.token);
  QCOMPARE(out.protocol, in.protocol);
  QCOMPARE(out.app_pid, in.app_pid);
}

void BrowserBridgeSecurityTests::rendezvous_readMissingFileFails() {
  QTemporaryDir dir;
  const QString missing = dir.filePath(QStringLiteral("does_not_exist.json"));
  RendezvousRecord out;
  QString error;
  QVERIFY(!readRendezvousRecord(missing, &out, &error));
  // Pin the file-open guard specifically (the errorString() tail is
  // OS/locale-variant).
  QVERIFY(error.startsWith(QStringLiteral("Cannot open ")));
  QVERIFY(error.contains(QStringLiteral("does_not_exist.json")));
}

void BrowserBridgeSecurityTests::rendezvous_invalidAppPidFailsClosed() {
  // F26: app_pid must be a positive integer within the exact-integer double
  // range. A record carrying an out-of-range app_pid must FAIL the read
  // (casting such a double to qint64 is UB) rather than yielding a garbage pid
  // the relay would then try to bind against.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString path = dir.filePath(QStringLiteral("bad.json"));
  QFile file(path);
  QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
  // 1e19 is beyond both int64 and the exact-integer double range.
  file.write(
      R"({"pipe_name":"\\\\.\\pipe\\x","token":"deadbeef","protocol":1,"app_pid":1e19})");
  file.close();

  RendezvousRecord out;
  QString error;
  QVERIFY(!readRendezvousRecord(path, &out, &error));
  QCOMPARE(error, QStringLiteral("Rendezvous record has an invalid app_pid."));
}

void BrowserBridgeSecurityTests::rendezvous_overCapFileFailsClosed() {
  // The on-disk rendezvous record is untrusted: a hostile same-user process can
  // rewrite it. readRendezvousRecord bounds the read at 64 KiB and refuses an
  // over-cap file BEFORE the JSON parse, so a multi-megabyte record cannot
  // force an unbounded allocation. The existing tests cover a missing file and
  // an out-of-range app_pid, never an over-cap file.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString path = dir.filePath(QStringLiteral("oversized.json"));
  QFile file(path);
  QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
  // 65 KiB > the 64 KiB cap. The size check fires before any parse, so the
  // content need not be valid JSON.
  file.write(QByteArray(65 * 1024, 'x'));
  file.close();

  RendezvousRecord out;
  QString error;
  QVERIFY(!readRendezvousRecord(path, &out, &error));
  QCOMPARE(error, QStringLiteral("Rendezvous record is too large."));
}

void BrowserBridgeSecurityTests::rendezvous_malformedJsonFailsClosed() {
  // A size-legal (<= 64 KiB) but malformed record body must fail closed at the
  // parse guard, BEFORE pipe_name/token/app_pid (which steer where the relay
  // connects and what token it presents) are trusted. Covers both a JSON parse
  // error and a valid-but-non-object document. The existing tests stop earlier:
  // missing-file at open, over-cap at the size check (before the parse), and
  // invalid-app_pid on a well-formed object.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  RendezvousRecord out;
  for (const QByteArray &body :
       {QByteArray("{\"pipe_name\":"),      // truncated write: parse error
        QByteArray("[1,2,3]"),              // valid JSON, but not object
        QByteArray("\"just-a-string\"")}) { // valid JSON, but not object
    const QString path = dir.filePath(QStringLiteral("malformed.json"));
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
    file.write(body);
    file.close();
    QString error;
    QVERIFY2(!readRendezvousRecord(path, &out, &error), body.constData());
    QVERIFY2(error.contains(QStringLiteral("Malformed rendezvous record")),
             qPrintable(error));
  }
}

void BrowserBridgeSecurityTests::
    security_daclIsCurrentUserOnlyWithMediumLabel() {
#ifdef Q_OS_WIN
  using chrome_control_mcp::buildBridgePipeSecurity;
  SECURITY_ATTRIBUTES attributes{};
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  QString error;
  QVERIFY2(buildBridgePipeSecurity(&attributes, &descriptor, &error),
           qPrintable(error));
  QVERIFY(descriptor != nullptr);
  QCOMPARE(attributes.bInheritHandle, FALSE);

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  QVERIFY(GetSecurityDescriptorControl(descriptor, &control, &revision) !=
          FALSE);
  QVERIFY((control & SE_DACL_PROTECTED) != 0);

  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL dacl = nullptr;
  QVERIFY(GetSecurityDescriptorDacl(descriptor, &dacl_present, &dacl,
                                    &dacl_defaulted) != FALSE);
  QVERIFY(dacl_present != FALSE);
  QVERIFY(dacl != nullptr);

  const QString sid = currentUserSidString(&error);
  PSID user_sid = nullptr;
  QVERIFY(ConvertStringSidToSidW(reinterpret_cast<LPCWSTR>(sid.utf16()),
                                 &user_sid) != FALSE);
  QVERIFY(aclContainsSidWithMask(dacl, ACCESS_ALLOWED_ACE_TYPE, user_sid,
                                 GENERIC_ALL));

  PSID system_sid = nullptr;
  QVERIFY(ConvertStringSidToSidW(L"S-1-5-18", &system_sid) != FALSE);
  QVERIFY(aclContainsSidWithMask(dacl, ACCESS_ALLOWED_ACE_TYPE, system_sid,
                                 GENERIC_ALL));

  BOOL sacl_present = FALSE;
  BOOL sacl_defaulted = FALSE;
  PACL sacl = nullptr;
  QVERIFY(GetSecurityDescriptorSacl(descriptor, &sacl_present, &sacl,
                                    &sacl_defaulted) != FALSE);
  QVERIFY(sacl_present != FALSE);
  QVERIFY(sacl != nullptr);
  PSID medium_sid = nullptr;
  QVERIFY(ConvertStringSidToSidW(L"S-1-16-8192", &medium_sid) != FALSE);
  constexpr ACCESS_MASK required_label_mask =
      SYSTEM_MANDATORY_LABEL_NO_READ_UP | SYSTEM_MANDATORY_LABEL_NO_WRITE_UP;
  QVERIFY(aclContainsSidWithMask(sacl, SYSTEM_MANDATORY_LABEL_ACE_TYPE,
                                 medium_sid, required_label_mask));

  // The descriptor must be one the OS actually accepts on a first-instance,
  // remote-rejecting pipe (a convertible SDDL is not proof CreateNamedPipe
  // accepts it -- the Medium mandatory label in particular must be settable at
  // our own IL).
  const std::wstring name = browserBridgePipeName(&error).toStdWString();
  HANDLE pipe = CreateNamedPipeW(
      name.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096,
      4096, 0, &attributes);
  QVERIFY2(pipe != INVALID_HANDLE_VALUE,
           qPrintable(QStringLiteral(
                          "CreateNamedPipe rejected the descriptor (err=%1)")
                          .arg(GetLastError())));
  CloseHandle(pipe);
  LocalFree(medium_sid);
  LocalFree(system_sid);
  LocalFree(user_sid);
  LocalFree(descriptor);
#else
  QString error;
  const QString endpoint = browserBridgePipeName(&error);
  QVERIFY2(!endpoint.isEmpty(), qPrintable(error));
  const QFileInfo directory(QFileInfo(endpoint).absolutePath());
  QCOMPARE(directory.ownerId(), static_cast<uint>(geteuid()));
  const QFileDevice::Permissions permissions = directory.permissions();
  QVERIFY((permissions & QFileDevice::ReadOwner) != 0);
  QVERIFY((permissions & QFileDevice::WriteOwner) != 0);
  QVERIFY((permissions & QFileDevice::ExeOwner) != 0);
  QVERIFY((permissions & (QFileDevice::ReadGroup | QFileDevice::WriteGroup |
                          QFileDevice::ExeGroup | QFileDevice::ReadOther |
                          QFileDevice::WriteOther | QFileDevice::ExeOther)) ==
          0);
#endif
}

QTEST_MAIN(BrowserBridgeSecurityTests)
#include "test_browser_bridge_security.moc"
