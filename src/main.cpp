// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/mcp_entry.h"

int main(int argc, char** argv) {
    // Same executable serves both roles. Chrome supplies its pinned extension origin
    // when launching native-host mode; every other invocation serves MCP over stdio.
    return chrome_control_mcp::runWin32McpProcess(argc, argv);
}

