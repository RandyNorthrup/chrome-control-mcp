// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/native_ipc.h"
#include "chrome_control_mcp/native_messaging.h"

#include <QHash>
#include <QJsonObject>
#include <QString>

#include <condition_variable>
#include <mutex>
#include <thread>

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
inline constexpr int kBrowserBridgeDefaultIoTimeoutMs = 30'000;

/// Whether a DIFFERENT, still-running process of this same program owns the
/// bridge described by the rendezvous record at @p rendezvous_path.
///
/// False when the record is absent, when it names this process, or when its
/// pid has exited or now resolves to a foreign image. A record a crashed server
/// left behind is therefore taken over rather than treated as an owner that
/// will never release it, and a stale or forged record whose pid has since been
/// reused by some other program does not get to keep the bridge hostage.
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
        kBrowserBridgeDefaultIoTimeoutMs}; ///< Per read/write deadline.
    QString rendezvous_path; ///< Empty -> the real per-user location.
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

  /// True while a verified relay is connected.
  [[nodiscard]] bool clientConnected() const;

  /// Increments on every newly verified relay connection. The MCP dispatch
  /// compares it against the last value it saw to detect a fresh browser
  /// session.
  [[nodiscard]] quint64 connectionGeneration() const;

  /// Send one command frame and block for the correlated reply. Call from a
  /// single thread only (the MCP thread); the server serves one op at a time.
  /// Returns ok == false with a reason when no relay is connected, on a
  /// deadline (the connection is reset), or on a framing error.
  [[nodiscard]] Exchange sendCommandAwaitReply(const QJsonObject &frame);

  [[nodiscard]] QString pipeName() const { return pipe_name_; }
  [[nodiscard]] QString token() const { return token_; }

private:
  // Create the named pipe + shutdown event and publish the rendezvous record.
  // Sets pipe_, shutdown_event_, token_ on success; on any failure frees
  // whatever it created and returns false with @p error set. Extracted from
  // start() so its lifecycle guard stays small.
  [[nodiscard]] bool createPipeResources(QString *error);
  void run();
  bool handshake();
  void serveConnected();
  bool verifyPeer(QString *why) const;

  Options options_;
  QString pipe_name_;
  QString token_;
  QString rendezvous_path_;
  QString rendezvous_error_; ///< Why rendezvous_path_ is empty, when it is.

#ifdef Q_OS_WIN
  NativeIpcHandle pipe_{kInvalidNativeIpcHandle};
  void *shutdown_event_{nullptr};
#else
  int listener_fd_{-1};
  int connection_fd_{-1};
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
  bool connected_{false};
  quint64 generation_{0};

  // Single in-flight command slot handed from the MCP thread to the I/O thread.
  bool has_request_{false};
  bool has_response_{false};
  QJsonObject request_frame_;
  Exchange response_;
};

} // namespace chrome_control_mcp
