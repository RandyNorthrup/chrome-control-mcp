// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/native_messaging.h"
#include "chrome_control_mcp/windows_process_identity.h"

#include <QFile>
#include <QHash>
#include <QtEndian>

#include <chrono>
#include <cstdint>

#include <tlhelp32.h>

namespace chrome_control_mcp {

namespace {

// Budget for the best-effort cancel written after an exchange has already blown
// its deadline. Short on purpose: the connection is being torn down either way,
// and this must not add another full timeout to a teardown that is already
// late.
constexpr DWORD kCancelWriteBudgetMs = 1000;

// Budget for draining the extension's late reply after a cancel. Writing the
// cancel is not enough on its own: tearing the pipe down immediately afterwards
// discards it before the relay -- which only looks at the pipe every few
// milliseconds -- can read it, so the cancel would almost never arrive. Waiting
// for the reply the cancelled command produces is what proves the relay
// consumed it. The reply is prompt, because the poll loop checks its command
// generation every iteration.
constexpr DWORD kCancelDrainBudgetMs = 3000;

// How long a refused relay is given to read the refusal before its instance is
// disconnected.
constexpr DWORD kRefusalLingerMs = 1000;

// Native-messaging framing: a fixed 4-byte little-endian length prefix precedes
// every body.
constexpr int kFrameHeaderBytes = 4;

// In/out buffer advisory for the named pipe (64 KiB each).
constexpr DWORD kPipeBufferBytes = 64 * 1024;

// Backoff after a transient accept failure so a persistent error cannot
// hot-spin the loop.
constexpr DWORD kAcceptRetryBackoffMs = 50;

// Best-effort ancestor-image walk depth when confirming a Chrome-launched
// client.
constexpr int kChromeAncestorMaxDepth = 12;

// An ABSOLUTE deadline (a GetTickCount64 tick by which the whole logical
// operation must finish) plus the event that aborts the wait (the server
// shutdown event). The deadline is absolute, not per-call, so a byte-at-a-time
// dribble cannot keep restarting a per-op timer and hold a read open forever
// (slow-loris).
struct IoDeadline {
  ULONGLONG m_deadline_tick;
  HANDLE m_cancel_event;
  // Zero leaves this a hard deadline, which is what the handshake and every
  // write want. Set, it makes the budget a SILENCE budget: bytes arriving push
  // the deadline out again, never past m_absolute_tick.
  DWORD m_refresh_ms{0};
  ULONGLONG m_absolute_tick{0};

  // Called after a chunk that actually moved bytes. A frame still arriving is
  // not a peer that has gone quiet, and a multi-megabyte screenshot crossing a
  // loaded machine's pipe used to fail as a timeout while it was arriving
  // perfectly well.
  void noteProgress() {
    if (m_refresh_ms == 0) {
      return;
    }
    const ULONGLONG next = GetTickCount64() + m_refresh_ms;
    m_deadline_tick = (m_absolute_tick != 0 && next > m_absolute_tick)
                          ? m_absolute_tick
                          : next;
  }

  [[nodiscard]] DWORD remainingMs() const {
    const ULONGLONG now = GetTickCount64();
    if (now >= m_deadline_tick) {
      return 0;
    }
    const ULONGLONG left = m_deadline_tick - now;
    return left > MAXDWORD ? MAXDWORD : static_cast<DWORD>(left);
  }
};

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

// One overlapped read or write bounded by the absolute deadline and abortable
// via its cancel event. Returns bytes transferred, or -1 on error / timeout /
// abort, with which of those in @p end when given.
int overlappedIo(HANDLE pipe, bool is_write, char *buffer, DWORD size,
                 IoDeadline deadline, ReadEnd *end = nullptr) {
  ReadEnd why = ReadEnd::Closed;
  OVERLAPPED overlapped{};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (overlapped.hEvent == nullptr) {
    if (end != nullptr) {
      *end = why;
    }
    return -1;
  }
  DWORD moved = 0;
  const BOOL immediate =
      is_write ? WriteFile(pipe, buffer, size, &moved, &overlapped)
               : ReadFile(pipe, buffer, size, &moved, &overlapped);
  int result = -1;
  if (immediate != FALSE) {
    result = static_cast<int>(moved);
  } else if (GetLastError() == ERROR_IO_PENDING) {
    const HANDLE waits[2] = {overlapped.hEvent, deadline.m_cancel_event};
    const DWORD count = deadline.m_cancel_event != nullptr ? 2 : 1;
    const DWORD which =
        WaitForMultipleObjects(count, waits, FALSE, deadline.remainingMs());
    if (which == WAIT_OBJECT_0 &&
        GetOverlappedResult(pipe, &overlapped, &moved, FALSE) != FALSE) {
      result = static_cast<int>(moved);
    } else {
      if (which == WAIT_TIMEOUT) {
        why = ReadEnd::Silent;
      } else if (which == WAIT_OBJECT_0 + 1) {
        why = ReadEnd::Cancelled;
      }
      CancelIoEx(pipe, &overlapped);
      WaitForSingleObject(overlapped.hEvent,
                          INFINITE); // drain before the OVERLAPPED dies
    }
  }
  CloseHandle(overlapped.hEvent);
  if (result <= 0 && end != nullptr) {
    *end = why; // a zero-byte read is the peer's end of the pipe
  }
  return result;
}

// Reads exactly @p size bytes, or says why it could not in @p end.
bool pipeReadExact(HANDLE pipe, char *buffer, DWORD size, IoDeadline deadline,
                   ReadEnd *end = nullptr) {
  DWORD offset = 0;
  while (offset < size) {
    const int got = overlappedIo(pipe, false, buffer + offset, size - offset,
                                 deadline, end);
    if (got <= 0) {
      return false;
    }
    offset += static_cast<DWORD>(got);
    deadline.noteProgress(); // a local copy, so only this read is extended
  }
  return true;
}

bool pipeWriteAll(HANDLE pipe, const char *buffer, DWORD size,
                  IoDeadline deadline) {
  DWORD offset = 0;
  while (offset < size) {
    const int put =
        overlappedIo(pipe, true, const_cast<char *>(buffer) + offset,
                     size - offset, deadline);
    if (put <= 0) {
      return false;
    }
    offset += static_cast<DWORD>(put);
  }
  return true;
}

bool readFrame(HANDLE pipe, IoDeadline deadline, QJsonObject *out,
               ReadEnd *end = nullptr) {
  const auto malformed = [end]() {
    if (end != nullptr) {
      *end = ReadEnd::Malformed;
    }
    return false;
  };
  char header[kFrameHeaderBytes];
  if (!pipeReadExact(pipe, header, kFrameHeaderBytes, deadline, end)) {
    return false;
  }
  if (parseFrame(QByteArray(header, kFrameHeaderBytes)).status ==
      NativeFrame::Status::Error) {
    return malformed(); // zero / over-cap length prefix
  }
  const DWORD length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  QByteArray frame(header, kFrameHeaderBytes);
  QByteArray body(static_cast<int>(length), Qt::Uninitialized);
  if (!pipeReadExact(pipe, body.data(), length, deadline, end)) {
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

bool writeFrame(HANDLE pipe, const QJsonObject &message, IoDeadline deadline) {
  const QByteArray frame = encodeFrame(message);
  return pipeWriteAll(pipe, frame.constData(), static_cast<DWORD>(frame.size()),
                      deadline);
}

enum class ConnectResult { Connected, Shutdown, Error };

// Overlapped ConnectNamedPipe that also wakes on the shutdown event.
// Distinguishes a real client (Connected), a requested shutdown, and a
// transient failure (Error) so the caller can re-arm on Error instead of
// tearing the accept loop down.
ConnectResult waitForConnection(HANDLE pipe, HANDLE shutdown_event) {
  OVERLAPPED overlapped{};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (overlapped.hEvent == nullptr) {
    return ConnectResult::Error;
  }
  ConnectResult result = ConnectResult::Error;
  if (ConnectNamedPipe(pipe, &overlapped) != FALSE) {
    result = ConnectResult::Connected; // rare immediate completion
  } else if (GetLastError() == ERROR_PIPE_CONNECTED) {
    result = ConnectResult::Connected; // a client connected before we armed
  } else if (GetLastError() == ERROR_IO_PENDING) {
    const HANDLE waits[2] = {overlapped.hEvent, shutdown_event};
    const DWORD which = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (which == WAIT_OBJECT_0) {
      result = ConnectResult::Connected;
    } else {
      CancelIoEx(pipe, &overlapped);
      WaitForSingleObject(overlapped.hEvent, INFINITE);
      result = which == WAIT_OBJECT_0 + 1 ? ConnectResult::Shutdown
                                          : ConnectResult::Error;
    }
  }
  CloseHandle(overlapped.hEvent);
  return result;
}

// What the relay on an idle connection is doing, seen without consuming a byte.
enum class IdlePeer : std::uint8_t {
  Present, // connected and quiet, as it should be between commands
  Gone,    // closed its end, or died
  Talking  // bytes arrived with no command outstanding
};

// Look at an idle connection without reading from it. PeekNamedPipe neither
// blocks nor consumes, so this cannot take part of a frame -- and while idle
// there is no frame to take: the relay writes only to answer a command.
IdlePeer idlePeerState(HANDLE pipe) {
  DWORD available = 0;
  if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) == FALSE) {
    // ERROR_BROKEN_PIPE once the relay has closed its end. This is the server
    // end of a named pipe we created, so -- unlike the relay's look at its
    // stdin -- there is no "not a pipe" failure to mistake for a hangup: any
    // failure is a connection that cannot carry the next command.
    return IdlePeer::Gone;
  }
  return available == 0 ? IdlePeer::Present : IdlePeer::Talking;
}

// Best-effort walk up the process tree to the nearest ancestor image (e.g.
// chrome.exe), returning its pid or 0. Toolhelp parent pids can be
// stale/reused, so this is defense in depth, not a hard boundary.
DWORD ancestorWithImage(DWORD pid, const QString &target_basename_lower,
                        int max_depth) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    return 0;
  }
  QHash<quint64, quint64> parent;
  QHash<quint64, QString> image;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry) != FALSE) {
    do {
      parent.insert(entry.th32ProcessID, entry.th32ParentProcessID);
      image.insert(entry.th32ProcessID,
                   QString::fromWCharArray(entry.szExeFile).toLower());
    } while (Process32NextW(snapshot, &entry) != FALSE);
  }
  CloseHandle(snapshot);

  return static_cast<DWORD>(nearestAncestorWithImage(
      pid, parent, image, target_basename_lower, max_depth));
}

// One more instance of the bridge pipe, for the next relay. The first is
// created with FILE_FLAG_FIRST_PIPE_INSTANCE, which is what refuses a squatter
// that got the name first; the rest join it. Room for every admitted
// connection, one instance listening, and one more being turned away.
HANDLE createPipeInstance(const QString &name, bool first, QString *error) {
  SECURITY_ATTRIBUTES attributes{};
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!buildBridgePipeSecurity(&attributes, &descriptor, error)) {
    return INVALID_HANDLE_VALUE;
  }
  const std::wstring wide = name.toStdWString();
  const HANDLE pipe =
      CreateNamedPipeW(wide.c_str(),
                       PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
                           (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
                       PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                           PIPE_REJECT_REMOTE_CLIENTS,
                       kMaxBridgeConnections + 2, kPipeBufferBytes,
                       kPipeBufferBytes, 0, &attributes);
  LocalFree(descriptor);
  if (pipe == INVALID_HANDLE_VALUE && error != nullptr) {
    *error = QStringLiteral(
                 "CreateNamedPipe failed (err=%1); the name may be squatted")
                 .arg(GetLastError());
  }
  return pipe;
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
  return isOwnExecutable(static_cast<quint32>(record.app_pid));
}

bool BrowserBridgePipeServer::browserProcessAlive(quint64 pid) {
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                     static_cast<DWORD>(pid));
  if (process == nullptr) {
    // Gone -- or not ours to open, which a Chrome of this user always is.
    return GetLastError() == ERROR_ACCESS_DENIED;
  }
  DWORD code = 0;
  const bool alive =
      GetExitCodeProcess(process, &code) != FALSE && code == STILL_ACTIVE;
  CloseHandle(process);
  return alive;
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
  pipe_ = createPipeInstance(pipe_name_, true, error);
  if (pipe_ == INVALID_HANDLE_VALUE) {
    return false;
  }
  shutdown_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  token_ = generateBridgeToken();
  const RendezvousRecord record{pipe_name_, token_, options_.protocol,
                                static_cast<qint64>(GetCurrentProcessId())};
  // Fail closed (and leak nothing) if the shutdown event could not be created
  // or the rendezvous record could not be written -- the I/O threads must have
  // a valid abort event, and the relay must be able to discover the pipe.
  if (shutdown_event_ == nullptr ||
      !writeRendezvousRecord(rendezvous_path_, record, error)) {
    if (shutdown_event_ == nullptr && (error != nullptr)) {
      *error =
          QStringLiteral("CreateEvent failed (err=%1)").arg(GetLastError());
    }
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
    if (shutdown_event_ != nullptr) {
      CloseHandle(shutdown_event_);
      shutdown_event_ = nullptr;
    }
    return false;
  }
  return true;
}

bool BrowserBridgePipeServer::start(QString *error) {
  const std::lock_guard<std::mutex> lifecycle(lifecycle_mutex_);
  // Refuse a second start while a session is live: move-assigning a std::thread
  // onto a still joinable thread_ would call std::terminate. A prior stopped
  // cycle left thread_ joined (not joinable); join any leftover defensively
  // before it is reassigned below.
  if (running_) {
    if (error != nullptr) {
      *error = QStringLiteral("Bridge IPC server is already running");
    }
    return false;
  }
  if (thread_.joinable()) {
    thread_.join();
  }
  if (!createPipeResources(error)) {
    return false;
  }
  running_ = true;
  stop_done_ = false; // arm teardown for this cycle
  thread_ = std::thread([this] { run(); });
  return true;
}

void BrowserBridgePipeServer::stop() {
  // Hold lifecycle_mutex_ for the whole teardown so a concurrent stop() (or the
  // destructor) BLOCKS until this finishes, then sees stop_done_ and returns --
  // no double-join or double-close. Unlike the old std::once_flag, stop_done_
  // is re-armed by start(), so a later start/stop cycle tears down again
  // instead of being permanently disabled.
  const std::lock_guard<std::mutex> lifecycle(lifecycle_mutex_);
  if (stop_done_) {
    return; // already torn down this cycle (or never started)
  }
  stop_done_ = true;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
  }
  if (shutdown_event_ != nullptr) {
    SetEvent(shutdown_event_);
  }
  cv_.notify_all();
  if (thread_.joinable()) {
    thread_.join();
  }
  // Every connection thread sees running_ false or its I/O aborted by the
  // shutdown event, closes its own instance, and ends.
  std::vector<ConnectionPtr> remaining;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    remaining.swap(connections_);
  }
  for (const ConnectionPtr &connection : remaining) {
    if (connection->thread.joinable()) {
      connection->thread.join();
    }
  }
  if (pipe_ != INVALID_HANDLE_VALUE) {
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
  }
  if (shutdown_event_ != nullptr) {
    CloseHandle(shutdown_event_);
    shutdown_event_ = nullptr;
  }
  // Only remove the rendezvous record if it still advertises THIS process. A
  // second instance that stood down never owned it, and a peer server may have
  // (re)claimed it; deleting another instance's record would orphan the pipe
  // the relay is bound to.
  RendezvousRecord current;
  if (readRendezvousRecord(rendezvous_path_, &current, nullptr) &&
      current.app_pid == static_cast<qint64>(GetCurrentProcessId())) {
    QFile::remove(rendezvous_path_);
  }
}

void BrowserBridgePipeServer::run() {
  while (true) {
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      if (!running_) {
        return;
      }
    }
    reapFinished();
    if (pipe_ == INVALID_HANDLE_VALUE) {
      // Every instance is in use, or creating one failed. One frees up when a
      // connection ends; look again shortly rather than spin.
      pipe_ = createPipeInstance(pipe_name_, false, nullptr);
      if (pipe_ == INVALID_HANDLE_VALUE) {
        if (WaitForSingleObject(shutdown_event_, kAcceptRetryBackoffMs * 4) ==
            WAIT_OBJECT_0) {
          return;
        }
        continue;
      }
    }
    const ConnectResult connect = waitForConnection(pipe_, shutdown_event_);
    if (connect == ConnectResult::Shutdown) {
      return;
    }
    if (connect == ConnectResult::Error) {
      // Transient accept failure: re-arm rather than killing the accept loop
      // for the life of the process. Reset the instance and back off briefly so
      // a persistent error cannot hot-spin.
      DisconnectNamedPipe(pipe_);
      Sleep(kAcceptRetryBackoffMs);
      continue;
    }
    // The connected instance belongs to its connection from here; the next
    // relay gets a fresh one.
    const auto connection = std::make_shared<Connection>();
    connection->handle = pipe_;
    pipe_ = createPipeInstance(pipe_name_, false, nullptr);
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      connection->id = ++next_connection_id_;
      connections_.push_back(connection);
      connection->thread =
          std::thread([this, connection] { serveConnection(connection); });
    }
  }
}

void BrowserBridgePipeServer::serveConnection(const ConnectionPtr &connection) {
  if (handshake(*connection)) {
    serveConnected(*connection);
  }
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    connection->live = false;
  }
  cv_.notify_all(); // wake a sender waiting on this connection: it has ended
  DisconnectNamedPipe(connection->handle);
  CloseHandle(connection->handle);
  connection->handle = INVALID_HANDLE_VALUE;
  const std::lock_guard<std::mutex> lock(mutex_);
  connection->finished = true;
}

bool BrowserBridgePipeServer::handshake(Connection &connection) {
  // One absolute budget for the whole handshake, so a dribbling peer cannot
  // hold an instance open past the deadline by restarting a per-read timer.
  const IoDeadline deadline{.m_deadline_tick =
                                GetTickCount64() + options_.io_timeout_ms,
                            .m_cancel_event = shutdown_event_};
  const HANDLE pipe = connection.handle;
  QJsonObject hello;
  if (!readFrame(pipe, deadline, &hello)) {
    return false;
  }
  if (hello.value(QStringLiteral("type")).toString() !=
          QLatin1String("hello") ||
      hello.value(QStringLiteral("token")).toString() != token_) {
    return false;
  }
  const auto refuse = [&](const QString &why) {
    if (writeFrame(
            pipe,
            QJsonObject{{QStringLiteral("type"), QStringLiteral("error")},
                        {QStringLiteral("error"), why}},
            deadline)) {
      // DisconnectNamedPipe discards whatever the relay has not read yet, so
      // tearing down straight after the write lost the reason more often than
      // not. Wait for the relay to read it and close its end, briefly.
      const IoDeadline linger{.m_deadline_tick =
                                  GetTickCount64() + kRefusalLingerMs,
                              .m_cancel_event = shutdown_event_};
      QJsonObject discarded;
      readFrame(pipe, linger, &discarded);
    }
    return false;
  };
  if (hello.value(QStringLiteral("protocol")).toInt() != options_.protocol) {
    return refuse(QStringLiteral("protocol_mismatch"));
  }
  QString why;
  quint64 browser_pid = 0;
  if (!verifyPeer(pipe, &browser_pid, &why)) {
    return refuse(QStringLiteral("unauthorized: %1").arg(why));
  }
  QString refusal;
  {
    // Admitted before the welcome goes out, so two relays handshaking at once
    // cannot both take the last place.
    const std::lock_guard<std::mutex> lock(mutex_);
    connection.versions = peerVersionsFromHello(hello);
    connection.profile =
        peerProfileFromJson(hello.value(QStringLiteral("profile_name")),
                            hello.value(QStringLiteral("profile_email")));
    connection.browser_pid = browser_pid;
    for (const ConnectionPtr &candidate : connections_) {
      if (candidate.get() == &connection) {
        refusal = admit(candidate);
      }
    }
  }
  if (!refusal.isEmpty()) {
    return refuse(refusal);
  }
  cv_.notify_all();
  // `version` is this server's own; a relay older than 1.9.0 reads only the
  // type and protocol of a welcome and ignores it.
  return writeFrame(
      pipe,
      QJsonObject{
          {QStringLiteral("type"), QStringLiteral("welcome")},
          {QStringLiteral("protocol"), options_.protocol},
          {QStringLiteral("pid"), static_cast<double>(GetCurrentProcessId())},
          {QStringLiteral("version"),
           QString::fromLatin1(kBrowserExtensionVersion)}},
      deadline);
}

bool BrowserBridgePipeServer::verifyPeer(NativeIpcHandle handle,
                                         quint64 *browser_pid,
                                         QString *why) const {
  ULONG client_pid = 0;
  if (GetNamedPipeClientProcessId(handle, &client_pid) == FALSE) {
    *why = QStringLiteral("cannot identify client");
    return false;
  }
  if (!isOwnExecutable(static_cast<quint32>(client_pid))) {
    *why = QStringLiteral("client is not the bridge binary");
    return false;
  }
  if (options_.require_chrome_ancestor) {
    const DWORD chrome = ancestorWithImage(static_cast<DWORD>(client_pid),
                                           QStringLiteral("chrome.exe"),
                                           kChromeAncestorMaxDepth);
    if (chrome == 0) {
      *why = QStringLiteral("client was not launched by Chrome");
      return false;
    }
    *browser_pid = chrome;
  }
  return true;
}

void BrowserBridgePipeServer::serveConnected(Connection &connection) {
  const HANDLE pipe = connection.handle;
  while (true) {
    std::unique_lock<std::mutex> lock(mutex_);
    // Wait in slices, never for as long as it takes. From inside a wait only a
    // command can end, a relay that died between commands is indistinguishable
    // from one that is idle -- and its instance stayed held for it until a
    // command happened along to fail.
    const bool asked = cv_.wait_for(
        lock, std::chrono::milliseconds(kBrowserBridgeIdlePeerCheckMs),
        [this, &connection] { return connection.has_request || !running_; });
    if (!running_) {
      return;
    }
    if (!asked) {
      // Looked at with the lock released, as all pipe I/O is. A command posted
      // meanwhile is safe either way: a live relay serves it on the next pass,
      // and for a dead one this returns, the connection is marked gone, and
      // the sender -- which wakes on exactly that -- fails it.
      lock.unlock();
      if (idlePeerState(pipe) != IdlePeer::Present) {
        // Gone, or talking with nothing asked. The second is not a relay that
        // is keeping to the protocol, and its bytes left unread would be taken
        // as the reply to the NEXT command, before that command was even sent.
        return;
      }
      continue;
    }
    const QJsonObject request = connection.request_frame;
    connection.has_request = false;
    lock.unlock();

    const IoDeadline deadline{.m_deadline_tick =
                                  GetTickCount64() + options_.io_timeout_ms,
                              .m_cancel_event = shutdown_event_};
    QJsonObject reply;
    Exchange result;
    QString why;
    if (!writeFrame(pipe, request, deadline)) {
      result.error = QStringLiteral(
          "browser did not accept the command (timeout or reset)");
    } else if (!awaitReply(pipe, request, &reply, &why)) {
      result.error = why;
      // Abandoning the exchange here does not stop the extension: a handler
      // that POLLS (browser_download runs to 120 s, well past this deadline)
      // keeps driving the page for as long as ITS own timeout allows, because
      // nothing has told it the command is dead. The cancel is that signal --
      // the relay forwards it while it waits, the extension retires the command
      // generation, and the poll loop stops on its next iteration. Best effort
      // on a fresh short budget: the deadline above has already elapsed, and a
      // peer that will not take the frame is being torn down anyway.
      const IoDeadline cancel_deadline{.m_deadline_tick = GetTickCount64() +
                                                          kCancelWriteBudgetMs,
                                       .m_cancel_event = shutdown_event_};
      if (writeFrame(
              pipe,
              QJsonObject{{QStringLiteral("type"), QStringLiteral("cancel")}},
              cancel_deadline)) {
        // Do not tear down until the relay has had the chance to act on it. The
        // late reply is the proof it did; it belongs to a command this exchange
        // has already failed, so it is read only to be discarded.
        const IoDeadline drain_deadline{.m_deadline_tick = GetTickCount64() +
                                                           kCancelDrainBudgetMs,
                                        .m_cancel_event = shutdown_event_};
        QJsonObject discarded;
        readFrame(pipe, drain_deadline, &discarded);
      }
    } else {
      result.ok = true;
      result.reply = reply;
    }

    lock.lock();
    connection.response = result;
    connection.has_response = true;
    cv_.notify_all();
    lock.unlock();

    if (!result.ok) {
      return; // I/O failure: tear down this connection
    }
  }
}

bool BrowserBridgePipeServer::awaitReply(NativeIpcHandle handle,
                                         const QJsonObject &request,
                                         QJsonObject *reply, QString *why) {
  const ULONGLONG started = GetTickCount64();
  const ULONGLONG absolute_end =
      started + static_cast<ULONGLONG>(options_.max_exchange_ms);
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
                     static_cast<qint64>(GetTickCount64() - started),
                     options_.io_timeout_ms);
  };
  for (;;) {
    // Whichever comes first: another silence budget, or the ceiling on the
    // whole exchange. Clamping here is what keeps a beat every few seconds
    // from extending the wait without end.
    const ULONGLONG quiet_end =
        GetTickCount64() + static_cast<ULONGLONG>(options_.io_timeout_ms);
    ceiling_bounds_read = absolute_end <= quiet_end;
    const IoDeadline deadline{
        .m_deadline_tick = ceiling_bounds_read ? absolute_end : quiet_end,
        .m_cancel_event = shutdown_event_,
        // The reply's own transfer counts as progress: a frame big enough to
        // take longer than one budget to cross is not a silent peer.
        .m_refresh_ms = static_cast<DWORD>(options_.io_timeout_ms),
        .m_absolute_tick = absolute_end};
    if (!readFrame(handle, deadline, reply, &end)) {
      *why = whyItEnded();
      return false;
    }
    if (reply->value(QStringLiteral("type")).toString() !=
        QLatin1String("progress")) {
      return true;
    }
    ++beats;
    if (GetTickCount64() >= absolute_end) {
      *why = whyItEnded();
      return false;
    }
  }
}

} // namespace chrome_control_mcp
