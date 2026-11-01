// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/browser_bridge_pipe.h"
#include "chrome_control_mcp/native_ipc.h"

#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

/// @file browser_bridge_relay.h
/// @brief The browser-control bridge RELAY, hosted in the Chrome-spawned native
/// messaging process (the client end of the bridge pipe).
///
/// Topology (settled by the design panel): the long-lived MCP process owns the
/// browser authority (BrowserBridgeSession + BrowserBridgePipeServer); THIS
/// process is a thin, id-transparent relay. Chrome launches it as a native
/// messaging host, so it cannot receive the pipe name on argv -- it discovers
/// the server through the rendezvous record, connects to the hardened pipe as
/// an IDENTIFICATION-level client, verifies the SERVER by code identity (the
/// record's pid must resolve to our own executable, so a squatted record cannot
/// redirect us to a foreign process), and completes the token/protocol
/// handshake. Thereafter it pumps whole native-messaging frames between
/// Chrome's stdio and the pipe with no parsing or correlation: a command from
/// the server goes to the extension over stdout, and the extension's reply
/// comes back over stdin to the server. All correlation, id minting, and
/// ref_index state live in the MCP process, so the relay can die and be
/// relaunched by Chrome at any time without losing browser state.
///
/// This phase is strictly request/reply (the extension speaks only in response
/// to a forwarded command), which is why a single-threaded alternating pump is
/// correct and matches the server's one-op-outstanding read-after-write model.
/// An event channel (for unsolicited detach/navigation notices) is a later
/// unit.
namespace chrome_control_mcp {

/// Read one whole native-messaging frame (a JSON object) from the browser side,
/// or return false at end-of-stream / on a framing error. Injected so the pump
/// is testable without real stdio.
using BrowserReadFn = std::function<bool(QJsonObject *)>;

/// Write one whole native-messaging frame (a JSON object) to the browser side,
/// or return false if the sink is closed.
using BrowserWriteFn = std::function<bool(const QJsonObject &)>;

/// Fill @p size bytes at @p buffer, or return false once the source closes or
/// errors. Injected so one frame decoder serves the pipe, the socket, and
/// stdin.
using ReadExactFn = std::function<bool(char *buffer, qsizetype size)>;

/// Decode one frame whose 4-byte length prefix has already been read into
/// @p length, pulling the body through @p read_exact. Every reader in the relay
/// -- pipe, socket, stdin, on either platform -- ends in this, so the length
/// check and the JSON validation have one implementation.
[[nodiscard]] bool readFrameBody(const ReadExactFn &read_exact, quint32 length,
                                 QJsonObject *out);

/// How long the relay waits for the extension to answer `bridge_offers` before
/// giving up. The answer arrives as fast as the service worker can post it, so
/// this is not a latency budget -- it is the bound that keeps a worker which
/// will NEVER answer (one older than this relay, which treats the offer as an
/// unknown frame type) from hanging the host forever.
inline constexpr int kRelayAttachTimeoutMs = 5000;

/// Choose which rendezvous record to connect to, given the records available
/// (@p records, newest first) and the session the extension asked for
/// (@p wanted, a pid as a string).
///
/// An empty @p wanted means the extension has no work for this port -- every
/// server it was offered already has one of its ports -- and yields an empty
/// string: the relay connects nowhere and reports the bridge unavailable, which
/// the extension takes as "nothing to retry for". A @p wanted naming a record
/// that is not in the list
/// yields an empty string: the server it asked for is gone, and connecting to a
/// different one instead would attach the extension's session to a server it
/// did not choose. Pure, so the rule is testable without a relay.
[[nodiscard]] QString selectRendezvousRecord(const QStringList &records,
                                             const QString &wanted);

/// The records among @p records whose server is still running as an instance
/// of this program, in the order given (newest first, as the listing returns
/// them).
///
/// A listing is of FILES, and a server that crashes leaves its file behind:
/// the sweep that removes such records runs only when a server starts. Offered
/// one, the extension can choose a pid that will never answer, and that port is
/// spent on a connection that cannot be made. A record that cannot be read, or
/// that names this very process -- a relay is never a server -- is left out
/// too.
[[nodiscard]] QStringList liveRendezvousRecords(const QStringList &records);

/// The ids the extension is offered for @p records: each record's pid as a
/// string, in the same order. A path not named like a record is skipped. Pure.
[[nodiscard]] QStringList rendezvousServerIds(const QStringList &records);

/// How often, in milliseconds, a pumping relay lists the live servers again
/// to see whether the set has changed.
inline constexpr int kRelayServerWatchMs = 1000;

/// Tells the extension, while the relay pumps, whenever the set of live
/// servers changes: `{"type":"bridge_servers","servers":["<pid>", ...]}`,
/// newest first, written through @p write.
///
/// A relay offers its list once, when it connects. A server that started
/// afterwards -- a second editor opening -- was therefore found only when the
/// extension's 30 s alarm next opened a port to ask, so the new window waited
/// up to half a minute for a browser that was already there. Listing again
/// every @p interval_ms on this thread cuts that to about a second.
///
/// "Changed" is a change of SET, measured against the last set reported, which
/// starts as the list the extension was offered. Order alone is not news: a
/// server re-publishing its record moves it to the front of the listing
/// without anything having started or stopped.
///
/// The frame runs relay -> extension only and asks for no answer. An extension
/// older than the frame logs an unexpected type and carries on, so it is safe
/// in that skew; and nothing is added to the extension -> relay direction,
/// where an unprompted frame would be read as the reply to a command. @p write
/// must be safe to call alongside the pump's own writes -- in the relay every
/// stdout write takes one lock -- and once it fails (stdout is gone) the
/// watcher stops.
class BridgeServerWatcher {
public:
  /// The live servers' ids right now, newest first.
  using ListFn = std::function<QStringList()>;

  BridgeServerWatcher(QStringList offered, ListFn list_live,
                      BrowserWriteFn write,
                      int interval_ms = kRelayServerWatchMs);
  ~BridgeServerWatcher();

  BridgeServerWatcher(const BridgeServerWatcher &) = delete;
  BridgeServerWatcher &operator=(const BridgeServerWatcher &) = delete;
  BridgeServerWatcher(BridgeServerWatcher &&) = delete;
  BridgeServerWatcher &operator=(BridgeServerWatcher &&) = delete;

  /// Stop listing and join the thread. Prompt whatever the interval, because
  /// the relay joins this on its way out and a relay that lingers holds the
  /// server's pipe. Call from the owning thread; a second call does nothing.
  void stop();

private:
  void run();

  QStringList reported_; ///< Touched only by the watcher thread once started.
  ListFn list_live_;
  BrowserWriteFn write_;
  int interval_ms_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool stopping_{false};
  std::thread thread_; ///< Last, so it starts after everything it reads.
};

/// The beats an extension sends while a command it was given is still
/// running, waiting to be written to the pipe by the thread that owns it.
///
/// They cross a thread boundary because the two handles have one owner each:
/// the reply thread is the only code that reads Chrome's stdout, and the pump
/// thread is the only code that touches the pipe. A beat read by the first and
/// written by the second has to be handed over, and this is the handover.
struct RelayProgressQueue {
  std::mutex m_mutex;
  std::vector<QJsonObject> m_frames;
  /// Beats seen on this exchange, capped so an extension that emits nothing
  /// else cannot keep the reply thread reading forever.
  int m_seen{0};
};

/// The most beats one exchange may carry before the relay stops believing it.
/// The server's absolute cap ends a genuine exchange long before this; anything
/// past it is a stream that is never going to become a reply.
inline constexpr int kMaxProgressFramesPerExchange = 4096;

/// Whether @p frame is a progress beat rather than a reply.
[[nodiscard]] bool relayFrameIsProgress(const QJsonObject &frame);

/// Read frames from the browser until one arrives that is NOT a progress beat,
/// which is the reply; beats are queued on @p progress for the pump thread to
/// forward. False at end-of-stream, on a framing error, or once a single
/// exchange has produced more beats than kMaxProgressFramesPerExchange.
[[nodiscard]] bool
readBrowserReplyPastProgress(const BrowserReadFn &browser_read,
                             RelayProgressQueue *progress, QJsonObject *reply);

/// Write every beat queued so far to @p pipe, oldest first. False if the pipe
/// rejected one, which the caller treats exactly as it treats any other pipe
/// failure. Called only on the thread that owns @p pipe.
[[nodiscard]] bool drainProgressToPipe(NativeIpcHandle pipe,
                                       RelayProgressQueue *progress);

/// Wait for the browser's reply to a command already forwarded, while staying
/// able to see a `cancel` the server sends mid-exchange and pass it on, and to
/// forward the beats the extension sends while it is still working.
///
/// The server abandons an exchange when its own I/O deadline elapses. A handler
/// that POLLS -- browser_wait_for, browser_download -- does not stop when that
/// happens: it keeps driving the page for as long as ITS timeout allows,
/// because a strictly synchronous pump is parked in the extension read and
/// cannot notice anything arriving on the pipe. Forwarding the cancel is what
/// stops it.
///
/// Ownership is split so no handle has two users: the reply thread is the only
/// code that touches stdin, and the calling thread is the only code that
/// touches @p pipe (and the only caller of @p browser_write). That is what
/// makes this safe without cancelling I/O on a synchronous handle. The reply
/// thread is ALWAYS joined -- an early return that abandoned a thread still
/// reading stdin would leave it writing into a destroyed frame.
///
/// Platform-specific only because watching a named pipe and watching a socket
/// for readable bytes have nothing in common; the pump around it does not.
/// Returns false when either side went away, or when the server sent anything
/// but a cancel mid-exchange (which would desynchronize the one-op pump).
[[nodiscard]] bool awaitBrowserReply(NativeIpcHandle pipe,
                                     const BrowserReadFn &browser_read,
                                     const BrowserWriteFn &browser_write,
                                     QJsonObject *reply);

/// Connect to the bridge server described by the rendezvous record at @p
/// rendezvous_path: read the record, verify the recorded pid resolves to OUR
/// OWN executable image (fail closed on a foreign or missing process, so a
/// rewritten record cannot redirect the relay), then open the pipe as an
/// IDENTIFICATION-level client. On success returns a valid handle and fills @p
/// token_out / @p protocol_out for the handshake; on failure returns
/// kInvalidNativeIpcHandle with @p error set. The caller owns the returned
/// handle and must close it with closeNativeIpcHandle().
[[nodiscard]] NativeIpcHandle relayConnect(const QString &rendezvous_path,
                                           QString *token_out,
                                           int *protocol_out, QString *error);

/// Perform the client side of the hello/welcome handshake on an
/// already-connected pipe @p pipe: send `{type:hello, token, protocol}` and
/// require a `welcome` reply carrying the matching protocol. Returns false
/// (with @p error set) if the server rejects the token/protocol or drops the
/// connection.
///
/// The hello also carries @p versions -- the extension's as it reported it,
/// and the relay's own -- as `extension_version` and `relay_version`, each only
/// when known, so a relay that knows neither sends the hello it always did.
/// The server's own version from the welcome lands in @p server_version when
/// given (empty from a server older than 1.9.0). @p profile -- the Chrome
/// profile the extension serves -- goes as `profile_name` and
/// `profile_email`, again only when known.
[[nodiscard]] bool relayHandshake(NativeIpcHandle pipe, const QString &token,
                                  int protocol, QString *error,
                                  const BridgePeerVersions &versions = {},
                                  QString *server_version = nullptr,
                                  const BridgePeerProfile &profile = {});

/// Pump exactly one command/reply exchange: block for a command frame from @p
/// pipe (sent by the server), forward it to the browser via @p browser_write,
/// block for the browser's reply via @p browser_read, and forward that reply
/// back to @p pipe. Returns false when either side closes (the caller stops the
/// relay), true to continue. Id-transparent: frames are moved verbatim, never
/// parsed or correlated.
[[nodiscard]] bool relayPumpOnce(NativeIpcHandle pipe,
                                 const BrowserReadFn &browser_read,
                                 const BrowserWriteFn &browser_write);

/// Blocking whole-frame read/write helpers for a synchronous (non-overlapped)
/// client pipe handle. Exposed for the relay pump and its tests; each
/// reads/writes the 4-byte little-endian length prefix plus body, guarding an
/// out-of-range prefix.
[[nodiscard]] bool relayReadPipeFrame(NativeIpcHandle pipe, QJsonObject *out);
[[nodiscard]] bool relayWritePipeFrame(NativeIpcHandle pipe,
                                       const QJsonObject &message);

/// How often the relay asks whether Chrome is still on the other end of its
/// stdio. Short enough that a reloaded extension frees the server's pipe before
/// the next command needs it, long enough to cost nothing while idle.
inline constexpr int kBrowserPresencePollMs = 250;

/// This process's standard input, as the handle type the presence check takes.
[[nodiscard]] NativeIpcHandle browserStdInHandle();

/// Whether the browser end of @p input has gone away -- Chrome closed the port,
/// or exited.
///
/// PEEKS ONLY: it never consumes a byte, so it is safe to call while the pump
/// is reading the same descriptor on another thread. It is also deliberately
/// one-sided: only a definite hangup answers true, and anything it cannot
/// interpret answers false. Exiting on a guess would kill a working relay,
/// which is worse than the leak this exists to stop.
[[nodiscard]] bool browserInputClosed(NativeIpcHandle input);

/// How many looks in a row must find the browser gone before the relay ends.
inline constexpr int kBrowserExitConfirmPolls = 3;

/// Whether the browser end has really gone, from one browserInputClosed() look
/// per poll. One look can be wrong on Linux and macOS: between poll() calling
/// stdin readable and asking how many bytes wait, the pump thread can read
/// them all, and "readable with nothing waiting" is exactly how a closed pipe
/// looks on macOS. That race ended live relays in the middle of a session --
/// most often during a long upload, a reply every few dozen milliseconds. A
/// closed pipe stays closed and a busy one does not, so only
/// kBrowserExitConfirmPolls closed looks in a row count.
class BrowserExitConfirmation {
public:
  /// Record one look; true once the browser has been seen gone enough times
  /// in a row to be sure.
  bool observe(bool closed) {
    streak_ = closed ? streak_ + 1 : 0;
    return streak_ >= kBrowserExitConfirmPolls;
  }

private:
  int streak_{0};
};

/// Poll browserInputClosed() on a detached thread and end this process once it
/// has answered true kBrowserExitConfirmPolls times in a row.
///
/// The relay spends nearly all its life blocked reading the pipe, waiting for
/// the server to send a command. Chrome closing the port -- which an extension
/// reload does every time -- is invisible from there: nothing wakes that read.
/// The relay stayed alive holding its end of a pipe created with
/// nMaxInstances = 1, so every relay Chrome started afterwards was refused with
/// ERROR_PIPE_BUSY and the bridge could not come back until the orphan was
/// killed by hand.
///
/// Ending the process is the whole repair: the relay holds no state worth
/// saving -- every id, ref and session lives in the MCP process -- and Chrome
/// starts a new one on the next port connection. The exit skips static
/// destructors on purpose, because another thread may be mid-write on the pipe
/// and running them underneath it would be the only way this could crash.
///
/// Its final flush takes the lock every stdout frame is written under, so it
/// never lands inside a frame -- but waits for it only briefly, since a writer
/// holding it longer is wedged on a pipe nobody reads, and waiting would keep
/// alive the very process this exists to end.
void watchForBrowserExit();

/// Run the full relay against Chrome's stdio. The sequence is:
///
///   1. list the rendezvous records of servers that are still running and
///      offer them to the extension as
///      `{type:"bridge_offers", protocol, servers:[<pid>, ...]}`
///   2. wait (bounded by kRelayAttachTimeoutMs) for
///      `{type:"attach_session", session:"<pid>"}` naming the one to take
///   3. connect to that record, verify the server's code identity, and complete
///      the token/protocol handshake
///   4. announce `{type:"bridge_ready", protocol}` and pump relayPumpOnce until
///      either side closes, while a BridgeServerWatcher sends
///      `{type:"bridge_servers", servers:[<pid>, ...]}` whenever the set of
///      running servers changes
///
/// Any failure before step 4 writes a single `bridge_unavailable` frame and
/// exits 0, so Chrome relaunches the host on the next port connection.
///
/// The relay speaks first because the extension has no filesystem access and
/// therefore no way to name a server until it is offered one -- and because a
/// frame sent unprompted would be read by an older relay as the reply to a
/// command it had not yet sent, putting every later exchange out of step.
///
/// Returns a process exit code (0 on a clean shutdown). Assumes stdin/stdout
/// are already in binary mode.
[[nodiscard]] int runBrowserRelay();

} // namespace chrome_control_mcp
