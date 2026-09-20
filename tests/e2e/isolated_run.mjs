// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Run a live suite against a dedicated browser (isolated_chrome.mjs) instead of the user's own:
// the suite starts the MCP server with the dedicated browser's environment, and the browser starts
// once that server has published its bridge record. The user's Chrome is never touched.
//
// Usage: node tests/e2e/isolated_run.mjs --chrome=<Chrome for Testing binary>
//          [--executable=<chrome_control_mcp>] [--scale=1] [--window=1280x800] [--zoom=100]
//          [--chrome-arg=<flag>]... <suite.mjs>
// The suite's own report is passed through on stdout, and its exit code is this runner's.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareIsolatedChrome } from "./isolated_chrome.mjs";

const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const suite = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const chrome = option("chrome");
assert.ok(
  chrome && existsSync(chrome),
  "--chrome=<Chrome for Testing binary> is required",
);
assert.ok(suite && existsSync(suite), "Name the suite to run");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const executable = path.resolve(
  option("executable") ||
    path.join(scriptDir, "..", "..", "build", "chrome_control_mcp"),
);
const [width, height] = (option("window") || "1280x800").split("x").map(Number);

const browser = await prepareIsolatedChrome({
  chrome,
  executable,
  scaleFactor: Number(option("scale") || 1),
  windowSize: [width, height],
  zoomPercent: Number(option("zoom") || 100),
  extraArgs: process.argv
    .filter((arg) => arg.startsWith("--chrome-arg="))
    .map((arg) => arg.slice("--chrome-arg=".length)),
});
let exitCode;
try {
  const child = spawn(process.execPath, [suite, executable], {
    // CHROME_PATH and CHROME_USER_DATA_DIR are how the interference suite opens a page as the
    // user would: through this browser's own binary and profile, which hands the URL to it.
    env: {
      ...browser.env,
      CHROME_PATH: chrome,
      CHROME_USER_DATA_DIR: browser.profile,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  try {
    await browser.launch();
  } catch (error) {
    // The suite is already running with a server of its own; leaving it alive would orphan both.
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  exitCode = await exited;
  if (exitCode !== 0) {
    // What the browser itself said. A suite that fails because Chrome died reads as a tool that
    // did not answer, and the reason is only in the browser's output.
    process.stderr.write(
      `--- dedicated browser stderr (tail) ---\n${browser.stderr().slice(-4000)}\n`,
    );
  }
} finally {
  await browser.close();
}
process.exitCode = exitCode ?? 1;
