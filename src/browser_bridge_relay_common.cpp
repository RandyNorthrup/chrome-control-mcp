// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The half of the relay that is the same on every platform: Chrome's stdio is
// std::cin and stdout everywhere, a frame body decodes the same way whatever
// carried it, and the handshake and the pump are written in terms of the
// platform half rather than in terms of a handle type.
//
// Only relayConnect, relayReadPipeFrame, relayWritePipeFrame, and
// awaitBrowserReply differ between a Windows named pipe and a POSIX socket;
// those live in browser_bridge_relay.cpp and browser_bridge_relay_posix.cpp.

#include "chrome_control_mcp/browser_bridge_relay.h"

#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QByteArray>
#include <QtEndian>

#include <cstdio>
#include <iostream>

namespace chrome_control_mcp {
namespace {

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

bool readStdinFrame(QJsonObject *out) {
  char header[kNativeFrameHeaderBytes];
  if (!stdinReadExact(header, kNativeFrameHeaderBytes) ||
      parseFrame(QByteArray(header, kNativeFrameHeaderBytes)).status ==
          NativeFrame::Status::Error) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  return readFrameBody(
      [](char *buffer, qsizetype size) { return stdinReadExact(buffer, size); },
      length, out);
}

bool writeStdoutFrame(const QJsonObject &message) {
  const QByteArray frame = encodeFrame(message);
  // Chrome terminates a native host that emits a host->browser frame over 1
  // MiB. Refuse to write an oversized frame (report failure so relayPumpOnce
  // tears the pipe down) rather than letting Chrome kill the host mid-stream.
  if (frame.size() - kNativeFrameHeaderBytes > kMaxHostToBrowserBytes) {
    return false;
  }
  const size_t written = std::fwrite(frame.constData(), 1,
                                     static_cast<size_t>(frame.size()), stdout);
  // A short write OR a failed flush means the frame did not reach Chrome
  // intact; report it so relayPumpOnce tears the pipe down instead of treating
  // a lost reply as delivered.
  return written == static_cast<size_t>(frame.size()) &&
         std::fflush(stdout) == 0;
}

} // namespace

bool readFrameBody(const ReadExactFn &read_exact, quint32 length,
                   QJsonObject *out) {
  QByteArray frame(kNativeFrameHeaderBytes, Qt::Uninitialized);
  qToLittleEndian<quint32>(length, reinterpret_cast<uchar *>(frame.data()));
  QByteArray body(static_cast<qsizetype>(length), Qt::Uninitialized);
  if (!read_exact(body.data(), body.size())) {
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
  // The welcome must confirm the SAME protocol version we offered, or the two
  // sides would pump frames under a version skew. Fail closed on a missing or
  // mismatched protocol value rather than trusting any frame whose type happens
  // to be "welcome".
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
  if (!relayReadPipeFrame(pipe, &command)) {
    return false; // the server (MCP process) closed the pipe
  }
  if (!browser_write(command)) {
    return false; // Chrome closed the extension port
  }
  QJsonObject reply;
  if (!awaitBrowserReply(pipe, browser_read, browser_write, &reply)) {
    return false; // the extension/Chrome went away, or the server abandoned
                  // the exchange
  }
  return relayWritePipeFrame(pipe,
                             reply); // false if the server reset the connection
}

int runBrowserRelay() {
  QString token;
  int protocol = 0;
  QString error;
  const QString rendezvous = browserBridgeRendezvousPath(&error);
  const NativeIpcHandle pipe =
      rendezvous.isEmpty()
          ? kInvalidNativeIpcHandle
          : relayConnect(rendezvous, &token, &protocol, &error);
  if (!nativeIpcHandleIsValid(pipe) ||
      !relayHandshake(pipe, token, protocol, &error)) {
    // Tell the extension the bridge is down so it can surface it, then exit
    // cleanly; Chrome relaunches the host on the next port connection.
    (void)writeStdoutFrame(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("bridge_unavailable")},
        {QStringLiteral("error"), error}});
    closeNativeIpcHandle(pipe);
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
  while (relayPumpOnce(pipe, reader, writer)) {
    // keep pumping until either side closes
  }
  closeNativeIpcHandle(pipe);
  return 0;
}

} // namespace chrome_control_mcp
