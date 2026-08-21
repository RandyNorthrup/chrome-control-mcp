// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_relay.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QByteArray>
#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QtEndian>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <system_error>
#include <thread>

#include <poll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#ifdef Q_OS_MACOS
#include <libproc.h>
#endif

namespace chrome_control_mcp {
namespace {

constexpr int kCancelPollMs = 25;
constexpr int kNativeFrameHeaderBytes = 4;

void setError(QString *error, const QString &message) {
  if (error != nullptr) {
    *error = message;
  }
}

QString errnoText(int value) {
  return QString::fromStdString(
      std::error_code(value, std::generic_category()).message());
}

QString processImage(pid_t pid) {
#ifdef Q_OS_LINUX
  return QFileInfo(QStringLiteral("/proc/%1/exe").arg(pid)).symLinkTarget();
#elif defined(Q_OS_MACOS)
  QByteArray path(PROC_PIDPATHINFO_MAXSIZE, Qt::Uninitialized);
  const int length = proc_pidpath(pid, path.data(), path.size());
  return length > 0 ? QString::fromUtf8(path.constData(), length) : QString();
#else
  (void)pid;
  return {};
#endif
}

bool pidIsOwnImage(pid_t pid) {
  const QString candidate = QFileInfo(processImage(pid)).canonicalFilePath();
  const QString own =
      QFileInfo(QCoreApplication::applicationFilePath()).canonicalFilePath();
  return !candidate.isEmpty() && !own.isEmpty() && candidate == own;
}

struct PeerIdentity {
  pid_t pid{-1};
  uid_t uid{static_cast<uid_t>(-1)};
};

PeerIdentity peerIdentity(int socket_fd) {
#ifdef Q_OS_LINUX
  ucred credentials{};
  socklen_t size = sizeof(credentials);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) !=
      0) {
    return {};
  }
  return {.pid = credentials.pid, .uid = credentials.uid};
#elif defined(Q_OS_MACOS)
  uid_t uid = static_cast<uid_t>(-1);
  gid_t gid = static_cast<gid_t>(-1);
  if (getpeereid(socket_fd, &uid, &gid) != 0) {
    return {};
  }
  pid_t pid = -1;
  socklen_t size = sizeof(pid);
  if (getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) != 0) {
    return {};
  }
  return {.pid = pid, .uid = uid};
#else
  (void)socket_fd;
  return {};
#endif
}

bool socketReadExact(int socket_fd, char *buffer, qsizetype size) {
  qsizetype offset = 0;
  while (offset < size) {
    const ssize_t received =
        ::read(socket_fd, buffer + offset, static_cast<size_t>(size - offset));
    if (received < 0 && errno == EINTR) {
      continue;
    }
    if (received <= 0) {
      return false;
    }
    offset += received;
  }
  return true;
}

bool socketWriteAll(int socket_fd, const char *buffer, qsizetype size) {
  qsizetype offset = 0;
  while (offset < size) {
#ifdef MSG_NOSIGNAL
    constexpr int flags = MSG_NOSIGNAL;
#else
    constexpr int flags = 0;
#endif
    const ssize_t sent = ::send(socket_fd, buffer + offset,
                                static_cast<size_t>(size - offset), flags);
    if (sent < 0 && errno == EINTR) {
      continue;
    }
    if (sent <= 0) {
      return false;
    }
    offset += sent;
  }
  return true;
}

bool stdinReadExact(char *buffer, qsizetype size) {
  qsizetype offset = 0;
  while (offset < size) {
    std::cin.read(buffer + offset, static_cast<std::streamsize>(size - offset));
    const std::streamsize received = std::cin.gcount();
    if (received <= 0) {
      return false;
    }
    offset += static_cast<qsizetype>(received);
  }
  return true;
}

bool readBodyFrame(const std::function<bool(char *, qsizetype)> &readExact,
                   quint32 length, QJsonObject *out) {
  QByteArray frame(kNativeFrameHeaderBytes, Qt::Uninitialized);
  qToLittleEndian<quint32>(length, reinterpret_cast<uchar *>(frame.data()));
  QByteArray body(static_cast<qsizetype>(length), Qt::Uninitialized);
  if (!readExact(body.data(), body.size())) {
    return false;
  }
  frame.append(body);
  const NativeFrame parsed = parseFrame(frame);
  if (parsed.status != NativeFrame::Status::Ok) {
    return false;
  }
  *out = parsed.message;
  return true;
}

bool readStdinFrame(QJsonObject *out) {
  char header[kNativeFrameHeaderBytes];
  if (!stdinReadExact(header, kNativeFrameHeaderBytes) ||
      parseFrame(QByteArray(header, kNativeFrameHeaderBytes)).status ==
          NativeFrame::Status::Error) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  return readBodyFrame(
      [](char *buffer, qsizetype size) { return stdinReadExact(buffer, size); },
      length, out);
}

bool writeStdoutFrame(const QJsonObject &message) {
  const QByteArray frame = encodeFrame(message);
  if (frame.size() - kNativeFrameHeaderBytes > kMaxHostToBrowserBytes) {
    return false;
  }
  const size_t written = std::fwrite(frame.constData(), 1,
                                     static_cast<size_t>(frame.size()), stdout);
  return written == static_cast<size_t>(frame.size()) &&
         std::fflush(stdout) == 0;
}

bool awaitBrowserReply(NativeIpcHandle socket_fd,
                       const BrowserReadFn &browser_read,
                       const BrowserWriteFn &browser_write,
                       QJsonObject *reply) {
  std::atomic<bool> finished{false};
  bool readOk = false;
  std::thread reader([&] {
    readOk = browser_read(reply);
    finished.store(true, std::memory_order_release);
  });

  bool socketOk = true;
  while (!finished.load(std::memory_order_acquire)) {
    pollfd descriptor{socket_fd, POLLIN, 0};
    const int ready = poll(&descriptor, 1, kCancelPollMs);
    if (ready < 0 && errno == EINTR) {
      continue;
    }
    if (ready < 0 ||
        (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      socketOk = false;
      break;
    }
    if (ready == 0 || (descriptor.revents & POLLIN) == 0) {
      continue;
    }
    QJsonObject frame;
    if (!relayReadPipeFrame(socket_fd, &frame) ||
        frame.value(QStringLiteral("type")).toString() !=
            QLatin1String("cancel") ||
        !browser_write(frame)) {
      socketOk = false;
      break;
    }
  }

  reader.join();
  return socketOk && readOk;
}

} // namespace

bool relayReadPipeFrame(NativeIpcHandle pipe, QJsonObject *out) {
  char header[kNativeFrameHeaderBytes];
  if (!socketReadExact(pipe, header, kNativeFrameHeaderBytes) ||
      parseFrame(QByteArray(header, kNativeFrameHeaderBytes)).status ==
          NativeFrame::Status::Error) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  return readBodyFrame(
      [pipe](char *buffer, qsizetype size) {
        return socketReadExact(pipe, buffer, size);
      },
      length, out);
}

bool relayWritePipeFrame(NativeIpcHandle pipe, const QJsonObject &message) {
  const QByteArray frame = encodeFrame(message);
  return socketWriteAll(pipe, frame.constData(), frame.size());
}

NativeIpcHandle relayConnect(const QString &rendezvous_path, QString *token_out,
                             int *protocol_out, QString *error) {
  RendezvousRecord record;
  if (!readRendezvousRecord(rendezvous_path, &record, error)) {
    return kInvalidNativeIpcHandle;
  }
  if (record.pipe_name.isEmpty() || record.app_pid <= 0) {
    setError(error,
             QStringLiteral(
                 "Rendezvous record is missing the endpoint or server pid."));
    return kInvalidNativeIpcHandle;
  }
  if (!pidIsOwnImage(static_cast<pid_t>(record.app_pid))) {
    setError(error, QStringLiteral("Bridge server pid %1 is not the Chrome "
                                   "Control MCP binary (or is gone).")
                        .arg(record.app_pid));
    return kInvalidNativeIpcHandle;
  }

  const QByteArray endpoint = QFile::encodeName(record.pipe_name);
  if (endpoint.size() >=
      static_cast<qsizetype>(sizeof(sockaddr_un::sun_path))) {
    setError(error, QStringLiteral("Bridge socket path is too long."));
    return kInvalidNativeIpcHandle;
  }
  const int socketFd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (socketFd < 0) {
    setError(error, QStringLiteral("Could not create bridge socket: %1")
                        .arg(errnoText(errno)));
    return kInvalidNativeIpcHandle;
  }
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, endpoint.constData(),
              static_cast<size_t>(endpoint.size() + 1));
  int connected = connect(socketFd, reinterpret_cast<sockaddr *>(&address),
                          sizeof(address));
  while (connected != 0 && errno == EINTR) {
    connected = connect(socketFd, reinterpret_cast<sockaddr *>(&address),
                        sizeof(address));
  }
  if (connected != 0) {
    setError(error, QStringLiteral("Cannot open the bridge socket: %1")
                        .arg(errnoText(errno)));
    close(socketFd);
    return kInvalidNativeIpcHandle;
  }

  const PeerIdentity server = peerIdentity(socketFd);
  if (server.uid != geteuid() || server.pid != record.app_pid ||
      !pidIsOwnImage(server.pid)) {
    setError(error,
             QStringLiteral("The bridge socket is not served by the recorded "
                            "Chrome Control MCP process."));
    close(socketFd);
    return kInvalidNativeIpcHandle;
  }
  if (token_out != nullptr) {
    *token_out = record.token;
  }
  if (protocol_out != nullptr) {
    *protocol_out = record.protocol;
  }
  return socketFd;
}

bool relayHandshake(NativeIpcHandle pipe, const QString &token, int protocol,
                    QString *error) {
  const QJsonObject hello{{QStringLiteral("type"), QStringLiteral("hello")},
                          {QStringLiteral("token"), token},
                          {QStringLiteral("protocol"), protocol}};
  if (!relayWritePipeFrame(pipe, hello)) {
    setError(error, QStringLiteral("Failed to send the bridge hello."));
    return false;
  }
  QJsonObject welcome;
  if (!relayReadPipeFrame(pipe, &welcome)) {
    setError(error, QStringLiteral(
                        "Bridge server closed before welcoming the relay."));
    return false;
  }
  if (welcome.value(QStringLiteral("type")).toString() !=
      QLatin1String("welcome")) {
    setError(error,
             QStringLiteral("Bridge server refused the relay: %1")
                 .arg(welcome.value(QStringLiteral("error")).toString()));
    return false;
  }
  if (welcome.value(QStringLiteral("protocol")).toInt(-1) != protocol) {
    setError(
        error,
        QStringLiteral(
            "Bridge protocol mismatch: relay offered %1, server welcomed %2")
            .arg(protocol)
            .arg(welcome.value(QStringLiteral("protocol")).toInt(-1)));
    return false;
  }
  return true;
}

bool relayPumpOnce(NativeIpcHandle pipe, const BrowserReadFn &browser_read,
                   const BrowserWriteFn &browser_write) {
  QJsonObject command;
  if (!relayReadPipeFrame(pipe, &command) || !browser_write(command)) {
    return false;
  }
  QJsonObject reply;
  if (!awaitBrowserReply(pipe, browser_read, browser_write, &reply)) {
    return false;
  }
  return relayWritePipeFrame(pipe, reply);
}

int runBrowserRelay() {
  QString token;
  int protocol = 0;
  QString error;
  const NativeIpcHandle socketFd =
      relayConnect(browserBridgeRendezvousPath(), &token, &protocol, &error);
  if (!nativeIpcHandleIsValid(socketFd) ||
      !relayHandshake(socketFd, token, protocol, &error)) {
    (void)writeStdoutFrame(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("bridge_unavailable")},
        {QStringLiteral("error"), error}});
    closeNativeIpcHandle(socketFd);
    return 0;
  }
  (void)writeStdoutFrame(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("bridge_ready")},
                  {QStringLiteral("protocol"), protocol}});
  const BrowserReadFn reader = [](QJsonObject *out) {
    return readStdinFrame(out);
  };
  const BrowserWriteFn writer = [](const QJsonObject &message) {
    return writeStdoutFrame(message);
  };
  while (relayPumpOnce(socketFd, reader, writer)) {
  }
  closeNativeIpcHandle(socketFd);
  return 0;
}

} // namespace chrome_control_mcp
