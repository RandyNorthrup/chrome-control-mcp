// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QtEndian>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <system_error>
#include <thread>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#ifdef Q_OS_MACOS
#include <libproc.h>
#endif

namespace chrome_control_mcp {
namespace {

constexpr int kCancelWriteBudgetMs = 1'000;
constexpr int kCancelDrainBudgetMs = 3'000;
constexpr int kFrameHeaderBytes = 4;
constexpr int kAcceptRetryBackoffMs = 50;
constexpr int kChromeAncestorMaxDepth = 12;

struct IoDeadline {
  std::chrono::steady_clock::time_point deadline;
  int cancel_fd{-1};

  [[nodiscard]] int remainingMs() const {
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now());
    if (remaining.count() <= 0) {
      return 0;
    }
    return static_cast<int>(
        std::min<qint64>(remaining.count(), std::numeric_limits<int>::max()));
  }
};

IoDeadline deadlineAfter(int milliseconds, int cancel_fd) {
  return {.deadline = std::chrono::steady_clock::now() +
                      std::chrono::milliseconds(milliseconds),
          .cancel_fd = cancel_fd};
}

void setError(QString *error, const QString &message) {
  if (error != nullptr) {
    *error = message;
  }
}

QString systemError(const QString &operation) {
  const std::error_code code(errno, std::generic_category());
  return QStringLiteral("%1 failed: %2")
      .arg(operation, QString::fromStdString(code.message()));
}

void setCloseOnExec(int fd) {
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg) -- POSIX API is variadic.
  const int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg) -- POSIX API is
    // variadic.
    (void)fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
  }
}

bool waitForIo(int fd, short events, const IoDeadline &deadline) {
  while (true) {
    pollfd descriptors[2]{{fd, events, 0}, {deadline.cancel_fd, POLLIN, 0}};
    const nfds_t count = deadline.cancel_fd >= 0 ? 2 : 1;
    const int result = poll(descriptors, count, deadline.remainingMs());
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result <= 0) {
      return false;
    }
    if (count == 2 && (descriptors[1].revents & POLLIN) != 0) {
      return false;
    }
    if ((descriptors[0].revents & events) != 0) {
      return true;
    }
    if ((descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      return false;
    }
  }
}

bool socketReadExact(int socket_fd, char *buffer, qsizetype size,
                     const IoDeadline &deadline) {
  qsizetype offset = 0;
  while (offset < size) {
    if (!waitForIo(socket_fd, POLLIN, deadline)) {
      return false;
    }
    // Analyzer loses track of the explicit unlock in serveConnected(); socket
    // I/O runs without mutex_ held.
    // NOLINTBEGIN(clang-analyzer-unix.BlockInCriticalSection)
    const ssize_t received =
        ::read(socket_fd, buffer + offset, static_cast<size_t>(size - offset));
    // NOLINTEND(clang-analyzer-unix.BlockInCriticalSection)
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

bool socketWriteAll(int socket_fd, const char *buffer, qsizetype size,
                    const IoDeadline &deadline) {
  qsizetype offset = 0;
  while (offset < size) {
    if (!waitForIo(socket_fd, POLLOUT, deadline)) {
      return false;
    }
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

bool readFrame(int socket_fd, const IoDeadline &deadline, QJsonObject *out) {
  char header[kFrameHeaderBytes];
  if (!socketReadExact(socket_fd, header, kFrameHeaderBytes, deadline) ||
      parseFrame(QByteArray(header, kFrameHeaderBytes)).status ==
          NativeFrame::Status::Error) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  QByteArray frame(header, kFrameHeaderBytes);
  QByteArray body(static_cast<qsizetype>(length), Qt::Uninitialized);
  if (!socketReadExact(socket_fd, body.data(), body.size(), deadline)) {
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

bool writeFrame(int socket_fd, const QJsonObject &message,
                const IoDeadline &deadline) {
  const QByteArray frame = encodeFrame(message);
  return socketWriteAll(socket_fd, frame.constData(), frame.size(), deadline);
}

enum class ConnectResult : std::uint8_t { Connected, Shutdown, Error };

struct AcceptedConnection {
  ConnectResult result{ConnectResult::Error};
  int fd{-1};
};

AcceptedConnection acceptConnection(int listener_fd, int shutdown_fd) {
  while (true) {
    pollfd descriptors[2]{{listener_fd, POLLIN, 0}, {shutdown_fd, POLLIN, 0}};
    const int ready = poll(descriptors, 2, -1);
    if (ready < 0 && errno == EINTR) {
      continue;
    }
    if (ready <= 0) {
      return {};
    }
    if ((descriptors[1].revents & POLLIN) != 0) {
      return {.result = ConnectResult::Shutdown};
    }
    if ((descriptors[0].revents & POLLIN) == 0) {
      return {};
    }
    const int client = accept(listener_fd, nullptr, nullptr);
    if (client < 0 && errno == EINTR) {
      continue;
    }
    if (client < 0) {
      return {};
    }
    setCloseOnExec(client);
    return {.result = ConnectResult::Connected, .fd = client};
  }
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

pid_t parentPid(pid_t pid) {
#ifdef Q_OS_LINUX
  QFile statFile(QStringLiteral("/proc/%1/stat").arg(pid));
  if (!statFile.open(QIODevice::ReadOnly)) {
    return -1;
  }
  const QByteArray stat = statFile.readAll();
  const qsizetype closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) {
    return -1;
  }
  const QList<QByteArray> fields = stat.mid(closeParen + 2).split(' ');
  bool ok = false;
  const qlonglong parent =
      fields.size() > 1 ? fields.at(1).toLongLong(&ok) : -1;
  return ok ? static_cast<pid_t>(parent) : -1;
#elif defined(Q_OS_MACOS)
  proc_bsdinfo info{};
  const int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  return bytes == sizeof(info) ? static_cast<pid_t>(info.pbi_ppid) : -1;
#endif
}

bool sameExecutable(pid_t pid) {
  const QString peer = QFileInfo(processImage(pid)).canonicalFilePath();
  const QString own =
      QFileInfo(QCoreApplication::applicationFilePath()).canonicalFilePath();
  return !peer.isEmpty() && !own.isEmpty() && peer == own;
}

bool chromeProcessName(const QString &path) {
  const QString name = QFileInfo(path).fileName().toLower();
  return name == QLatin1String("chrome") ||
         name == QLatin1String("chrome-wrapper") ||
         name == QLatin1String("google-chrome") ||
         name == QLatin1String("google-chrome-stable") ||
         name == QLatin1String("chromium") ||
         name == QLatin1String("chromium-browser") ||
         name.startsWith(QLatin1String("google chrome"));
}

bool hasChromeAncestor(pid_t pid) {
  pid_t current = pid;
  for (int depth = 0; depth < kChromeAncestorMaxDepth && current > 1; ++depth) {
    current = parentPid(current);
    if (current <= 1) {
      return false;
    }
    if (chromeProcessName(processImage(current))) {
      return true;
    }
  }
  return false;
}

bool ancestorChainContainsImage(quint64 pid,
                                const QHash<quint64, quint64> &parent,
                                const QHash<quint64, QString> &image,
                                const QString &target_basename_lower,
                                int max_depth) {
  quint64 current = pid;
  for (int depth = 0; depth < max_depth && current != 0; ++depth) {
    const auto it = parent.constFind(current);
    if (it == parent.constEnd()) {
      break;
    }
    if (image.value(it.value()) == target_basename_lower) {
      return true;
    }
    current = it.value();
  }
  return false;
}

} // namespace

bool BrowserBridgePipeServer::ancestorChainContainsImageForTesting(
    quint64 pid, const QHash<quint64, quint64> &parent,
    const QHash<quint64, QString> &image, const QString &target_basename_lower,
    int max_depth) {
  return ancestorChainContainsImage(pid, parent, image, target_basename_lower,
                                    max_depth);
}

BrowserBridgePipeServer::BrowserBridgePipeServer()
    : BrowserBridgePipeServer(Options{}) {}

BrowserBridgePipeServer::BrowserBridgePipeServer(Options options)
    : options_(std::move(options)) {
  rendezvous_path_ = options_.rendezvous_path.isEmpty()
                         ? browserBridgeRendezvousPath()
                         : options_.rendezvous_path;
}

BrowserBridgePipeServer::~BrowserBridgePipeServer() { stop(); }

bool BrowserBridgePipeServer::createPipeResources(QString *error) {
  pipe_name_ = browserBridgePipeName(error);
  if (pipe_name_.isEmpty()) {
    return false;
  }
  const QByteArray endpoint = QFile::encodeName(pipe_name_);
  if (endpoint.size() >=
      static_cast<qsizetype>(sizeof(sockaddr_un::sun_path))) {
    setError(
        error,
        QStringLiteral("Bridge socket path is too long: %1").arg(pipe_name_));
    return false;
  }

  listener_fd_ = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener_fd_ < 0) {
    setError(error, systemError(QStringLiteral("socket")));
    return false;
  }
  setCloseOnExec(listener_fd_);

  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, endpoint.constData(),
              static_cast<size_t>(endpoint.size() + 1));
  if (bind(listener_fd_, reinterpret_cast<sockaddr *>(&address),
           sizeof(address)) != 0 ||
      chmod(endpoint.constData(), S_IRUSR | S_IWUSR) != 0 ||
      listen(listener_fd_, 1) != 0) {
    setError(error, systemError(QStringLiteral("bind/listen")));
    close(listener_fd_);
    listener_fd_ = -1;
    QFile::remove(pipe_name_);
    return false;
  }

  if (pipe(shutdown_pipe_) != 0) {
    setError(error, systemError(QStringLiteral("pipe")));
    close(listener_fd_);
    listener_fd_ = -1;
    QFile::remove(pipe_name_);
    return false;
  }
  setCloseOnExec(shutdown_pipe_[0]);
  setCloseOnExec(shutdown_pipe_[1]);

  token_ = generateBridgeToken();
  const RendezvousRecord record{pipe_name_, token_, options_.protocol,
                                static_cast<qint64>(getpid())};
  if (!writeRendezvousRecord(rendezvous_path_, record, error)) {
    close(listener_fd_);
    listener_fd_ = -1;
    close(shutdown_pipe_[0]);
    close(shutdown_pipe_[1]);
    shutdown_pipe_[0] = -1;
    shutdown_pipe_[1] = -1;
    QFile::remove(pipe_name_);
    return false;
  }
  return true;
}

bool BrowserBridgePipeServer::start(QString *error) {
  const std::lock_guard<std::mutex> lifecycle(lifecycle_mutex_);
  if (running_) {
    setError(error, QStringLiteral("Bridge IPC server is already running"));
    return false;
  }
  if (thread_.joinable()) {
    thread_.join();
  }
  if (!createPipeResources(error)) {
    return false;
  }
  running_ = true;
  stop_done_ = false;
  thread_ = std::thread([this] { run(); });
  return true;
}

void BrowserBridgePipeServer::stop() {
  const std::lock_guard<std::mutex> lifecycle(lifecycle_mutex_);
  if (stop_done_) {
    return;
  }
  stop_done_ = true;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
  }
  if (shutdown_pipe_[1] >= 0) {
    const char wake = 1;
    (void)::write(shutdown_pipe_[1], &wake, 1);
  }
  cv_.notify_all();
  if (thread_.joinable()) {
    thread_.join();
  }
  if (connection_fd_ >= 0) {
    close(connection_fd_);
    connection_fd_ = -1;
  }
  if (listener_fd_ >= 0) {
    close(listener_fd_);
    listener_fd_ = -1;
  }
  for (int &fd : shutdown_pipe_) {
    if (fd >= 0) {
      close(fd);
      fd = -1;
    }
  }
  QFile::remove(rendezvous_path_);
  QFile::remove(pipe_name_);
}

bool BrowserBridgePipeServer::clientConnected() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return connected_;
}

quint64 BrowserBridgePipeServer::connectionGeneration() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return generation_;
}

void BrowserBridgePipeServer::run() {
  while (true) {
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      if (!running_) {
        return;
      }
    }
    const AcceptedConnection accepted =
        acceptConnection(listener_fd_, shutdown_pipe_[0]);
    if (accepted.result == ConnectResult::Shutdown) {
      return;
    }
    if (accepted.result == ConnectResult::Error) {
      std::this_thread::sleep_for(
          std::chrono::milliseconds(kAcceptRetryBackoffMs));
      continue;
    }
    connection_fd_ = accepted.fd;
    if (!handshake()) {
      close(connection_fd_);
      connection_fd_ = -1;
      continue;
    }
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      connected_ = true;
      ++generation_;
      has_request_ = false;
      has_response_ = false;
    }
    cv_.notify_all();
    serveConnected();
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      connected_ = false;
    }
    cv_.notify_all();
    close(connection_fd_);
    connection_fd_ = -1;
  }
}

bool BrowserBridgePipeServer::handshake() {
  const IoDeadline deadline =
      deadlineAfter(options_.io_timeout_ms, shutdown_pipe_[0]);
  QJsonObject hello;
  if (!readFrame(connection_fd_, deadline, &hello) ||
      hello.value(QStringLiteral("type")).toString() !=
          QLatin1String("hello") ||
      hello.value(QStringLiteral("token")).toString() != token_) {
    return false;
  }
  if (hello.value(QStringLiteral("protocol")).toInt() != options_.protocol) {
    (void)writeFrame(
        connection_fd_,
        QJsonObject{
            {QStringLiteral("type"), QStringLiteral("error")},
            {QStringLiteral("error"), QStringLiteral("protocol_mismatch")}},
        deadline);
    return false;
  }
  QString why;
  if (!verifyPeer(&why)) {
    (void)writeFrame(
        connection_fd_,
        QJsonObject{{QStringLiteral("type"), QStringLiteral("error")},
                    {QStringLiteral("error"),
                     QStringLiteral("unauthorized: %1").arg(why)}},
        deadline);
    return false;
  }
  return writeFrame(
      connection_fd_,
      QJsonObject{{QStringLiteral("type"), QStringLiteral("welcome")},
                  {QStringLiteral("protocol"), options_.protocol},
                  {QStringLiteral("pid"), static_cast<double>(getpid())}},
      deadline);
}

bool BrowserBridgePipeServer::verifyPeer(QString *why) const {
  const PeerIdentity peer = peerIdentity(connection_fd_);
  if (peer.pid <= 0 || peer.uid != geteuid()) {
    *why = QStringLiteral("client identity does not match the current user");
    return false;
  }
  if (!sameExecutable(peer.pid)) {
    *why = QStringLiteral("client is not the bridge binary");
    return false;
  }
  if (options_.require_chrome_ancestor && !hasChromeAncestor(peer.pid)) {
    *why = QStringLiteral("client was not launched by Chrome");
    return false;
  }
  return true;
}

void BrowserBridgePipeServer::serveConnected() {
  while (true) {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return has_request_ || !running_; });
    if (!running_) {
      return;
    }
    const QJsonObject request = request_frame_;
    has_request_ = false;
    lock.unlock();

    const IoDeadline deadline =
        deadlineAfter(options_.io_timeout_ms, shutdown_pipe_[0]);
    QJsonObject reply;
    Exchange result;
    if (!writeFrame(connection_fd_, request, deadline)) {
      result.error = QStringLiteral(
          "browser did not accept the command (timeout or reset)");
    } else if (!readFrame(connection_fd_, deadline, &reply)) {
      result.error =
          QStringLiteral(
              "browser did not reply within %1 ms (connection reset)")
              .arg(options_.io_timeout_ms);
      const IoDeadline cancelDeadline =
          deadlineAfter(kCancelWriteBudgetMs, shutdown_pipe_[0]);
      if (writeFrame(
              connection_fd_,
              QJsonObject{{QStringLiteral("type"), QStringLiteral("cancel")}},
              cancelDeadline)) {
        const IoDeadline drainDeadline =
            deadlineAfter(kCancelDrainBudgetMs, shutdown_pipe_[0]);
        QJsonObject discarded;
        (void)readFrame(connection_fd_, drainDeadline, &discarded);
      }
    } else {
      result.ok = true;
      result.reply = reply;
    }

    lock.lock();
    response_ = result;
    has_response_ = true;
    cv_.notify_all();
    lock.unlock();
    if (!result.ok) {
      return;
    }
  }
}

BrowserBridgePipeServer::Exchange
BrowserBridgePipeServer::sendCommandAwaitReply(const QJsonObject &frame) {
  std::unique_lock<std::mutex> lock(mutex_);
  if (!connected_ || !running_) {
    return {.ok = false,
            .reply = {},
            .error = QStringLiteral("Browser not connected.")};
  }
  if (has_request_) {
    return {.ok = false,
            .reply = {},
            .error =
                QStringLiteral("A browser action is already in progress.")};
  }
  const quint64 myGeneration = generation_;
  request_frame_ = frame;
  has_request_ = true;
  has_response_ = false;
  cv_.notify_all();
  cv_.wait(lock, [this, myGeneration] {
    return has_response_ || !running_ || generation_ != myGeneration;
  });
  const bool gotResponse = has_response_;
  Exchange result{};
  if (gotResponse) {
    result = response_;
  } else {
    result = Exchange{.ok = false,
                      .reply = {},
                      .error = QStringLiteral(
                          "Browser connection closed before it replied.")};
  }
  has_request_ = false;
  has_response_ = false;
  return result;
}

} // namespace chrome_control_mcp
