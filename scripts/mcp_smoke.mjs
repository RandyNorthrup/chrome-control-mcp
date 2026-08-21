// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const readOnly = process.argv.includes("--read-only");
const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const executable = path.resolve(
  positional ||
    (process.platform === "win32"
      ? path.join(repoRoot, "build", "Release", "chrome_control_mcp.exe")
      : path.join(repoRoot, "build", "chrome_control_mcp")),
);

const child = spawn(executable, [], {
  env: {
    ...process.env,
    CHROME_CONTROL_MCP_MODE: "1",
    CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT: "true",
    ...(readOnly ? { CHROME_CONTROL_MCP_SECURITY_PROFILE: "read_only" } : {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const responses = [];
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => responses.push(JSON.parse(line)));

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chrome-control-mcp-smoke", version: "1" },
    },
  },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "browser_extension_status", arguments: {} },
  },
];
for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
}
child.stdin.end();

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
assert.equal(exitCode, 0, `MCP server failed: ${stderr}`);
assert.equal(responses.length, 3, "Expected three MCP responses");

const initialize = responses.find(({ id }) => id === 1);
assert.equal(initialize.result.serverInfo.name, "chrome-control-mcp");
const catalog = responses.find(({ id }) => id === 2);
assert.equal(catalog.result.tools.length, readOnly ? 10 : 43);
const statusResponse = responses.find(({ id }) => id === 3);
assert.equal(statusResponse.result.isError, false);
const status = JSON.parse(statusResponse.result.content[0].text);
assert.equal(status.extension_id, "iojehhmnaigcejfcpmilpclmeljhlkaa");
assert.equal(status.extension_present, true);

console.log(
  JSON.stringify(
    {
      server: initialize.result.serverInfo.name,
      protocol: initialize.result.protocolVersion,
      security_profile: readOnly ? "read_only" : "full",
      tool_count: catalog.result.tools.length,
      extension_state: status.state,
      extension_present: status.extension_present,
    },
    null,
    2,
  ),
);
