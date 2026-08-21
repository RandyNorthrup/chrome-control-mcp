// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const operations = new Set(["status", "install", "uninstall"]);
const operation = process.argv[2] || "status";
if (!operations.has(operation)) {
  throw new Error("Operation must be status, install, or uninstall.");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const executable = path.resolve(
  process.argv[3] ||
    (process.platform === "win32"
      ? path.join(repoRoot, "build", "Release", "chrome_control_mcp.exe")
      : path.join(repoRoot, "build", "chrome_control_mcp")),
);

const child = spawn(executable, [], {
  env: { ...process.env, CHROME_CONTROL_MCP_MODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
let response;
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
readline.createInterface({ input: child.stdout }).once("line", (line) => {
  response = JSON.parse(line);
});

child.stdin.end(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: `browser_extension_${operation}`, arguments: {} },
  })}\n`,
);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
assert.equal(exitCode, 0, `MCP server failed: ${stderr}`);
assert.ok(response, "MCP server returned no response");
if (response.error) {
  throw new Error(response.error.message);
}
if (response.result.isError) {
  throw new Error(response.result.content[0].text);
}
console.log(
  JSON.stringify(JSON.parse(response.result.content[0].text), null, 2),
);
