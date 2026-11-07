// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The meter (docs/plans/lean-observations.md): what this server costs an agent, measured. For the
// catalog -- tools/list in the full and read-only profiles, read twice in separate processes -- and
// for every observation tool on the fixture pages and three public pages, it records the bytes of
// each reply, its lines, an estimated token count (bytes / 4) and the wall-clock time. It measures
// whichever tools and parameters the server under test offers, so the same suite records a build
// from before browser_find and the build that adds it, and the two reports compare line for line.
//
// A measurement, not a gate: a public page that cannot be reached is recorded as such and the run
// still reports; only a failure on the local fixture pages fails it.
//
// Run through isolated_run.mjs: node tests/e2e/isolated_run.mjs --chrome=<CfT>
//   --executable=<server> tests/e2e/meter_e2e.mjs

import { decodePng } from "./png.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, textContent } from "./mcp_client.mjs";

const PUBLIC_PAGES = [
  {
    name: "wikipedia",
    url: "https://en.wikipedia.org/wiki/Web_browser",
    wait: "Web browser",
    find: "History",
  },
  {
    name: "hacker-news",
    url: "https://news.ycombinator.com/",
    wait: "Hacker News",
    find: "comments",
  },
  {
    name: "github",
    url: "https://github.com/microsoft/playwright-mcp",
    wait: "playwright-mcp",
    find: "Code",
  },
];
const PAGE_TIMEOUT_MS = 60000;

const bytesOf = (text) => Buffer.byteLength(text, "utf8");
const measureText = (text, ms) => ({
  bytes: bytesOf(text),
  lines: text.length === 0 ? 0 : text.split("\n").length,
  tokens_est: Math.round(bytesOf(text) / 4),
  ms,
});

async function timed(client, name, args, timeoutMs) {
  const started = Date.now();
  const outcome = await client.tool(name, args, timeoutMs);
  return { outcome, ms: Date.now() - started };
}

async function initialize(client) {
  return client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "meter", version: "1" },
  });
}

// One profile's catalog, from a fresh process: the bytes a client receives, and how much of them
// the tab_id description and the instructions take.
async function catalogOf(executable, env) {
  const client = new McpClient(executable, env);
  try {
    const init = await initialize(client);
    const list = await client.request("tools/list", {});
    const json = JSON.stringify(list.tools);
    const tabIdDescriptions = list.tools
      .map((tool) => tool.inputSchema?.properties?.tab_id?.description)
      .filter((description) => typeof description === "string");
    return {
      tools: list.tools.length,
      bytes: bytesOf(json),
      tokens_est: Math.round(bytesOf(json) / 4),
      tab_id_copies: tabIdDescriptions.length,
      tab_id_bytes: tabIdDescriptions.reduce((n, d) => n + bytesOf(d), 0),
      instructions_chars: (init.instructions || "").length,
      longest: list.tools
        .map((tool) => ({ name: tool.name, chars: tool.description.length }))
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 6),
      json,
      instructions: init.instructions || "",
    };
  } finally {
    await client.close();
  }
}

async function measurePage(client, tools, page) {
  const out = { name: page.name, url: page.url };
  const opened = await client.tool(
    "browser_new_tab",
    { url: page.url, agent: "meter" },
    PAGE_TIMEOUT_MS,
  );
  if (opened.isError) {
    throw new Error(`browser_new_tab: ${opened.text.slice(0, 300)}`);
  }
  const tabId = JSON.parse(opened.text).tab_id;
  try {
    const waited = await client.tool(
      "browser_wait_for",
      { tab_id: tabId, text: page.wait, timeout_ms: 30000 },
      PAGE_TIMEOUT_MS,
    );
    out.loaded = !waited.isError;
    const record = async (key, name, args) => {
      const { outcome, ms } = await timed(
        client,
        name,
        { tab_id: tabId, ...args },
        PAGE_TIMEOUT_MS,
      );
      out[key] = outcome.isError
        ? { error: outcome.text.slice(0, 300), ms }
        : measureText(outcome.text, ms);
      return outcome;
    };
    await record("snapshot", "browser_snapshot", {});
    // Measured twice: the first snapshot attaches the debugger and warms the page.
    await record("snapshot_again", "browser_snapshot", {});
    const snapshotProps = tools.get("browser_snapshot") || {};
    if ("filter" in snapshotProps) {
      await record("snapshot_interactive", "browser_snapshot", {
        filter: "interactive",
      });
      await record("snapshot_viewport", "browser_snapshot", {
        filter: "viewport",
      });
    }
    if ("max_chars" in snapshotProps) {
      await record("snapshot_30k", "browser_snapshot", { max_chars: 30000 });
    }
    if (tools.has("browser_find")) {
      await record("find", "browser_find", { text: page.find });
    }
    await record("read", "browser_read", {});
    const { outcome, ms } = await timed(
      client,
      "browser_screenshot",
      { tab_id: tabId },
      PAGE_TIMEOUT_MS,
    );
    const image = Array.isArray(outcome.result.content)
      ? outcome.result.content.find((item) => item && item.type === "image")
      : null;
    if (outcome.isError || !image) {
      out.screenshot = { error: textContent(outcome.result).slice(0, 300), ms };
    } else {
      const png = decodePng(Buffer.from(image.data, "base64"));
      out.screenshot = {
        base64_bytes: image.data.length,
        width: png.width,
        height: png.height,
        claude_tokens_est:
          Math.ceil(png.width / 28) * Math.ceil(png.height / 28),
        ms,
      };
    }
  } finally {
    await client.tool("browser_release", { tab_id: tabId }).catch(() => {});
  }
  return out;
}

async function main() {
  const executable = process.argv[2];
  if (!executable) {
    throw new Error("usage: meter_e2e.mjs <server executable>");
  }
  const report = { ok: false, catalog: {}, pages: [], error: null };
  const fixture = await startFixtureServer();
  const client = new McpClient(executable);
  try {
    // The catalog, twice per profile from separate processes: a client caches it as a prompt
    // prefix, so the two must be the same bytes.
    const full = await catalogOf(executable, process.env);
    const fullAgain = await catalogOf(executable, process.env);
    const readOnlyEnv = {
      ...process.env,
      CHROME_CONTROL_MCP_SECURITY_PROFILE: "read_only",
    };
    const readOnly = await catalogOf(executable, readOnlyEnv);
    const readOnlyAgain = await catalogOf(executable, readOnlyEnv);
    const strip = ({ json: _json, instructions: _instructions, ...rest }) =>
      rest;
    report.catalog = {
      full: strip(full),
      read_only: strip(readOnly),
      byte_identical_across_runs:
        full.json === fullAgain.json &&
        full.instructions === fullAgain.instructions &&
        readOnly.json === readOnlyAgain.json,
    };

    const init = await initialize(client);
    report.server = init.serverInfo;
    const list = await client.request("tools/list", {});
    const tools = new Map(
      list.tools.map((tool) => [tool.name, tool.inputSchema?.properties || {}]),
    );
    const local = [
      {
        name: "fixture-home",
        url: `${fixture.origin}/`,
        wait: "Navigation",
        find: "Fixture text input",
      },
    ];
    if (await fetch(`${fixture.origin}/find`).then((r) => r.ok)) {
      local.push({
        name: "fixture-find",
        url: `${fixture.origin}/find`,
        wait: "Messages",
        find: "Send message",
      });
    }
    for (const page of local) {
      report.pages.push(await measurePage(client, tools, page));
    }
    for (const page of PUBLIC_PAGES) {
      try {
        report.pages.push(await measurePage(client, tools, page));
      } catch (error) {
        report.pages.push({
          name: page.name,
          url: page.url,
          unreachable: String(error.message || error).slice(0, 300),
        });
      }
    }
    // A refusal the server makes because the extension is too old for an option (it says so,
    // and says to reload it) is the documented answer, measured against an older extension on
    // purpose; it is recorded apart, not counted as a failure.
    const olderExtension = /older than the server/;
    const fixtureReplies = report.pages
      .filter((page) => page.name.startsWith("fixture"))
      .flatMap((page) =>
        Object.entries(page)
          .filter(
            ([, value]) => value && typeof value === "object" && value.error,
          )
          .map(([key, value]) => ({ key: `${page.name}.${key}`, value })),
      );
    report.refused_for_older_extension = fixtureReplies
      .filter(({ value }) => olderExtension.test(value.error))
      .map(({ key }) => key);
    const localErrors = fixtureReplies
      .filter(({ value }) => !olderExtension.test(value.error))
      .map(({ key, value }) => `${key}: ${value.error}`);
    report.ok =
      localErrors.length === 0 && report.catalog.byte_identical_across_runs;
    if (localErrors.length > 0) {
      report.error = localErrors.join("; ");
    }
  } catch (error) {
    report.error = String(error.stack || error);
  } finally {
    await client.close();
    await fixture.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
