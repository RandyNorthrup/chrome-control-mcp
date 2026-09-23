// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_security.h"

#include "chrome_control_mcp/error_out.h"

#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRandomGenerator>
#include <QStandardPaths>
#include <QVector>

#include <cmath>

#ifdef Q_OS_WIN
#include <sddl.h>
#else
#include <unistd.h>
#endif

namespace chrome_control_mcp {

namespace {

constexpr int kNonceHexWidth = 16; // 64-bit nonce as zero-padded hex
constexpr int kHexBase = 16;

// Upper bound for a valid app_pid: the largest value that survives a
// double->qint64 cast exactly. Anything above this exact-integer double range
// fails the record closed.
constexpr double kMaxAppPidExactDouble = 9.0e15;

// A well-formed rendezvous record (pipe_name, token, protocol, app_pid) is well
// under 1 KiB. Cap the read so a corrupt/oversized file cannot force an
// unbounded allocation before parse.
constexpr qint64 kMaxRendezvousRecordBytes = qint64{64} * 1024;

#ifdef Q_OS_WIN
QString lastError(const QString &api) {
  return QStringLiteral("%1 failed (GetLastError=%2)")
      .arg(api)
      .arg(GetLastError());
}
#endif

// Random 64-bit value as zero-padded hex, drawn from the OS CSPRNG.
QString randomHex64() {
  const quint64 value = QRandomGenerator::system()->generate64();
  return QStringLiteral("%1").arg(value, kNonceHexWidth, kHexBase,
                                  QLatin1Char('0'));
}

// The directory kBrowserBridgeRuntimeDirVariable names. Returns false when it
// is not set. When it is set but unusable, *path is empty and *error says why:
// it is used as given or not at all, because falling back to the shared
// location would pair this process with whichever browser answers there. It
// must be absolute -- Chrome starts the relay in a directory of its choosing.
bool runtimeDirectoryOverride(QString *path, QString *error) {
  const QString configured =
      qEnvironmentVariable(kBrowserBridgeRuntimeDirVariable);
  if (configured.isEmpty()) {
    return false;
  }
  if (QDir::isRelativePath(configured)) {
    path->clear();
    setError(error, QStringLiteral("%1 must be an absolute path, not \"%2\".")
                        .arg(QLatin1String(kBrowserBridgeRuntimeDirVariable),
                             configured));
    return true;
  }
  *path = QDir::cleanPath(configured);
  return true;
}

#ifndef Q_OS_WIN
QString bridgeRuntimeDirectory(QString *error) {
  QString configured;
  if (runtimeDirectoryOverride(&configured, error)) {
    return configured;
  }
  const QString suffix = QStringLiteral("chrome-control-mcp-%1").arg(geteuid());
  const QString base =
      QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
  QString candidate = QDir(base).filePath(suffix);
  // sockaddr_un::sun_path is only 104 bytes on macOS. Keep ample room for the
  // random socket filename even when the platform runtime path is long.
  if (base.isEmpty() || candidate.toUtf8().size() > 64) {
    candidate = QDir(QDir::tempPath()).filePath(suffix);
  }
  return QDir::cleanPath(candidate);
}

bool ensurePrivateDirectory(const QString &path, QString *error) {
  if (!QDir().mkpath(path) ||
      !QFile::setPermissions(path, QFileDevice::ReadOwner |
                                       QFileDevice::WriteOwner |
                                       QFileDevice::ExeOwner)) {
    setError(
        error,
        QStringLiteral("Cannot create private runtime directory %1").arg(path));
    return false;
  }
  const QFileInfo info(path);
  if (info.ownerId() != static_cast<uint>(geteuid())) {
    setError(error,
             QStringLiteral("Runtime directory is not owned by this user: %1")
                 .arg(path));
    return false;
  }
  return true;
}
#endif

} // namespace

QString currentUserSidString(QString *error) {
#ifdef Q_OS_WIN
  HANDLE token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) == FALSE) {
    setError(error, lastError(QStringLiteral("OpenProcessToken")));
    return {};
  }
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  QVector<char> buffer(static_cast<int>(needed) > 0 ? static_cast<int>(needed)
                                                    : 1);
  QString result;
  if (GetTokenInformation(token, TokenUser, buffer.data(), needed, &needed) !=
      FALSE) {
    const auto *user = reinterpret_cast<const TOKEN_USER *>(buffer.constData());
    LPWSTR sid_string = nullptr;
    if (ConvertSidToStringSidW(user->User.Sid, &sid_string) != FALSE) {
      result = QString::fromWCharArray(sid_string);
      LocalFree(sid_string);
    } else {
      setError(error, lastError(QStringLiteral("ConvertSidToStringSid")));
    }
  } else {
    setError(error, lastError(QStringLiteral("GetTokenInformation")));
  }
  CloseHandle(token);
  return result;
#else
  Q_UNUSED(error);
  return QString::number(geteuid());
#endif
}

QString browserBridgePipeName(QString *error) {
#ifdef Q_OS_WIN
  const QString sid = currentUserSidString(error);
  if (sid.isEmpty()) {
    return {};
  }
  DWORD session = 0;
  if (ProcessIdToSessionId(GetCurrentProcessId(), &session) == FALSE) {
    setError(error, lastError(QStringLiteral("ProcessIdToSessionId")));
    return {};
  }
  return QStringLiteral("\\\\.\\pipe\\ChromeControlMCP_BrowserBridge_%1_%2_%3")
      .arg(sid)
      .arg(session)
      .arg(randomHex64());
#else
  const QString directory = bridgeRuntimeDirectory(error);
  if (directory.isEmpty() || !ensurePrivateDirectory(directory, error)) {
    return {};
  }
  return QDir(directory).filePath(
      QStringLiteral("bridge-%1-%2.sock").arg(getpid()).arg(randomHex64()));
#endif
}

QString generateBridgeToken() {
  return randomHex64() + randomHex64(); // 128-bit
}

QString browserBridgeRendezvousPath(QString *error) {
#ifdef Q_OS_WIN
  QString configured;
  if (runtimeDirectoryOverride(&configured, error)) {
    return configured.isEmpty()
               ? QString()
               : QDir(configured)
                     .filePath(QStringLiteral("browser_bridge.json"));
  }
  QString base = qEnvironmentVariable("LOCALAPPDATA");
  if (base.isEmpty()) {
    base =
        QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
  }
  return QDir(base).filePath(
      QStringLiteral("ChromeControlMCP/browser_bridge.json"));
#else
  const QString directory = bridgeRuntimeDirectory(error);
  return directory.isEmpty()
             ? QString()
             : QDir(directory).filePath(QStringLiteral("browser_bridge.json"));
#endif
}

bool writeRendezvousRecord(const QString &path, const RendezvousRecord &record,
                           QString *error) {
  const QFileInfo info(path);
  if (!QDir().mkpath(info.absolutePath())) {
    setError(
        error,
        QStringLiteral("Cannot create directory %1").arg(info.absolutePath()));
    return false;
  }
#ifndef Q_OS_WIN
  if (!ensurePrivateDirectory(info.absolutePath(), error)) {
    return false;
  }
#endif
  const QJsonObject object{{QStringLiteral("pipe_name"), record.pipe_name},
                           {QStringLiteral("token"), record.token},
                           {QStringLiteral("protocol"), record.protocol},
                           {QStringLiteral("app_pid"), record.app_pid}};
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
    setError(error, QStringLiteral("Cannot open %1 for writing: %2")
                        .arg(path, file.errorString()));
    return false;
  }
  const QByteArray bytes = QJsonDocument(object).toJson(QJsonDocument::Compact);
  if (file.write(bytes) != bytes.size() || !file.flush()) {
    setError(
        error,
        QStringLiteral("Cannot write %1: %2").arg(path, file.errorString()));
    return false;
  }
#ifndef Q_OS_WIN
  if (!file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner)) {
    setError(error,
             QStringLiteral("Cannot secure rendezvous record %1").arg(path));
    return false;
  }
#endif
  return true;
}

bool readRendezvousRecord(const QString &path, RendezvousRecord *out,
                          QString *error) {
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly)) {
    setError(
        error,
        QStringLiteral("Cannot open %1: %2").arg(path, file.errorString()));
    return false;
  }
  // Bound the read: an over-cap file is a corrupt/hostile record, not our own
  // writer's output.
  const QByteArray raw = file.read(kMaxRendezvousRecordBytes + 1);
  if (raw.size() > kMaxRendezvousRecordBytes) {
    setError(error, QStringLiteral("Rendezvous record is too large."));
    return false;
  }
  QJsonParseError parse_error;
  const QJsonDocument doc = QJsonDocument::fromJson(raw, &parse_error);
  if (parse_error.error != QJsonParseError::NoError || !doc.isObject()) {
    setError(error, QStringLiteral("Malformed rendezvous record: %1")
                        .arg(parse_error.errorString()));
    return false;
  }
  const QJsonObject object = doc.object();
  out->pipe_name = object.value(QStringLiteral("pipe_name")).toString();
  out->token = object.value(QStringLiteral("token")).toString();
  out->protocol = object.value(QStringLiteral("protocol")).toInt();
  // app_pid must be a positive integer within the exact-integer double range:
  // casting a NaN/negative/2^63-overflow double straight to qint64 is UB (the
  // same hazard the codebase fixed in clampMs). A non-integral value (e.g.
  // 1234.5) is a forged/wrapped record, not a real Windows PID; reject it
  // rather than silently truncating. A malformed value fails the record closed
  // rather than yielding garbage.
  const QJsonValue pid_value = object.value(QStringLiteral("app_pid"));
  const double pid_raw = pid_value.toDouble(-1.0);
  if (!pid_value.isDouble() || pid_raw < 1.0 ||
      pid_raw > kMaxAppPidExactDouble || std::floor(pid_raw) != pid_raw) {
    setError(error,
             QStringLiteral("Rendezvous record has an invalid app_pid."));
    return false;
  }
  out->app_pid = static_cast<qint64>(pid_raw);
  return true;
}

#ifdef Q_OS_WIN
bool buildBridgePipeSecurity(SECURITY_ATTRIBUTES *attributes,
                             PSECURITY_DESCRIPTOR *descriptor, QString *error) {
  const QString sid = currentUserSidString(error);
  if (sid.isEmpty()) {
    return false;
  }
  // DACL: PROTECTED (no inherited ACEs), GENERIC_ALL to this user SID + SYSTEM
  // only. SACL: Medium mandatory-integrity label, NO_READ_UP | NO_WRITE_UP -- a
  // below-Medium process (e.g. a sandboxed browser renderer, the real
  // injection-to-local vector) cannot open the pipe for read OR write, so it
  // can neither drive it nor occupy the single instance. NR is essential: with
  // NW alone a low-IL subject could still open for read and wedge the sole pipe
  // instance (denial of service).
  const QString sddl =
      QStringLiteral("D:P(A;;GA;;;%1)(A;;GA;;;SY)S:(ML;;NRNW;;;ME)").arg(sid);
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
          reinterpret_cast<LPCWSTR>(sddl.utf16()), SDDL_REVISION_1, &sd,
          nullptr) == FALSE) {
    setError(error,
             lastError(QStringLiteral(
                 "ConvertStringSecurityDescriptorToSecurityDescriptor")));
    return false;
  }
  attributes->nLength = sizeof(*attributes);
  attributes->bInheritHandle = FALSE;
  attributes->lpSecurityDescriptor = sd;
  *descriptor = sd;
  return true;
}
#endif

QString bridgeImageMismatchText(const QString &server_image, qint64 server_pid,
                                const QString &own_image) {
  if (server_image.isEmpty()) {
    return QStringLiteral("The bridge is served by process %1, which this "
                          "relay cannot read (it may have exited).")
        .arg(server_pid);
  }
  return QStringLiteral(
             "The bridge is served by %1, but this relay is %2. Chrome starts "
             "the executable named in its native-messaging registration, so "
             "re-register from the server you are running: call "
             "browser_extension_install on it.")
      .arg(server_image, own_image);
}

} // namespace chrome_control_mcp
