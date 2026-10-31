// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_messaging.h"
#include "chrome_control_mcp/posix_process_identity.h"

#include <QFile>
#include <QFileInfo>
#include <QtEndian>

#include <algorithm>
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
  // Zero leaves this a hard deadline, which is what the handshake and every
  // write want. Set, it makes the budget a SILENCE budget: bytes arriving push
  // the deadline out again, never past absolute_end.
  int refresh_ms{0};
  std::chrono::steady_clock::time_point absolute_end{};

  // Called after a chunk that actually moved bytes. A frame still arriving is
  // not a peer that has gone quiet, and a multi-megabyte screenshot crossing a
  // loaded machine's socket used to fail as a timeout while it was arriving
  // perfectly well.
  void noteProgress() {
    if (refresh_ms == 0) {
      return;
    }
    const auto next = std::chrono::steady_clock::now() +
                      std::chrono::milliseconds(refresh_ms);
    deadline =
        (absolute_end.time_since_epoch().count() != 0 && next > absolute_end)
            ? absolute_end
            : next;
  }

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

QString systemError(const QString &operation) {
  const std::error_code code(errno, std::generic_category());
  return QStringLiteral("%1 failed: %2")
      .arg(operation, QString::fromStdString(code.message()));
}

void setCloseOnExec(int fd) {
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg) -- POSIX API is variadic.
  const int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) {
    // POSIX fcntl is variadic.
    // NOLINTBEGIN(cppcoreguidelines-pro-type-vararg)
    (void)fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
    // NOLINTEND(cppcoreguidelines-pro-type-vararg)
  }
}

// Why a read stopped short of a whole frame. Only one of these is the peer
// going quiet. All of them used to be reported as though it were -- "did not
// reply within 30000 ms" for a relay that had closed the connection a moment
// after the command went out -- which left a failure with no way to tell a
// stalled browser from a broken bridge.
enum class ReadEnd : std::uint8_t {
  Complete,
  Silent,
  Closed,
  Malformed,
  Cancelled
};

ReadEnd awaitIo(int fd, short events, const IoDeadline &deadline) {
  while (true) {
    pollfd descriptors[2]{{fd, events, 0}, {deadline.cancel_fd, POLLIN, 0}};
    const nfds_t count = deadline.cancel_fd >= 0 ? 2 : 1;
    const int result = poll(descriptors, count, deadline.remainingMs());
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result == 0) {
      return ReadEnd::Silent;
    }
    if (result < 0) {
      return ReadEnd::Closed;
    }
    if (count == 2 && (descriptors[1].revents & POLLIN) != 0) {
      return ReadEnd::Cancelled;
    }
    if ((descriptors[0].revents & events) != 0) {
      return ReadEnd::Complete;
    }
    if ((descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      return ReadEnd::Closed;
    }
  }
}

bool waitForIo(int fd, short events, const IoDeadline &deadline) {
  return awaitIo(fd, events, deadline) == ReadEnd::Complete;
}

// Reads exactly @p size bytes, or says why it could not in @p end.
bool socketReadExact(int socket_fd, char *buffer, qsizetype size,
                     const IoDeadline &whole_read, ReadEnd *end = nullptr) {
  // A copy, so a refreshed budget bounds this read and leaks into nothing else.
  IoDeadline deadline = whole_read;
  qsizetype offset = 0;
  const auto stop = [end](ReadEnd why) {
    if (end != nullptr) {
      *end = why;
    }
    return false;
  };
  while (offset < size) {
    const ReadEnd waited = awaitIo(socket_fd, POLLIN, deadline);
    if (waited != ReadEnd::Complete) {
      return stop(waited);
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
      return stop(ReadEnd::Closed); // end of stream, or the socket failed
    }
    offset += received;
    deadline.noteProgress(); // bytes arriving is not a peer gone quiet
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

bool readFrame(int socket_fd, const IoDeadline &deadline, QJsonObject *out,
               ReadEnd *end = nullptr) {
  const auto malformed = [end]() {
    if (end != nullptr) {
      *end = ReadEnd::Malformed;
    }
    return false;
  };
  char header[kFrameHeaderBytes];
  if (!socketReadExact(socket_fd, header, kFrameHeaderBytes, deadline, end)) {
    return false;
  }
  if (parseFrame(QByteArray(header, kFrameHeaderBytes)).status ==
      NativeFrame::Status::Error) {
    return malformed();
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  QByteArray frame(header, kFrameHeaderBytes);
  QByteArray body(static_cast<qsizetype>(length), Qt::Uninitialized);
  if (!socketReadExact(socket_fd, body.data(), body.size(), deadline, end)) {
    return false;
  }
  frame.append(body);
  const NativeFrame parsed = parseFrame(frame);
  if (parsed.status != NativeFrame::Status::Ok) {
    return malformed();
  }
  *out = parsed.message;
  return true;
}

// What the caller is told about an exchange that ended without a reply, by why
// the read ended. The silent case keeps the wording it has always had; the
// others name what happened and when, so a closed connection a moment after the
// command went out no longer reads as thirty seconds of silence.
QString endedText(ReadEnd end, const QString &cmd, qint64 elapsed_ms,
                  int io_timeout_ms) {
  switch (end) {
  case ReadEnd::Closed:
    return QStringLiteral("the browser's relay closed the connection %1 ms "
                          "into %2, before replying (connection reset)")
        .arg(elapsed_ms)
        .arg(cmd);
  case ReadEnd::Malformed:
    return QStringLiteral("the browser's reply to %1 could not be read: a "
                          "malformed frame %2 ms in (connection reset)")
        .arg(cmd)
        .arg(elapsed_ms);
  case ReadEnd::Cancelled:
    return QStringLiteral(
               "the server stopped while waiting for the browser's reply to %1")
        .arg(cmd);
  case ReadEnd::Complete:
  case ReadEnd::Silent:
    break;
  }
  return QStringLiteral("browser did not reply within %1 ms (connection reset)")
      .arg(io_timeout_ms);
}

bool writeFrame(int socket_fd, const QJsonObject &message,
                const IoDeadline &deadline) {
  const QByteArray frame = encodeFrame(message);
  return socketWriteAll(socket_fd, frame.constData(), frame.size(), deadline);
}

// What the relay on an idle connection is doing, seen without consuming a byte.
enum class IdlePeer : std::uint8_t {
  Present, // connected and quiet, as it should be between commands
  Gone,    // closed its end, or died
  Talking  // bytes arrived with no command outstanding
};

// Whether a failed non-blocking peek only means "nothing there after all".
// Spelled as a function because EAGAIN and EWOULDBLOCK are the same value on
// Linux and not guaranteed to be elsewhere, and comparing errno against both
// inline reads as a redundant expression to the analyzer.
bool peekWouldBlock(int error) {
#if EAGAIN == EWOULDBLOCK
  return error == EAGAIN;
#else
  return error == EAGAIN || error == EWOULDBLOCK;
#endif
}

// Look at an idle connection without reading from it: poll with no timeout,
// then a peek that never blocks. Neither consumes, so this cannot take part of
// a frame -- and while idle there is no frame to take: the relay writes only
// to answer a command.
IdlePeer idlePeerState(int socket_fd) {
  pollfd watched{socket_fd, POLLIN, 0};
  int ready = ::poll(&watched, 1, 0);
  while (ready < 0 && errno == EINTR) {
    ready = ::poll(&watched, 1, 0);
  }
  if (ready <= 0) {
    // Nothing to report -- or poll itself failed, which says nothing about the
    // peer. The next check asks again.
    return IdlePeer::Present;
  }
  if ((watched.revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
    return IdlePeer::Gone;
  }
  if ((watched.revents & POLLIN) == 0) {
    return IdlePeer::Present;
  }
  // Readable is either bytes or end-of-stream, and the platforms disagree on
  // which they flag: Linux raises POLLHUP for a stream socket whose peer has
  // closed, macOS may only mark it readable. A one-byte peek tells them apart.
  char probe = 0;
  // Runs with mutex_ released (see serveConnected); the analyzer loses track
  // of the explicit unlock there, as it does for the reads above.
  // NOLINTBEGIN(clang-analyzer-unix.BlockInCriticalSection)
  ssize_t peeked = ::recv(socket_fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
  while (peeked < 0 && errno == EINTR) {
    peeked = ::recv(socket_fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
  }
  // NOLINTEND(clang-analyzer-unix.BlockInCriticalSection)
  if (peeked > 0) {
    return IdlePeer::Talking;
  }
  if (peeked == 0) {
    return IdlePeer::Gone; // orderly end-of-stream: the relay closed its end
  }
  return peekWouldBlock(errno) ? IdlePeer::Present : IdlePeer::Gone;
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

} // namespace

bool liveBridgeOwnerExists(const QString &rendezvous_path) {
  RendezvousRecord record;
  if (!readRendezvousRecord(rendezvous_path, &record, nullptr)) {
    return false;
  }
  if (record.app_pid == currentProcessId()) {
    return false;
  }
  return isOwnExecutable(static_cast<pid_t>(record.app_pid));
}

bool BrowserBridgePipeServer::createPipeResources(QString *error) {
  if (rendezvous_path_.isEmpty()) {
    if (error != nullptr) {
      *error = rendezvous_error_;
    }
    return false;
  }
  // Records a departed server left behind are nobody's, and a relay searching
  // them wastes a connection attempt on each. Clear them before deciding
  // whether anyone is actually here.
  (void)sweepStaleRendezvousRecords(rendezvous_path_);
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
    ssize_t wake_result = ::write(shutdown_pipe_[1], &wake, 1);
    while (wake_result < 0 && errno == EINTR) {
      wake_result = ::write(shutdown_pipe_[1], &wake, 1);
    }
    // The pipe is only a best-effort wakeup. stop() closes it after joining,
    // so a full or already-closed descriptor requires no recovery here.
    (void)wake_result;
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
  // Only remove the rendezvous record if it still advertises THIS process. A
  // second instance that stood down never owned it, and a peer server may have
  // (re)claimed it; deleting another instance's record would orphan the socket
  // the relay is bound to. Our own listener socket (pipe_name_, empty when we
  // stood down) is always ours to clean up.
  RendezvousRecord current;
  if (readRendezvousRecord(rendezvous_path_, &current, nullptr) &&
      current.app_pid == static_cast<qint64>(getpid())) {
    QFile::remove(rendezvous_path_);
  }
  QFile::remove(pipe_name_);
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
  if (!isOwnExecutable(peer.pid)) {
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
    // Wait in slices, never for as long as it takes. From inside a wait only a
    // command can end, a relay that died between commands is indistinguishable
    // from one that is idle -- and the connection stayed held for it, with
    // every relay Chrome started afterwards parked unanswered in the listen
    // backlog, until a command happened along to fail.
    const bool asked = cv_.wait_for(
        lock, std::chrono::milliseconds(kBrowserBridgeIdlePeerCheckMs),
        [this] { return has_request_ || !running_; });
    if (!running_) {
      return;
    }
    if (!asked) {
      // Looked at with the lock released, as all socket I/O is. A command
      // posted meanwhile is safe either way: a live relay serves it on the next
      // pass, and for a dead one this returns, run() marks the connection gone,
      // and the sender -- which wakes on exactly that -- fails it. run() clears
      // the slot before it serves another relay, so it never reaches the next.
      lock.unlock();
      if (idlePeerState(connection_fd_) != IdlePeer::Present) {
        // Gone, or talking with nothing asked. The second is not a relay that
        // is keeping to the protocol, and its bytes left unread would be taken
        // as the reply to the NEXT command, before that command was even sent.
        return;
      }
      continue;
    }
    const QJsonObject request = request_frame_;
    has_request_ = false;
    lock.unlock();

    const IoDeadline deadline =
        deadlineAfter(options_.io_timeout_ms, shutdown_pipe_[0]);
    QJsonObject reply;
    Exchange result;
    QString why;
    if (!writeFrame(connection_fd_, request, deadline)) {
      result.error = QStringLiteral(
          "browser did not accept the command (timeout or reset)");
    } else if (!awaitReply(request, &reply, &why)) {
      result.error = why;
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

bool BrowserBridgePipeServer::awaitReply(const QJsonObject &request,
                                         QJsonObject *reply, QString *why) {
  const auto started = std::chrono::steady_clock::now();
  const auto absolute_end =
      started + std::chrono::milliseconds(options_.max_exchange_ms);
  int beats = 0;
  ReadEnd end = ReadEnd::Silent;
  // Whether the ceiling, rather than the silence budget, is what bounds the
  // read now in flight.
  //
  // Which of the two ran out decides what the caller is told, and it cannot be
  // decided by reading the clock afterwards: the deadline is built from whole
  // milliseconds of remaining time, so a read cut short by the ceiling expires
  // a fraction BEFORE it -- measured -- and a clock comparison then says the
  // ceiling had not been reached. The read that the ceiling cut short is the
  // read whose budget the ceiling set, which is a fact about the loop.
  bool ceiling_bounds_read = false;
  const auto whyItEnded = [&]() {
    if (beats > 0 && ceiling_bounds_read && end == ReadEnd::Silent) {
      // Still working, and out of time. Say so rather than reporting a reset:
      // the connection is fine, and the caller's next move (a smaller job, a
      // longer-running tool) is not the one a transport failure calls for.
      return QStringLiteral("browser was still working on %1 after %2 ms (%3 "
                            "progress reports); the command was abandoned")
          .arg(request.value(QStringLiteral("cmd")).toString())
          .arg(options_.max_exchange_ms)
          .arg(beats);
    }
    return endedText(end, request.value(QStringLiteral("cmd")).toString(),
                     std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::steady_clock::now() - started)
                         .count(),
                     options_.io_timeout_ms);
  };
  for (;;) {
    // Whichever comes first: another silence budget, or the ceiling on the
    // whole exchange. Clamping here is what keeps a beat every few seconds
    // from extending the wait without end.
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            absolute_end - std::chrono::steady_clock::now())
            .count();
    ceiling_bounds_read = remaining <= options_.io_timeout_ms;
    const int budget = static_cast<int>(std::min<qint64>(
        options_.io_timeout_ms, std::max<qint64>(0, remaining)));
    IoDeadline deadline = deadlineAfter(budget, shutdown_pipe_[0]);
    // The reply's own transfer counts as progress: a frame big enough to take
    // longer than one budget to cross is not a silent peer.
    deadline.refresh_ms = options_.io_timeout_ms;
    deadline.absolute_end = absolute_end;
    if (!readFrame(connection_fd_, deadline, reply, &end)) {
      *why = whyItEnded();
      return false;
    }
    if (reply->value(QStringLiteral("type")).toString() !=
        QLatin1String("progress")) {
      return true;
    }
    ++beats;
    if (std::chrono::steady_clock::now() >= absolute_end) {
      *why = whyItEnded();
      return false;
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
  // Pin the connection identity, and wake on either sign that it has ended.
  // The generation changes when a fresh relay replaces this one, and it cannot
  // be missed -- connected_ oscillates false->true across a reconnect, so a
  // sender watching only that could sleep through both edges. connected_ going
  // false is the prompt sign: the I/O thread drops an idle connection whose
  // relay has gone, possibly just after this request was posted, and no
  // successor need ever arrive to move the generation on.
  const quint64 my_generation = generation_;
  // Ask the extension to report progress while it works. The deadline belongs
  // to this transport, so the request for the beats that hold it open belongs
  // here too. An extension older than this server ignores the flag and is
  // simply held to the plain silence budget, as it always was.
  request_frame_ = frame;
  request_frame_.insert(QStringLiteral("progress"), true);
  has_request_ = true;
  has_response_ = false;
  cv_.notify_all();
  cv_.wait(lock, [this, my_generation] {
    return has_response_ || !running_ || !connected_ ||
           generation_ != my_generation;
  });
  const bool got_response = has_response_;
  Exchange result{};
  // The I/O worker sets this; cppcheck cannot model that cross-thread write.
  // cppcheck-suppress knownConditionTrueFalse
  if (got_response) {
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
