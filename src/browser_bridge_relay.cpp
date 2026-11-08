// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_relay.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_messaging.h"
#include "chrome_control_mcp/windows_process_identity.h"

#include <QByteArray>
#include <QtEndian>

#include <atomic>
#include <chrono>
#include <thread>

namespace chrome_control_mcp {

namespace {

// Loop a synchronous ReadFile until @p size bytes arrive or the pipe
// closes/errors.
bool pipeReadExact(HANDLE pipe, char *buffer, DWORD size) {
  DWORD offset = 0;
  while (offset < size) {
    DWORD got = 0;
    if (ReadFile(pipe, buffer + offset, size - offset, &got, nullptr) ==
            FALSE ||
        got == 0) {
      return false;
    }
    offset += got;
  }
  return true;
}

bool pipeWriteAll(HANDLE pipe, const char *buffer, DWORD size) {
  DWORD offset = 0;
  while (offset < size) {
    DWORD put = 0;
    if (WriteFile(pipe, buffer + offset, size - offset, &put, nullptr) ==
            FALSE ||
        put == 0) {
      return false;
    }
    offset += put;
  }
  return true;
}

// An event the reply's reader sets once the reply is in, so the loop waiting
// on the bridge pipe wakes for it at once. Without it every exchange waited out
// the rest of that loop's 25 ms Sleep: replies measured 26, 51, 76 and 101 ms,
// whole ticks, however fast the extension was. An event that cannot be made
// leaves the loop as it was, on its tick.
class ReplyEvent {
public:
  ReplyEvent() : event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ReplyEvent(const ReplyEvent &) = delete;
  ReplyEvent &operator=(const ReplyEvent &) = delete;
  ReplyEvent(ReplyEvent &&) = delete;
  ReplyEvent &operator=(ReplyEvent &&) = delete;
  ~ReplyEvent() {
    if (event_ != nullptr) {
      CloseHandle(event_);
    }
  }
  void set() const {
    if (event_ != nullptr) {
      SetEvent(event_);
    }
  }
  // Up to @p ms, returning early when the reply is in.
  void wait(DWORD ms) const {
    if (event_ != nullptr) {
      WaitForSingleObject(event_, ms);
    } else {
      Sleep(ms);
    }
  }

private:
  HANDLE event_;
};

} // namespace

NativeIpcHandle browserStdInHandle() { return GetStdHandle(STD_INPUT_HANDLE); }

bool browserInputClosed(NativeIpcHandle input) {
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    return true;
  }
  DWORD available = 0;
  if (PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) != FALSE) {
    return false; // still connected, with or without bytes waiting
  }
  // Only a hangup counts. Run from a console or with stdin redirected from a
  // file, PeekNamedPipe fails with something else entirely (the handle is not
  // a pipe), and answering "closed" there would end a relay that is fine.
  const DWORD reason = GetLastError();
  return reason == ERROR_BROKEN_PIPE || reason == ERROR_PIPE_NOT_CONNECTED;
}

bool relayReadPipeFrame(HANDLE pipe, QJsonObject *out) {
  char header[kNativeFrameHeaderBytes];
  if (!pipeReadExact(pipe, header, kNativeFrameHeaderBytes)) {
    return false;
  }
  if (parseFrame(QByteArray(header, kNativeFrameHeaderBytes)).status ==
      NativeFrame::Status::Error) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  return readFrameBody(
      [pipe](char *buffer, qsizetype size) {
        return pipeReadExact(pipe, buffer, static_cast<DWORD>(size));
      },
      length, out);
}

bool relayWritePipeFrame(HANDLE pipe, const QJsonObject &message) {
  const QByteArray frame = encodeFrame(message);
  return pipeWriteAll(pipe, frame.constData(),
                      static_cast<DWORD>(frame.size()));
}

HANDLE relayConnect(const QString &rendezvous_path, QString *token_out,
                    int *protocol_out, QString *error) {
  RendezvousRecord record;
  if (!readRendezvousRecord(rendezvous_path, &record, error)) {
    return INVALID_HANDLE_VALUE;
  }
  if (record.pipe_name.isEmpty() || record.app_pid <= 0) {
    setError(error,
             QStringLiteral(
                 "Rendezvous record is missing the pipe name or server pid."));
    return INVALID_HANDLE_VALUE;
  }
  // Early sanity: the recorded server pid should be our own binary (a clear
  // error if the server is gone). The binding check below is what actually
  // matters.
  if (!isOwnExecutable(static_cast<quint32>(record.app_pid))) {
    // Name both images. The commonest cause by far is not an intruder but two
    // copies of this program: Chrome starts whichever executable its
    // native-messaging registration names, and that is not always the one
    // serving MCP. "Not the binary" alone sends the reader looking for the
    // wrong fault.
    setError(error, bridgeImageMismatchText(
                        processImage(static_cast<quint32>(record.app_pid)),
                        record.app_pid, ownProcessImage()));
    return INVALID_HANDLE_VALUE;
  }
  const std::wstring wide = record.pipe_name.toStdWString();
  // SECURITY_IDENTIFICATION: the server may identify us but never impersonate
  // us.
  const HANDLE pipe = CreateFileW(
      wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) {
    setError(error, QStringLiteral("Cannot open the bridge pipe (err=%1).")
                        .arg(GetLastError()));
    return INVALID_HANDLE_VALUE;
  }
  // Bind identity to the ACTUAL connected pipe, not just the recorded pid: a
  // rewritten record could cite our real pid while naming a foreign pipe. The
  // process serving THIS handle must be our binary, or we refuse and close.
  ULONG server_pid = 0;
  if (GetNamedPipeServerProcessId(pipe, &server_pid) == FALSE ||
      !isOwnExecutable(static_cast<quint32>(server_pid))) {
    setError(error, bridgeImageMismatchText(
                        processImage(static_cast<quint32>(server_pid)),
                        static_cast<qint64>(server_pid), ownProcessImage()));
    CloseHandle(pipe);
    return INVALID_HANDLE_VALUE;
  }
  if (token_out != nullptr) {
    *token_out = record.token;
  }
  if (protocol_out != nullptr) {
    *protocol_out = record.protocol;
  }
  return pipe;
}

bool awaitBrowserReply(NativeIpcHandle pipe, const BrowserReadFn &browser_read,
                       const BrowserWriteFn &browser_write, QJsonObject *reply,
                       std::chrono::milliseconds cancel_poll) {
  std::atomic<bool> finished{false};
  bool read_ok = false;
  RelayProgressQueue progress;
  const ReplyEvent replied;
  std::thread reader([&] {
    read_ok = readBrowserReplyPastProgress(browser_read, &progress, reply);
    finished.store(true, std::memory_order_release);
    replied.set();
  });

  bool pipe_ok = true;
  while (!finished.load(std::memory_order_acquire)) {
    // Forwarded from the thread that owns the pipe, never from the one that
    // read them: a synchronous handle with a blocking read on it is no place
    // for a second thread's write.
    if (!drainProgressToPipe(pipe, &progress)) {
      pipe_ok = false;
      break;
    }
    DWORD available = 0;
    if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) ==
        FALSE) {
      pipe_ok =
          false; // the server went away; stop watching and let the read finish
      break;
    }
    if (available < kNativeFrameHeaderBytes) {
      // Bounded by the tick so a cancel and queued progress are still seen.
      replied.wait(static_cast<DWORD>(cancel_poll.count()));
      continue;
    }
    QJsonObject frame;
    if (!relayReadPipeFrame(pipe, &frame)) {
      pipe_ok = false;
      break;
    }
    // Only a cancel may arrive mid-exchange. Anything else means the server
    // sent a second command while this one is unanswered, which would desync
    // the one-op pump
    // -- fail closed rather than forward it.
    if (frame.value(QStringLiteral("type")).toString() !=
        QLatin1String("cancel")) {
      pipe_ok = false;
      break;
    }
    if (!browser_write(frame)) {
      pipe_ok = false; // Chrome closed the port
      break;
    }
  }

  reader.join();
  return pipe_ok && read_ok;
}

} // namespace chrome_control_mcp
