// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// How long an action takes in the agent's own tab, which sits behind the user's.
//
// Chrome draws a tab that is not in front about once a second, and an input event or a scroll is
// acknowledged only when the next frame is drawn, so an action that waits for that frame takes up
// to a second a step. The extension keeps the tab drawing while an action runs, and the same
// action takes tens of milliseconds. Measured on Linux in this suite, with the cast that keeps the
// tab drawing and with it removed: scrolls 49 to 97 ms against 245 to 1,416 (the worst of each
// kind's three 994 ms or more); a click 26 to 43 against up to 464.
//
// The bound sits between the two, five times the slowest drawn-for action, which leaves room for
// a slow CI runner. Each kind of scroll fails it when the tab is not kept drawing; a click or hover
// is held to it too. Every time is reported, the listing and dialog reads among them: those are
// the server's own round trip, with nothing for the page to draw.
//
// Usage: node tests/e2e/action_latency_e2e.mjs [path/to/chrome_control_mcp]
// Run it through isolated_run.mjs to drive a dedicated browser instead of the user's own.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";

const ROUNDS = 3;
const ACTION_BOUND_MS = 500;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

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
  const check = (condition, label, detail = "") => {
    checks.push({
      check: label,
      status: condition ? "passed" : "failed",
      ...(condition ? {} : { detail }),
    });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition ? "" : `: ${detail}`}\n`,
    );
  };
  const timings = {};
  // What each scroll reported: how far the page moved and how long the extension waited for it to
  // come to rest. A slow scroll that moved far and settled is the page's own animation; one that
  // waited without moving is not.
  const scrolls = {};
  let failure = null;

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chrome-control-mcp-latency-e2e", version: "1" },
    });
    await waitForExtensionAttached((name, args) => client.tool(name, args));

    const opened = await client.json("browser_new_tab", {
      url: `${fixture.origin}/`,
    });
    const tab = opened.tab_id;
    const listing = await client.json("browser_tabs");
    const own = listing.tabs.find((entry) => entry.id === tab);
    check(
      own && own.active === false,
      "the agent's tab is behind the browser's own tab, as it is beside a user",
      JSON.stringify(own),
    );
    const snapshot = (await client.tool("browser_snapshot", { tab_id: tab }))
      .text;
    const refs = {
      click: refFor(snapshot, "Fixture click button"),
      hover: refFor(snapshot, "Fixture hover target"),
      region: refFor(snapshot, "Fixture scroll region"),
      below: refFor(snapshot, "Fixture Page Two"),
    };

    const timed = async (label, name, args) => {
      const began = performance.now();
      const reply = await client.tool(name, args);
      const ms = Math.round(performance.now() - began);
      (timings[label] ??= []).push(ms);
      if (reply.isError) {
        throw new Error(`${label} failed: ${reply.text}`);
      }
      if (name === "browser_scroll") {
        const answer = JSON.parse(reply.text);
        (scrolls[label] ??= []).push({
          ms,
          scrolled: answer.scrolled,
          settled: answer.settled,
          waited_ms: answer.waited_ms,
        });
      }
      return ms;
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      await timed("click", "browser_click", { tab_id: tab, ref: refs.click });
      await timed("hover", "browser_hover", { tab_id: tab, ref: refs.hover });
      await timed("scroll a region by ref", "browser_scroll", {
        tab_id: tab,
        ref: refs.region,
        direction: "down",
        amount: 180,
      });
      await timed("scroll the page by ref", "browser_scroll", {
        tab_id: tab,
        ref: refs.below,
        direction: "down",
        amount: 200,
      });
      await timed("scroll the page", "browser_scroll", {
        tab_id: tab,
        direction: "up",
        amount: 100000,
      });
      await timed("list tabs", "browser_tabs", {});
      await timed("read the dialog state", "browser_dialog", { tab_id: tab });
    }

    for (const label of [
      "scroll a region by ref",
      "scroll the page by ref",
      "scroll the page",
      "click",
      "hover",
    ]) {
      const worst = Math.max(...timings[label]);
      check(
        worst < ACTION_BOUND_MS,
        `${label} replies without waiting for a background frame (worst ${worst} ms)`,
        `${JSON.stringify(timings[label])} ms, bound ${ACTION_BOUND_MS}`,
      );
    }
    await client.tool("browser_release", { tab_id: tab });
  } catch (error) {
    failure = error;
    process.stderr.write(`FAIL ${error.stack || error}\n`);
  } finally {
    await client.close();
    await fixture.close();
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === 6,
    bound_ms: ACTION_BOUND_MS,
    timings: Object.fromEntries(
      Object.entries(timings).map(([label, values]) => [
        label,
        { ms: values, median: median(values), worst: Math.max(...values) },
      ]),
    ),
    scrolls,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
