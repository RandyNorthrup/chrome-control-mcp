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

#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/browser_bridge_security.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/error_out.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QByteArray>
#include <QJsonArray>
#include <QSet>
#include <QStringList>
#include <QtEndian>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>

namespace chrome_control_mcp {
namespace {

// How long the exit path waits for the stdout lock before leaving without its
// flush. Every frame is written and flushed whole under that lock, so a writer
// that holds it longer than this is wedged in a write nobody will read -- and
// waiting on it would strand the very process the exit path exists to end.
constexpr int kExitFlushLockBudgetMs = 1000;

// The one lock every frame written to Chrome is written under. The pump, the
// cancel it forwards, the server watcher and the exit path's flush run on
// different threads, and two frames interleaved on stdout are not two frames:
// Chrome reads a length prefix out of the middle of a body and kills the host.
//
// Timed, so the exit path can give up on a wedged writer. Never destroyed: the
// exit watcher is a detached thread that may still reach for it while static
// destructors run after the relay returns.
std::timed_mutex &stdoutLock() {
  static auto *const lock = new std::timed_mutex;
  return *lock;
}

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
  // Held across the write AND the flush, so a frame leaves whole before the
  // next one starts and the exit path never flushes half of one.
  const std::lock_guard<std::timed_mutex> lock(stdoutLock());
  const size_t written = std::fwrite(frame.constData(), 1,
                                     static_cast<size_t>(frame.size()), stdout);
  // A short write OR a failed flush means the frame did not reach Chrome
  // intact; report it so relayPumpOnce tears the pipe down instead of treating
  // a lost reply as delivered.
  return written == static_cast<size_t>(frame.size()) &&
         std::fflush(stdout) == 0;
}

// Wait for the extension's answer to `bridge_offers`, giving up after
// @p timeout_ms and filling @p wanted with the session it named.
//
// The read runs on its own thread because a blocking std::cin.read cannot be
// cancelled: on timeout the thread is ABANDONED rather than joined, and its
// buffer is kept alive by the shared state it owns, so nothing it may still
// write into has been destroyed. That is only safe because the sole caller
// exits the process immediately afterwards -- the fields the thread writes are
// never read on this path.
// The extension's answer to the offer: which server it wants, and -- from 1.9.0
// on -- its own manifest version, and from 1.10.0 its Chrome profile, which
// travel on to that server.
bool awaitAttachSession(int timeout_ms, QString *wanted,
                        QString *extension_version,
                        BridgePeerProfile *profile) {
  struct Pending {
    std::atomic<bool> done{false};
    bool ok{false};
    QJsonObject frame;
  };
  const auto pending = std::make_shared<Pending>();
  std::thread reader([pending] {
    pending->ok = readStdinFrame(&pending->frame);
    pending->done.store(true, std::memory_order_release);
  });

  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (!pending->done.load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (!pending->done.load(std::memory_order_acquire)) {
    reader.detach();
    return false;
  }
  reader.join();
  if (!pending->ok || pending->frame.value(QStringLiteral("type")).toString() !=
                          QLatin1String("attach_session")) {
    // Anything other than the answer to the question just asked leaves the
    // stream out of step; there is no way back to a known state from here.
    return false;
  }
  *wanted = pending->frame.value(QStringLiteral("session")).toString();
  *extension_version =
      bridgeVersionOrEmpty(pending->frame.value(QStringLiteral("version")));
  *profile = peerProfileFromJson(
      pending->frame.value(QStringLiteral("profile_name")),
      pending->frame.value(QStringLiteral("profile_email")));
  return true;
}

} // namespace

QString selectRendezvousRecord(const QStringList &records,
                               const QString &wanted) {
  if (records.isEmpty()) {
    return {};
  }
  if (wanted.isEmpty()) {
    // No server named: the extension has no work for this port -- every
    // server it was offered already has one of its ports. Connecting it to
    // the newest anyway would hand that server a second connection of the
    // same profile that answers for the first's tabs and then goes away.
    return {};
  }
  const auto match = std::find_if(
      records.cbegin(), records.cend(), [&wanted](const QString &record) {
        return QString::number(rendezvousRecordPid(record)) == wanted;
      });
  if (match != records.cend()) {
    return *match;
  }
  // The server it asked for is gone. Connecting to a different one would bind
  // the extension's session to a server it did not choose, which is worse than
  // reporting that the bridge is unavailable.
  return {};
}

QStringList liveRendezvousRecords(const QStringList &records) {
  QStringList live;
  // The same question the server's sweep asks of each record -- a different,
  // still-running process of this program -- so the relay and the server can
  // never disagree about which records are somebody's.
  std::copy_if(
      records.cbegin(), records.cend(), std::back_inserter(live),
      [](const QString &record) { return liveBridgeOwnerExists(record); });
  return live;
}

QStringList rendezvousServerIds(const QStringList &records) {
  QStringList ids;
  ids.reserve(records.size());
  for (const QString &record : records) {
    const qint64 pid = rendezvousRecordPid(record);
    if (pid != 0) {
      ids.append(QString::number(pid));
    }
  }
  return ids;
}

BridgeServerWatcher::BridgeServerWatcher(QStringList offered, ListFn list_live,
                                         BrowserWriteFn write, int interval_ms)
    : reported_(std::move(offered)), list_live_(std::move(list_live)),
      write_(std::move(write)), interval_ms_(interval_ms) {
  thread_ = std::thread([this] { run(); });
}

BridgeServerWatcher::~BridgeServerWatcher() { stop(); }

void BridgeServerWatcher::stop() {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) {
    thread_.join();
  }
}

void BridgeServerWatcher::run() {
  std::unique_lock<std::mutex> lock(mutex_);
  while (!cv_.wait_for(lock, std::chrono::milliseconds(interval_ms_),
                       [this] { return stopping_; })) {
    // Listing reads a file per record and asks the OS about each pid; none of
    // that needs the lock, and stop() should not have to wait behind it.
    lock.unlock();
    const QStringList live = list_live_();
    const bool changed = QSet<QString>(live.cbegin(), live.cend()) !=
                         QSet<QString>(reported_.cbegin(), reported_.cend());
    bool sink_open = true;
    if (changed) {
      sink_open = write_(QJsonObject{
          {QStringLiteral("type"), QStringLiteral("bridge_servers")},
          {QStringLiteral("servers"), QJsonArray::fromStringList(live)}});
      if (sink_open) {
        reported_ = live;
      }
    }
    lock.lock();
    if (!sink_open) {
      // stdout is gone, so Chrome is too; the exit watcher ends the process.
      // Listing on into a closed pipe would only spin.
      return;
    }
  }
}

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
                    QString *error, const BridgePeerVersions &versions,
                    QString *server_version, const BridgePeerProfile &profile) {
  QJsonObject hello{{QStringLiteral("type"), QStringLiteral("hello")},
                    {QStringLiteral("token"), token},
                    {QStringLiteral("protocol"), protocol}};
  if (!versions.extension.isEmpty()) {
    hello.insert(QStringLiteral("extension_version"), versions.extension);
  }
  if (!versions.installed.isEmpty()) {
    hello.insert(QStringLiteral("relay_version"), versions.installed);
  }
  if (!profile.name.isEmpty()) {
    hello.insert(QStringLiteral("profile_name"), profile.name);
  }
  if (!profile.email.isEmpty()) {
    hello.insert(QStringLiteral("profile_email"), profile.email);
  }
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
  if (server_version != nullptr) {
    *server_version =
        bridgeVersionOrEmpty(welcome.value(QStringLiteral("version")));
  }
  return true;
}

bool relayFrameIsProgress(const QJsonObject &frame) {
  return frame.value(QStringLiteral("type")).toString() ==
         QLatin1String("progress");
}

bool readBrowserReplyPastProgress(const BrowserReadFn &browser_read,
                                  RelayProgressQueue *progress,
                                  QJsonObject *reply) {
  for (;;) {
    QJsonObject frame;
    if (!browser_read(&frame)) {
      return false;
    }
    if (!relayFrameIsProgress(frame)) {
      *reply = frame;
      return true;
    }
    const std::lock_guard<std::mutex> lock(progress->m_mutex);
    if (++progress->m_seen > kMaxProgressFramesPerExchange) {
      return false;
    }
    progress->m_frames.push_back(frame);
  }
}

bool drainProgressToPipe(NativeIpcHandle pipe, RelayProgressQueue *progress) {
  std::vector<QJsonObject> beats;
  {
    // Taken under the lock and written outside it: a pipe write can block, and
    // holding the lock across one would stall the thread reading the reply.
    const std::lock_guard<std::mutex> lock(progress->m_mutex);
    beats.swap(progress->m_frames);
  }
  // all_of stops at the first false, so this is the loop it replaces: oldest
  // beat first, and the first write the pipe refuses ends the drain.
  return std::all_of(beats.cbegin(), beats.cend(),
                     [pipe](const QJsonObject &beat) {
                       return relayWritePipeFrame(pipe, beat);
                     });
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

void watchForBrowserExit() {
  std::thread([] {
    const NativeIpcHandle input = browserStdInHandle();
    BrowserExitConfirmation confirmation;
    for (;;) {
      std::this_thread::sleep_for(
          std::chrono::milliseconds(kBrowserPresencePollMs));
      if (confirmation.observe(browserInputClosed(input))) {
        // Flush what is already buffered, then leave without unwinding: the
        // pump thread may be mid-write on the pipe, and running static
        // destructors underneath it is the one way this could turn a clean
        // exit into a crash. The server sees its client drop, which is exactly
        // what happened.
        //
        // The flush is taken under the stdout lock so it cannot land inside a
        // frame another thread is writing, and the lock is never released --
        // nothing should start a frame on the way out. It is waited for only
        // briefly: a writer that holds it longer is wedged on a pipe nobody
        // reads, it has nothing worth flushing, and waiting on it would leave
        // this process holding the server's pipe.
        if (stdoutLock().try_lock_for(
                std::chrono::milliseconds(kExitFlushLockBudgetMs))) {
          static_cast<void>(std::fflush(nullptr));
        }
        std::_Exit(0);
      }
    }
  }).detach();
}

namespace {

// The live servers' ids as the watcher reports them. A listing that fails
// reads as none; the rendezvous directory is fixed for the life of the
// process, so that is a failure the offer met too, and the set it reports
// matches the one already offered rather than flapping.
QStringList liveServerIds() {
  QString ignored;
  return rendezvousServerIds(
      liveRendezvousRecords(browserBridgeRendezvousRecords(&ignored)));
}

} // namespace

int runBrowserRelay() {
  // Armed before anything else. The pump is where an unnoticed Chrome is
  // fatal -- that read blocks forever -- but every earlier phase can strand a
  // process too, and there is no phase in which carrying on without a browser
  // is the right answer.
  watchForBrowserExit();
  QString token;
  int protocol = 0;
  QString error;
  // Records are per-server, so the relay does not compute one path: it lists
  // what is published and offers that list to the extension, which picks. The
  // relay speaks first on this hop -- as it already does with bridge_ready --
  // because the extension has no filesystem access and so has no pid to name
  // until it is told one.
  //
  // Only servers that are still running. A crashed server's record stays on
  // disk until another server starts and sweeps it, and the extension picks
  // from this list without any way to tell the dead from the living.
  const QStringList records =
      liveRendezvousRecords(browserBridgeRendezvousRecords(&error));
  const QStringList offered = rendezvousServerIds(records);
  (void)writeStdoutFrame(QJsonObject{
      {QStringLiteral("type"), QStringLiteral("bridge_offers")},
      {QStringLiteral("protocol"), kBrowserBridgeProtocol},
      {QStringLiteral("servers"), QJsonArray::fromStringList(offered)}});

  QString wanted;
  QString extension_version;
  BridgePeerProfile profile;
  if (!awaitAttachSession(kRelayAttachTimeoutMs, &wanted, &extension_version,
                          &profile)) {
    // An extension older than this relay treats the offer as an unknown frame
    // type and never answers. The protocol version is never exchanged on this
    // path, so the message has to carry the diagnosis itself.
    (void)writeStdoutFrame(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("bridge_unavailable")},
        {QStringLiteral("error"),
         QStringLiteral("The Chrome Control MCP extension did not answer the "
                        "bridge offer within %1 ms. It is older than this "
                        "server; reload it from the managed install.")
             .arg(kRelayAttachTimeoutMs)}});
    return 0;
  }

  const QString chosen = selectRendezvousRecord(records, wanted);
  NativeIpcHandle pipe = kInvalidNativeIpcHandle;
  if (!chosen.isEmpty()) {
    pipe = relayConnect(chosen, &token, &protocol, &error);
  }
  if (!nativeIpcHandleIsValid(pipe) && error.isEmpty()) {
    if (records.isEmpty()) {
      error = QStringLiteral("No running Chrome Control MCP server has "
                             "published a bridge record.");
    } else if (wanted.isEmpty()) {
      error = QStringLiteral("Every running Chrome Control MCP server already "
                             "has a connection from this extension; this port "
                             "has none to attach to.");
    } else {
      error = QStringLiteral("The Chrome Control MCP server the extension "
                             "asked for (%1) is no longer published.")
                  .arg(wanted);
    }
  }
  // This relay is the program Chrome starts from the installed copy, so its
  // version is the installed version: the server compares it with its own and
  // with the extension's, and the extension with its manifest.
  const QString installed = QString::fromLatin1(kBrowserExtensionVersion);
  if (!nativeIpcHandleIsValid(pipe) ||
      !relayHandshake(pipe, token, protocol, &error,
                      {.extension = extension_version, .installed = installed},
                      nullptr, profile)) {
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
                  {QStringLiteral("protocol"), protocol},
                  {QStringLiteral("version"), installed}});
  const BrowserReadFn reader = [](QJsonObject *out) {
    return readStdinFrame(out);
  };
  const BrowserWriteFn writer = [](const QJsonObject &message) {
    return writeStdoutFrame(message);
  };
  // Started only now: before bridge_ready the extension is still choosing from
  // the offer, and a second list arriving then would be one more thing for it
  // to reconcile for nothing. It writes through the same writer as the pump,
  // so its frames take the same lock.
  BridgeServerWatcher watcher(offered, liveServerIds, writer);
  while (relayPumpOnce(pipe, reader, writer)) {
    // keep pumping until either side closes
  }
  // The pipe first: the watcher never touches it, and the server should get
  // its endpoint back even if joining the watcher has to wait out a write.
  closeNativeIpcHandle(pipe);
  watcher.stop();
  return 0;
}

} // namespace chrome_control_mcp
