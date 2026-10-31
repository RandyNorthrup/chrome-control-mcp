// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QElapsedTimer>
#include <QDir>
#include <QFile>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QtEndian>
#include <QtTest/QtTest>

#include <atomic>
#include <chrono>
#include <cstring>
#include <thread>

#ifndef Q_OS_WIN
#include <sys/socket.h>
#include <sys/un.h>
#endif

using chrome_control_mcp::BrowserBridgePipeServer;
using chrome_control_mcp::closeNativeIpcHandle;
using chrome_control_mcp::encodeFrame;
using chrome_control_mcp::kBrowserBridgeProtocol;
using chrome_control_mcp::kInvalidNativeIpcHandle;
using chrome_control_mcp::NativeFrame;
using chrome_control_mcp::NativeIpcHandle;
using chrome_control_mcp::parseFrame;

namespace {

template <typename Predicate>
bool waitUntil(Predicate predicate, int timeout_ms) {
  QElapsedTimer timer;
  timer.start();
  while (!predicate() && timer.elapsed() < timeout_ms) {
    QTest::qWait(10);
  }
  return predicate();
}

// -- Minimal synchronous test client (stands in for the Chrome-spawned relay)
// ------

void sleepMilliseconds(int milliseconds) {
  std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

void flushClient(NativeIpcHandle handle) {
#ifdef Q_OS_WIN
  FlushFileBuffers(handle);
#else
  Q_UNUSED(handle);
#endif
}

NativeIpcHandle clientConnect(const QString &name) {
#ifdef Q_OS_WIN
  const std::wstring wide = name.toStdWString();
  for (int attempt = 0; attempt < 200; ++attempt) {
    const NativeIpcHandle handle = CreateFileW(
        wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (handle != kInvalidNativeIpcHandle) {
      return handle;
    }
    if (GetLastError() == ERROR_PIPE_BUSY) {
      WaitNamedPipeW(wide.c_str(), 100);
    } else {
      sleepMilliseconds(10);
    }
  }
  return kInvalidNativeIpcHandle;
#else
  const QByteArray endpoint = QFile::encodeName(name);
  for (int attempt = 0; attempt < 200; ++attempt) {
    const int handle = socket(AF_UNIX, SOCK_STREAM, 0);
    if (handle >= 0) {
      sockaddr_un address{};
      address.sun_family = AF_UNIX;
      if (endpoint.size() <
          static_cast<qsizetype>(sizeof(sockaddr_un::sun_path))) {
        std::memcpy(address.sun_path, endpoint.constData(),
                    static_cast<size_t>(endpoint.size() + 1));
        if (connect(handle, reinterpret_cast<sockaddr *>(&address),
                    sizeof(address)) == 0) {
          return handle;
        }
      }
      closeNativeIpcHandle(handle);
    }
    sleepMilliseconds(10);
  }
  return kInvalidNativeIpcHandle;
#endif
}

bool clientWrite(NativeIpcHandle handle, const QJsonObject &object) {
  const QByteArray frame = encodeFrame(object);
  qsizetype offset = 0;
  while (offset < frame.size()) {
#ifdef Q_OS_WIN
    DWORD wrote = 0;
    if (WriteFile(handle, frame.constData() + offset,
                  static_cast<DWORD>(frame.size() - offset), &wrote,
                  nullptr) == FALSE ||
        wrote == 0) {
      return false;
    }
    offset += wrote;
#else
    // MSG_NOSIGNAL, exactly as the code under test writes
    // (browser_bridge_pipe_posix.cpp). A plain write() to a socket whose peer
    // has closed raises SIGPIPE and kills the process -- which is what a test
    // that keeps writing until the server tears the connection down does on
    // purpose. The failure has to come back as a false, or the suite dies
    // instead of reporting.
#ifdef MSG_NOSIGNAL
    constexpr int flags = MSG_NOSIGNAL;
#else
    constexpr int flags = 0;
#endif
    const ssize_t wrote =
        ::send(handle, frame.constData() + offset,
               static_cast<size_t>(frame.size() - offset), flags);
    if (wrote <= 0) {
      return false;
    }
    offset += wrote;
#endif
  }
  return true;
}

// Write one frame in pieces, pausing between them: what a multi-megabyte reply
// looks like crossing a busy machine. Returns false as soon as the peer stops
// taking it.
bool clientWriteSlowly(NativeIpcHandle handle, const QJsonObject &object,
                       qsizetype chunk, int gap_ms) {
  const QByteArray frame = encodeFrame(object);
  qsizetype offset = 0;
  while (offset < frame.size()) {
    const qsizetype piece = qMin(chunk, frame.size() - offset);
    qsizetype written = 0;
    while (written < piece) {
#ifdef Q_OS_WIN
      DWORD wrote = 0;
      if (WriteFile(handle, frame.constData() + offset + written,
                    static_cast<DWORD>(piece - written), &wrote,
                    nullptr) == FALSE ||
          wrote == 0) {
        return false;
      }
      written += wrote;
#else
#ifdef MSG_NOSIGNAL
      constexpr int flags = MSG_NOSIGNAL;
#else
      constexpr int flags = 0;
#endif
      const ssize_t wrote = ::send(handle, frame.constData() + offset + written,
                                   static_cast<size_t>(piece - written), flags);
      if (wrote <= 0) {
        return false;
      }
      written += wrote;
#endif
    }
    offset += piece;
    if (offset < frame.size()) {
      sleepMilliseconds(gap_ms);
    }
  }
  return true;
}

bool clientReadExact(NativeIpcHandle handle, char *buffer, qsizetype size) {
  qsizetype offset = 0;
  while (offset < size) {
#ifdef Q_OS_WIN
    DWORD got = 0;
    if (ReadFile(handle, buffer + offset, static_cast<DWORD>(size - offset),
                 &got, nullptr) == FALSE ||
        got == 0) {
      return false;
    }
    offset += got;
#else
    const ssize_t got =
        read(handle, buffer + offset, static_cast<size_t>(size - offset));
    if (got <= 0) {
      return false;
    }
    offset += got;
#endif
  }
  return true;
}

bool clientRead(NativeIpcHandle handle, QJsonObject *out) {
  char header[4];
  if (!clientReadExact(handle, header, 4)) {
    return false;
  }
  const quint32 length =
      qFromLittleEndian<quint32>(reinterpret_cast<const uchar *>(header));
  QByteArray frame(header, 4);
  QByteArray body(static_cast<int>(length), Qt::Uninitialized);
  if (!clientReadExact(handle, body.data(), length)) {
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

// Connect + complete the hello/welcome handshake. Returns the connected handle,
// or kInvalidNativeIpcHandle on any failure.
NativeIpcHandle connectAndHandshake(const QString &name, const QString &token) {
  const NativeIpcHandle handle = clientConnect(name);
  if (handle == kInvalidNativeIpcHandle) {
    return handle;
  }
  // The version from its one definition: a literal here would have to be found
  // and raised by hand every time the protocol moves, and a stale one fails
  // every handshake in the suite rather than the one test that is about it.
  const bool sent = clientWrite(
      handle,
      QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                  {QStringLiteral("token"), token},
                  {QStringLiteral("protocol"), kBrowserBridgeProtocol}});
  QJsonObject welcome;
  if (!sent || !clientRead(handle, &welcome) ||
      welcome.value(QStringLiteral("type")).toString() !=
          QLatin1String("welcome")) {
    closeNativeIpcHandle(handle);
    return kInvalidNativeIpcHandle;
  }
  return handle;
}

// Result of a single handshake attempt with a caller-supplied hello frame.
// Unlike connectAndHandshake this does NOT require a welcome -- it reports
// exactly what the server did, so a test can assert a REFUSAL (no welcome, or
// an explicit error frame).
struct HandshakeAttempt {
  bool connected{false}; // the pipe opened
  bool got_frame{false}; // the server sent a frame back before dropping
  QJsonObject reply;     // that frame (empty if the server dropped silently)
};

HandshakeAttempt attemptHandshake(const QString &name,
                                  const QJsonObject &hello) {
  HandshakeAttempt out;
  const NativeIpcHandle handle = clientConnect(name);
  if (handle == kInvalidNativeIpcHandle) {
    return out;
  }
  out.connected = true;
  if (clientWrite(handle, hello)) {
    QJsonObject frame;
    if (clientRead(handle, &frame)) {
      out.got_frame = true;
      out.reply = frame;
    }
  }
  closeNativeIpcHandle(handle);
  return out;
}

BrowserBridgePipeServer::Options testOptions(const QString &rendezvous,
                                             int timeout_ms) {
  BrowserBridgePipeServer::Options options;
  options.require_chrome_ancestor =
      false; // the test client is not a Chrome child
  options.rendezvous_path = rendezvous;
  options.io_timeout_ms = timeout_ms;
  return options;
}

} // namespace

class BrowserBridgePipeTests : public QObject {
  Q_OBJECT

private slots:
  void send_beforeAnyClientReturnsNotConnected();
  void handshake_refusesForgedTokenAndUnknownType();
  void handshake_refusesProtocolMismatch();
  void ancestorChain_boundsDepthAndMatchesImage();
  void handshake_thenCommandReplyRoundTrips();
  void silentPeer_deadlineResetsConnection();
  void closingPeer_isReportedAsClosedNotSilent();
  void workingPeer_beatsHoldTheConnectionOpen();
  void slowFrame_transferHoldsTheConnectionOpen();
  void endlessPeer_absoluteCapAbandonsTheCommand();
  void reconnect_secondClientServedWithNewGeneration();
  void idlePeer_departureIsNoticedWithoutACommand();
  void idlePeer_departureFreesThePipeForTheNextRelay();
  void idlePeer_unpromptedFrameDropsTheConnection();
  void idlePeer_commandRacingTheDepartureFailsAndIsNeverReplayed();
  void doubleStop_isSafe();
  void restartAfterStopWorksAndDoubleStartRefused();
  void stop_keepsRendezvousOwnedByAnotherProcess();
  void start_takesOverStaleRendezvousRecord();
  void ensurePublished_republishesALostRecord();
  void ensurePublished_takesOverARecordLeftByAnExitedServer();
  void ensurePublished_refusesWhileNotRunning();
  void sweep_removesDepartedServersAndSparesTheLiving();
};

void BrowserBridgePipeTests::send_beforeAnyClientReturnsNotConnected() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")}});
  QVERIFY(!exchange.ok);
  QCOMPARE(exchange.error, QStringLiteral("Browser not connected."));
  server.stop();
}

void BrowserBridgePipeTests::handshake_refusesForgedTokenAndUnknownType() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  const QString name = server.pipeName();
  const QString real_token = server.token();

  // (1) Forged token: the token is the shared secret authorizing the pipe peer.
  // A hello
  //     carrying the wrong token (a foreign process that connected to the pipe
  //     and guessed) is dropped with no welcome, and the server never admits
  //     the peer.
  HandshakeAttempt forged;
  std::thread forged_client([&] {
    forged = attemptHandshake(
        name,
        QJsonObject{
            {QStringLiteral("type"), QStringLiteral("hello")},
            {QStringLiteral("token"), real_token + QStringLiteral("_forged")},
            {QStringLiteral("protocol"), kBrowserBridgeProtocol}});
  });
  forged_client.join();
  QVERIFY(forged.connected); // pipe opened -- the refusal is the token gate,
                             // not connect
  // Token gate drops the peer before any frame; !got_frame pins that (!=
  // welcome was vacuous).
  QVERIFY(!forged.got_frame);
  QVERIFY(!server.clientConnected());

  // (2) Unknown first-frame type WITH the correct token: the handshake must
  // open with a
  //     "hello"; anything else ("attach" here) is refused even though the token
  //     is right.
  HandshakeAttempt bad_type;
  std::thread type_client([&] {
    bad_type = attemptHandshake(
        name,
        QJsonObject{{QStringLiteral("type"), QStringLiteral("attach")},
                    {QStringLiteral("token"), real_token},
                    {QStringLiteral("protocol"), kBrowserBridgeProtocol}});
  });
  type_client.join();
  QVERIFY(!bad_type.got_frame); // wrong first-frame type is dropped before any
                                // welcome frame
  QVERIFY(!server.clientConnected());

  // Non-vacuity control: the SAME harness, with a correct hello (right type +
  // token + protocol), completes the handshake and the server admits the peer
  // and serves a command -- so the refusals above are the hello/token gates,
  // not a server that welcomes nobody. The re-armed accept loop (proven
  // elsewhere) accepts this connection.
  std::atomic<bool> good_ok{false};
  std::thread good_client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, real_token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (clientRead(handle, &command)) {
      clientWrite(
          handle,
          QJsonObject{
              {QStringLiteral("type"), QStringLiteral("result")},
              {QStringLiteral("id"), command.value(QStringLiteral("id"))},
              {QStringLiteral("payload"), QJsonObject{}}});
      flushClient(handle);
      good_ok = true;
    }
    closeNativeIpcHandle(handle);
  });
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  const auto served = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("ok-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY2(served.ok, qPrintable(served.error));
  good_client.join();
  QVERIFY(good_ok.load());
  server.stop();
}

void BrowserBridgePipeTests::handshake_refusesProtocolMismatch() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  const QString name = server.pipeName();
  const QString real_token = server.token();

  // A hello with the right type and token but a mismatched protocol version is
  // refused: no welcome, and the server never admits the peer. The server makes
  // a best-effort "protocol_mismatch" diagnostic write before it drops, but its
  // immediate DisconnectNamedPipe can discard that frame before the client
  // reads it (a named pipe drops unread data on disconnect), so the RELIABLE
  // contract asserted here is the refusal itself; if the diagnostic frame does
  // survive the race it must be the error, never a welcome. This stays specific
  // to the protocol gate: were that gate removed, the mismatched hello would be
  // welcomed and the "!= welcome" checks would go red.
  HandshakeAttempt mism;
  std::thread client([&] {
    mism = attemptHandshake(
        name, QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                          {QStringLiteral("token"), real_token},
                          {QStringLiteral("protocol"), 999}});
  });
  client.join();
  QVERIFY(mism.reply.value(QStringLiteral("type")).toString() !=
          QLatin1String("welcome"));
  if (mism.got_frame) {
    QCOMPARE(mism.reply.value(QStringLiteral("type")).toString(),
             QStringLiteral("error"));
    QCOMPARE(mism.reply.value(QStringLiteral("error")).toString(),
             QStringLiteral("protocol_mismatch"));
  }
  QVERIFY(!server.clientConnected());
  server.stop();
}

void BrowserBridgePipeTests::ancestorChain_boundsDepthAndMatchesImage() {
  // In production the pipe optionally binds the peer to a Chrome-launched
  // process (require_chrome_ancestor) by walking the process tree for
  // chrome.exe within a depth cap. Model a tree: leaf 100 -> 90 -> 80 ->
  // 70(chrome.exe) -> 0(root), so chrome is three ancestors above the leaf.
  // Images are stored LOWERCASED (as the live walk does).
  const QHash<quint64, quint64> parent{{100, 90}, {90, 80}, {80, 70}, {70, 0}};
  const QHash<quint64, QString> image{{100, QStringLiteral("tab.exe")},
                                      {90, QStringLiteral("renderer.exe")},
                                      {80, QStringLiteral("gpu.exe")},
                                      {70, QStringLiteral("chrome.exe")}};

  // Authorized: a generous depth budget reaches the chrome ancestor.
  QVERIFY(chrome_control_mcp::ancestorChainContainsImage(
      100, parent, image, QStringLiteral("chrome.exe"), 12));

  // Depth cap (the security bound): a budget too small to reach chrome must NOT
  // authorize. The walk inspects one ancestor per iteration, so a budget of 2
  // sees only the two nearest ancestors (renderer, gpu) and stops before chrome
  // -> refused. This is what stops a peer with a very distant, coincidental
  // chrome.exe ancestor from being bound.
  QVERIFY(!chrome_control_mcp::ancestorChainContainsImage(
      100, parent, image, QStringLiteral("chrome.exe"), 2));

  // No chrome anywhere in the chain -> refused (a non-Chrome-launched peer).
  const QHash<quint64, QString> noChrome{{100, QStringLiteral("tab.exe")},
                                         {90, QStringLiteral("renderer.exe")},
                                         {80, QStringLiteral("gpu.exe")},
                                         {70, QStringLiteral("explorer.exe")}};
  QVERIFY(!chrome_control_mcp::ancestorChainContainsImage(
      100, parent, noChrome, QStringLiteral("chrome.exe"), 12));

  // A CYCLE in the parent map (100 -> 90 -> 100) must terminate under the depth
  // bound rather than loop forever, and with no chrome ancestor it fails
  // closed. A stale/reused Toolhelp parent pid can produce exactly such a
  // cycle.
  const QHash<quint64, quint64> cyclic{{100, 90}, {90, 100}};
  const QHash<quint64, QString> cyclicImage{
      {100, QStringLiteral("tab.exe")}, {90, QStringLiteral("renderer.exe")}};
  QVERIFY(!chrome_control_mcp::ancestorChainContainsImage(
      100, cyclic, cyclicImage, QStringLiteral("chrome.exe"), 12));
}

void BrowserBridgePipeTests::handshake_thenCommandReplyRoundTrips() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const QString name = server.pipeName();
  const QString token = server.token();
  std::atomic<bool> client_ok{false};
  std::thread client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (clientRead(handle, &command)) {
      clientWrite(
          handle,
          QJsonObject{
              {QStringLiteral("type"), QStringLiteral("result")},
              {QStringLiteral("id"), command.value(QStringLiteral("id"))},
              {QStringLiteral("cmd"), command.value(QStringLiteral("cmd"))},
              {QStringLiteral("payload"),
               QJsonObject{{QStringLiteral("echoed"), true}}}});
      flushClient(handle); // ensure the server reads the reply before we close
      client_ok = true;
    }
    closeNativeIpcHandle(handle);
  });

  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  QCOMPARE(server.connectionGeneration(), quint64{1});

  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  QCOMPARE(exchange.reply.value(QStringLiteral("id")).toString(),
           QStringLiteral("b-1"));
  QCOMPARE(exchange.reply.value(QStringLiteral("payload"))
               .toObject()
               .value(QStringLiteral("echoed"))
               .toBool(),
           true);

  client.join();
  QVERIFY(client_ok.load());
  server.stop();
}

void BrowserBridgePipeTests::silentPeer_deadlineResetsConnection() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 300));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const QString name = server.pipeName();
  const QString token = server.token();
  std::thread client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    clientRead(handle, &command); // read the command but never reply
    sleepMilliseconds(600); // stay connected past the server's 300 ms deadline
    closeNativeIpcHandle(handle);
  });

  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY(!exchange.ok);
  QCOMPARE(
      exchange.error,
      QStringLiteral("browser did not reply within 300 ms (connection reset)"));
  QVERIFY(waitUntil([&server] { return !server.clientConnected(); },
                    5000)); // connection torn down

  client.join();
  server.stop();
}

// A relay that goes away mid-command is not a browser gone quiet. Both used to
// be reported as "browser did not reply within N ms" -- here the budget is 30 s
// and the relay closes at once, so that text would have claimed half a minute
// of silence for a connection that was gone in a millisecond, and a stalled
// browser could not be told from a broken bridge.
void BrowserBridgePipeTests::closingPeer_isReportedAsClosedNotSilent() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 30000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const QString name = server.pipeName();
  const QString token = server.token();
  std::thread client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    clientRead(handle, &command); // take the command, then leave
    closeNativeIpcHandle(handle);
  });

  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  QElapsedTimer timer;
  timer.start();
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("click")}});
  QVERIFY(!exchange.ok);
  QVERIFY2(exchange.error.startsWith(
               QStringLiteral("the browser's relay closed the connection ")),
           qPrintable(exchange.error));
  QVERIFY2(
      exchange.error.contains(QStringLiteral(" ms into click, before "
                                             "replying (connection reset)")),
      qPrintable(exchange.error));
  QVERIFY2(timer.elapsed() < 10000, "reported at once, not after the budget");

  client.join();
  server.stop();
}

// The reply budget is a SILENCE budget, not a work budget.
//
// Before this, 30 s without a frame on the pipe tore the connection down --
// while handlers are allowed far longer by design (browser_download polls to
// 120 s). A download on a slow link, or a loaded machine, therefore came back
// as "browser did not reply within 30000 ms (connection reset)": a transport
// failure reported for work that was proceeding normally, and a reset for a
// browser that was perfectly healthy.
//
// Here the peer takes four times its silence budget to answer, and says so
// while it works.
void BrowserBridgePipeTests::workingPeer_beatsHoldTheConnectionOpen() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 300));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const QString name = server.pipeName();
  const QString token = server.token();
  std::atomic<bool> asked_for_progress{false};
  std::thread client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (!clientRead(handle, &command)) {
      closeNativeIpcHandle(handle);
      return;
    }
    // The server asks for the beats it is about to rely on. An extension older
    // than this server never sees the flag, ignores it, and is held to the
    // plain silence budget.
    asked_for_progress.store(
        command.value(QStringLiteral("progress")).toBool(false));
    // Four beats at 150 ms: every one of them lands inside the 300 ms budget,
    // and together they carry the exchange to twice what a silent peer is
    // allowed.
    for (int beat = 0; beat < 4; ++beat) {
      sleepMilliseconds(150);
      if (!clientWrite(
              handle,
              QJsonObject{{QStringLiteral("type"), QStringLiteral("progress")},
                          {QStringLiteral("id"), QStringLiteral("b-1")},
                          {QStringLiteral("elapsed_ms"), 150 * (beat + 1)}})) {
        closeNativeIpcHandle(handle);
        return;
      }
    }
    clientWrite(handle,
                QJsonObject{{QStringLiteral("type"), QStringLiteral("result")},
                            {QStringLiteral("id"), QStringLiteral("b-1")},
                            {QStringLiteral("payload"),
                             QJsonObject{{QStringLiteral("slow"), true}}}});
    closeNativeIpcHandle(handle);
  });

  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("download")}});
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  QVERIFY(asked_for_progress.load());
  QCOMPARE(exchange.reply.value(QStringLiteral("payload"))
               .toObject()
               .value(QStringLiteral("slow"))
               .toBool(),
           true);
  // The beats were consumed by the transport, never handed up as the answer.
  QCOMPARE(exchange.reply.value(QStringLiteral("type")).toString(),
           QStringLiteral("result"));

  client.join();
  server.stop();
}

// A beat every few seconds must not be able to hold a command open forever: a
// handler still running this long is not going to finish, and the alternative
// is an MCP call that never returns. The refusal says the command ran too long
// rather than blaming the connection -- the caller's next move is not the one a
// transport failure calls for.
// A frame that is still arriving is not a peer that has gone silent.
//
// The read loop handed every chunk the SAME shrinking deadline, so a reply had
// to cross the pipe IN FULL inside one budget however steadily its bytes
// flowed. A screenshot at 5120x2880 is megabytes; on a loaded runner that
// transfer outran 30 s and came back as "browser did not reply within 30000 ms
// (connection reset)" -- for a reply that was arriving perfectly well. The
// progress beats cannot help there: once the extension starts posting the reply
// there are no more beats to send, and the stall is in the transfer itself.
//
// Here the peer takes three times its silence budget to deliver one frame, a
// piece at a time.
void BrowserBridgePipeTests::slowFrame_transferHoldsTheConnectionOpen() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 300));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const QString name = server.pipeName();
  const QString token = server.token();
  // Big enough that it has to be chunked, and recognisable on the way out.
  const QString payload(4000, QLatin1Char('x'));
  std::thread client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (!clientRead(handle, &command)) {
      closeNativeIpcHandle(handle);
      return;
    }
    // Ten pieces, 100 ms apart: a second of transfer against a 300 ms budget.
    clientWriteSlowly(
        handle,
        QJsonObject{{QStringLiteral("type"), QStringLiteral("result")},
                    {QStringLiteral("id"), QStringLiteral("b-1")},
                    {QStringLiteral("payload"),
                     QJsonObject{{QStringLiteral("data"), payload}}}},
        450, 100);
    closeNativeIpcHandle(handle);
  });

  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("screenshot")}});
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  // Whole and intact, not merely accepted.
  QCOMPARE(exchange.reply.value(QStringLiteral("payload"))
               .toObject()
               .value(QStringLiteral("data"))
               .toString()
               .size(),
           payload.size());

  client.join();
  server.stop();
}

void BrowserBridgePipeTests::endlessPeer_absoluteCapAbandonsTheCommand() {
  QTemporaryDir dir;
  auto options = testOptions(dir.filePath(QStringLiteral("r.json")), 1000);
  options.max_exchange_ms = 700; // the whole exchange, however lively the peer
  BrowserBridgePipeServer server(options);
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const QString name = server.pipeName();
  const QString token = server.token();
  std::thread client([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (!clientRead(handle, &command)) {
      closeNativeIpcHandle(handle);
      return;
    }
    // Beats, and never an answer: the shape of a handler wedged in a poll loop.
    while (clientWrite(
        handle,
        QJsonObject{{QStringLiteral("type"), QStringLiteral("progress")},
                    {QStringLiteral("id"), QStringLiteral("b-1")}})) {
      sleepMilliseconds(100);
    }
    closeNativeIpcHandle(handle);
  });

  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("wait_for")}});
  QVERIFY(!exchange.ok);
  // Names the command, the budget it spent, and that it was working rather than
  // silent.
  QVERIFY2(exchange.error.contains(QStringLiteral("still working on wait_for")),
           qPrintable(exchange.error));
  QVERIFY2(exchange.error.contains(QStringLiteral("700 ms")),
           qPrintable(exchange.error));
  QVERIFY2(!exchange.error.contains(QStringLiteral("connection reset")),
           qPrintable(exchange.error));
  QVERIFY(waitUntil([&server] { return !server.clientConnected(); }, 5000));

  client.join();
  server.stop();
}

void BrowserBridgePipeTests::reconnect_secondClientServedWithNewGeneration() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), 500));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  const QString name = server.pipeName();
  const QString token = server.token();

  // Relay A: connect, read the command, then vanish without replying (a reset).
  std::thread client_a([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    clientRead(handle, &command);
    closeNativeIpcHandle(handle); // die mid-command
  });
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  const auto reset = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY(!reset.ok);
  // A relay that died is reported as one that closed the connection, not as
  // one that stayed silent for the whole budget.
  QVERIFY2(reset.error.startsWith(
               QStringLiteral("the browser's relay closed the connection ")),
           qPrintable(reset.error));
  client_a.join();
  QVERIFY(waitUntil([&server] { return !server.clientConnected(); },
                    5000)); // the accept loop re-armed

  // Relay B: a fresh connection must be accepted and served (generation
  // advances).
  std::atomic<bool> client_ok{false};
  std::thread client_b([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (clientRead(handle, &command)) {
      clientWrite(
          handle,
          QJsonObject{
              {QStringLiteral("type"), QStringLiteral("result")},
              {QStringLiteral("id"), command.value(QStringLiteral("id"))},
              {QStringLiteral("payload"), QJsonObject{}}});
      flushClient(handle);
      client_ok = true;
    }
    closeNativeIpcHandle(handle);
  });
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  QCOMPARE(server.connectionGeneration(), quint64{2});
  const auto served = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-2")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY2(served.ok, qPrintable(served.error));
  QCOMPARE(served.reply.value(QStringLiteral("id")).toString(),
           QStringLiteral("b-2"));
  client_b.join();
  QVERIFY(client_ok.load());
  server.stop();
}

// -- A relay that leaves while nothing is being asked of it ------------------
//
// The server only ever looked at its connection while it had a command to
// send. A relay that went away between commands -- Chrome restarting, the
// extension reloading, both routine -- left the server holding its one pipe
// instance "connected" until the next command happened to fail, and every
// relay Chrome started in the meantime was turned away with ERROR_PIPE_BUSY.
// Observed live on Windows: a server started the day before had been
// unreachable all day, because nothing had sent it a command since its relay
// died. These pin that the server notices on its own.

namespace {

// Far longer than any of these tests run, so no exchange deadline can be what
// notices the departure: if the server lets go inside the test's window, it was
// the idle check that did it.
constexpr int kNoDeadlineInPlayMs = 60'000;

// The bound on noticing. The check runs several times a second, so this is
// generous; it exists so that a server which never notices FAILS the test
// rather than hanging it.
constexpr int kDepartureNoticedWithinMs = 2'000;

// How long a command that raced the departure may take to be refused. Well
// under kNoDeadlineInPlayMs, so a sender left waiting for a connection that is
// already gone cannot pass by timing out.
constexpr int kRacingCommandSettledWithinMs = 5'000;

} // namespace

void BrowserBridgePipeTests::idlePeer_departureIsNoticedWithoutACommand() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), kNoDeadlineInPlayMs));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const NativeIpcHandle relay =
      connectAndHandshake(server.pipeName(), server.token());
  QVERIFY(relay != kInvalidNativeIpcHandle);
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  closeNativeIpcHandle(relay); // gone, and no command was ever sent

  QVERIFY2(waitUntil([&server] { return !server.clientConnected(); },
                     kDepartureNoticedWithinMs),
           "the server still believes a relay that left is connected");
  // And the next caller is told so at once, rather than being handed a
  // connection that will fail it.
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY(!exchange.ok);
  QCOMPARE(exchange.error, QStringLiteral("Browser not connected."));
  server.stop();
}

// The half of the fault a user actually sees: the NEXT relay is turned away.
// Nothing here sends a command, because nothing did in the field either.
void BrowserBridgePipeTests::idlePeer_departureFreesThePipeForTheNextRelay() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), kNoDeadlineInPlayMs));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  const QString name = server.pipeName();
  const QString token = server.token();

  const NativeIpcHandle first = connectAndHandshake(name, token);
  QVERIFY(first != kInvalidNativeIpcHandle);
  QVERIFY(waitUntil([&server] { return server.connectionGeneration() == 1; },
                    5000));
  closeNativeIpcHandle(first);

  // On a thread, because against a server that never noticed the first relay
  // leave, this connect is refused for as long as it retries (Windows:
  // ERROR_PIPE_BUSY) or its hello is never answered (POSIX: it sits in the
  // listen backlog). The test has to fail on that, not hang on it.
  std::atomic<bool> welcomed{false};
  std::thread second([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle != kInvalidNativeIpcHandle) {
      welcomed.store(true);
      closeNativeIpcHandle(handle);
    }
  });
  // Both sides of the handshake, so stop() below cannot race the welcome: a
  // named pipe discards unread bytes on disconnect.
  const bool admitted = waitUntil(
      [&] { return welcomed.load() && server.connectionGeneration() == 2; },
      kDepartureNoticedWithinMs + 3000);
  server.stop(); // releases a second relay that the server never turned to
  second.join();
  QVERIFY2(admitted, "a relay that left with no command outstanding still "
                     "holds the pipe, and the next relay was turned away");
}

// The relay speaks on the pipe only to answer a command. A frame with no
// command outstanding is a peer out of step with the protocol -- and left
// unread it would be taken as the reply to the NEXT command, which would then
// be "answered" before it was even sent.
void BrowserBridgePipeTests::idlePeer_unpromptedFrameDropsTheConnection() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), kNoDeadlineInPlayMs));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const NativeIpcHandle relay =
      connectAndHandshake(server.pipeName(), server.token());
  QVERIFY(relay != kInvalidNativeIpcHandle);
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));
  // Not flushed: on Windows FlushFileBuffers waits for the server to READ the
  // bytes, and a server that only peeks never will.
  QVERIFY(clientWrite(
      relay, QJsonObject{{QStringLiteral("type"), QStringLiteral("result")},
                         {QStringLiteral("id"), QStringLiteral("unasked")},
                         {QStringLiteral("payload"), QJsonObject{}}}));

  QVERIFY2(waitUntil([&server] { return !server.clientConnected(); },
                     kDepartureNoticedWithinMs),
           "a peer that spoke unprompted is still being served");
  closeNativeIpcHandle(relay);
  server.stop();
}

// The drop decides on its own thread, so a command can arrive while it is
// deciding. Whichever side wins, the command must FAIL -- promptly, not after
// a successor relay happens to arrive -- and it must never be executed on the
// connection that comes next. Swept across the window in which the idle check
// can land, since which side wins is a matter of timing.
void BrowserBridgePipeTests::
    idlePeer_commandRacingTheDepartureFailsAndIsNeverReplayed() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      testOptions(dir.filePath(QStringLiteral("r.json")), kNoDeadlineInPlayMs));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  const QString name = server.pipeName();
  const QString token = server.token();

  // Every way a command can fail against a relay that has just gone, and
  // nothing else. The last is the existing wording for a reply read that hit
  // end-of-stream, which names the budget even though it ended at once.
  const QStringList refusals{
      QStringLiteral("Browser not connected."),
      QStringLiteral("Browser connection closed before it replied."),
      QStringLiteral("browser did not accept the command (timeout or reset)"),
      QStringLiteral("browser did not reply within %1 ms (connection reset)")
          .arg(kNoDeadlineInPlayMs)};

  constexpr int kRounds = 12;
  constexpr int kStepMs = 25; // 0..275 ms after the departure: one full check
  quint64 generation = 0;
  for (int round = 0; round < kRounds; ++round) {
    const NativeIpcHandle doomed = connectAndHandshake(name, token);
    QVERIFY(doomed != kInvalidNativeIpcHandle);
    ++generation;
    QVERIFY(waitUntil(
        [&] {
          return server.clientConnected() &&
                 server.connectionGeneration() == generation;
        },
        5000));
    closeNativeIpcHandle(doomed);
    sleepMilliseconds(round * kStepMs);

    std::atomic<bool> settled{false};
    BrowserBridgePipeServer::Exchange outcome;
    std::thread sender([&] {
      outcome = server.sendCommandAwaitReply(
          QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                      {QStringLiteral("id"), QStringLiteral("stale")},
                      {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
      settled.store(true);
    });
    const bool prompt = waitUntil([&] { return settled.load(); },
                                  kRacingCommandSettledWithinMs);
    if (!prompt) {
      server.stop(); // the only thing left that wakes a stranded sender
    }
    sender.join();
    QVERIFY2(prompt, qPrintable(QStringLiteral("round %1: a command that raced "
                                               "the departure was left waiting")
                                    .arg(round)));
    QVERIFY(!outcome.ok);
    QVERIFY2(refusals.contains(outcome.error), qPrintable(outcome.error));
    QVERIFY(waitUntil([&server] { return !server.clientConnected(); },
                      kDepartureNoticedWithinMs));
  }

  // The relay that comes next is asked only what it is asked: none of the
  // commands above reaches it.
  std::atomic<bool> replied{false};
  QString first_id;
  std::thread successor([&] {
    const NativeIpcHandle handle = connectAndHandshake(name, token);
    if (handle == kInvalidNativeIpcHandle) {
      return;
    }
    QJsonObject command;
    if (clientRead(handle, &command)) {
      first_id = command.value(QStringLiteral("id")).toString();
      clientWrite(
          handle,
          QJsonObject{
              {QStringLiteral("type"), QStringLiteral("result")},
              {QStringLiteral("id"), command.value(QStringLiteral("id"))},
              {QStringLiteral("payload"), QJsonObject{}}});
      flushClient(handle);
      replied.store(true);
    }
    closeNativeIpcHandle(handle);
  });
  ++generation;
  QVERIFY(waitUntil(
      [&] {
        return server.clientConnected() &&
               server.connectionGeneration() == generation;
      },
      5000));
  const auto served = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("fresh")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  successor.join();
  QVERIFY2(served.ok, qPrintable(served.error));
  QVERIFY(replied.load());
  QCOMPARE(first_id, QStringLiteral("fresh"));
  server.stop();
}

void BrowserBridgePipeTests::doubleStop_isSafe() {
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  QVERIFY(QFile::exists(rendezvous)); // start() published the discovery record
  server.stop();
  server.stop(); // second stop (and the destructor's) must be a safe no-op, not
                 // a crash

  // Idempotence is OBSERVABLE, not just "it did not crash": the first stop tore
  // the cycle down -- rendezvous record removed, sender fails closed -- and the
  // second left that teardown exactly as it found it rather than re-closing a
  // handle or re-joining a thread.
  QVERIFY(!QFile::exists(rendezvous));
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")}});
  QVERIFY(!exchange.ok);
  QCOMPARE(exchange.error, QStringLiteral("Browser not connected."));
}

void BrowserBridgePipeTests::restartAfterStopWorksAndDoubleStartRefused() {
  // B13-05: start -> stop -> start must tear down each cycle (the old
  // std::once_flag disabled every stop() after the first), and a second start()
  // while running must be refused rather than move-assign onto a joinable
  // std::thread (which would std::terminate).
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  // A second start while running is refused (not a crash).
  QString busy;
  QVERIFY(!server.start(&busy));
  QCOMPARE(busy, QStringLiteral("Bridge IPC server is already running"));

  server.stop();
  QVERIFY(!QFile::exists(rendezvous)); // cycle 1 really tore down
  // A fresh cycle starts and tears down cleanly (the once_flag would have
  // blocked this stop()).
  QVERIFY2(server.start(&error), qPrintable(error));
  QVERIFY(QFile::exists(rendezvous)); // cycle 2 re-published the record
  server.stop();
  // The SECOND stop is the whole point: under the retired std::once_flag it
  // silently did nothing, leaving cycle 2's pipe handle, I/O thread and
  // rendezvous record alive. The record being gone -- and the sender failing
  // closed -- is the observable proof that this teardown ran, which the old
  // terminal QVERIFY(true) never established.
  QVERIFY(!QFile::exists(rendezvous));
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")}});
  QVERIFY(!exchange.ok);
  QCOMPARE(exchange.error, QStringLiteral("Browser not connected."));
}

// A dead pid far above any live process, used to forge "another server" and
// "a server that has exited" records without a second process.
constexpr qint64 kAbsentPid = 0x7FFF'FFF0;

void BrowserBridgePipeTests::stop_keepsRendezvousOwnedByAnotherProcess() {
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  // A peer server (re)claims the shared rendezvous by overwriting the record to
  // advertise a different pid. stop() must leave that record in place: deleting
  // another instance's record would orphan the pipe its relay is bound to.
  const chrome_control_mcp::RendezvousRecord foreign{
      server.pipeName(), server.token(), 0, kAbsentPid};
  QVERIFY2(
      chrome_control_mcp::writeRendezvousRecord(rendezvous, foreign, &error),
      qPrintable(error));

  server.stop();

  QVERIFY(QFile::exists(rendezvous));
  chrome_control_mcp::RendezvousRecord after;
  QVERIFY2(chrome_control_mcp::readRendezvousRecord(rendezvous, &after, &error),
           qPrintable(error));
  QCOMPARE(after.app_pid, kAbsentPid);
}

void BrowserBridgePipeTests::start_takesOverStaleRendezvousRecord() {
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  QString error;

  // A record left behind by a server that has since exited: its pid resolves to
  // no live process, so a fresh server is free to claim the bridge rather than
  // stand down.
  const chrome_control_mcp::RendezvousRecord stale{
      QStringLiteral("stale-endpoint"), QStringLiteral("t"), 0, kAbsentPid};
  QVERIFY2(chrome_control_mcp::writeRendezvousRecord(rendezvous, stale, &error),
           qPrintable(error));

  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QVERIFY2(server.start(&error), qPrintable(error));

  chrome_control_mcp::RendezvousRecord after;
  QVERIFY2(chrome_control_mcp::readRendezvousRecord(rendezvous, &after, &error),
           qPrintable(error));
  QVERIFY(after.pipe_name != QLatin1String("stale-endpoint"));
  QCOMPARE(after.pipe_name, server.pipeName());
  server.stop();
}

// The race the fix is for: a concurrent short-lived instance wrote the record
// last and removed it on exit, so the long-lived server is listening on an
// endpoint nothing can discover. Before a browser tool call the server puts
// its record back.
void BrowserBridgePipeTests::ensurePublished_republishesALostRecord() {
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));
  QVERIFY(QFile::remove(rendezvous));
  QVERIFY(!QFile::exists(rendezvous));

  QVERIFY2(server.ensurePublished(&error), qPrintable(error));

  chrome_control_mcp::RendezvousRecord after;
  QVERIFY2(chrome_control_mcp::readRendezvousRecord(rendezvous, &after, &error),
           qPrintable(error));
  QCOMPARE(after.pipe_name, server.pipeName());
  QCOMPARE(after.token, server.token());
  // Already ours: a second call changes nothing and still says so.
  QVERIFY2(server.ensurePublished(&error), qPrintable(error));
  server.stop();
  QVERIFY(!QFile::exists(rendezvous)); // stop() removed what was ours
}

// A record naming a server that has exited is nobody's: it is taken over,
// the way start() takes over a stale record.
void BrowserBridgePipeTests::
    ensurePublished_takesOverARecordLeftByAnExitedServer() {
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  const chrome_control_mcp::RendezvousRecord foreign{
      QStringLiteral("gone-endpoint"), QStringLiteral("t"), 0, kAbsentPid};
  QVERIFY2(
      chrome_control_mcp::writeRendezvousRecord(rendezvous, foreign, &error),
      qPrintable(error));

  QVERIFY2(server.ensurePublished(&error), qPrintable(error));

  chrome_control_mcp::RendezvousRecord after;
  QVERIFY2(chrome_control_mcp::readRendezvousRecord(rendezvous, &after, &error),
           qPrintable(error));
  QCOMPARE(after.pipe_name, server.pipeName());
  QVERIFY(after.app_pid != kAbsentPid);
  server.stop();
}

// Nothing to publish for a server that is not listening: it says so rather
// than advertising an endpoint that would refuse every relay.
void BrowserBridgePipeTests::ensurePublished_refusesWhileNotRunning() {
  QTemporaryDir dir;
  const QString rendezvous = dir.filePath(QStringLiteral("r.json"));
  BrowserBridgePipeServer server(testOptions(rendezvous, 30'000));
  QString error;
  QVERIFY(!server.ensurePublished(&error));
  QVERIFY(!error.isEmpty());
  QVERIFY(!QFile::exists(rendezvous));
}

// Records a departed server left behind are swept when a server starts, so a
// relay never pays a failed connection attempt for one. With one shared record
// a dead server's entry was simply overwritten and nothing ever accumulated.
void BrowserBridgePipeTests::sweep_removesDepartedServersAndSparesTheLiving() {
  // One shared record was overwritten by whoever published next, so nothing
  // ever accumulated and nothing ever had to be cleaned up. Per-pid records do
  // accumulate, and a directory of dead servers is what a relay would then have
  // to search through, paying a failed connection attempt for each.
  QTemporaryDir dir;
  QVERIFY(dir.isValid());
  const QString root = QDir::cleanPath(dir.path());
  const qint64 self = chrome_control_mcp::currentProcessId();
  const QString own =
      QDir(root).filePath(QStringLiteral("browser_bridge-%1.json").arg(self));
  const QString departed = QDir(root).filePath(
      QStringLiteral("browser_bridge-%1.json").arg(kAbsentPid));
  const QString also_departed = QDir(root).filePath(
      QStringLiteral("browser_bridge-%1.json").arg(kAbsentPid - 1));

  QString error;
  const chrome_control_mcp::RendezvousRecord mine{QStringLiteral("mine"),
                                                  QStringLiteral("t"), 0, self};
  const chrome_control_mcp::RendezvousRecord gone{
      QStringLiteral("gone"), QStringLiteral("t"), 0, kAbsentPid};
  QVERIFY2(chrome_control_mcp::writeRendezvousRecord(own, mine, &error),
           qPrintable(error));
  QVERIFY2(chrome_control_mcp::writeRendezvousRecord(departed, gone, &error),
           qPrintable(error));
  QVERIFY2(
      chrome_control_mcp::writeRendezvousRecord(also_departed, gone, &error),
      qPrintable(error));

  QCOMPARE(chrome_control_mcp::sweepStaleRendezvousRecords(own), 2);
  QVERIFY2(QFile::exists(own), "our own record is never swept");
  QVERIFY2(!QFile::exists(departed), "a departed server's record is removed");
  QVERIFY2(!QFile::exists(also_departed), "and so is the next one");

  // Sweeping again finds nothing left to do, so a server that starts repeatedly
  // does not churn the directory.
  QCOMPARE(chrome_control_mcp::sweepStaleRendezvousRecords(own), 0);
  QVERIFY(QFile::exists(own));
}

QTEST_MAIN(BrowserBridgePipeTests)
#include "test_browser_bridge_pipe.moc"
