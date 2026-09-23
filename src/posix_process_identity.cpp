// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/posix_process_identity.h"

#include <QByteArray>
#include <QCoreApplication>
#include <QFileInfo>
#include <QtGlobal>

#include <cstdint>

#include <sys/socket.h>
#include <unistd.h>

#ifdef Q_OS_MACOS
#include <libproc.h>
#endif

namespace chrome_control_mcp {

QString processImage(pid_t pid) {
#ifdef Q_OS_LINUX
  return QFileInfo(QStringLiteral("/proc/%1/exe").arg(pid)).symLinkTarget();
#elif defined(Q_OS_MACOS)
  QByteArray path(PROC_PIDPATHINFO_MAXSIZE, Qt::Uninitialized);
  const int length =
      proc_pidpath(pid, path.data(), static_cast<uint32_t>(path.size()));
  return length > 0 ? QString::fromUtf8(path.constData(), length) : QString();
#else
  (void)pid;
  return {};
#endif
}

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

bool isOwnExecutable(pid_t pid) {
  // Canonicalize both sides: one of them can arrive through a symbolic link
  // (an install reached through `current/`), and comparing the raw paths would
  // then call our own process a stranger.
  const QString peer = QFileInfo(processImage(pid)).canonicalFilePath();
  const QString own =
      QFileInfo(QCoreApplication::applicationFilePath()).canonicalFilePath();
  return !peer.isEmpty() && !own.isEmpty() && peer == own;
}

} // namespace chrome_control_mcp
