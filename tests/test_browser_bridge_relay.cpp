// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/browser_bridge_relay.h"
#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/browser_control.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonObject>
#include <QProcess>
#include <QTemporaryDir>
#include <QtTest/QtTest>

#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

using chrome_control_mcp::bridgeImageMismatchText;
using chrome_control_mcp::BridgeServerWatcher;
using chrome_control_mcp::BrowserBridgePipeServer;
using chrome_control_mcp::BrowserControl;
using chrome_control_mcp::browserInputClosed;
using chrome_control_mcp::closeNativeIpcHandle;
using chrome_control_mcp::kBrowserBridgeProtocol;
using chrome_control_mcp::kInvalidNativeIpcHandle;
using chrome_control_mcp::NativeIpcHandle;
using chrome_control_mcp::relayConnect;
using chrome_control_mcp::relayHandshake;
using chrome_control_mcp::relayPumpOnce;
using chrome_control_mcp::RendezvousRecord;
using chrome_control_mcp::ToolResult;
using chrome_control_mcp::writeRendezvousRecord;

namespace {

// A copy of this test binary started with this flag only waits. That gives a
// test a live process of the bridge's own image to point a record at -- which
// is what a relay has to recognise as a running server -- without building a
// second program for it.
constexpr char kLingerFlag[] = "--linger-as-a-server";
constexpr int kLingerSeconds = 30;

template <typename Predicate>
bool waitUntil(Predicate predicate, int timeout_ms) {
  QElapsedTimer timer;
  timer.start();
  while (!predicate() && timer.elapsed() < timeout_ms) {
    QTest::qWait(10);
  }
  return predicate();
}

BrowserBridgePipeServer::Options serverOptions(const QString &rendezvous) {
  BrowserBridgePipeServer::Options options;
  options.require_chrome_ancestor =
      false; // the in-process relay is not a Chrome child
  options.rendezvous_path = rendezvous;
  options.io_timeout_ms = 30'000;
  return options;
}

// A fake extension for relayPumpOnce: capture the forwarded command, then
// answer it by echoing the correlation id with a canned payload. browser_write
// runs before browser_read in the pump, so the id is captured before the reply
// is built. It answers as bridge protocol 2 does for a command that touched a
// tab -- naming the tab and its DOM generation -- or, with reply_error set,
// with an error frame carrying that text.
struct FakeExtension {
  QJsonObject last_command;
  QJsonObject reply_payload;
  int tab_id{1};
  QString reply_error;

  chrome_control_mcp::BrowserWriteFn writer() {
    return [this](const QJsonObject &command) {
      last_command = command;
      return true;
    };
  }
  chrome_control_mcp::BrowserReadFn reader() {
    return [this](QJsonObject *out) {
      if (!reply_error.isEmpty()) {
        *out = QJsonObject{
            {QStringLiteral("type"), QStringLiteral("error")},
            {QStringLiteral("id"), last_command.value(QStringLiteral("id"))},
            {QStringLiteral("error"), reply_error}};
        return true;
      }
      *out = QJsonObject{
          {QStringLiteral("type"), QStringLiteral("result")},
          {QStringLiteral("id"), last_command.value(QStringLiteral("id"))},
          {QStringLiteral("tabId"), tab_id},
          {QStringLiteral("domEpoch"), 1},
          {QStringLiteral("payload"), reply_payload}};
      return true;
    };
  }
};

// A fake extension that behaves like a POLLING handler: it does not answer
// until the test releases it. That is the only shape in which the
// abandoned-exchange bug is observable -- a handler that replies promptly never
// outlives its command.
struct SlowFakeExtension {
  QJsonObject last_command;
  std::atomic<bool> release{false};
  std::atomic<int> cancels_seen{0};

  chrome_control_mcp::BrowserWriteFn writer() {
    return [this](const QJsonObject &frame) {
      if (frame.value(QStringLiteral("type")).toString() ==
          QLatin1String("cancel")) {
        cancels_seen.fetch_add(1);
        release.store(true); // the poll loop stops when its command is retired
        return true;
      }
      last_command = frame;
      return true;
    };
  }
  chrome_control_mcp::BrowserReadFn reader() {
    return [this](QJsonObject *out) {
      // Bounded, so that a regression which stops the cancel from arriving
      // FAILS this test instead of hanging it. A hang reads as a stuck machine
      // and gets retried; a failure names the defect.
      const auto give_up =
          std::chrono::steady_clock::now() + std::chrono::seconds(10);
      while (!release.load() && std::chrono::steady_clock::now() < give_up) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      *out = QJsonObject{
          {QStringLiteral("type"), QStringLiteral("error")},
          {QStringLiteral("id"), last_command.value(QStringLiteral("id"))},
          {QStringLiteral("error"), QStringLiteral("command superseded")}};
      return true;
    };
  }
};

// A fake extension that takes its time and says so, which is what every long
// handler now does: a few beats while it works, then the answer. The beats are
// frames on the same channel as the reply, so the relay has to read past them
// -- and forward them, or the server learns nothing and its silence budget
// expires exactly as before.
struct BeatingFakeExtension {
  QJsonObject last_command;
  int beats_to_send{3};
  int beats_sent{0};
  int beat_gap_ms{250};

  chrome_control_mcp::BrowserWriteFn writer() {
    return [this](const QJsonObject &command) {
      last_command = command;
      return true;
    };
  }
  chrome_control_mcp::BrowserReadFn reader() {
    return [this](QJsonObject *out) {
      std::this_thread::sleep_for(std::chrono::milliseconds(beat_gap_ms));
      if (beats_sent < beats_to_send) {
        ++beats_sent;
        *out = QJsonObject{
            {QStringLiteral("type"), QStringLiteral("progress")},
            {QStringLiteral("id"), last_command.value(QStringLiteral("id"))},
            {QStringLiteral("elapsed_ms"), beat_gap_ms * beats_sent}};
        return true;
      }
      *out = QJsonObject{
          {QStringLiteral("type"), QStringLiteral("result")},
          {QStringLiteral("id"), last_command.value(QStringLiteral("id"))},
          {QStringLiteral("payload"),
           QJsonObject{{QStringLiteral("worked_for_ms"),
                        beat_gap_ms * (beats_to_send + 1)}}}};
      return true;
    };
  }
};

} // namespace

class BrowserBridgeRelayTests : public QObject {
  Q_OBJECT

private slots:
  void relayConnect_rejectsForeignServerPid();
  void imageMismatchText_namesBothCopiesAndTheFix();
  void selectRecord_honoursTheSessionTheExtensionNamed();
  void liveRecords_offerOnlyServersThatAreRunning();
  void serverIds_areThePidsInTheOrderGiven();
  void serverWatch_reportsChangesToTheLiveSetAndNothingElse();
  void serverWatch_stopsPromptlyAndWhenTheSinkCloses();
  void relayHandshake_rejectsBadToken();
  void relayHandshake_rejectsProtocolMismatch();
  void relay_forwardsCommandAndReplyOverRealPipe();
  void relay_forwardsCancelToAPollingExtensionWhenTheServerAbandons();
  void relay_forwardsProgressBeatsAndStillDeliversTheReply();
  void control_notConnectedReportsError();
  void control_snapshotRoundTripsThroughRelay();
  void control_waitsForARelayThatIsAttaching();
  void control_protocolMismatchSaysHowToFixIt();
  void browserPresence_openInputIsNotClosed();
  void browserPresence_waitingBytesAreNotAHangup();
  void browserPresence_closedWriteEndIsAHangup();
  void browserPresence_peekDoesNotConsume();
  void browserPresence_invalidInputIsClosed();
};

void BrowserBridgeRelayTests::relayConnect_rejectsForeignServerPid() {
  QTemporaryDir dir;
  const QString path = dir.filePath(QStringLiteral("r.json"));
  // A record pointing at a pid that is not our binary (almost certainly
  // nonexistent) must be refused: a rewritten record cannot redirect the relay
  // to a foreign server.
  const RendezvousRecord record{
      QStringLiteral("\\\\.\\pipe\\ChromeControlMCP_BrowserBridge_bogus"),
      QStringLiteral("deadbeef"), kBrowserBridgeProtocol, 999'999};
  QString error;
  QVERIFY(writeRendezvousRecord(path, record, &error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(path, &token, &protocol, &error);
  QCOMPARE(pipe, kInvalidNativeIpcHandle);
  // A pid nothing is running under cannot be compared to anything, and saying
  // "not the Chrome Control MCP binary" about a process that does not exist
  // sends the reader looking for an impostor. Pin the exact deterministic
  // message, which names the pid and says why it could not be checked.
  QCOMPARE(error, QStringLiteral("The bridge is served by process 999999, "
                                 "which this relay cannot read (it may have "
                                 "exited)."));
}

void BrowserBridgeRelayTests::imageMismatchText_namesBothCopiesAndTheFix() {
  // The check is a security check, but its commonest cause is two copies of
  // this program -- a build directory beside an installed one -- because Chrome
  // starts whichever executable its native-messaging registration names. The
  // message has to name both, or the reader cannot tell a misconfiguration from
  // an attack.
  const QString text = bridgeImageMismatchText(
      QStringLiteral("c:/users/x/appdata/local/programs/ccm/ccm.exe"), 4242,
      QStringLiteral("c:/users/x/code/ccm/build/release/ccm.exe"));
  QVERIFY(text.contains(
      QStringLiteral("c:/users/x/appdata/local/programs/ccm/ccm.exe")));
  QVERIFY(text.contains(
      QStringLiteral("c:/users/x/code/ccm/build/release/ccm.exe")));
  QVERIFY(text.contains(QStringLiteral("browser_extension_install")));

  // An unreadable process is reported as that, not as a path mismatch: there is
  // no second path to name, and claiming one would be a guess.
  const QString gone =
      bridgeImageMismatchText(QString(), 4242, QStringLiteral("/opt/ccm/ccm"));
  QVERIFY(gone.contains(QStringLiteral("4242")));
  QVERIFY(gone.contains(QStringLiteral("cannot read")));
  QVERIFY(!gone.contains(QStringLiteral("/opt/ccm/ccm")));
}

void BrowserBridgeRelayTests::relayHandshake_rejectsBadToken() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      serverOptions(dir.filePath(QStringLiteral("r.json"))));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(
      dir.filePath(QStringLiteral("r.json")), &token, &protocol, &error);
  QVERIFY(pipe != kInvalidNativeIpcHandle);
  // The server drops a wrong-token handshake, so the relay's welcome read
  // fails.
  QVERIFY(
      !relayHandshake(pipe, QStringLiteral("wrong-token"), protocol, &error));
  QCOMPARE(error,
           QStringLiteral("Bridge server closed before welcoming the relay."));
  closeNativeIpcHandle(pipe);
  server.stop();
}

void BrowserBridgeRelayTests::relayHandshake_rejectsProtocolMismatch() {
  // B13-08: the handshake must enforce the protocol version. Offering a
  // protocol the server does not speak must fail rather than pump frames under
  // a version skew (the server rejects the hello, and the relay additionally
  // verifies the welcome's protocol as defense in depth).
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      serverOptions(dir.filePath(QStringLiteral("r.json"))));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(
      dir.filePath(QStringLiteral("r.json")), &token, &protocol, &error);
  QVERIFY(pipe != kInvalidNativeIpcHandle);
  QVERIFY(!relayHandshake(pipe, token, protocol + 1,
                          &error)); // wrong protocol -> refused
  closeNativeIpcHandle(pipe);
  server.stop();
}

void BrowserBridgeRelayTests::relay_forwardsCommandAndReplyOverRealPipe() {
  QTemporaryDir dir;
  BrowserBridgePipeServer server(
      serverOptions(dir.filePath(QStringLiteral("r.json"))));
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(
      dir.filePath(QStringLiteral("r.json")), &token, &protocol, &error);
  QVERIFY(pipe != kInvalidNativeIpcHandle);
  QVERIFY2(relayHandshake(pipe, token, protocol, &error), qPrintable(error));
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));

  FakeExtension extension;
  extension.reply_payload = QJsonObject{{QStringLiteral("echoed"), true}};
  std::atomic<bool> pumped{false};
  std::thread relay([&] {
    pumped = relayPumpOnce(pipe, extension.reader(), extension.writer());
  });

  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  relay.join();
  QVERIFY(pumped.load());
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  QCOMPARE(exchange.reply.value(QStringLiteral("id")).toString(),
           QStringLiteral("b-1"));
  QVERIFY(exchange.reply.value(QStringLiteral("payload"))
              .toObject()
              .value(QStringLiteral("echoed"))
              .toBool());
  // The relay forwarded exactly the server's command, id-transparent.
  QCOMPARE(extension.last_command.value(QStringLiteral("cmd")).toString(),
           QStringLiteral("snapshot"));
  closeNativeIpcHandle(pipe);
  server.stop();
}

void BrowserBridgeRelayTests::
    relay_forwardsCancelToAPollingExtensionWhenTheServerAbandons() {
  QTemporaryDir dir;
  auto options = serverOptions(dir.filePath(QStringLiteral("r.json")));
  // Short enough that the exchange is abandoned while the fake extension is
  // still polling, which is the whole condition under test.
  options.io_timeout_ms = 400;
  BrowserBridgePipeServer server(options);
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(
      dir.filePath(QStringLiteral("r.json")), &token, &protocol, &error);
  QVERIFY(pipe != kInvalidNativeIpcHandle);
  QVERIFY2(relayHandshake(pipe, token, protocol, &error), qPrintable(error));
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));

  SlowFakeExtension extension;
  std::thread relay([&] {
    (void)relayPumpOnce(pipe, extension.reader(), extension.writer());
  });

  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-slow")},
                  {QStringLiteral("cmd"), QStringLiteral("download")}});
  relay.join();

  // The server gave up on the exchange...
  QVERIFY(!exchange.ok);
  QCOMPARE(
      exchange.error,
      QStringLiteral("browser did not reply within 400 ms (connection reset)"));
  // ...and the extension was TOLD, rather than being left polling until its own
  // ceiling. Without the cancel this count is 0 and the reader never releases,
  // so the join above would hang -- the assertion and the test's ability to
  // finish are the same thing.
  QCOMPARE(extension.cancels_seen.load(), 1);
  // relayPumpOnce's own return is deliberately NOT asserted: whether the late
  // reply lands in the server's drain read or after the teardown is a genuine
  // race, and pinning it would make this test flaky rather than more truthful.
  // What matters is that the extension was told, and the exchange still failed
  // for the caller.

  closeNativeIpcHandle(pipe);
  server.stop();
}

// The whole path, end to end: a handler that outlives the server's silence
// budget four times over, beating as it works, over a real pipe with the real
// relay in between.
//
// Every piece has to hold or this fails. The extension beats; the relay reads
// past the beats instead of handing the first one up as the reply, and forwards
// each from the thread that owns the pipe; the server restarts its deadline on
// each and keeps waiting. Before this, the server tore the connection down at
// 400 ms and the caller was told the browser had reset -- for a command that
// was working the entire time.
void BrowserBridgeRelayTests::
    relay_forwardsProgressBeatsAndStillDeliversTheReply() {
  QTemporaryDir dir;
  auto options = serverOptions(dir.filePath(QStringLiteral("r.json")));
  options.io_timeout_ms = 400; // four beats at 250 ms each outlast this
  BrowserBridgePipeServer server(options);
  QString error;
  QVERIFY2(server.start(&error), qPrintable(error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(
      dir.filePath(QStringLiteral("r.json")), &token, &protocol, &error);
  QVERIFY(pipe != kInvalidNativeIpcHandle);
  QVERIFY2(relayHandshake(pipe, token, protocol, &error), qPrintable(error));
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));

  BeatingFakeExtension extension;
  std::atomic<bool> pumped{false};
  std::thread relay([&] {
    pumped = relayPumpOnce(pipe, extension.reader(), extension.writer());
  });

  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("b-1")},
                  {QStringLiteral("cmd"), QStringLiteral("download")}});
  relay.join();
  QVERIFY(pumped.load());
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  // The REPLY came up, not the first beat wearing its id.
  QCOMPARE(exchange.reply.value(QStringLiteral("type")).toString(),
           QStringLiteral("result"));
  QCOMPARE(exchange.reply.value(QStringLiteral("payload"))
               .toObject()
               .value(QStringLiteral("worked_for_ms"))
               .toInt(),
           1000);
  QCOMPARE(extension.beats_sent, 3);
  // And the extension was asked for them: the server sets the flag, so an older
  // extension that ignores it is still held to the plain silence budget rather
  // than being relied on to beat.
  QVERIFY(extension.last_command.value(QStringLiteral("progress")).toBool());

  closeNativeIpcHandle(pipe);
  server.stop();
}

void BrowserBridgeRelayTests::control_notConnectedReportsError() {
  QTemporaryDir dir;
  BrowserControl control(serverOptions(dir.filePath(QStringLiteral("r.json"))));
  QString error;
  QVERIFY2(control.start(&error), qPrintable(error));
  // The server published a moment ago, so a call now waits for a relay before
  // refusing. Shortened so the refusal this test expects does not cost the
  // production wait -- and measured, so the wait is shown to happen.
  constexpr int kWaitMs = 300;
  control.setRelayAttachWait(std::chrono::milliseconds(kWaitMs));

  // No relay has connected: every browser tool call is a clean, model-readable
  // error.
  QElapsedTimer timer;
  timer.start();
  const ToolResult result =
      control.invoke(QStringLiteral("browser_snapshot"), {});
  QVERIFY(timer.elapsed() >= kWaitMs);
  QVERIFY(result.is_error);
  // The refusal itself is fixed text. What may follow it is a diagnosis of the
  // native-host registration, which depends on what this machine has
  // registered -- and in a test binary is nearly always a different executable
  // -- so the refusal is pinned by its start and the diagnosis is tested where
  // it is built, on the pure function.
  QVERIFY2(result.text.startsWith(
               QStringLiteral("Browser not connected: the Chrome Control MCP "
                              "browser-control extension is not attached.")),
           qPrintable(result.text));
  control.stop();
}

void BrowserBridgeRelayTests::control_snapshotRoundTripsThroughRelay() {
  QTemporaryDir dir;
  const QString path = dir.filePath(QStringLiteral("r.json"));
  BrowserControl control(serverOptions(path));
  QString error;
  QVERIFY2(control.start(&error), qPrintable(error));

  // Bring up the relay end (client) against the control's server, then keep
  // pumping.
  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(path, &token, &protocol, &error);
  QVERIFY2(pipe != kInvalidNativeIpcHandle, qPrintable(error));
  QVERIFY2(relayHandshake(pipe, token, protocol, &error), qPrintable(error));

  FakeExtension extension;
  // A minimal DOM capture: one interactable node the snapshot renderer will
  // keep.
  extension.reply_payload = QJsonObject{
      {QStringLiteral("url"), QStringLiteral("https://example.test/")},
      {QStringLiteral("title"), QStringLiteral("Example")},
      {QStringLiteral("nodes"),
       QJsonArray{
           QJsonObject{{QStringLiteral("backendNodeId"), 42},
                       {QStringLiteral("role"), QStringLiteral("button")},
                       {QStringLiteral("name"), QStringLiteral("Sign in")},
                       {QStringLiteral("tag"), QStringLiteral("button")},
                       {QStringLiteral("depth"), 1},
                       {QStringLiteral("interactable"), true},
                       {QStringLiteral("visible"), true},
                       {QStringLiteral("bounds"),
                        QJsonObject{{QStringLiteral("x"), 10},
                                    {QStringLiteral("y"), 20},
                                    {QStringLiteral("width"), 80},
                                    {QStringLiteral("height"), 30}}}}}}};
  std::atomic<bool> running{true};
  std::thread relay([&] {
    while (running.load() &&
           relayPumpOnce(pipe, extension.reader(), extension.writer())) {
    }
  });

  QVERIFY(waitUntil([&control] { return control.clientConnected(); }, 5000));
  const ToolResult result =
      control.invoke(QStringLiteral("browser_snapshot"), {});
  // Checked, not asserted, so a failure still stops the pump thread below
  // instead of leaving it joinable at return (which aborts the whole binary
  // and hides every other result).
  const bool ok = !result.is_error;
  running = false;
  control.stop(); // tears down the pipe; the relay's next pipe read fails and
                  // it exits
  relay.join();
  closeNativeIpcHandle(pipe);
  QVERIFY2(ok, qPrintable(result.text));
  QCOMPARE(result.text,
           QStringLiteral("url: https://example.test/\ntitle: Example\n"
                          "tab_id: 1\nelements: 1\n"
                          "  - button \"Sign in\" [ref=e1]\n"));
}

// The first call of a newly started agent lands before the extension has found
// the server. It must be held for the attach, not refused into a diagnosis of
// a browser that is a second from working.
void BrowserBridgeRelayTests::control_waitsForARelayThatIsAttaching() {
  QTemporaryDir dir;
  const QString path = dir.filePath(QStringLiteral("r.json"));
  BrowserControl control(serverOptions(path));
  QString error;
  QVERIFY2(control.start(&error), qPrintable(error));

  FakeExtension extension;
  extension.reply_payload = QJsonObject{
      {QStringLiteral("url"), QStringLiteral("https://example.test/")},
      {QStringLiteral("title"), QStringLiteral("Example")},
      {QStringLiteral("nodes"), QJsonArray{}}};
  std::atomic<bool> running{true};
  std::atomic<NativeIpcHandle> pipe{kInvalidNativeIpcHandle};
  // The relay arrives only after the call has started waiting.
  std::thread relay([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    QString token;
    QString why;
    int protocol = 0;
    const NativeIpcHandle handle = relayConnect(path, &token, &protocol, &why);
    if (handle == kInvalidNativeIpcHandle ||
        !relayHandshake(handle, token, protocol, &why)) {
      return;
    }
    pipe = handle;
    while (running.load() &&
           relayPumpOnce(handle, extension.reader(), extension.writer())) {
    }
  });

  QVERIFY(!control.clientConnected());
  const ToolResult result =
      control.invoke(QStringLiteral("browser_snapshot"), {});
  const bool ok = !result.is_error;
  running = false;
  control.stop();
  relay.join();
  if (pipe.load() != kInvalidNativeIpcHandle) {
    closeNativeIpcHandle(pipe.load());
  }
  QVERIFY2(ok, qPrintable(result.text));
  QVERIFY(result.text.startsWith(QStringLiteral("url: https://example.test/")));
}

// A protocol mismatch is reported by the extension in its own words, which
// name two version numbers and not the fix. The fix is always the same, so it
// is appended.
void BrowserBridgeRelayTests::control_protocolMismatchSaysHowToFixIt() {
  QTemporaryDir dir;
  const QString path = dir.filePath(QStringLiteral("r.json"));
  BrowserControl control(serverOptions(path));
  QString error;
  QVERIFY2(control.start(&error), qPrintable(error));

  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(path, &token, &protocol, &error);
  QVERIFY2(pipe != kInvalidNativeIpcHandle, qPrintable(error));
  QVERIFY2(relayHandshake(pipe, token, protocol, &error), qPrintable(error));

  FakeExtension extension;
  extension.reply_error =
      QStringLiteral("Bridge protocol mismatch: host 2, extension 1");
  std::atomic<bool> running{true};
  std::thread relay([&] {
    while (running.load() &&
           relayPumpOnce(pipe, extension.reader(), extension.writer())) {
    }
  });
  const bool attached =
      waitUntil([&control] { return control.clientConnected(); }, 5000);
  const ToolResult result =
      control.invoke(QStringLiteral("browser_snapshot"), {});
  running = false;
  control.stop();
  relay.join();
  closeNativeIpcHandle(pipe);
  QVERIFY(attached);
  QVERIFY(result.is_error);
  QVERIFY2(result.text.startsWith(QStringLiteral(
               "Bridge protocol mismatch: host 2, extension 1 Reload the "
               "Chrome Control MCP extension at chrome://extensions")),
           qPrintable(result.text));
}

// Which record a relay connects to is now the extension's choice, so the rule
// is a pure function and testable without a relay or a server.
void BrowserBridgeRelayTests::
    selectRecord_honoursTheSessionTheExtensionNamed() {
  const QStringList records{
      QStringLiteral("/run/ccmcp/browser_bridge-300.json"),
      QStringLiteral("/run/ccmcp/browser_bridge-200.json"),
      QStringLiteral("/run/ccmcp/browser_bridge-100.json"),
  };

  // Named: that one, not the newest.
  QCOMPARE(chrome_control_mcp::selectRendezvousRecord(records,
                                                      QStringLiteral("100")),
           records.at(2));
  QCOMPARE(chrome_control_mcp::selectRendezvousRecord(records,
                                                      QStringLiteral("300")),
           records.first());

  // No preference: the newest, which is what a one-server install resolves to.
  QCOMPARE(chrome_control_mcp::selectRendezvousRecord(records, QString{}),
           records.first());

  // The server it asked for is gone. Substituting another would attach the
  // extension's session to a server it did not choose, so nothing is returned
  // and the relay reports the bridge unavailable instead.
  QVERIFY(
      chrome_control_mcp::selectRendezvousRecord(records, QStringLiteral("999"))
          .isEmpty());
  QVERIFY(chrome_control_mcp::selectRendezvousRecord(
              records, QStringLiteral("not-a-pid"))
              .isEmpty());

  // Nothing published at all.
  QVERIFY(chrome_control_mcp::selectRendezvousRecord({}, QStringLiteral("100"))
              .isEmpty());
  QVERIFY(chrome_control_mcp::selectRendezvousRecord({}, QString{}).isEmpty());
}

// -- Chrome going away while the relay is blocked on the pipe ----------------
//
// The relay spends nearly all its life waiting for the server to send a
// command. Chrome closing the port is invisible from there, so the relay used
// to stay alive holding its end of a pipe created with nMaxInstances = 1: every
// relay Chrome started afterwards was refused with ERROR_PIPE_BUSY, and the
// bridge stayed down until the orphan was killed by hand. These pin the check
// that ends it -- including that it never eats a byte the pump is owed.

namespace {

// A pipe standing in for the one Chrome hands a native host.
struct StdioPipe {
  NativeIpcHandle read_end{kInvalidNativeIpcHandle};
  NativeIpcHandle write_end{kInvalidNativeIpcHandle};

  StdioPipe() {
#ifdef Q_OS_WIN
    HANDLE r = nullptr;
    HANDLE w = nullptr;
    if (CreatePipe(&r, &w, nullptr, 0) != FALSE) {
      read_end = r;
      write_end = w;
    }
#else
    int fds[2] = {-1, -1};
    if (::pipe(fds) == 0) {
      read_end = fds[0];
      write_end = fds[1];
    }
#endif
  }
  ~StdioPipe() {
    closeWriteEnd();
    if (read_end != kInvalidNativeIpcHandle) {
      closeNativeIpcHandle(read_end);
    }
  }
  StdioPipe(const StdioPipe &) = delete;
  StdioPipe &operator=(const StdioPipe &) = delete;
  StdioPipe(StdioPipe &&) = delete;
  StdioPipe &operator=(StdioPipe &&) = delete;

  bool valid() const {
    return read_end != kInvalidNativeIpcHandle &&
           write_end != kInvalidNativeIpcHandle;
  }
  void closeWriteEnd() {
    if (write_end != kInvalidNativeIpcHandle) {
      closeNativeIpcHandle(write_end);
      write_end = kInvalidNativeIpcHandle;
    }
  }
  bool put(const char *bytes, int size) {
#ifdef Q_OS_WIN
    DWORD written = 0;
    return WriteFile(write_end, bytes, static_cast<DWORD>(size), &written,
                     nullptr) != FALSE;
#else
    return ::write(write_end, bytes, static_cast<size_t>(size)) == size;
#endif
  }
  int take(char *bytes, int size) {
#ifdef Q_OS_WIN
    DWORD got = 0;
    if (ReadFile(read_end, bytes, static_cast<DWORD>(size), &got, nullptr) ==
        FALSE) {
      return -1;
    }
    return static_cast<int>(got);
#else
    return static_cast<int>(::read(read_end, bytes, static_cast<size_t>(size)));
#endif
  }
};

} // namespace

void BrowserBridgeRelayTests::browserPresence_openInputIsNotClosed() {
  StdioPipe stdio;
  QVERIFY(stdio.valid());
  QVERIFY(!browserInputClosed(stdio.read_end));
}

void BrowserBridgeRelayTests::browserPresence_waitingBytesAreNotAHangup() {
  StdioPipe stdio;
  QVERIFY(stdio.valid());
  QVERIFY(stdio.put("hello", 5));
  // Readable is not closed. Confusing the two would end the relay exactly when
  // the browser was talking to it.
  QVERIFY(!browserInputClosed(stdio.read_end));
}

void BrowserBridgeRelayTests::browserPresence_closedWriteEndIsAHangup() {
  StdioPipe stdio;
  QVERIFY(stdio.valid());
  stdio.closeWriteEnd();
  QVERIFY(browserInputClosed(stdio.read_end));
}

void BrowserBridgeRelayTests::browserPresence_peekDoesNotConsume() {
  StdioPipe stdio;
  QVERIFY(stdio.valid());
  QVERIFY(stdio.put("frame", 5));
  // The watchdog runs on its own thread while the pump reads this same
  // descriptor, so a check that consumed would steal part of a frame.
  for (int i = 0; i < 5; ++i) {
    QVERIFY(!browserInputClosed(stdio.read_end));
  }
  char buffer[5] = {0};
  QCOMPARE(stdio.take(buffer, 5), 5);
  QCOMPARE(QByteArray(buffer, 5), QByteArray("frame"));
}

void BrowserBridgeRelayTests::browserPresence_invalidInputIsClosed() {
  QVERIFY(browserInputClosed(kInvalidNativeIpcHandle));
}

// -- Which servers the extension is told about -------------------------------
//
// A listing of rendezvous records is a listing of files, and a server that
// crashes leaves its file behind until another server starts and sweeps it.
// The extension picks from what it is offered with no way to tell a dead pid
// from a live one, so a stale record cost it a port and a failed connection.

namespace {

// A dead pid far above any live process, as the pipe suite uses.
constexpr qint64 kAbsentPid = 0x7FFF'FFF0;

// Something that is running but is not this program.
bool startStranger(QProcess *stranger) {
#ifdef Q_OS_WIN
  stranger->start(QStringLiteral("cmd.exe"),
                  {QStringLiteral("/c"), QStringLiteral("ping"),
                   QStringLiteral("-n"), QStringLiteral("30"),
                   QStringLiteral("127.0.0.1")});
#else
  stranger->start(QStringLiteral("sleep"), {QStringLiteral("30")});
#endif
  return stranger->waitForStarted(10'000);
}

// A running copy of this very program, which is what a server is.
bool startLingerer(QProcess *lingerer) {
  lingerer->start(QCoreApplication::applicationFilePath(),
                  {QString::fromLatin1(kLingerFlag)});
  return lingerer->waitForStarted(10'000);
}

QString recordFor(const QTemporaryDir &dir, qint64 pid) {
  const QString path =
      QDir(dir.path())
          .filePath(QStringLiteral("browser_bridge-%1.json").arg(pid));
  const RendezvousRecord record{QStringLiteral("endpoint-%1").arg(pid),
                                QStringLiteral("t"), kBrowserBridgeProtocol,
                                pid};
  return writeRendezvousRecord(path, record, nullptr) ? path : QString();
}

void endProcess(QProcess *process) {
  process->kill();
  process->waitForFinished(10'000);
}

} // namespace

void BrowserBridgeRelayTests::liveRecords_offerOnlyServersThatAreRunning() {
  QTemporaryDir dir;
  QVERIFY(dir.isValid());

  QProcess newer_server;
  QProcess older_server;
  QProcess stranger;
  QVERIFY2(startLingerer(&newer_server), "could not start a copy of us");
  QVERIFY2(startLingerer(&older_server), "could not start a copy of us");
  QVERIFY2(startStranger(&stranger), "could not start a stranger process");

  const QString newer = recordFor(dir, newer_server.processId());
  const QString older = recordFor(dir, older_server.processId());
  // Left by a server that crashed: the pid is gone.
  const QString crashed = recordFor(dir, kAbsentPid);
  // A pid that has since been reused by some other program.
  const QString reused = recordFor(dir, stranger.processId());
  // A record naming this process. The relay is never a server, so a record
  // naming it is not one it could attach to.
  const QString self = recordFor(dir, chrome_control_mcp::currentProcessId());
  // Unreadable, so there is no pid in it to check.
  const QString garbled =
      QDir(dir.path()).filePath(QStringLiteral("browser_bridge-12345.json"));
  {
    QFile file(garbled);
    QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Truncate));
    QVERIFY(file.write("not a record") > 0);
  }
  for (const QString &path : {newer, older, crashed, reused, self}) {
    QVERIFY2(!path.isEmpty(), "could not write a record");
  }

  // Interleaved, in the newest-first order a listing hands over: the living
  // keep their places relative to each other, and nothing else survives.
  const QStringList listed{crashed, newer, reused, garbled, older, self};
  QCOMPARE(chrome_control_mcp::liveRendezvousRecords(listed),
           (QStringList{newer, older}));

  // A server that exits drops out of the listing, which is what the watcher
  // relies on to report it gone. Polled rather than asserted at once: on
  // Windows a process object outlives its exit for as long as anything still
  // holds a handle to it, and something other than this test may, briefly.
  endProcess(&older_server);
  QVERIFY(waitUntil(
      [&listed, &newer] {
        return chrome_control_mcp::liveRendezvousRecords(listed) ==
               QStringList{newer};
      },
      5000));

  endProcess(&newer_server);
  endProcess(&stranger);
  QVERIFY(waitUntil(
      [&listed] {
        return chrome_control_mcp::liveRendezvousRecords(listed).isEmpty();
      },
      5000));
}

void BrowserBridgeRelayTests::serverIds_areThePidsInTheOrderGiven() {
  QCOMPARE(chrome_control_mcp::rendezvousServerIds(
               {QStringLiteral("/run/ccmcp/browser_bridge-300.json"),
                QStringLiteral("/run/ccmcp/not-a-record.json"),
                QStringLiteral("/run/ccmcp/browser_bridge-100.json")}),
           (QStringList{QStringLiteral("300"), QStringLiteral("100")}));
  QVERIFY(chrome_control_mcp::rendezvousServerIds({}).isEmpty());
}

namespace {

// Short, so the watcher's passes are cheap to wait through; what is under test
// is what it reports, not how often it looks.
constexpr int kTestWatchMs = 20;
// Ten passes at kTestWatchMs: long enough that a frame which should not be sent
// would have been.
constexpr int kQuietWindowMs = 200;

// What the extension would receive, captured from the watcher's thread.
struct FrameSink {
  std::mutex mutex;
  std::vector<QJsonObject> frames;

  chrome_control_mcp::BrowserWriteFn writer() {
    return [this](const QJsonObject &frame) {
      const std::lock_guard<std::mutex> lock(mutex);
      frames.push_back(frame);
      return true;
    };
  }
  std::size_t count() {
    const std::lock_guard<std::mutex> lock(mutex);
    return frames.size();
  }
  QJsonObject at(std::size_t index) {
    const std::lock_guard<std::mutex> lock(mutex);
    return frames.at(index);
  }
};

// The live set the watcher sees, changed by the test as servers come and go.
struct LiveServers {
  std::mutex mutex;
  QStringList ids;

  BridgeServerWatcher::ListFn lister() {
    return [this] {
      const std::lock_guard<std::mutex> lock(mutex);
      return ids;
    };
  }
  void set(const QStringList &next) {
    const std::lock_guard<std::mutex> lock(mutex);
    ids = next;
  }
};

QJsonObject serversNotice(const QStringList &ids) {
  return QJsonObject{
      {QStringLiteral("type"), QStringLiteral("bridge_servers")},
      {QStringLiteral("servers"), QJsonArray::fromStringList(ids)}};
}

} // namespace

// A relay offers its list once. Before the watcher, a server started after
// that -- a second editor opening -- waited for the extension's 30 s alarm to
// be found. The watcher reports a changed set within one pass, and stays quiet
// otherwise: the extension acts on each notice, so a notice for nothing is not
// free.
void BrowserBridgeRelayTests::
    serverWatch_reportsChangesToTheLiveSetAndNothingElse() {
  FrameSink sink;
  LiveServers live;
  // Same servers as the offer, in a different order: a server re-publishing
  // its record moves it to the front of the listing, and nothing started.
  live.set({QStringLiteral("200"), QStringLiteral("300")});
  BridgeServerWatcher watcher({QStringLiteral("300"), QStringLiteral("200")},
                              live.lister(), sink.writer(), kTestWatchMs);
  QTest::qWait(kQuietWindowMs);
  QCOMPARE(sink.count(), std::size_t{0});

  // A server starts. The notice is the whole set, newest first, in exactly the
  // documented shape and nothing more.
  live.set(
      {QStringLiteral("400"), QStringLiteral("300"), QStringLiteral("200")});
  QVERIFY(waitUntil([&sink] { return sink.count() == 1; }, 2000));
  QCOMPARE(sink.at(0),
           serversNotice({QStringLiteral("400"), QStringLiteral("300"),
                          QStringLiteral("200")}));
  // Reported once, not on every pass that sees it.
  QTest::qWait(kQuietWindowMs);
  QCOMPARE(sink.count(), std::size_t{1});

  // Servers leaving are news too.
  live.set({QStringLiteral("300")});
  QVERIFY(waitUntil([&sink] { return sink.count() == 2; }, 2000));
  QCOMPARE(sink.at(1), serversNotice({QStringLiteral("300")}));

  // Down to none at all, which is reported as an empty list, not skipped.
  live.set({});
  QVERIFY(waitUntil([&sink] { return sink.count() == 3; }, 2000));
  QCOMPARE(sink.at(2), serversNotice({}));

  watcher.stop();
  live.set({QStringLiteral("500")});
  QTest::qWait(kQuietWindowMs);
  QCOMPARE(sink.count(), std::size_t{3}); // stopped means stopped
}

void BrowserBridgeRelayTests::serverWatch_stopsPromptlyAndWhenTheSinkCloses() {
  {
    // The relay joins the watcher on its way out, and a relay that lingers
    // holds the server's pipe. So stopping cannot wait out the interval.
    FrameSink sink;
    LiveServers live;
    BridgeServerWatcher watcher({}, live.lister(), sink.writer(), 60'000);
    QElapsedTimer timer;
    timer.start();
    watcher.stop();
    QVERIFY2(
        timer.elapsed() < 2000,
        qPrintable(QStringLiteral("stop took %1 ms").arg(timer.elapsed())));
    watcher.stop(); // and a second stop is harmless
  }

  // A write that fails means stdout -- and so Chrome -- is gone. The watcher
  // stops there rather than listing on into a closed pipe.
  std::atomic<int> listings{0};
  std::atomic<int> writes{0};
  BridgeServerWatcher watcher(
      {},
      [&listings] {
        listings.fetch_add(1);
        return QStringList{QStringLiteral("1")};
      },
      [&writes](const QJsonObject &) {
        writes.fetch_add(1);
        return false;
      },
      kTestWatchMs);
  QVERIFY(waitUntil([&writes] { return writes.load() == 1; }, 2000));
  QTest::qWait(kQuietWindowMs);
  QCOMPARE(writes.load(), 1);
  QCOMPARE(listings.load(), 1);
}

int main(int argc, char *argv[]) {
  if (argc >= 2 && std::strcmp(argv[1], kLingerFlag) == 0) {
    // Killed by the test that started it; the bound only stops an orphan
    // outliving a test that died before it could.
    std::this_thread::sleep_for(std::chrono::seconds(kLingerSeconds));
    return 0;
  }
  QCoreApplication app(argc, argv);
  BrowserBridgeRelayTests tests;
  QTEST_SET_MAIN_SOURCE_PATH
  return QTest::qExec(&tests, argc, argv);
}

#include "test_browser_bridge_relay.moc"
