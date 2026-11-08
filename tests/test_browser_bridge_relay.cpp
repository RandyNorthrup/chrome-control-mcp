// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/browser_bridge_relay.h"
#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/browser_control.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/browser_uploads.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QTemporaryDir>
#include <QtTest/QtTest>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <functional>
#include <limits>
#include <mutex>
#include <thread>
#include <vector>

#ifndef Q_OS_WIN
#include <sys/socket.h>
#endif

using chrome_control_mcp::bridgeImageMismatchText;
using chrome_control_mcp::BridgePeerVersions;
using chrome_control_mcp::BridgeServerWatcher;
using chrome_control_mcp::bridgeVersionNotice;
using chrome_control_mcp::bridgeVersionOrEmpty;
using chrome_control_mcp::BrowserBridgePipeServer;
using chrome_control_mcp::BrowserControl;
using chrome_control_mcp::browserInputClosed;
using chrome_control_mcp::closeNativeIpcHandle;
using chrome_control_mcp::kBrowserBridgeProtocol;
using chrome_control_mcp::kBrowserExtensionVersion;
using chrome_control_mcp::kInvalidNativeIpcHandle;
using chrome_control_mcp::NativeIpcHandle;
using chrome_control_mcp::peerVersionsFromHello;
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
  QList<QJsonObject> commands; ///< Every command, in order.
  QJsonObject reply_payload;
  int tab_id{1};
  QString reply_error;

  chrome_control_mcp::BrowserWriteFn writer() {
    return [this](const QJsonObject &command) {
      last_command = command;
      commands.append(command);
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

// This server's own version, and one either side of it, so the tests hold
// whatever the project's version is.
QString thisVersion() { return QString::fromLatin1(kBrowserExtensionVersion); }
const QString kOlder = QStringLiteral("1.0.0");
const QString kNewer = QStringLiteral("99.0.0");

// A BrowserControl with one relay attached that reported @p versions, its
// extension played by @p extension. @p calls runs on this (the MCP) thread
// while the relay pumps; everything is torn down after. False when the relay
// never attached.
bool withAttachedControl(const BridgePeerVersions &versions,
                         FakeExtension &extension,
                         const std::function<void(BrowserControl &)> &calls) {
  QTemporaryDir dir;
  const QString path = dir.filePath(QStringLiteral("r.json"));
  BrowserControl control(serverOptions(path));
  QString error;
  if (!control.start(&error)) {
    return false;
  }
  QString token;
  int protocol = 0;
  const NativeIpcHandle pipe = relayConnect(path, &token, &protocol, &error);
  if (pipe == kInvalidNativeIpcHandle ||
      !relayHandshake(pipe, token, protocol, &error, versions)) {
    control.stop();
    closeNativeIpcHandle(pipe);
    return false;
  }
  std::atomic<bool> running{true};
  std::thread relay([&] {
    while (running.load() &&
           relayPumpOnce(pipe, extension.reader(), extension.writer())) {
    }
  });
  const bool attached =
      waitUntil([&control] { return control.clientConnected(); }, 5000);
  if (attached) {
    calls(control);
  }
  running = false;
  control.stop();
  relay.join();
  closeNativeIpcHandle(pipe);
  return attached;
}

// One Chrome profile's extension as the server meets it through a relay: it
// answers the commands routing depends on as that profile would -- which
// profile it is and when it was last focused, whether it has a tab, its tabs
// and windows, a new tab, a release, a snapshot -- and echoes anything else
// with its name, so a test can see which profile a call reached.
struct ProfileExtension {
  QString name;
  QString email;
  bool focused{false};
  double focused_at{0};
  QList<qint64> tabs;
  QList<qint64> windows;
  qint64 next_tab{0};
  QString fail_cmd;          ///< A command this profile answers with an error.
  QString extension_version; ///< Empty: the current version.
  std::mutex mutex;
  QStringList received; ///< "cmd" or "cmd:tab_id", in order.
  QJsonObject last_command;

  chrome_control_mcp::BrowserWriteFn writer() {
    return [this](const QJsonObject &command) {
      const std::lock_guard<std::mutex> lock(mutex);
      last_command = command;
      const QString cmd = command.value(QStringLiteral("cmd")).toString();
      received
          << (command.value(QStringLiteral("tab_id")).isDouble()
                  ? QStringLiteral("%1:%2").arg(cmd).arg(
                        command.value(QStringLiteral("tab_id")).toInteger())
                  : cmd);
      return true;
    };
  }

  chrome_control_mcp::BrowserReadFn reader() {
    return [this](QJsonObject *out) {
      const std::lock_guard<std::mutex> lock(mutex);
      const QJsonObject &command = last_command;
      const QString cmd = command.value(QStringLiteral("cmd")).toString();
      const qint64 tab = command.value(QStringLiteral("tab_id")).toInteger();
      QJsonObject reply{
          {QStringLiteral("type"), QStringLiteral("result")},
          {QStringLiteral("id"), command.value(QStringLiteral("id"))}};
      if (cmd == fail_cmd) {
        *out = QJsonObject{
            {QStringLiteral("type"), QStringLiteral("error")},
            {QStringLiteral("id"), command.value(QStringLiteral("id"))},
            {QStringLiteral("error"), QStringLiteral("%1 broke").arg(name)}};
        return true;
      }
      QJsonObject payload{{QStringLiteral("profile"), name}};
      if (cmd == QLatin1String("profileState")) {
        payload = QJsonObject{{QStringLiteral("profile_name"), name},
                              {QStringLiteral("focused"), focused},
                              {QStringLiteral("focused_at"), focused_at}};
        if (!email.isEmpty()) {
          payload.insert(QStringLiteral("profile_email"), email);
        }
      } else if (cmd == QLatin1String("findTab")) {
        payload = QJsonObject{{QStringLiteral("exists"), tabs.contains(tab)},
                              {QStringLiteral("held"), false}};
      } else if (cmd == QLatin1String("listTabs")) {
        QJsonArray list;
        for (const qint64 id : tabs) {
          list.append(QJsonObject{{QStringLiteral("tab_id"), id},
                                  {QStringLiteral("id"), id},
                                  {QStringLiteral("index"), list.size()}});
        }
        payload.insert(QStringLiteral("tabs"), list);
        payload.insert(QStringLiteral("your_tabs"), QJsonArray{});
        payload.insert(QStringLiteral("count"), list.size());
        payload.insert(QStringLiteral("capped"), false);
      } else if (cmd == QLatin1String("listWindows")) {
        QJsonArray list;
        for (const qint64 id : windows) {
          list.append(QJsonObject{{QStringLiteral("window_id"), id}});
        }
        payload.insert(QStringLiteral("windows"), list);
      } else if (cmd == QLatin1String("newTab")) {
        tabs.append(next_tab);
        payload.insert(QStringLiteral("ok"), true);
        payload.insert(QStringLiteral("tab_id"), next_tab);
        reply.insert(QStringLiteral("tabId"), next_tab);
        reply.insert(QStringLiteral("domEpoch"), 1);
        ++next_tab;
      } else if (cmd == QLatin1String("release")) {
        payload.insert(QStringLiteral("ok"), true);
        payload.insert(QStringLiteral("closed"), QJsonArray{tabs.value(0)});
        payload.insert(QStringLiteral("handed_back"), QJsonArray{});
        payload.insert(QStringLiteral("kept_open"), QJsonArray{});
        payload.insert(QStringLiteral("tabs_still_held"), 0);
      } else if (cmd == QLatin1String("snapshot")) {
        payload = QJsonObject{
            {QStringLiteral("url"), QStringLiteral("https://example.test/")},
            {QStringLiteral("title"), name},
            {QStringLiteral("nodes"),
             QJsonArray{
                 QJsonObject{{QStringLiteral("backendNodeId"), 7},
                             {QStringLiteral("role"), QStringLiteral("button")},
                             {QStringLiteral("name"), name},
                             {QStringLiteral("interactable"), true}}}}};
        reply.insert(QStringLiteral("tabId"), tab);
        reply.insert(QStringLiteral("domEpoch"), 1);
      } else if (tab != 0) {
        reply.insert(QStringLiteral("tabId"), tab);
        reply.insert(QStringLiteral("domEpoch"), 1);
      }
      reply.insert(QStringLiteral("payload"), payload);
      *out = reply;
      return true;
    };
  }

  QStringList seen() {
    const std::lock_guard<std::mutex> lock(mutex);
    return received;
  }
};

// One relay per profile attached to @p control, pumping until stopped. The
// relay reports the profile's name and email in its hello, as a 1.10.0 relay
// passes on what the extension said in attach_session.
struct ProfileRelay {
  NativeIpcHandle pipe{kInvalidNativeIpcHandle};
  std::atomic<bool> running{true};
  std::atomic<bool> done{false};
  std::thread thread;

  bool attach(const QString &rendezvous, ProfileExtension &extension) {
    QString token;
    int protocol = 0;
    QString error;
    pipe = relayConnect(rendezvous, &token, &protocol, &error);
    if (pipe == kInvalidNativeIpcHandle) {
      return false;
    }
    const BridgePeerVersions versions{.extension =
                                          extension.extension_version.isEmpty()
                                              ? thisVersion()
                                              : extension.extension_version,
                                      .installed = thisVersion()};
    if (!relayHandshake(pipe, token, protocol, &error, versions, nullptr,
                        {.name = extension.name, .email = extension.email})) {
      return false;
    }
    thread = std::thread([this, &extension] {
      while (running.load() &&
             relayPumpOnce(pipe, extension.reader(), extension.writer())) {
      }
      done = true;
    });
    return true;
  }

  // Close the relay's end, as a profile's Chrome window closing or its
  // extension reloading does. The pump sits in a blocking read of the pipe,
  // and closing a handle another thread is reading waits for that read, so the
  // read is ended first -- repeatedly, since the pump may not be in it yet.
  void leave() {
    running = false;
    for (int attempt = 0; attempt < 500 && !done.load(); ++attempt) {
#ifdef Q_OS_WIN
      CancelSynchronousIo(static_cast<HANDLE>(thread.native_handle()));
#else
      ::shutdown(pipe, SHUT_RDWR);
#endif
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (thread.joinable()) {
      thread.join();
    }
    closeNativeIpcHandle(pipe);
    pipe = kInvalidNativeIpcHandle;
  }

  ~ProfileRelay() {
    running = false;
    if (thread.joinable()) {
      thread.join();
    }
    if (pipe != kInvalidNativeIpcHandle) {
      closeNativeIpcHandle(pipe);
    }
  }
};

// Two profiles, work and personal, attached to one BrowserControl. @p calls
// runs once both are connected; relays and control are torn down after.
bool withTwoProfiles(ProfileExtension &work, ProfileExtension &personal,
                     const std::function<void(BrowserControl &, ProfileRelay &,
                                              ProfileRelay &)> &calls) {
  QTemporaryDir dir;
  const QString path = dir.filePath(QStringLiteral("r.json"));
  ProfileRelay work_relay;
  ProfileRelay personal_relay;
  BrowserControl control(serverOptions(path));
  QString error;
  if (!control.start(&error) || !work_relay.attach(path, work) ||
      !personal_relay.attach(path, personal)) {
    return false;
  }
  const bool both = waitUntil(
      [&control] {
        return control.connectionVersions()
                   .value(QStringLiteral("profiles"))
                   .toArray()
                   .size() == 2;
      },
      5000);
  if (both) {
    calls(control, work_relay, personal_relay);
  }
  work_relay.running = false;
  personal_relay.running = false;
  control.stop();
  return both;
}

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
  int beats_to_send{5};
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
  void relay_answersAsSoonAsTheReplyIsIn();
  void relay_forwardsCancelToAPollingExtensionWhenTheServerAbandons();
  void relay_forwardsProgressBeatsAndStillDeliversTheReply();
  void control_notConnectedReportsError();
  void control_snapshotRoundTripsThroughRelay();
  void control_waitsForARelayThatIsAttaching();
  void control_protocolMismatchSaysHowToFixIt();
  void versions_onlyMajorMinorPatchIsAVersion();
  void relayHandshake_carriesVersionsBothWays();
  void relayHandshake_withoutVersionsIsTheHelloItAlwaysWas();
  void versionNotice_namesWhatIsBehindAndTheFix();
  void control_toldOncePerConnectionWhenVersionsDisagree();
  void control_matchingVersionsAreNeverTold();
  void control_unknownCommandFromAnOlderExtensionSaysWhy();
  void profiles_newTabGoesToTheOneNamedOrTheLastFocused();
  void profiles_callsFollowTheirTab();
  void profiles_listingsAndReleaseCoverEveryProfile();
  void profiles_oneLeavingKeepsTheOthersRefs();
  void profiles_statusAndNoticesNameEachProfile();
  void profiles_oldestWinsATieAndAnOlderExtensionIsUnnamed();
  void upload_goesInPiecesToThePageAndAnOlderExtensionKeepsItsBound();
  void browserPresence_openInputIsNotClosed();
  void browserPresence_waitingBytesAreNotAHangup();
  void browserPresence_closedWriteEndIsAHangup();
  void browserPresence_peekDoesNotConsume();
  void browserPresence_invalidInputIsClosed();
  void browserPresence_oneClosedLookEndsNothing();
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

// The relay hands the reply to the server as soon as it is in. Its loop looks
// at the bridge for a cancel every 25 ms, and used to notice the reply only on
// its next look: every exchange cost a whole tick on top of the extension's own
// time (replies measured 26, 51, 76 and 101 ms). The reader now wakes the loop.
// The fastest of five exchanges with an extension that answers at once must
// come in well under one tick; a loop that sleeps through it never can.
void BrowserBridgeRelayTests::relay_answersAsSoonAsTheReplyIsIn() {
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

  // The relay's tick lengthened to a second: a reply that waited it out takes
  // a second, one that woke the wait takes milliseconds, and no load on the
  // machine running this can make the one look like the other. At the real
  // 25 ms tick the two were 10 ms apart, and a busy machine closed the gap.
  constexpr std::chrono::milliseconds kTick{1000};
  constexpr qint64 kWokenWithinMs = 500;
  qint64 fastest = std::numeric_limits<qint64>::max();
  for (int round = 0; round < 3; ++round) {
    FakeExtension extension;
    extension.reply_payload = QJsonObject{{QStringLiteral("round"), round}};
    std::atomic<bool> pumped{false};
    std::thread relay([&] {
      pumped =
          relayPumpOnce(pipe, extension.reader(), extension.writer(), kTick);
    });
    QElapsedTimer timer;
    timer.start();
    const auto exchange = server.sendCommandAwaitReply(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("command")},
        {QStringLiteral("id"), QStringLiteral("fast-%1").arg(round)},
        {QStringLiteral("cmd"), QStringLiteral("dialog")}});
    const qint64 elapsed = timer.elapsed();
    relay.join();
    QVERIFY2(exchange.ok, qPrintable(exchange.error));
    QVERIFY(pumped.load());
    fastest = std::min(fastest, elapsed);
  }
  QVERIFY2(fastest < kWokenWithinMs,
           qPrintable(QStringLiteral("fastest exchange took %1 ms; the relay "
                                     "waited out its %2 ms tick")
                          .arg(fastest)
                          .arg(kTick.count())));

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
// budget, beating as it works, over a real pipe with the real relay in between.
//
// Every piece has to hold or this fails. The extension beats; the relay reads
// past the beats instead of handing the first one up as the reply, and forwards
// each from the thread that owns the pipe; the server restarts its deadline on
// each and keeps waiting. Before this, the server tore the connection down when
// the budget ran out and the caller was told the browser had reset -- for a
// command that was working the entire time.
void BrowserBridgeRelayTests::
    relay_forwardsProgressBeatsAndStillDeliversTheReply() {
  QTemporaryDir dir;
  auto options = serverOptions(dir.filePath(QStringLiteral("r.json")));
  // Six 250 ms gaps outlast this by half again, so only the beats can carry
  // the exchange to its reply. Each gap is a 250 ms sleep plus up to one relay
  // drain poll; at 400 ms that left the macOS runner barely 125 ms of
  // scheduling slack, and one late wake-up failed the test with nothing wrong.
  options.io_timeout_ms = 1000;
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
  // The server's side first: when the relay's pump fails it is because the
  // server gave up, and only the server's error says why.
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  QVERIFY(pumped.load());
  // The REPLY came up, not the first beat wearing its id.
  QCOMPARE(exchange.reply.value(QStringLiteral("type")).toString(),
           QStringLiteral("result"));
  QCOMPARE(exchange.reply.value(QStringLiteral("payload"))
               .toObject()
               .value(QStringLiteral("worked_for_ms"))
               .toInt(),
           1500);
  QCOMPARE(extension.beats_sent, 5);
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
                          "- button \"Sign in\" [ref=e1]\n"));
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

void BrowserBridgeRelayTests::versions_onlyMajorMinorPatchIsAVersion() {
  // Peers say these, and an agent ends up reading them: three short numbers
  // and nothing else, or nothing at all.
  QCOMPARE(bridgeVersionOrEmpty(QJsonValue(QStringLiteral("1.9.0"))),
           QStringLiteral("1.9.0"));
  QCOMPARE(bridgeVersionOrEmpty(QJsonValue(QStringLiteral("12.345.6789"))),
           QStringLiteral("12.345.6789"));
  const QList<QJsonValue> rejected{
      QJsonValue(),
      QJsonValue(QStringLiteral("")),
      QJsonValue(QStringLiteral("1.9")),
      QJsonValue(QStringLiteral("1.9.0.1")),
      QJsonValue(QStringLiteral("v1.9.0")),
      QJsonValue(QStringLiteral("1.9.0\n")),
      QJsonValue(QStringLiteral(" 1.9.0")),
      QJsonValue(QStringLiteral("1.9.0-beta")),
      QJsonValue(QStringLiteral("<b>1.9.0</b>")),
      QJsonValue(QStringLiteral("123456.0.0")),
      QJsonValue(QString(300, QLatin1Char('9'))),
      // Arabic-Indic digits are digits to a Unicode-aware \d.
      QJsonValue(QString::fromUtf8("\xd9\xa1.\xd9\xa9.\xd9\xa0")),
      QJsonValue(1.9),
      QJsonValue(true),
      QJsonValue(QJsonObject{{QStringLiteral("v"), QStringLiteral("1.9.0")}}),
  };
  for (const QJsonValue &value : rejected) {
    QVERIFY2(bridgeVersionOrEmpty(value).isEmpty(),
             qPrintable(QJsonDocument(QJsonArray{value}).toJson()));
  }
  const BridgePeerVersions junk = peerVersionsFromHello(
      QJsonObject{{QStringLiteral("extension_version"), QStringLiteral("x")},
                  {QStringLiteral("relay_version"), 2}});
  QVERIFY(junk.extension.isEmpty());
  QVERIFY(junk.installed.isEmpty());
}

void BrowserBridgeRelayTests::relayHandshake_carriesVersionsBothWays() {
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
  QString server_version;
  QVERIFY2(relayHandshake(pipe, token, protocol, &error,
                          {.extension = kOlder, .installed = thisVersion()},
                          &server_version),
           qPrintable(error));
  QVERIFY(waitUntil([&server] { return server.clientConnected(); }, 5000));

  // The server heard both, and said its own.
  const BridgePeerVersions heard = server.peerVersions();
  QCOMPARE(heard.extension, kOlder);
  QCOMPARE(heard.installed, thisVersion());
  QCOMPARE(server_version, thisVersion());

  closeNativeIpcHandle(pipe);
  // Gone with the connection: nothing connected reports nothing.
  QVERIFY(waitUntil([&server] { return !server.clientConnected(); }, 5000));
  QVERIFY(server.peerVersions().extension.isEmpty());
  server.stop();
}

void BrowserBridgeRelayTests::
    relayHandshake_withoutVersionsIsTheHelloItAlwaysWas() {
  // A relay older than 1.9.0 sends no versions. It is admitted exactly as
  // before, commands flow, and the versions read as not said.
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
  QVERIFY(server.peerVersions().extension.isEmpty());
  QVERIFY(server.peerVersions().installed.isEmpty());

  FakeExtension extension;
  extension.reply_payload = QJsonObject{{QStringLiteral("echoed"), true}};
  std::thread relay([&] {
    (void)relayPumpOnce(pipe, extension.reader(), extension.writer());
  });
  const auto exchange = server.sendCommandAwaitReply(
      QJsonObject{{QStringLiteral("type"), QStringLiteral("command")},
                  {QStringLiteral("id"), QStringLiteral("v-1")},
                  {QStringLiteral("cmd"), QStringLiteral("snapshot")}});
  relay.join();
  QVERIFY2(exchange.ok, qPrintable(exchange.error));
  closeNativeIpcHandle(pipe);
  server.stop();
}

void BrowserBridgeRelayTests::versionNotice_namesWhatIsBehindAndTheFix() {
  const QString server = thisVersion();
  const auto notice = [&server](const QString &extension,
                                const QString &installed) {
    return bridgeVersionNotice(
        server, {.extension = extension, .installed = installed});
  };
  // All the same: nothing to say.
  QVERIFY(notice(server, server).isEmpty());

  // An extension that says nothing is older than 1.9.0, and what that costs is
  // named.
  const QString silent = notice(QString(), server);
  QVERIFY2(silent.contains(QStringLiteral("older than 1.9.0")) &&
               silent.contains(QStringLiteral("chrome://extensions")) &&
               silent.contains(QStringLiteral("browser_clipboard")) &&
               silent.contains(QStringLiteral("system clipboard")),
           qPrintable(silent));

  // Older, with newer files installed: reload, and it would reload itself.
  const QString older = notice(kOlder, server);
  QVERIFY2(older.contains(kOlder) && older.contains(server) &&
               older.contains(QStringLiteral("chrome://extensions")) &&
               older.contains(QStringLiteral("reloads itself")),
           qPrintable(older));

  // A newer copy installed than this server: restart the server.
  const QString behind = notice(kNewer, kNewer);
  QVERIFY2(behind.contains(QStringLiteral("is installed, but this server")) &&
               behind.contains(kNewer) &&
               behind.contains(QStringLiteral("Restart the server")) &&
               !behind.contains(QStringLiteral("chrome://extensions")),
           qPrintable(behind));

  // An extension newer than the server, with nothing newer installed.
  const QString ahead = notice(kNewer, server);
  QVERIFY2(ahead.contains(QStringLiteral("newer than this server")) &&
               ahead.contains(QStringLiteral("browser_update_apply")),
           qPrintable(ahead));

  // The installed copy is older than this server (a build-tree server):
  // reloading would load the older copy again, so the fix is to install.
  const QString build = notice(kOlder, kOlder);
  QVERIFY2(build.contains(QStringLiteral("--install")) &&
               !build.contains(QStringLiteral("reloads itself")),
           qPrintable(build));

  // A relay that says nothing: what Chrome starts is older than 1.9.0.
  const QString old_relay = notice(QString(), QString());
  QVERIFY2(old_relay.contains(QStringLiteral("older than 1.9.0")) &&
               old_relay.contains(QStringLiteral("--install")),
           qPrintable(old_relay));
}

void BrowserBridgeRelayTests::
    control_toldOncePerConnectionWhenVersionsDisagree() {
  FakeExtension extension;
  extension.reply_payload = QJsonObject{{QStringLiteral("tabs"), QJsonArray{}}};
  ToolResult first;
  QString first_notice;
  QString second_notice;
  QJsonObject running;
  const bool attached = withAttachedControl(
      {.extension = kOlder, .installed = thisVersion()}, extension,
      [&](BrowserControl &control) {
        first = control.invoke(QStringLiteral("browser_tabs"), {});
        first_notice = control.takeVersionNotice();
        (void)control.invoke(QStringLiteral("browser_tabs"), {});
        second_notice = control.takeVersionNotice();
        running = control.connectionVersions();
      });
  QVERIFY(attached);
  QVERIFY2(!first.is_error, qPrintable(first.text));
  // The reply itself is untouched: the notice travels beside it.
  QVERIFY(!first.text.contains(QStringLiteral("Note:")));
  QVERIFY2(first_notice.contains(kOlder) &&
               first_notice.contains(QStringLiteral("chrome://extensions")),
           qPrintable(first_notice));
  QVERIFY2(second_notice.isEmpty(), qPrintable(second_notice));
  // browser_extension_status can ask at any time, and gets the same answer.
  QCOMPARE(running.value(QStringLiteral("connected")).toBool(), true);
  QCOMPARE(running.value(QStringLiteral("connections")).toInt(), 1);
  QCOMPARE(running.value(QStringLiteral("extension_version")).toString(),
           kOlder);
  QCOMPARE(running.value(QStringLiteral("installed_version")).toString(),
           thisVersion());
  QCOMPARE(running.value(QStringLiteral("server_version")).toString(),
           thisVersion());
  QCOMPARE(running.value(QStringLiteral("notice")).toString(), first_notice);

  // A new connection is told again: it may be another extension entirely.
  FakeExtension again;
  again.reply_payload = QJsonObject{{QStringLiteral("tabs"), QJsonArray{}}};
  QString reconnected_notice;
  QVERIFY(withAttachedControl(
      {.extension = kOlder, .installed = thisVersion()}, again,
      [&](BrowserControl &control) {
        (void)control.invoke(QStringLiteral("browser_tabs"), {});
        reconnected_notice = control.takeVersionNotice();
      }));
  QVERIFY(!reconnected_notice.isEmpty());
}

void BrowserBridgeRelayTests::control_matchingVersionsAreNeverTold() {
  FakeExtension extension;
  extension.reply_payload = QJsonObject{{QStringLiteral("tabs"), QJsonArray{}}};
  QString notice = QStringLiteral("unset");
  QJsonObject running;
  QVERIFY(withAttachedControl(
      {.extension = thisVersion(), .installed = thisVersion()}, extension,
      [&](BrowserControl &control) {
        (void)control.invoke(QStringLiteral("browser_tabs"), {});
        notice = control.takeVersionNotice();
        running = control.connectionVersions();
      }));
  QVERIFY2(notice.isEmpty(), qPrintable(notice));
  QVERIFY(running.value(QStringLiteral("notice")).toString().isEmpty());

  // And nothing is told before anything has connected.
  QTemporaryDir dir;
  BrowserControl idle(serverOptions(dir.filePath(QStringLiteral("r.json"))));
  QVERIFY(idle.takeVersionNotice().isEmpty());
  const QJsonObject nothing = idle.connectionVersions();
  QCOMPARE(nothing.value(QStringLiteral("connected")).toBool(), false);
  QVERIFY(nothing.value(QStringLiteral("extension_version")).isNull());
}

void BrowserBridgeRelayTests::
    control_unknownCommandFromAnOlderExtensionSaysWhy() {
  // What a 1.8.x extension answers browser_clipboard with.
  const QString unknown = QStringLiteral("Unknown command: clipboard");
  FakeExtension old_extension;
  old_extension.reply_error = unknown;
  ToolResult old_result;
  QVERIFY(withAttachedControl(
      {.extension = QString(), .installed = thisVersion()}, old_extension,
      [&](BrowserControl &control) {
        old_result = control.invoke(
            QStringLiteral("browser_clipboard"),
            QJsonObject{{QStringLiteral("action"), QStringLiteral("read")}});
      }));
  QVERIFY(old_result.is_error);
  QVERIFY2(old_result.text.startsWith(unknown) &&
               old_result.text.contains(QStringLiteral("older than 1.9.0")) &&
               old_result.text.contains(QStringLiteral("chrome://extensions")),
           qPrintable(old_result.text));

  // The same words from an extension of this server's own version are its
  // own business, passed on unchanged.
  FakeExtension current;
  current.reply_error = unknown;
  ToolResult current_result;
  QVERIFY(withAttachedControl(
      {.extension = thisVersion(), .installed = thisVersion()}, current,
      [&](BrowserControl &control) {
        current_result = control.invoke(
            QStringLiteral("browser_clipboard"),
            QJsonObject{{QStringLiteral("action"), QStringLiteral("read")}});
      }));
  QVERIFY(current_result.is_error);
  QCOMPARE(current_result.text, unknown);
}

void BrowserBridgeRelayTests::
    profiles_newTabGoesToTheOneNamedOrTheLastFocused() {
  ProfileExtension work;
  work.name = QStringLiteral("work");
  work.email = QStringLiteral("randy@work.example");
  work.focused_at = 100;
  work.next_tab = 100;
  ProfileExtension personal;
  personal.name = QStringLiteral("personal");
  personal.focused_at = 200; // the user was in personal last
  personal.next_tab = 200;
  ToolResult named;
  ToolResult by_email;
  ToolResult upper;
  ToolResult unnamed;
  ToolResult unknown;
  ToolResult focused_now;
  QVERIFY(withTwoProfiles(
      work, personal,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &) {
        const auto open = [&control](const QJsonObject &args) {
          return control.invoke(QStringLiteral("browser_new_tab"), args);
        };
        named = open({{QStringLiteral("profile"), QStringLiteral("work")}});
        by_email = open({{QStringLiteral("profile"),
                          QStringLiteral("Randy@Work.Example")}});
        upper = open({{QStringLiteral("profile"), QStringLiteral("PERSONAL")}});
        unnamed = open({});
        unknown = open({{QStringLiteral("profile"), QStringLiteral("school")}});
        // A window of work in front right now beats personal's later focus
        // time.
        work.focused = true;
        focused_now = open({});
      }));
  QVERIFY2(!named.is_error, qPrintable(named.text));
  QVERIFY2(!by_email.is_error, qPrintable(by_email.text));
  QVERIFY2(!upper.is_error, qPrintable(upper.text));
  QVERIFY2(!unnamed.is_error, qPrintable(unnamed.text));
  QCOMPARE(work.seen().filter(QStringLiteral("newTab")).size(), 3);
  QCOMPARE(personal.seen().filter(QStringLiteral("newTab")).size(), 2);
  // Asked for a profile that is not there: refused, saying which are.
  QVERIFY(unknown.is_error);
  QVERIFY2(unknown.text.contains(QStringLiteral("\"school\"")) &&
               unknown.text.contains(QStringLiteral("work")) &&
               unknown.text.contains(QStringLiteral("personal")),
           qPrintable(unknown.text));
  QVERIFY2(!focused_now.is_error, qPrintable(focused_now.text));
}

void BrowserBridgeRelayTests::profiles_callsFollowTheirTab() {
  ProfileExtension work;
  work.name = QStringLiteral("work");
  work.tabs = {11};
  ProfileExtension personal;
  personal.name = QStringLiteral("personal");
  personal.tabs = {22};
  ToolResult in_personal;
  ToolResult in_work;
  ToolResult current;
  ToolResult missing;
  ToolResult by_ref;
  QVERIFY(withTwoProfiles(
      work, personal,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &) {
        const auto read = [&control](const QJsonObject &args) {
          return control.invoke(QStringLiteral("browser_read"), args);
        };
        // Tab 22 has never been in a reply: the server asks which profile has
        // it.
        in_personal = read({{QStringLiteral("tab_id"), 22}});
        in_work = read({{QStringLiteral("tab_id"), 11}});
        // No tab named: the agent's current profile, the one it last used.
        current = read({});
        // In no profile: the current one answers, as the one browser always
        // did.
        missing = read({{QStringLiteral("tab_id"), 99}});
        // A ref is bound to its tab, and so to its profile.
        (void)control.invoke(QStringLiteral("browser_snapshot"),
                             {{QStringLiteral("tab_id"), 22}});
        (void)read({{QStringLiteral("tab_id"), 11}}); // now current: work
        by_ref =
            control.invoke(QStringLiteral("browser_click"),
                           {{QStringLiteral("ref"), QStringLiteral("e1")}});
      }));
  QVERIFY2(!in_personal.is_error, qPrintable(in_personal.text));
  QVERIFY(in_personal.text.contains(QStringLiteral("personal")));
  QVERIFY(in_work.text.contains(QStringLiteral("work")));
  QVERIFY2(current.text.contains(QStringLiteral("work")),
           qPrintable(current.text));
  QVERIFY(work.seen().contains(QStringLiteral("read:99")));
  QVERIFY2(!by_ref.is_error, qPrintable(by_ref.text));
  QVERIFY2(personal.seen().contains(QStringLiteral("click:22")),
           qPrintable(personal.seen().join(QLatin1Char(' '))));
  QVERIFY(!work.seen().contains(QStringLiteral("click:22")));
}

void BrowserBridgeRelayTests::profiles_listingsAndReleaseCoverEveryProfile() {
  ProfileExtension work;
  work.name = QStringLiteral("work");
  work.tabs = {11, 12};
  work.windows = {1};
  ProfileExtension personal;
  personal.name = QStringLiteral("personal");
  personal.tabs = {22};
  personal.windows = {2};
  QJsonObject tabs;
  QJsonObject windows;
  QJsonObject released;
  QJsonObject partial;
  QVERIFY(withTwoProfiles(
      work, personal,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &) {
        const auto json = [&control](const QString &tool) {
          return QJsonDocument::fromJson(control.invoke(tool, {}).text.toUtf8())
              .object();
        };
        tabs = json(QStringLiteral("browser_tabs"));
        windows = json(QStringLiteral("browser_windows"));
        released = json(QStringLiteral("browser_release"));
        personal.fail_cmd = QStringLiteral("listTabs");
        partial = json(QStringLiteral("browser_tabs"));
      }));
  QCOMPARE(tabs.value(QStringLiteral("count")).toInt(), 3);
  QStringList where;
  for (const QJsonValue &tab : tabs.value(QStringLiteral("tabs")).toArray()) {
    where
        << QStringLiteral("%1@%2")
               .arg(tab.toObject().value(QStringLiteral("tab_id")).toInt())
               .arg(tab.toObject().value(QStringLiteral("profile")).toString());
  }
  QCOMPARE(where,
           (QStringList{QStringLiteral("11@work"), QStringLiteral("12@work"),
                        QStringLiteral("22@personal")}));
  QCOMPARE(windows.value(QStringLiteral("windows")).toArray().size(), 2);
  QCOMPARE(released.value(QStringLiteral("profiles")).toArray().size(), 2);
  QCOMPARE(released.value(QStringLiteral("closed")).toArray().size(), 2);
  QVERIFY(work.seen().contains(QStringLiteral("release")));
  QVERIFY(personal.seen().contains(QStringLiteral("release")));
  // A profile that fails is named; the rest are still listed.
  QCOMPARE(partial.value(QStringLiteral("count")).toInt(), 2);
  const QJsonArray failed = partial.value(QStringLiteral("failed")).toArray();
  QCOMPARE(failed.size(), 1);
  QCOMPARE(
      failed.first().toObject().value(QStringLiteral("profile")).toString(),
      QStringLiteral("personal"));
}

void BrowserBridgeRelayTests::profiles_oneLeavingKeepsTheOthersRefs() {
  ProfileExtension work;
  work.name = QStringLiteral("work");
  work.tabs = {11};
  ProfileExtension personal;
  personal.name = QStringLiteral("personal");
  personal.tabs = {22};
  ToolResult work_ref;
  ToolResult personal_ref;
  QJsonObject after;
  QVERIFY(withTwoProfiles(
      work, personal,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &leaving) {
        (void)control.invoke(QStringLiteral("browser_snapshot"),
                             {{QStringLiteral("tab_id"), 11}}); // e1, work
        (void)control.invoke(QStringLiteral("browser_snapshot"),
                             {{QStringLiteral("tab_id"), 22}}); // e2, personal
        leaving.leave();
        QVERIFY(waitUntil(
            [&control] {
              return control.connectionVersions()
                         .value(QStringLiteral("profiles"))
                         .toArray()
                         .size() == 1;
            },
            5000));
        work_ref =
            control.invoke(QStringLiteral("browser_click"),
                           {{QStringLiteral("ref"), QStringLiteral("e1")}});
        personal_ref =
            control.invoke(QStringLiteral("browser_click"),
                           {{QStringLiteral("ref"), QStringLiteral("e2")}});
        after = control.connectionVersions();
      }));
  // Work's ref survived personal leaving; personal's went with it.
  QVERIFY2(!work_ref.is_error, qPrintable(work_ref.text));
  QVERIFY(work.seen().contains(QStringLiteral("click:11")));
  QVERIFY(personal_ref.is_error);
  QVERIFY2(personal_ref.text.contains(QStringLiteral("e2")),
           qPrintable(personal_ref.text));
  QCOMPARE(after.value(QStringLiteral("profiles"))
               .toArray()
               .first()
               .toObject()
               .value(QStringLiteral("name"))
               .toString(),
           QStringLiteral("work"));
}

void BrowserBridgeRelayTests::profiles_statusAndNoticesNameEachProfile() {
  ProfileExtension work;
  work.name = QStringLiteral("work");
  work.email = QStringLiteral("randy@work.example");
  work.extension_version = kOlder;
  ProfileExtension personal;
  personal.name = QStringLiteral("personal");
  QString notice;
  QJsonObject status;
  QVERIFY(withTwoProfiles(
      work, personal,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &) {
        (void)control.invoke(QStringLiteral("browser_tabs"), {});
        notice = control.takeVersionNotice();
        status = control.connectionVersions();
      }));
  QVERIFY2(notice.startsWith(QStringLiteral("In Chrome profile work: ")) &&
               notice.contains(kOlder) &&
               !notice.contains(QStringLiteral("profile personal")),
           qPrintable(notice));
  const QJsonArray profiles =
      status.value(QStringLiteral("profiles")).toArray();
  QCOMPARE(profiles.size(), 2);
  QStringList seen;
  for (const QJsonValue &entry : profiles) {
    const QJsonObject profile = entry.toObject();
    seen << QStringLiteral("%1|%2|%3")
                .arg(profile.value(QStringLiteral("name")).toString(),
                     profile.value(QStringLiteral("email")).toString(),
                     profile.value(QStringLiteral("extension_version"))
                         .toString());
  }
  QCOMPARE(seen, (QStringList{
                     QStringLiteral("work|randy@work.example|%1").arg(kOlder),
                     QStringLiteral("personal||%1").arg(thisVersion())}));
}

// A file of @p size bytes, each byte its index modulo a prime, in @p dir.
QString uploadFile(const QTemporaryDir &dir, const QString &name, qint64 size) {
  const QString path = dir.filePath(name);
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly)) {
    return {};
  }
  QByteArray bytes(static_cast<qsizetype>(size), Qt::Uninitialized);
  for (qsizetype i = 0; i < bytes.size(); ++i) {
    bytes[i] = static_cast<char>(i % 251);
  }
  file.write(bytes);
  return QFileInfo(path).canonicalFilePath();
}

QStringList commandNames(const FakeExtension &extension) {
  QStringList names;
  for (const QJsonObject &command : extension.commands) {
    names << command.value(QStringLiteral("cmd")).toString();
  }
  return names;
}

void BrowserBridgeRelayTests::
    upload_goesInPiecesToThePageAndAnOlderExtensionKeepsItsBound() {
  QTemporaryDir dir;
  // Two and a half pieces.
  const qint64 size = chrome_control_mcp::browser::kUploadPieceBytes * 2 + 1000;
  const QString path = uploadFile(dir, QStringLiteral("clip.mp4"), size);
  const QString big =
      uploadFile(dir, QStringLiteral("long.mp4"),
                 chrome_control_mcp::browser::kMaxUploadFileBytes + 1);
  QVERIFY(!path.isEmpty() && !big.isEmpty());
  const auto paths = [](const QString &file) { return QJsonArray{file}; };

  // An extension that stages: pieces as uploadStage, addressed to the tab and
  // the element the ref names, then the upload naming the file.
  FakeExtension current;
  current.reply_payload = QJsonObject{
      {QStringLiteral("url"), QStringLiteral("https://example.test/")},
      {QStringLiteral("title"), QStringLiteral("Upload")},
      {QStringLiteral("nodes"),
       QJsonArray{
           QJsonObject{{QStringLiteral("backendNodeId"), 7},
                       {QStringLiteral("role"), QStringLiteral("button")},
                       {QStringLiteral("name"), QStringLiteral("Upload")},
                       {QStringLiteral("interactable"), true}}}}};
  ToolResult staged;
  ToolResult over_cap;
  ToolResult not_understood;
  int before_cap = 0;
  int after_cap = 0;
  QVERIFY(withAttachedControl(
      {.extension = thisVersion(), .installed = thisVersion()}, current,
      [&](BrowserControl &control) {
        (void)control.invoke(QStringLiteral("browser_snapshot"),
                             {{QStringLiteral("tab_id"), 1}});
        staged = control.invoke(QStringLiteral("browser_upload"),
                                {{QStringLiteral("ref"), QStringLiteral("e1")},
                                 {QStringLiteral("paths"), paths(path)}});
        // The operator's cap: a file over it goes nowhere, and a value that
        // is not understood falls back to 16 MiB and says so.
        qputenv("CHROME_CONTROL_MCP_UPLOAD_MAX_MB", "1");
        before_cap = static_cast<int>(current.commands.size());
        over_cap = control.invoke(QStringLiteral("browser_upload"),
                                  {{QStringLiteral("tab_id"), 1},
                                   {QStringLiteral("paths"), paths(big)}});
        qputenv("CHROME_CONTROL_MCP_UPLOAD_MAX_MB", "lots");
        not_understood =
            control.invoke(QStringLiteral("browser_upload"),
                           {{QStringLiteral("tab_id"), 1},
                            {QStringLiteral("paths"), paths(big)}});
        after_cap = static_cast<int>(current.commands.size());
        qunsetenv("CHROME_CONTROL_MCP_UPLOAD_MAX_MB");
      }));
  QVERIFY2(!staged.is_error, qPrintable(staged.text));
  const QStringList names = commandNames(current);
  QCOMPARE(
      names.mid(names.indexOf(QStringLiteral("uploadStage")), 4),
      (QStringList{QStringLiteral("uploadStage"), QStringLiteral("uploadStage"),
                   QStringLiteral("uploadStage"), QStringLiteral("upload")}));
  QByteArray rejoined;
  int seq = 0;
  for (const QJsonObject &command : current.commands) {
    // No path ever leaves this side.
    QVERIFY(!QJsonDocument(command).toJson().contains(path.toUtf8()));
    if (command.value(QStringLiteral("cmd")).toString() !=
        QLatin1String("uploadStage")) {
      continue;
    }
    QCOMPARE(command.value(QStringLiteral("seq")).toInt(), seq++);
    QCOMPARE(command.value(QStringLiteral("total")).toInt(), 3);
    QCOMPARE(command.value(QStringLiteral("size")).toInteger(), size);
    QCOMPARE(command.value(QStringLiteral("tab_id")).toInt(), 1);
    QCOMPARE(command.value(QStringLiteral("backendNodeId")).toInt(), 7);
    rejoined.append(QByteArray::fromBase64(
        command.value(QStringLiteral("data")).toString().toLatin1()));
  }
  QCOMPARE(rejoined.size(), size);
  QFile original(path);
  QVERIFY(original.open(QIODevice::ReadOnly));
  QCOMPARE(rejoined, original.readAll());
  QVERIFY(over_cap.is_error);
  QVERIFY2(over_cap.text.contains(QStringLiteral("at most 1048576")) &&
               over_cap.text.contains(
                   QStringLiteral("CHROME_CONTROL_MCP_UPLOAD_MAX_MB")),
           qPrintable(over_cap.text));
  QVERIFY(not_understood.is_error);
  QVERIFY2(not_understood.text.contains(QStringLiteral("\"lots\"")) &&
               not_understood.text.contains(QStringLiteral("16 MiB")),
           qPrintable(not_understood.text));
  // Refused before any piece went.
  QCOMPARE(after_cap, before_cap);

  // An extension older than 1.11.0: pieces the old way, which it holds whole,
  // and above 16 MiB a refusal that says to reload it. The clipboard keeps the
  // old way whatever the extension.
  FakeExtension older;
  ToolResult small;
  ToolResult large;
  ToolResult clipboard;
  int before_large = 0;
  int after_large = 0;
  QVERIFY(withAttachedControl(
      {.extension = kOlder, .installed = thisVersion()}, older,
      [&](BrowserControl &control) {
        small = control.invoke(QStringLiteral("browser_upload"),
                               {{QStringLiteral("tab_id"), 1},
                                {QStringLiteral("paths"), paths(path)}});
        before_large = static_cast<int>(older.commands.size());
        large = control.invoke(QStringLiteral("browser_upload"),
                               {{QStringLiteral("tab_id"), 1},
                                {QStringLiteral("paths"), paths(big)}});
        after_large = static_cast<int>(older.commands.size());
      }));
  QVERIFY2(!small.is_error, qPrintable(small.text));
  QVERIFY(commandNames(older).contains(QStringLiteral("uploadChunk")));
  QVERIFY(!commandNames(older).contains(QStringLiteral("uploadStage")));
  QVERIFY(large.is_error);
  QVERIFY2(large.text.contains(kOlder) &&
               large.text.contains(QStringLiteral("reload Chrome Control MCP")),
           qPrintable(large.text));
  QCOMPARE(after_large, before_large);

  FakeExtension clipboard_extension;
  QVERIFY(withAttachedControl(
      {.extension = thisVersion(), .installed = thisVersion()},
      clipboard_extension, [&](BrowserControl &control) {
        clipboard =
            control.invoke(QStringLiteral("browser_clipboard"),
                           {{QStringLiteral("tab_id"), 1},
                            {QStringLiteral("action"), QStringLiteral("write")},
                            {QStringLiteral("paths"), paths(path)}});
      }));
  QVERIFY2(!clipboard.is_error, qPrintable(clipboard.text));
  QVERIFY(commandNames(clipboard_extension)
              .contains(QStringLiteral("uploadChunk")));
  QVERIFY(!commandNames(clipboard_extension)
               .contains(QStringLiteral("uploadStage")));
}

void BrowserBridgeRelayTests::
    profiles_oldestWinsATieAndAnOlderExtensionIsUnnamed() {
  // No window of either has ever had focus: the oldest connection, the first
  // to attach, gets the new tab.
  ProfileExtension first;
  first.name = QStringLiteral("first");
  first.next_tab = 100;
  ProfileExtension second;
  second.name = QStringLiteral("second");
  second.next_tab = 200;
  ToolResult tie;
  QVERIFY(withTwoProfiles(
      first, second,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &) {
        tie = control.invoke(QStringLiteral("browser_new_tab"), {});
      }));
  QVERIFY2(!tie.is_error, qPrintable(tie.text));
  QCOMPARE(first.seen().filter(QStringLiteral("newTab")).size(), 1);
  QCOMPARE(second.seen().filter(QStringLiteral("newTab")).size(), 0);

  // An extension older than profiles: its relay says no profile, and it does
  // not know profileState. It is called unnamed and never counts as focused,
  // so a profile focused once wins the new tab although this one is older.
  ProfileExtension older;
  older.fail_cmd = QStringLiteral("profileState");
  older.next_tab = 100;
  ProfileExtension personal;
  personal.name = QStringLiteral("personal");
  personal.focused_at = 50;
  personal.next_tab = 200;
  ToolResult opened;
  QJsonObject status;
  QVERIFY(withTwoProfiles(
      older, personal,
      [&](BrowserControl &control, ProfileRelay &, ProfileRelay &) {
        opened = control.invoke(QStringLiteral("browser_new_tab"), {});
        status = control.connectionVersions();
      }));
  QVERIFY2(!opened.is_error, qPrintable(opened.text));
  QCOMPARE(older.seen().filter(QStringLiteral("newTab")).size(), 0);
  QCOMPARE(personal.seen().filter(QStringLiteral("newTab")).size(), 1);
  QStringList names;
  for (const QJsonValue &entry :
       status.value(QStringLiteral("profiles")).toArray()) {
    names << entry.toObject().value(QStringLiteral("name")).toString();
  }
  names.sort();
  QCOMPARE(names, (QStringList{QStringLiteral("personal"),
                               QStringLiteral("unnamed")}));
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

  // No server named: the extension has no work for this port, because every
  // server already has one of its ports. Connecting it to the newest would
  // give that server a second connection of the same profile -- one that
  // answers for the first's tabs and then goes away -- so nothing is returned.
  QVERIFY(
      chrome_control_mcp::selectRendezvousRecord(records, QString{}).isEmpty());

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

// A single look can call a busy pipe closed: the pump drains it between the
// look finding it readable and asking how many bytes wait. Ending the relay on
// that killed live sessions mid-upload, so a look has to repeat.
void BrowserBridgeRelayTests::browserPresence_oneClosedLookEndsNothing() {
  chrome_control_mcp::BrowserExitConfirmation confirmation;
  // A misread between ordinary looks ends nothing, and is forgotten.
  QVERIFY(!confirmation.observe(false));
  QVERIFY(!confirmation.observe(true));
  QVERIFY(!confirmation.observe(false));
  for (int look = 1; look < chrome_control_mcp::kBrowserExitConfirmPolls;
       ++look) {
    QVERIFY(!confirmation.observe(true));
  }
  QVERIFY(!confirmation.observe(false));
  // A pipe that stays closed is believed, after the looks it takes.
  for (int look = 1; look < chrome_control_mcp::kBrowserExitConfirmPolls;
       ++look) {
    QVERIFY(!confirmation.observe(true));
  }
  QVERIFY(confirmation.observe(true));
  QVERIFY(chrome_control_mcp::kBrowserExitConfirmPolls >= 2);
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
