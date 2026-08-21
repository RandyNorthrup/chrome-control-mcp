// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

#include "chrome_control_mcp/mcp_entry.h"

#include <QCoreApplication>

int main(int argc, char **argv) {
  // QCoreApplication provides a reliable absolute executable path on every
  // platform. The installer and peer-identity checks depend on it; no event
  // loop is started.
  const QCoreApplication application(argc, argv);

  // Same executable serves both roles. Chrome supplies its pinned extension
  // origin when launching native-host mode; every other invocation serves MCP
  // over stdio.
  return chrome_control_mcp::runMcpProcess(argc, argv);
}
