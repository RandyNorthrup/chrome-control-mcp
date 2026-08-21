// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/native_messaging.h"

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
using chrome_control_mcp::kInvalidNativeIpcHandle;
using chrome_control_mcp::NativeFrame;
using chrome_control_mcp::NativeIpcHandle;
using chrome_control_mcp::parseFrame;

namespace {

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
    const ssize_t wrote = write(handle, frame.constData() + offset,
                                static_cast<size_t>(frame.size() - offset));
    if (wrote <= 0) {
      return false;
    }
    offset += wrote;
#endif
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
  const bool sent = clientWrite(
      handle, QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                          {QStringLiteral("token"), token},
                          {QStringLiteral("protocol"), 1}});
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
  void reconnect_secondClientServedWithNewGeneration();
  void doubleStop_isSafe();
  void restartAfterStopWorksAndDoubleStartRefused();
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
        name, QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                          {QStringLiteral("token"),
                           real_token + QStringLiteral("_forged")},
                          {QStringLiteral("protocol"), 1}});
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
        name, QJsonObject{{QStringLiteral("type"), QStringLiteral("attach")},
                          {QStringLiteral("token"), real_token},
                          {QStringLiteral("protocol"), 1}});
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
  QTRY_VERIFY_WITH_TIMEOUT(server.clientConnected(), 5000);
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
  using Server = BrowserBridgePipeServer;
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
  QVERIFY(Server::ancestorChainContainsImageForTesting(
      100, parent, image, QStringLiteral("chrome.exe"), 12));

  // Depth cap (the security bound): a budget too small to reach chrome must NOT
  // authorize. The walk inspects one ancestor per iteration, so a budget of 2
  // sees only the two nearest ancestors (renderer, gpu) and stops before chrome
  // -> refused. This is what stops a peer with a very distant, coincidental
  // chrome.exe ancestor from being bound.
  QVERIFY(!Server::ancestorChainContainsImageForTesting(
      100, parent, image, QStringLiteral("chrome.exe"), 2));

  // No chrome anywhere in the chain -> refused (a non-Chrome-launched peer).
  const QHash<quint64, QString> noChrome{{100, QStringLiteral("tab.exe")},
                                         {90, QStringLiteral("renderer.exe")},
                                         {80, QStringLiteral("gpu.exe")},
                                         {70, QStringLiteral("explorer.exe")}};
  QVERIFY(!Server::ancestorChainContainsImageForTesting(
      100, parent, noChrome, QStringLiteral("chrome.exe"), 12));

  // A CYCLE in the parent map (100 -> 90 -> 100) must terminate under the depth
  // bound rather than loop forever, and with no chrome ancestor it fails
  // closed. A stale/reused Toolhelp parent pid can produce exactly such a
  // cycle.
  const QHash<quint64, quint64> cyclic{{100, 90}, {90, 100}};
  const QHash<quint64, QString> cyclicImage{
      {100, QStringLiteral("tab.exe")}, {90, QStringLiteral("renderer.exe")}};
  QVERIFY(!Server::ancestorChainContainsImageForTesting(
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

  QTRY_VERIFY_WITH_TIMEOUT(server.clientConnected(), 5000);
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

  QTRY_VERIFY_WITH_TIMEOUT(server.clientConnected(), 5000);
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY(!exchange.ok);
  QCOMPARE(
      exchange.error,
      QStringLiteral("browser did not reply within 300 ms (connection reset)"));
  QTRY_VERIFY_WITH_TIMEOUT(!server.clientConnected(),
                           5000); // connection torn down

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
  QTRY_VERIFY_WITH_TIMEOUT(server.clientConnected(), 5000);
  const auto reset = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  QVERIFY(!reset.ok);
  QCOMPARE(
      reset.error,
      QStringLiteral("browser did not reply within 500 ms (connection reset)"));
  client_a.join();
  QTRY_VERIFY_WITH_TIMEOUT(!server.clientConnected(),
                           5000); // the accept loop re-armed

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
  QTRY_VERIFY_WITH_TIMEOUT(server.clientConnected(), 5000);
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

QTEST_MAIN(BrowserBridgePipeTests)
#include "test_browser_bridge_pipe.moc"
