// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_relay.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_messaging.h"
#include "chrome_control_mcp/posix_process_identity.h"

#include <QByteArray>
#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QtEndian>

#include <atomic>
#include <cerrno>
#include <cstring>
#include <system_error>
#include <thread>

#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

namespace chrome_control_mcp {
namespace {

constexpr int kCancelPollMs = 25;

QString errnoText(int value) {
  return QString::fromStdString(
      std::error_code(value, std::generic_category()).message());
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

} // namespace

bool awaitBrowserReply(NativeIpcHandle pipe, const BrowserReadFn &browser_read,
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
    pollfd descriptor{pipe, POLLIN, 0};
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
    if (!relayReadPipeFrame(pipe, &frame) ||
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

NativeIpcHandle browserStdInHandle() { return STDIN_FILENO; }

bool browserInputClosed(NativeIpcHandle input) {
  if (input < 0) {
    return true;
  }
  pollfd watched{};
  watched.fd = input;
  watched.events = POLLIN;
  if (::poll(&watched, 1, 0) <= 0) {
    return false; // nothing to report: still there, or cannot tell
  }
  if ((watched.revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
    return true;
  }
  if ((watched.revents & POLLIN) == 0) {
    return false;
  }
  // Readable means either bytes waiting or end-of-file, and the two platforms
  // disagree about which they report: Linux raises POLLHUP for a pipe whose
  // writer has gone, macOS only marks it readable. Telling them apart by
  // reading is not available here -- those bytes belong to the pump, on another
  // thread -- so ask how many are waiting instead. None, on a descriptor poll
  // calls readable, is the writer having closed.
  int available = 0;
  // POSIX ioctl is variadic; there is no non-variadic spelling of FIONREAD.
  // NOLINTBEGIN(cppcoreguidelines-pro-type-vararg)
  const int asked = ::ioctl(input, FIONREAD, &available);
  // NOLINTEND(cppcoreguidelines-pro-type-vararg)
  if (asked != 0) {
    return false;
  }
  return available == 0;
}

bool relayReadPipeFrame(NativeIpcHandle pipe, QJsonObject *out) {
  char header[kNativeFrameHeaderBytes];
  if (!socketReadExact(pipe, header, kNativeFrameHeaderBytes) ||
      parseFrame(QByteArray(header, kNativeFrameHeaderBytes)).status ==
          NativeFrame::Status::Error) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  return readFrameBody(
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
  if (!isOwnExecutable(static_cast<pid_t>(record.app_pid))) {
    // Name both images: the commonest cause is two copies of this program, not
    // an intruder. Chrome starts whichever executable its native-messaging
    // registration names, and that is not always the one serving MCP.
    setError(error,
             bridgeImageMismatchText(
                 QFileInfo(processImage(static_cast<pid_t>(record.app_pid)))
                     .canonicalFilePath(),
                 record.app_pid,
                 QFileInfo(QCoreApplication::applicationFilePath())
                     .canonicalFilePath()));
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
      !isOwnExecutable(server.pid)) {
    setError(error, bridgeImageMismatchText(
                        QFileInfo(processImage(server.pid)).canonicalFilePath(),
                        server.pid,
                        QFileInfo(QCoreApplication::applicationFilePath())
                            .canonicalFilePath()));
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

} // namespace chrome_control_mcp
