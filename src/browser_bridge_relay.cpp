// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_relay.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QByteArray>
#include <QtEndian>

#include <atomic>
#include <thread>

namespace chrome_control_mcp {

namespace {

// How often the pump looks at the pipe while it is waiting for the extension's
// reply. Short enough that a cancel stops a polling handler promptly, long
// enough that an idle wait costs nothing measurable.
constexpr DWORD kCancelPollMs = 25;

// Room for a long \\?\-prefixed image path: twice MAX_PATH wide characters.
constexpr int kImagePathBufferChars = MAX_PATH * 2;

// Our own executable image path, lowercased for a case-insensitive compare.
// Used to verify the recorded server pid is really the bridge binary (not a
// foreign process a rewritten rendezvous record points at).
QString ownImageLower() {
  wchar_t buffer[kImagePathBufferChars] = {0};
  const DWORD length =
      GetModuleFileNameW(nullptr, buffer, kImagePathBufferChars);
  return QString::fromWCharArray(buffer, static_cast<int>(length)).toLower();
}

QString imageLower(DWORD pid) {
  const HANDLE process =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) {
    return {};
  }
  wchar_t buffer[kImagePathBufferChars] = {0};
  DWORD size = kImagePathBufferChars;
  const BOOL ok = QueryFullProcessImageNameW(process, 0, buffer, &size);
  CloseHandle(process);
  return ok != FALSE
             ? QString::fromWCharArray(buffer, static_cast<int>(size)).toLower()
             : QString();
}

// True iff @p pid resolves to our own executable image (case-insensitive). An
// empty image (pid gone / not queryable) is a failure, not a match.
bool pidIsOwnImage(DWORD pid) {
  const QString image = imageLower(pid);
  return !image.isEmpty() && image == ownImageLower();
}

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

} // namespace

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
  if (!pidIsOwnImage(static_cast<DWORD>(record.app_pid))) {
    // Name both images. The commonest cause by far is not an intruder but two
    // copies of this program: Chrome starts whichever executable its
    // native-messaging registration names, and that is not always the one
    // serving MCP. "Not the binary" alone sends the reader looking for the
    // wrong fault.
    setError(error, bridgeImageMismatchText(
                        imageLower(static_cast<DWORD>(record.app_pid)),
                        record.app_pid, ownImageLower()));
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
      !pidIsOwnImage(static_cast<DWORD>(server_pid))) {
    setError(error, bridgeImageMismatchText(
                        imageLower(static_cast<DWORD>(server_pid)),
                        static_cast<qint64>(server_pid), ownImageLower()));
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
                       const BrowserWriteFn &browser_write,
                       QJsonObject *reply) {
  std::atomic<bool> finished{false};
  bool read_ok = false;
  std::thread reader([&] {
    read_ok = browser_read(reply);
    finished.store(true, std::memory_order_release);
  });

  bool pipe_ok = true;
  while (!finished.load(std::memory_order_acquire)) {
    DWORD available = 0;
    if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) ==
        FALSE) {
      pipe_ok =
          false; // the server went away; stop watching and let the read finish
      break;
    }
    if (available < kNativeFrameHeaderBytes) {
      Sleep(kCancelPollMs);
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
