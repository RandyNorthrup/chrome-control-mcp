// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
#pragma once

#include "chrome_control_mcp/browser_extension_installer.h" // kBrowserExtensionId

#include <cstring>
#include <string>

namespace chrome_control_mcp {

// True only when @p arg is the native-messaging origin of OUR pinned extension
// (chrome-extension://<our-id>[/...]), not merely any chrome-extension://
// origin. Chrome's allowed_origins already restricts which extension can launch
// the host, but validating the id here is defense in depth so a stray/spoofed
// chrome-extension:// argument from another extension cannot drive this process
// as the browser-control relay. Header-inline so it is unit-testable without
// linking the entry translation unit.
[[nodiscard]] inline bool isOurExtensionOrigin(const char *arg) {
  if (arg == nullptr) {
    return false;
  }
  static const std::string prefix =
      std::string("chrome-extension://") + kBrowserExtensionId;
  if (std::strncmp(arg, prefix.c_str(), prefix.size()) != 0) {
    return false;
  }
  const char after = arg[prefix.size()];
  return after == '\0' ||
         after == '/'; // the exact 32-char id, then end-of-arg or a path
}

// The MCP server and Chrome browser-control host share one executable. main()
// selects one of two roles at launch:
//
//   * MCP server: CHROME_CONTROL_MCP_MODE is set. Serves newline-delimited MCP
//     JSON-RPC on stdio and owns the browser-control bridge.
//   * Browser relay: launched by Chrome as the native messaging host, which
//     passes the calling extension's chrome-extension://<id>/ origin (or
//     --browser-relay for tests) as an argument. Pumps native-messaging frames
//     between Chrome and the bridge endpoint.

// Run the MCP helper (MCP server or browser relay, auto-detected). Configures
// platform-specific process state and runs synchronously with no Qt event loop.
[[nodiscard]] int runMcpProcess(int argc, char **argv);

} // namespace chrome_control_mcp
