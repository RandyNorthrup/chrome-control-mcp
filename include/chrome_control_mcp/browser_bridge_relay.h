// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#pragma once

#include "chrome_control_mcp/native_ipc.h"

#include <QJsonObject>
#include <QString>

#include <functional>

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
/// An empty @p wanted means the extension expressed no preference and the
/// newest record is taken. A @p wanted naming a record that is not in the list
/// yields an empty string: the server it asked for is gone, and connecting to a
/// different one instead would attach the extension's session to a server it
/// did not choose. Pure, so the rule is testable without a relay.
[[nodiscard]] QString selectRendezvousRecord(const QStringList &records,
                                             const QString &wanted);

/// Wait for the browser's reply to a command already forwarded, while staying
/// able to see a `cancel` the server sends mid-exchange and pass it on.
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
[[nodiscard]] bool relayHandshake(NativeIpcHandle pipe, const QString &token,
                                  int protocol, QString *error);

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

/// Run the full relay against Chrome's stdio. The sequence is:
///
///   1. list the published rendezvous records and offer them to the extension
///      as `{type:"bridge_offers", protocol, servers:[<pid>, ...]}`
///   2. wait (bounded by kRelayAttachTimeoutMs) for
///      `{type:"attach_session", session:"<pid>"}` naming the one to take
///   3. connect to that record, verify the server's code identity, and complete
///      the token/protocol handshake
///   4. announce `{type:"bridge_ready", protocol}` and pump relayPumpOnce until
///      either side closes
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
