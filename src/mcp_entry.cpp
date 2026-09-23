// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// MCP JSON-RPC 2.0 server over stdio. Runs synchronously with no Qt event loop:
// read a line, route it, write the reply. The same executable also serves as
// Chrome's native-messaging relay.

#include "chrome_control_mcp/mcp_entry.h"

#include "chrome_control_mcp/mcp_jsonrpc.h"
#include "chrome_control_mcp/install_layout.h"
#include "chrome_control_mcp/updater.h"
#include "chrome_control_mcp/browser_bridge_relay.h"
#include "chrome_control_mcp/browser_extension_installer.h"
#include "chrome_control_mcp/browser_control.h"
#include "chrome_control_mcp/mcp_dispatch.h"
#include "chrome_control_mcp/mcp_tools.h"

#include <QByteArray>
#include <QCoreApplication>
#include <QDir>
#include <QJsonDocument>
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

// Write one line of plain output, checked. The same rule as writeResponse:
// a caller that never received the path this prints cannot act on it, so a
// failed write is reported rather than assumed away.
bool writeLine(const QByteArray &line) {
  const size_t want = static_cast<size_t>(line.size());
  return std::fwrite(line.constData(), 1, want, stdout) == want &&
         std::fputc('\n', stdout) != EOF && std::fflush(stdout) == 0;
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

bool wantsFlag(int argc, char **argv, const char *flag) {
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], flag) == 0) {
      return true;
    }
  }
  return false;
}

// `--install`: put this copy into the managed layout and register the native
// host, then print the two paths that everything else has to name. It exists
// because the first install is the one step an MCP client cannot drive -- the
// client has to be told a command path before it can call a tool -- and because
// a person who downloaded an archive should not have to start a JSON-RPC
// session to install it.
int runInstall() {
  const QString executable =
      QDir::cleanPath(QCoreApplication::applicationFilePath());
  // A copy already inside the managed layout has nothing to move, but asking it
  // to install is still a reasonable thing to do: it is how a registration that
  // was overwritten by another copy of this program gets repaired. Treat it as
  // "make the registrations name me", not as an error.
  UpdateApplyResult result;
  if (installRootForExecutable(executable).isEmpty()) {
    result = adoptRunningInstall({});
  } else {
    const InstallLayout layout = InstallLayout::resolved(executable);
    result.ok = true;
    result.installed_version = serverVersion();
    result.executable_path = stableExecutablePath(executable);
    result.extension_path = QDir::cleanPath(
        QDir(layout.current)
            .filePath(QString::fromLatin1(kBrowserExtensionDirectoryName)));
  }
  QJsonObject payload;
  if (!result.ok) {
    payload.insert(QStringLiteral("ok"), false);
    payload.insert(QStringLiteral("error"), result.error);
  } else {
    BrowserExtensionInstaller installer(
        ExtensionInstallConfig{.extension_path = {},
                               .data_dir = {},
                               .host_exe_path = result.executable_path,
                               .native_host_key_path = {},
                               .native_host_manifest_dir = {}});
    const ExtensionInstallResult registered = installer.install();
    payload.insert(QStringLiteral("ok"), registered.ok);
    payload.insert(QStringLiteral("version"), result.installed_version);
    payload.insert(QStringLiteral("command"),
                   QDir::toNativeSeparators(result.executable_path));
    payload.insert(QStringLiteral("extension_path"),
                   QDir::toNativeSeparators(result.extension_path));
    payload.insert(QStringLiteral("native_host"), registered.summary);
    if (!registered.ok) {
      payload.insert(QStringLiteral("error"), registered.detail);
    }
  }
  if (!writeLine(QJsonDocument(payload).toJson(QJsonDocument::Compact))) {
    std::cerr << "chrome-control-mcp: could not report the install result\n";
    return 1;
  }
  return payload.value(QStringLiteral("ok")).toBool() ? 0 : 1;
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

  // Install mode: no stdio protocol, one line of JSON, then exit.
  if (wantsFlag(argc, argv, "--install")) {
    return runInstall();
  }
  if (wantsFlag(argc, argv, "--version")) {
    const QString identity = chrome_control_mcp::serverName() +
                             QStringLiteral(" ") +
                             chrome_control_mcp::serverVersion();
    return writeLine(identity.toUtf8()) ? 0 : 1;
  }

  // MCP server mode: own the browser authority (pipe server + session) so a
  // browser_* tool call drives the live extension through the relay. If the
  // bridge fails to start here (squatted, or another instance owned it at this
  // instant), the browser tools stay listed and each call tries the start
  // again -- the owner may have been a short-lived listing that has since
  // exited -- so a session never has to be restarted to get its browser back.
  chrome_control_mcp::BrowserControl browser;
  QString browser_error;
  if (!browser.start(&browser_error)) {
    std::cerr << "browser control unavailable for now: "
              << browser_error.toStdString()
              << " (retried on the next browser tool call)\n";
  }
  chrome_control_mcp::BrowserControl *const browser_ptr = &browser;

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
