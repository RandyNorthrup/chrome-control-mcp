// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The session keeps driving its own tab while the user works in the same browser: the user opens
// a page from another application (a new foreground tab), then a whole new window, and every
// snapshot, keystroke, screenshot, and tab listing must still address the session's tab -- never
// the page the user just brought forward.
//
// Usage: node tests/e2e/user_interference_e2e.mjs [path/to/chrome_control_mcp]
// Requires the unpacked extension loaded in the running Chrome. CHROME_PATH overrides how the
// "user" opens pages (default: google-chrome-stable on Linux, `open -a` on macOS, chrome.exe on
// Windows); the browser hands the URL to its running instance exactly as a clicked link would.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "./fixture_server.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function userOpens(flag, url) {
  if (process.env.CHROME_PATH) {
    execFileSync(process.env.CHROME_PATH, [flag, url], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    // `open` hands a URL to the running Chrome as a new tab; it drops launch flags, so a new
    // window goes through Chrome's scripting interface instead.
    if (flag === "--new-window") {
      execFileSync("osascript", [
        "-e",
        `tell application "Google Chrome" to make new window with properties {URL:${JSON.stringify(url)}}`,
      ]);
    } else {
      execFileSync("open", ["-a", "Google Chrome", url], { stdio: "ignore" });
    }
  } else if (process.platform === "win32") {
    const chrome = path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
    execFileSync(chrome, [flag, url], { stdio: "ignore" });
  } else {
    execFileSync("google-chrome-stable", [flag, url], { stdio: "ignore" });
  }
}

function refFor(snapshot, accessibleName) {
  const line = snapshot
    .split(/\r?\n/)
    .find(
      (candidate) =>
        candidate.includes(`"${accessibleName}"`) &&
        candidate.includes("[ref="),
    );
  const match = line && line.match(/\[ref=(e\d+)\]/);
  assert.ok(match, `No ref for "${accessibleName}"`);
  return match[1];
}

class McpClient {
  constructor(executable) {
    this.child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    readline
      .createInterface({ input: this.child.stdout })
      .on("line", (line) => {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          pending(response);
        }
      });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async tool(name, args = {}) {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    const text =
      response.result?.content?.find((item) => item.type === "text")?.text ??
      JSON.stringify(response.error);
    return { isError: Boolean(response.result?.isError), text };
  }

  async json(name, args = {}) {
    const result = await this.tool(name, args);
    if (result.isError) {
      throw new Error(`${name} failed: ${result.text}`);
    }
    return JSON.parse(result.text);
  }

  close() {
    this.child.stdin.end();
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const executable = path.resolve(
    process.argv[2] ||
      path.join(
        scriptDir,
        "..",
        "..",
        "build",
        process.platform === "win32"
          ? path.join("Release", "chrome_control_mcp.exe")
          : "chrome_control_mcp",
      ),
  );
  assert.ok(existsSync(executable), `MCP executable not found: ${executable}`);

  const fixture = await startFixtureServer();
  const client = new McpClient(executable);
  const checks = [];
  const check = (condition, label) => {
    checks.push({ check: label, status: condition ? "passed" : "failed" });
    process.stderr.write(`${condition ? "PASS" : "FAIL"} ${label}\n`);
  };
  let failure = null;

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chrome-control-mcp-interference-e2e", version: "1" },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await client.tool("browser_windows")).isError) {
        break;
      }
      await sleep(500);
    }

    await client.json("browser_new_tab", { url: `${fixture.origin}/` });
    let snapshot = (await client.tool("browser_snapshot")).text;
    check(
      snapshot.includes('"Fixture text input"'),
      "session tab shows the fixture home page",
    );

    userOpens("--new-tab", `${fixture.origin}/page2?user=tab`);
    await sleep(2000);
    snapshot = (await client.tool("browser_snapshot")).text;
    check(
      !snapshot.includes("user=tab") &&
        snapshot.includes('"Fixture text input"'),
      "snapshot reads the session tab after the user opened a tab",
    );
    const input = refFor(snapshot, "Fixture text input");
    await client.json("browser_type", { ref: input, text: "session-typed" });
    check(
      (await client.json("browser_get_value", { ref: input })).value ===
        "session-typed",
      "typing lands in the session tab, not the user's",
    );
    check(
      !(await client.tool("browser_screenshot", { full_page: false })).isError,
      "screenshot of the session tab while the user's tab is in front",
    );

    userOpens("--new-window", `${fixture.origin}/page2?user=window`);
    await sleep(2000);
    snapshot = (await client.tool("browser_snapshot")).text;
    check(
      !snapshot.includes("user=window") &&
        snapshot.includes('"Fixture text input"'),
      "snapshot reads the session tab after the user opened a window",
    );
    const inputAgain = refFor(snapshot, "Fixture text input");
    await client.json("browser_type", { ref: inputAgain, text: "-still" });
    check(
      (await client.json("browser_get_value", { ref: inputAgain })).value ===
        "session-typed-still",
      "typing still lands in the session tab",
    );
    const listing = await client.json("browser_tabs");
    check(
      listing.tabs.some((tab) => tab.url === `${fixture.origin}/`),
      "browser_tabs lists the session's window",
    );
  } catch (error) {
    failure = error;
  } finally {
    // Close every fixture tab (the user's window closes with its last tab), window by window.
    try {
      const windows = await client.json("browser_windows");
      for (const window of windows.windows) {
        if (
          (
            await client.tool("browser_window", {
              action: "focus",
              window_id: window.window_id,
            })
          ).isError
        ) {
          continue;
        }
        const tabs = await client.json("browser_tabs");
        for (const tab of [...tabs.tabs].sort((a, b) => b.index - a.index)) {
          if (String(tab.url).startsWith(fixture.origin)) {
            await client.json("browser_tabs");
            await client.tool("browser_close_tab", { index: tab.index });
          }
        }
      }
    } catch (error) {
      failure ??= error;
    }
    client.close();
    await fixture.close();
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === 7,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
