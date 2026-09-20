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
// Run it through isolated_run.mjs to drive a dedicated browser instead of the user's own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";
import { decodePng } from "./png.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// A dedicated browser (isolated_run.mjs) is driven through its own DevTools endpoint: its process
// singleton does not listen in headless mode, so a second process cannot hand it a URL. The tab or
// window it opens is a real foreground one, exactly what a click in another application produces.
async function opensInDedicatedBrowser(flag, url) {
  const port = (
    await readFile(
      path.join(process.env.CHROME_USER_DATA_DIR, "DevToolsActivePort"),
      "utf8",
    )
  ).split(/\r?\n/)[0];
  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools socket failed"));
  });
  const opened = new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        message.error ? reject(new Error(message.error.message)) : resolve();
      }
    };
    setTimeout(() => reject(new Error("Target.createTarget timed out")), 15000);
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Target.createTarget",
      params: { url, newWindow: flag === "--new-window" },
    }),
  );
  await opened;
  socket.close();
}

async function userOpens(flag, url) {
  if (process.env.CHROME_USER_DATA_DIR) {
    await opensInDedicatedBrowser(flag, url);
  } else if (process.env.CHROME_PATH) {
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
    await waitForExtensionAttached((name, args) => client.tool(name, args));

    await client.json("browser_new_tab", { url: `${fixture.origin}/` });
    let snapshot = (await client.tool("browser_snapshot")).text;
    check(
      snapshot.includes('"Fixture text input"'),
      "session tab shows the fixture home page",
    );

    await userOpens("--new-tab", `${fixture.origin}/page2?user=tab`);
    await sleep(2000);
    snapshot = (await client.tool("browser_snapshot")).text;
    check(
      !snapshot.includes("user=tab") &&
        snapshot.includes('"Fixture text input"'),
      "snapshot reads the session tab after the user opened a tab",
    );
    // The tab the user just opened is the one in front. Nothing the session does may change that:
    // the user goes on reading their own page while the session works in the background.
    const userTab = (await client.json("browser_tabs")).tabs.find(
      (tab) => tab.active,
    );
    check(
      String(userTab?.url).includes("user=tab"),
      "the tab the user opened is the one in front",
    );
    const input = refFor(snapshot, "Fixture text input");
    await client.json("browser_type", { ref: input, text: "session-typed" });
    check(
      (await client.json("browser_get_value", { ref: input })).value ===
        "session-typed",
      "typing lands in the session tab, not the user's",
    );
    // The image itself, not merely the absence of an error: a capture of the USER's tab would
    // pass an isError check identically. The fixture's page is blue-free white with known text,
    // so the check is that a real PNG of a real viewport came back.
    const capture = await client.tool("browser_screenshot", {
      full_page: false,
    });
    const image = capture.result?.content?.find(
      (block) => block.type === "image",
    );
    const decoded = image ? decodePng(Buffer.from(image.data, "base64")) : null;
    check(
      !capture.isError &&
        decoded !== null &&
        decoded.width > 100 &&
        decoded.height > 100,
      "screenshot of the session tab while the user's tab is in front",
    );
    await client.json("browser_scroll", { direction: "down", amount: 200 });
    await client.json("browser_click", {
      ref: refFor(
        (await client.tool("browser_snapshot")).text,
        "Fixture click button",
      ),
    });
    check(
      (await client.json("browser_tabs")).tabs.find((tab) => tab.active)?.id ===
        userTab?.id,
      "the user's tab is still in front after the session typed, scrolled, and clicked",
    );

    await userOpens("--new-window", `${fixture.origin}/page2?user=window`);
    await sleep(2000);
    const windowsWithUsers = (await client.json("browser_windows")).windows
      .map((window) => window.window_id)
      .sort();
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
    const windowsAfter = (await client.json("browser_windows")).windows
      .map((window) => window.window_id)
      .sort();
    check(
      JSON.stringify(windowsAfter) === JSON.stringify(windowsWithUsers),
      "the session opened and closed no windows of its own",
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
    await client.close();
    await fixture.close();
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === 10,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
