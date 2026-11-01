// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// What the server tells its agent when the extension Chrome is running is not the server's
// version, and the extension reloading itself for a newer installed copy, in a live browser
// (docs/plans/extension-version.md). Which case runs is how isolated_run.mjs loads the extension:
//
//   (nothing)                      the extension staged with this server: nothing is said, nothing
//                                  reloads, and replies are what they always were
//   --extension-version=1.0.0      this extension's code under an older manifest version, so the
//                                  installed copy (this build) is newer: the agent is told once per
//                                  connection; the extension reloads itself once, a quiet period
//                                  after it was last used; it comes back still saying 1.0.0 -- its
//                                  folder was not updated -- and does not reload again
//   --extension=<released folder>  an extension from before 1.9.0, which says no version: the agent
//                                  is told it is older than 1.9.0, browser_clipboard says why it
//                                  fails, and everything else works as it did
//
// The suite reads which from browser_extension_status, a native tool that never sends the extension
// a command -- so it can watch the extension go quiet without disturbing that quiet.
//
// Usage: node tests/e2e/isolated_run.mjs --chrome=<Chrome for Testing> [case flag]
//          tests/e2e/extension_version_e2e.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { devtoolsEndpoint, evaluateIn, extensionWorker } from "./devtools.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient } from "./mcp_client.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const RELOADED_FOR_VERSION_KEY = "chrome_control_mcp.reloadedForVersion";
// The extension's quiet period (RELOAD_QUIET_MS in background.js), and how long after it the
// reload and the reattach after it get.
const QUIET_MS = 10000;
const RELOAD_WITHIN_MS = 60000;
// Long enough to see a second reload if there were going to be one: past a quiet period and a
// reconnect-alarm tick.
const NO_LOOP_WATCH_MS = 40000;

async function until(probe, deadlineMs, stepMs = 250) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() - started >= deadlineMs) {
      return null;
    }
    await sleep(stepMs);
  }
}

// The notice a reply carries: a text block of its own after the reply's content, or null.
function noticeOf(outcome) {
  const blocks = outcome.result.content || [];
  return blocks.length > 1 && blocks[blocks.length - 1].type === "text"
    ? blocks[blocks.length - 1].text
    : null;
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

  const checks = [];
  const check = (condition, label, detail = "") => {
    checks.push({ check: label, status: condition ? "passed" : "failed" });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition || !detail ? "" : ` -- ${detail}`}\n`,
    );
  };
  const fixture = await startFixtureServer();
  const server = new McpClient(executable);
  let failure = null;
  let expected = 0;
  let which = "unknown";
  try {
    await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "extension-version", version: "1" },
    });
    const status = async () =>
      (await server.json("browser_extension_status")).running;
    const attached = await until(async () => {
      const running = await status();
      return running.connected ? running : null;
    }, 180000);
    assert.ok(attached, "the extension did not attach within 180 s");
    const endpoint = await devtoolsEndpoint();
    const worker = await until(() => extensionWorker(endpoint), 15000);
    assert.ok(worker, "no extension service worker in the browser's targets");

    const serverVersion = attached.server_version;
    which =
      attached.extension_version === null
        ? "released"
        : attached.extension_version === serverVersion
          ? "current"
          : "older";
    process.stderr.write(
      `case: ${which} (extension ${attached.extension_version}, installed ${attached.installed_version}, server ${serverVersion})\n`,
    );
    check(
      attached.installed_version === serverVersion,
      "the relay reports the installed version, this build's",
      JSON.stringify(attached),
    );

    // The worker stays the one it was: nothing reloaded it.
    const stillSameWorker = async (watchMs) => {
      const started = Date.now();
      while (Date.now() - started < watchMs) {
        const now = await extensionWorker(endpoint);
        if (!now || now.id !== worker.id) {
          return false;
        }
        await sleep(500);
      }
      return true;
    };

    if (which === "current") {
      expected = 6;
      check(
        attached.notice === "",
        "an extension of the server's own version is not mentioned",
        attached.notice,
      );
      const first = await server.tool("browser_new_tab", {
        url: `${fixture.origin}/`,
      });
      check(
        !first.isError && first.result.content.length === 1,
        "the first reply is the reply alone, with no notice",
        JSON.stringify(first.result.content),
      );
      const tab = JSON.parse(first.text).tab_id;
      const snapshot = await server.tool("browser_snapshot", { tab_id: tab });
      check(!snapshot.isError, "and the bridge works", snapshot.text);
      check(
        await stillSameWorker(15000),
        "the extension does not reload itself for its own version",
      );
      const release = await server.tool("browser_release", {});
      check(!release.isError, "releasing works", release.text);
    } else if (which === "older") {
      expected = 12;
      const older = attached.extension_version;
      check(
        attached.notice.includes(older) &&
          attached.notice.includes("chrome://extensions"),
        "browser_extension_status names the running version and the fix",
        attached.notice,
      );
      // Two quick calls: the first is told, the second is not.
      const first = await server.tool("browser_tabs", {});
      const second = await server.tool("browser_tabs", {});
      const told = noticeOf(first);
      check(
        !first.isError && told !== null && told.includes(older),
        "the first browser reply on the connection carries the notice, after its own content",
        JSON.stringify(first.result.content),
      );
      check(
        Array.isArray(JSON.parse(first.text).tabs),
        "and the reply itself is still the JSON it always was",
        first.text,
      );
      check(
        noticeOf(second) === null,
        "a later reply on the same connection carries none",
        JSON.stringify(second.result.content),
      );

      // Now leave it alone: no tab held, no command. It reloads itself a quiet period later and
      // its new worker attaches again -- often inside one poll, so what shows the reload is a new
      // worker and a new connection, not a gap seen between them. Until the server has the new
      // connection a call can still meet the old relay on its way out (see the plan's readiness
      // review), so the suite waits for it as a caller that cares would.
      const lastCommandAt = Date.now();
      const reloaded = await until(
        async () => {
          const running = await status();
          const now = await extensionWorker(endpoint);
          return now &&
            now.id !== worker.id &&
            running.connected &&
            running.connections > attached.connections
            ? now
            : null;
        },
        RELOAD_WITHIN_MS,
        500,
      );
      const waited = Date.now() - lastCommandAt;
      check(
        reloaded !== null && waited >= QUIET_MS,
        "left idle, the extension reloads itself for the newer installed copy, never sooner than its quiet period",
        JSON.stringify({ reloaded: Boolean(reloaded), waited_ms: waited }),
      );
      const after = await status();
      check(
        after.connected && after.extension_version === older,
        "it comes back, still saying the older version: its folder was not updated",
        JSON.stringify(after),
      );
      const remembered = reloaded
        ? await evaluateIn(
            reloaded.webSocketDebuggerUrl,
            `chrome.storage.local.get(${JSON.stringify(RELOADED_FOR_VERSION_KEY)})` +
              `.then((r) => r[${JSON.stringify(RELOADED_FOR_VERSION_KEY)}] ?? null)`,
          )
        : null;
      check(
        remembered === serverVersion,
        "and remembers the version it reloaded for",
        JSON.stringify(remembered),
      );
      const reconnected = await server.tool("browser_tabs", {});
      check(
        !reconnected.isError && (noticeOf(reconnected) || "").includes(older),
        "the new connection is told again",
        JSON.stringify(reconnected.result.content),
      );
      // It must not reload again for the same version, however long it is left.
      const sameWorker = reloaded ? reloaded.id : null;
      let stable = sameWorker !== null;
      const watchStarted = Date.now();
      while (stable && Date.now() - watchStarted < NO_LOOP_WATCH_MS) {
        const now = await extensionWorker(endpoint);
        const running = await status();
        stable = Boolean(now && now.id === sameWorker && running.connected);
        await sleep(500);
      }
      check(
        stable,
        "it does not reload again for that version: no loop",
        `${Math.round((Date.now() - watchStarted) / 1000)} s watched`,
      );
      const opened = await server.tool("browser_new_tab", {
        url: `${fixture.origin}/`,
      });
      check(!opened.isError, "after the reload the bridge works", opened.text);
      const release = await server.tool("browser_release", {});
      check(!release.isError, "releasing works", release.text);
    } else {
      expected = 8;
      check(
        attached.notice.includes("older than 1.9.0") &&
          attached.notice.includes("chrome://extensions"),
        "browser_extension_status says the extension is older than 1.9.0 and how to fix it",
        attached.notice,
      );
      const first = await server.tool("browser_new_tab", {
        url: `${fixture.origin}/`,
      });
      const told = noticeOf(first);
      check(
        !first.isError &&
          told !== null &&
          told.includes("older than 1.9.0") &&
          told.includes("browser_clipboard"),
        "the first reply tells the agent, and names what is missing until it is reloaded",
        JSON.stringify(first.result.content),
      );
      const tab = JSON.parse(first.text).tab_id;
      const clipboard = await server.tool("browser_clipboard", {
        tab_id: tab,
        action: "read",
      });
      check(
        clipboard.isError &&
          clipboard.text.startsWith("Unknown command: clipboard") &&
          clipboard.text.includes("older than 1.9.0") &&
          clipboard.text.includes("chrome://extensions"),
        "browser_clipboard against it says why it fails and what to do",
        clipboard.text,
      );
      const snapshot = await server.tool("browser_snapshot", { tab_id: tab });
      check(
        !snapshot.isError && noticeOf(snapshot) === null,
        "everything it already did still works, and is told only once",
        snapshot.text.slice(0, 200),
      );
      check(
        await stillSameWorker(15000),
        "an extension from before 1.9.0 does not reload itself",
      );
      const release = await server.tool("browser_release", { tab_id: tab });
      check(!release.isError, "releasing works", release.text);
      const tabs = await server.json("browser_tabs");
      check(
        !tabs.tabs.some((t) => t.id === tab),
        "and its tab is gone",
        JSON.stringify(tabs.tabs.map((t) => t.id)),
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    await server.close();
    await fixture.close();
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === expected,
    case: which,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
