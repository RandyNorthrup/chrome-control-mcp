// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// MCP JSON-RPC 2.0 server over stdio. Runs synchronously with no Qt event loop:
// read a line, route it, write the reply. The same executable also serves as
// Chrome's native-messaging relay.

#include "chrome_control_mcp/mcp_entry.h"

#include "chrome_control_mcp/mcp_jsonrpc.h"
#include "chrome_control_mcp/browser_bridge_relay.h"
#include "chrome_control_mcp/browser_control.h"
#include "chrome_control_mcp/mcp_dispatch.h"
#include "chrome_control_mcp/mcp_tools.h"

#include <QByteArray>
#include <QJsonObject>

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace chrome_control_mcp {
namespace {

// A single MCP request is one compact JSON object on its own line; a legitimate
// one is small. Cap the read so a peer that never sends a newline cannot force
// unbounded memory growth on this process. 4 MiB comfortably clears any real
// tool call while bounding a hostile/runaway stream.
constexpr std::size_t kMaxRequestLineBytes = std::size_t{4} * 1024U * 1024U;

enum class LineRead : std::uint8_t { Ok, Eof, TooLong };

// Read one newline-delimited line, failing closed (TooLong) once the ceiling is
// crossed instead of letting std::getline grow the string without bound. A
// trailing unterminated line at EOF is returned once as Ok, then Eof.
LineRead readBoundedLine(std::istream &in, std::string &line) {
  line.clear();
  char ch = 0;
  while (in.get(ch)) {
    if (ch == '\n') {
      return LineRead::Ok;
    }
    line.push_back(ch);
    if (line.size() > kMaxRequestLineBytes) {
      return LineRead::TooLong;
    }
  }
  return line.empty() ? LineRead::Eof : LineRead::Ok;
}

// Write one response line, returning false if the write or flush failed -- a
// lost response means the client can no longer be trusted to have received a
// mutating command's result, so the caller stops serving rather than silently
// continuing (and eventually exiting 0) with a dropped ack.
bool writeResponse(const QJsonObject &response) {
  const QByteArray out = chrome_control_mcp::mcp::jsonLine(response);
  const size_t want = static_cast<size_t>(out.size());
  return std::fwrite(out.constData(), 1, want, stdout) == want &&
         std::fflush(stdout) == 0;
}

// Serve newline-delimited JSON-RPC until EOF, or until a line exceeds the size
// ceiling -- at which point we stop serving (the stream is desynchronized and
// cannot be trusted to re-frame). Returns true on a clean end-of-stream (the
// peer closed our stdin) and false on an ABNORMAL teardown -- an oversized line
// that desynchronized the stream, or a failed response write -- so the caller
// can propagate the distinction as an exit code instead of always exiting 0.
bool serveRequests(BrowserControl *browser_ptr, const McpServerPolicy &policy) {
  std::string line;
  while (true) {
    const LineRead status = readBoundedLine(std::cin, line);
    if (status == LineRead::Eof) {
      return true; // clean end-of-stream
    }
    if (status == LineRead::TooLong) {
      std::cerr << "chrome-control-mcp: request line exceeded "
                << kMaxRequestLineBytes << " bytes; closing stream\n";
      return false; // desynchronized stream: abnormal teardown
    }
    if (line.empty()) {
      continue;
    }
    QString parse_error;
    const QJsonObject request = chrome_control_mcp::mcp::parseJsonLine(
        QByteArray::fromStdString(line), &parse_error);
    if (!parse_error.isEmpty()) {
      // A malformed line carries no reliable id to answer against; drop it and
      // keep serving rather than desynchronizing the stream.
      continue;
    }
    const std::optional<QJsonObject> response =
        handleRequest(request, browser_ptr, policy);
    if (response.has_value() && !writeResponse(response.value())) {
      std::cerr
          << "chrome-control-mcp: response write failed; closing stream\n";
      return false; // lost response ack: abnormal teardown
    }
  }
}

// Chrome launches a native messaging host with the calling extension's origin
// (chrome-extension://<id>/) as an argument -- we never get to add our own flag
// to the manifest's `path`, so OUR extension's origin is the signal to run as
// the browser-control relay. The explicit --browser-relay flag is accepted too,
// for local testing.
bool wantsRelayMode(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--browser-relay") == 0 ||
        isOurExtensionOrigin(argv[i])) {
      return true;
    }
  }
  return false;
}

} // namespace

int runMcpProcess(int argc, char **argv) {
  // Per-monitor-v2 DPI awareness BEFORE any window/monitor query or input
  // injection: without it the OS virtualizes coordinates on
  // scaled/multi-monitor hosts, so GetWindowRect bounds are wrong and any
  // future click/drag would land in the wrong place. Best-effort (older OSes
  // lack the API); the manifest is not used since this is a console child
  // process.
#if defined(Q_OS_WIN) && defined(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
  if (SetProcessDpiAwarenessContext(
          DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == FALSE) {
    // Best-effort: on a modern OS this succeeds; surface a failure so a
    // virtualized-coordinate session is diagnosable rather than silently wrong.
    // (Older OSes lack the API entirely and compile this branch out.)
    std::cerr
        << "chrome-control-mcp: could not set per-monitor DPI awareness\n";
  }
#endif

  // Binary stdio so message framing is byte-exact in both directions (newline
  // for MCP JSON-RPC, length-prefixed for native messaging). A failure here
  // would corrupt every frame, so fail closed rather than serve on a
  // text-translated stream.
#ifdef Q_OS_WIN
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
      _setmode(_fileno(stdout), _O_BINARY) == -1) {
    std::cerr
        << "chrome-control-mcp: could not set binary stdio mode; aborting\n";
    return 1;
  }
#endif

  // Relay mode (launched by Chrome for the browser-control extension): pump
  // length-prefixed native-messaging frames between Chrome and the bridge pipe
  // of the long-lived MCP process, instead of serving newline-delimited
  // JSON-RPC.
  if (wantsRelayMode(argc, argv)) {
    return chrome_control_mcp::runBrowserRelay();
  }

  // MCP server mode: own the browser authority (pipe server + session) so a
  // browser_* tool call drives the live extension through the relay. If the
  // bridge fails to start (e.g. squatted), keep serving built-in native tools
  // with browser control off.
  chrome_control_mcp::BrowserControl browser;
  QString browser_error;
  const bool browser_ready = browser.start(&browser_error);
  if (!browser_ready) {
    std::cerr << "browser control unavailable: " << browser_error.toStdString()
              << '\n';
  }
  chrome_control_mcp::BrowserControl *const browser_ptr =
      browser_ready ? &browser : nullptr;

  // Enforce the security profile / output redaction the provider gateway set in
  // this process's environment. The gateway pools a distinct process per
  // profile, so reading it once here holds for the process lifetime.
  const chrome_control_mcp::McpServerPolicy policy =
      chrome_control_mcp::McpServerPolicy::fromEnvironment();

  const bool clean_exit = serveRequests(browser_ptr, policy);
  browser.stop();
  // A clean EOF (the gateway closed our stdin) exits 0; an abnormal teardown --
  // an oversized line that desynchronized the stream, or a failed response
  // write -- exits non-zero so the parent gateway can distinguish a normal
  // shutdown from a protocol desync rather than reading success.
  return clean_exit ? 0 : 1;
}

} // namespace chrome_control_mcp
