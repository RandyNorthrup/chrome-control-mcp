// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/native_ipc.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QHash>
#include <QList>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>

#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

/// @file browser_bridge_pipe.h
/// @brief The browser-control bridge pipe SERVER, hosted in the long-lived MCP
/// process (the authority end).
///
/// It owns the hardened named pipe (see browser_bridge_security), publishes the
/// rendezvous record, and runs one dedicated I/O thread that: waits for the
/// Chrome-spawned relay to connect, verifies the peer by code identity (the
/// client must be our own executable and, in production, launched by Chrome),
/// completes a token/protocol handshake, then serves exactly one browser
/// command at a time from the MCP thread over overlapped, deadline-bounded
/// reads/writes. All pipe-handle I/O lives on that single thread, so there are
/// no cross-thread handle races; the MCP thread hands a command frame across
/// and waits for the reply.
///
/// The server is deliberately decoupled from BrowserBridgeSession: it exposes a
/// monotonically increasing connection generation instead of calling the
/// (single- threaded) session directly, so the MCP dispatch can observe a fresh
/// relay and drive onHostConnected/onHostDisconnected on its own thread.
namespace chrome_control_mcp {

/// Default per read/write deadline for a bridge exchange, in milliseconds.
///
/// This is a SILENCE budget, not a work budget. An extension handling a command
/// says so every few seconds, and each beat restarts this deadline -- so a
/// download that legitimately runs for two minutes stays connected while an
/// extension that has actually stopped answering still fails in thirty seconds.
inline constexpr int kBrowserBridgeDefaultIoTimeoutMs = 30'000;

/// The absolute ceiling on one exchange, however lively the extension is.
///
/// Above the longest budget any handler is allowed to take (browser_download
/// polls to 120 s), with headroom for the page it is waiting on. Past this the
/// command is abandoned even though beats are still arriving: a handler running
/// this long is not going to finish, and the alternative is an MCP call that
/// never returns.
inline constexpr int kBrowserBridgeMaxExchangeMs = 180'000;

/// How often, in milliseconds, the server looks at an IDLE connection to see
/// whether its relay is still there.
///
/// The relay speaks on the pipe only to answer a command, so between commands
/// the server had nothing to read and never looked. A relay that died there --
/// Chrome restarting, the extension reloading, both routine -- left the server
/// holding its single pipe instance as "connected" until the next command
/// happened to fail, and every relay Chrome started meanwhile was refused with
/// ERROR_PIPE_BUSY. Observed live on Windows: a server started the previous day
/// had been unreachable all day. Short enough that the next relay is admitted
/// well inside the extension's 2 s retry; long enough that an idle server costs
/// nothing measurable.
inline constexpr int kBrowserBridgeIdlePeerCheckMs = 250;

/// Whether a DIFFERENT, still-running process of this same program owns the
/// bridge described by the rendezvous record at @p rendezvous_path.
///
/// False when the record is absent, when it names this process, or when its
/// pid has exited or now resolves to a foreign image. A record a crashed server
/// left behind is therefore taken over rather than treated as an owner that
/// will never release it, and a stale or forged record whose pid has since been
/// reused by some other program does not get to keep the bridge hostage. The
/// relay asks the same question to decide which records are worth offering the
/// extension, since a record outlives a server that crashed.
///
/// Platform-specific, because identifying the program behind a pid is; the
/// callers are not.
[[nodiscard]] bool liveBridgeOwnerExists(const QString &rendezvous_path);

/// Delete rendezvous records left behind by servers that are gone: a pid that
/// has exited, or one that now resolves to a different program after reuse.
/// Never touches @p own_path, and never touches a record naming a live instance
/// of this program -- that one is its owner's to remove.
///
/// With one shared record a dead server's entry was simply overwritten by the
/// next one, so nothing ever had to be cleaned up. Per-pid records accumulate
/// instead, and a directory filling with dead servers would eventually be what
/// a relay has to search. Returns the number removed.
int sweepStaleRendezvousRecords(const QString &own_path);

/// Climb at most @p max_depth links of the child->parent map @p parent from
/// @p pid, and report whether any ancestor's lowercased image name (looked up
/// in @p image) equals @p target_basename_lower. Pure, and bounded so a cyclic
/// or malformed map terminates rather than spinning.
///
/// This is the check behind `require_chrome_ancestor`: binding the peer to a
/// Chrome-launched process is defence in depth over the handshake token.
/// Windows drives it from a Toolhelp snapshot, which hands over the whole
/// process table at once; POSIX has no such snapshot and climbs one step at a
/// time, so there this is exercised by its tests rather than by the walk.
[[nodiscard]] bool
ancestorChainContainsImage(quint64 pid, const QHash<quint64, quint64> &parent,
                           const QHash<quint64, QString> &image,
                           const QString &target_basename_lower, int max_depth);

/// The same walk, returning the nearest such ancestor's pid, or 0. For a relay
/// that is the Chrome browser process that started it, which is how the server
/// tells one Chrome's profiles from another Chrome's.
[[nodiscard]] quint64
nearestAncestorWithImage(quint64 pid, const QHash<quint64, quint64> &parent,
                         const QHash<quint64, QString> &image,
                         const QString &target_basename_lower, int max_depth);

/// What a bridge connection says about its far ends, as the relay passes it on
/// in its hello: the running extension's manifest version, and the relay's own
/// version, which is the INSTALLED version -- Chrome starts the relay from the
/// native-host registration, and `--install` points that at the installed
/// copy. Before these were exchanged, server and extension compared only the
/// bridge protocol, so after an update that kept it Chrome went on running the
/// old extension and nothing anywhere said so. Empty means not said: a peer
/// older than 1.9.0, or a value that is not a version.
struct BridgePeerVersions {
  QString extension;
  QString installed;
};

/// @p value as a `major.minor.patch` version, or empty when it is anything
/// else. Versions come from peers and end up in text an agent reads, so they
/// are checked here, once, before anything uses them.
[[nodiscard]] QString bridgeVersionOrEmpty(const QJsonValue &value);

/// The versions a relay's hello reports (`extension_version`,
/// `relay_version`), each checked by bridgeVersionOrEmpty.
[[nodiscard]] BridgePeerVersions
peerVersionsFromHello(const QJsonObject &hello);

/// How many relays one server serves at once: one per Chrome profile whose
/// extension reaches it. Chrome gives every profile its own instance of the
/// extension, each with its own relay, and the server once took exactly one --
/// so it bound to whichever profile got there first and refused the rest. The
/// bound keeps anything that can reach the pipe from pinning threads.
inline constexpr int kMaxBridgeConnections = 8;

/// Longest profile name, and longest email, a relay may report.
inline constexpr int kMaxProfileNameChars = 64;
inline constexpr int kMaxProfileEmailChars = 254;

/// The profile a connection serves, as its relay reported it in the hello
/// (`profile_name`, `profile_email`). Both come from the extension and end up
/// in an agent's context, so both are cleaned here: printable characters only,
/// whitespace collapsed, bounded, and the email must look like one. Empty means
/// not said -- an extension or relay older than profile support.
struct BridgePeerProfile {
  QString name;
  QString email;
};

/// @p value as printable text of at most @p max_chars, whitespace collapsed,
/// or empty.
[[nodiscard]] QString bridgeLabelOrEmpty(const QJsonValue &value,
                                         int max_chars);

/// The profile a relay's hello (or an extension's reply) reports.
[[nodiscard]] BridgePeerProfile peerProfileFromJson(const QJsonValue &name,
                                                    const QJsonValue &email);

/// One connection as BrowserBridgePipeServer::connections() describes it.
struct BridgeConnectionInfo {
  /// Given by this server, never reused: a profile that reconnects is a new
  /// connection, and anything known about the old one ends with it.
  quint64 id{0};
  BridgePeerVersions versions;
  BridgePeerProfile profile;
  /// The Chrome process the relay was started by, or 0 when not known (the
  /// Chrome-ancestor check is off, as in tests).
  quint64 browser_pid{0};
};

/// Why a relay from Chrome process @p incoming is refused while connections
/// from @p serving are open, or empty to admit it. Tab and window ids are
/// unique only within one Chrome process, which every profile of one user data
/// directory shares; a relay from another, still-running Chrome is refused.
/// One whose Chrome has exited (@p alive says no) does not count: after a
/// restart the old relays can take a moment to be noticed gone, and the new
/// Chrome is admitted at once rather than refused for that moment. Pure, so the
/// rule is testable without a browser.
[[nodiscard]] QString
otherBrowserRefusal(quint64 incoming, const QList<quint64> &serving,
                    const std::function<bool(quint64)> &alive);

/// Why a relay of version @p relay_version from Chrome process @p incoming is
/// refused while connections from @p serving are open, or empty to admit it. A
/// relay older than 1.10.0 connects even a port of the extension that has no
/// server -- one answering its offer with no session, because every server
/// already has one of its ports -- to the newest server, which took one relay
/// and refused it. Beside another connection of its own Chrome such a relay is
/// refused the same way, so a port with no work never becomes a second
/// profile. Pure, so the rule is testable without a browser.
[[nodiscard]] QString olderRelayRefusal(quint64 incoming,
                                        const QString &relay_version,
                                        const QList<quint64> &serving);

class BrowserBridgePipeServer {
public:
  struct Options {
    /// The bridge protocol version this server offers in its welcome. It
    /// takes the value from its one definition rather than repeating it: a
    /// literal here and a comment claiming the two match is exactly how a
    /// bumped protocol ends up announced on one side only.
    int protocol{kBrowserBridgeProtocol};
    bool require_chrome_ancestor{true}; ///< Production; tests relax this.
    int io_timeout_ms{
        kBrowserBridgeDefaultIoTimeoutMs}; ///< Silence budget per read/write.
    int max_exchange_ms{
        kBrowserBridgeMaxExchangeMs}; ///< Ceiling on one whole exchange.
    QString rendezvous_path;          ///< Empty -> the real per-user location.
  };

  /// The result of one command/reply exchange.
  struct Exchange {
    bool ok{false};
    QJsonObject reply;
    QString error;
  };

  BrowserBridgePipeServer();
  explicit BrowserBridgePipeServer(Options options);
  ~BrowserBridgePipeServer();

  BrowserBridgePipeServer(const BrowserBridgePipeServer &) = delete;
  BrowserBridgePipeServer &operator=(const BrowserBridgePipeServer &) = delete;

  /// Create the hardened pipe, write the rendezvous record, and start the I/O
  /// thread. Returns false (fail-closed) with @p error set if the pipe cannot
  /// be created -- notably if the name already exists (squatting), since it
  /// uses FILE_FLAG_FIRST_PIPE_INSTANCE.
  [[nodiscard]] bool start(QString *error);

  /// Signal shutdown, abort any in-flight I/O, join the thread, close handles,
  /// and remove the rendezvous record. Safe to call more than once.
  void stop();

  /// Make sure the shared rendezvous record still advertises THIS server's
  /// endpoint, re-publishing it when it is missing or names a server that has
  /// exited. Two servers that start within the same instant can both pass the
  /// live-owner check in start(); the one that writes last owns the record,
  /// and when that one is short-lived (a tool listing, a health probe) it takes
  /// the record with it on exit, leaving the long-lived server listening on a
  /// pipe nothing can discover. Called before each browser tool call while no
  /// relay is connected, so the record heals without a restart. Returns false
  /// with @p error set when the server is not running or when another live
  /// server of our own image owns the record (that one keeps the browser).
  [[nodiscard]] bool ensurePublished(QString *error);

  /// True while at least one verified relay is connected.
  [[nodiscard]] bool clientConnected() const;

  /// Increments on every newly verified relay connection. The MCP dispatch
  /// compares it against the last value it saw to detect a fresh browser
  /// session.
  [[nodiscard]] quint64 connectionGeneration() const;

  /// What the newest connected relay reported about the extension and the
  /// installed copy (see BridgePeerVersions) -- with one profile, the
  /// connection's. Set in the same step that admits a connection, so a caller
  /// that sees a new generation sees its versions; empty while nothing is
  /// connected.
  [[nodiscard]] BridgePeerVersions peerVersions() const;

  /// Every connection being served, oldest first.
  [[nodiscard]] QList<BridgeConnectionInfo> connections() const;

  /// Send one command frame to the newest connection and block for the
  /// correlated reply -- with one profile, to the connection. Call from a
  /// single thread only (the MCP thread); the server serves one op at a time.
  /// Returns ok == false with a reason when no relay is connected, on a
  /// deadline (the connection is reset), or on a framing error.
  [[nodiscard]] Exchange sendCommandAwaitReply(const QJsonObject &frame);

  /// The same, to the connection @p connection_id (see connections()); a
  /// connection that has gone is reported as not connected.
  [[nodiscard]] Exchange sendCommandAwaitReply(quint64 connection_id,
                                               const QJsonObject &frame);

  [[nodiscard]] QString pipeName() const { return pipe_name_; }
  [[nodiscard]] QString token() const { return token_; }

private:
  // One relay connection: its own handle, thread, and command slot, so a
  // profile's connection arriving, working or leaving touches nothing of
  // another's. Every field but `handle` and `thread` is guarded by mutex_;
  // `handle` is used only by the connection's own thread once admitted.
  struct Connection {
    quint64 id{0};
    NativeIpcHandle handle{kInvalidNativeIpcHandle};
    std::thread thread;
    bool live{false};     ///< Admitted, and its relay not yet known gone.
    bool finished{false}; ///< Its thread has ended; ready to be joined.
    BridgePeerVersions versions;
    BridgePeerProfile profile;
    quint64 browser_pid{0};
    bool has_request{false};
    bool has_response{false};
    QJsonObject request_frame;
    Exchange response;
  };
  using ConnectionPtr = std::shared_ptr<Connection>;

  // Create the named pipe + shutdown event and publish the rendezvous record.
  // Sets pipe_, shutdown_event_, token_ on success; on any failure frees
  // whatever it created and returns false with @p error set. Extracted from
  // start() so its lifecycle guard stays small.
  [[nodiscard]] bool createPipeResources(QString *error);
  // The acceptor: waits for each relay and hands it to a thread of its own,
  // so a slow handshake never holds up the next one.
  void run();
  // A connection's whole life on its own thread: handshake, admission,
  // serving, and the handle closed once it ends.
  void serveConnection(const ConnectionPtr &connection);
  bool handshake(Connection &connection);
  // Serve commands on the verified connection until it ends: an exchange
  // fails, the server stops, or -- looked at every
  // kBrowserBridgeIdlePeerCheckMs while no command is waiting -- the relay has
  // gone or has spoken unprompted.
  void serveConnected(Connection &connection);
  // Read the reply to @p request, reading past the progress beats the extension
  // sends while it is still working. Each beat restarts the silence budget;
  // max_exchange_ms bounds the whole wait regardless. False with @p why set
  // when either budget is spent, saying WHICH -- silence and a command that ran
  // too long are different faults and want different answers from the caller.
  [[nodiscard]] bool awaitReply(NativeIpcHandle handle,
                                const QJsonObject &request, QJsonObject *reply,
                                QString *why);
  // Verifies the peer on @p handle and, when the Chrome-ancestor check is on,
  // says which Chrome process started it.
  bool verifyPeer(NativeIpcHandle handle, quint64 *browser_pid,
                  QString *why) const;
  // Under mutex_: why @p connection may not be admitted now (the bound, or
  // another Chrome), or empty -- in which case it is admitted.
  [[nodiscard]] QString admit(const ConnectionPtr &connection);
  // Under mutex_: the newest live connection, or null.
  [[nodiscard]] ConnectionPtr newestLive() const;
  // Join and forget connections whose threads have ended. Not under mutex_.
  void reapFinished();
  // Whether process @p pid is still running; per platform.
  static bool browserProcessAlive(quint64 pid);

  Options options_;
  QString pipe_name_;
  QString token_;
  QString rendezvous_path_;
  QString rendezvous_error_; ///< Why rendezvous_path_ is empty, when it is.

#ifdef Q_OS_WIN
  // The instance waiting for the next relay; a connected one moves to its
  // Connection and a fresh instance takes its place.
  NativeIpcHandle pipe_{kInvalidNativeIpcHandle};
  void *shutdown_event_{nullptr};
#else
  int listener_fd_{-1};
  int shutdown_pipe_[2]{-1, -1};
#endif
  std::thread thread_;
  // Serializes start()/stop() so a concurrent stop() (or the destructor) BLOCKS
  // until an in-progress teardown finishes, and so start() never move-assigns
  // over a joinable thread. stop_done_ makes stop() idempotent WITHIN a
  // start/stop cycle while start() re-arms it, so a start -> stop -> start
  // sequence tears down each cycle (the old std::once_flag fired once for the
  // object's whole life, disabling every later stop()).
  std::mutex lifecycle_mutex_;
  bool stop_done_{
      true}; // true until start() arms a cycle: a pre-start stop() is a no-op

  mutable std::mutex mutex_;
  std::condition_variable cv_;
  bool running_{false};
  quint64 generation_{0};
  quint64 next_connection_id_{0};
  // Every connection with a thread, admitted or not yet, oldest first.
  std::vector<ConnectionPtr> connections_;
};

} // namespace chrome_control_mcp
