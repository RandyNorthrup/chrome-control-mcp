// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Several agents in one browser, as they actually arrive: two MCP servers (two editor windows,
// two clients of any kind) and, inside one of them, two agents sharing that server. Each must get
// its own tab, its own refs and its own coloured group; none may act on another's tab; and when an
// agent is done -- or its server exits -- what it opened is closed and nothing of it is left on
// the tab strip. File pickers a page opens are answered without a native dialog.
//
// Usage: node tests/e2e/multi_agent_e2e.mjs [path/to/chrome_control_mcp]
// Run it through isolated_run.mjs to drive a dedicated browser instead of the user's own.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// How long a second server may take to be attached. A relay already attached reports a new
// server within about a second; without that report the extension's own probe is minutes away.
const SECOND_SERVER_ATTACH_MS = 15000;
// How long the extension may take to clean up after a server exits: the relay goes, the port
// drops, and the next offer shows the server gone.
const CLEANUP_DEADLINE_MS = 20000;

async function startServer(executable, name) {
  const client = new McpClient(executable);
  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name, version: "1" },
  });
  return { client, init };
}

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

const tabIdLine = (snapshot) => {
  const match = /^tab_id: (\d+)$/m.exec(snapshot);
  return match ? Number(match[1]) : null;
};
const refsIn = (snapshot) =>
  new Set([...snapshot.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]));

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
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ccm-upload-"));
  const upload = path.join(scratch, "hello.txt");
  await writeFile(upload, "hello upload");
  const checks = [];
  const check = (condition, label, detail = "") => {
    checks.push({ check: label, status: condition ? "passed" : "failed" });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition || !detail ? "" : ` -- ${detail}`}\n`,
    );
  };
  let failure = null;
  const one = await startServer(executable, "suite-one");
  let two = null;

  try {
    check(
      typeof one.init.instructions === "string" &&
        one.init.instructions.includes("tab_id"),
      "the server tells every client how to share the browser (MCP instructions)",
    );
    await waitForExtensionAttached((name, args) => one.client.tool(name, args));

    // -- Two agents sharing one server ------------------------------------------------
    const alpha = await one.client.json("browser_new_tab", {
      url: `${fixture.origin}/`,
      agent: "alpha",
    });
    const beta = await one.client.json("browser_new_tab", {
      url: `${fixture.origin}/page2`,
      agent: "beta",
    });
    check(
      Number.isInteger(alpha.tab_id) && Number.isInteger(beta.tab_id),
      "browser_new_tab answers with the tab_id to act on",
    );
    const alphaSnap = (
      await one.client.tool("browser_snapshot", { tab_id: alpha.tab_id })
    ).text;
    const betaSnap = (
      await one.client.tool("browser_snapshot", { tab_id: beta.tab_id })
    ).text;
    check(
      tabIdLine(alphaSnap) === alpha.tab_id &&
        tabIdLine(betaSnap) === beta.tab_id,
      "each snapshot names the tab it was taken of",
    );
    const overlap = [...refsIn(alphaSnap)].filter((ref) =>
      refsIn(betaSnap).has(ref),
    );
    check(
      overlap.length === 0,
      "two tabs' refs never share a name",
      overlap.join(","),
    );
    // beta's tab is the server's current one now; alpha's ref must still go to alpha's tab.
    const input = refFor(alphaSnap, "Fixture text input");
    await one.client.json("browser_type", { ref: input, text: "alpha-typed" });
    check(
      (await one.client.json("browser_get_value", { ref: input })).value ===
        "alpha-typed",
      "a ref acts on the tab it came from, whatever tab is current",
    );
    const listing = await one.client.json("browser_tabs");
    const alphaRow = listing.tabs.find((t) => t.tab_id === alpha.tab_id);
    const betaRow = listing.tabs.find((t) => t.tab_id === beta.tab_id);
    check(
      alphaRow?.group === "AI · alpha" && betaRow?.group === "AI · beta",
      "each agent's tab sits in a group named for it",
      JSON.stringify([alphaRow?.group, betaRow?.group]),
    );
    check(
      alphaRow?.group_id !== betaRow?.group_id,
      "and the two agents' groups are different groups",
    );

    // -- A second server --------------------------------------------------------------
    two = await startServer(executable, "suite-two");
    const attachMs = await waitForExtensionAttached((name, args) =>
      two.client.tool(name, args),
    );
    check(
      attachMs < SECOND_SERVER_ATTACH_MS,
      "a server started later is attached in seconds",
      `${attachMs} ms`,
    );
    const theirs = await two.client.json("browser_new_tab", {
      url: `${fixture.origin}/uploads`,
    });
    const refused = await two.client.tool("browser_snapshot", {
      tab_id: alpha.tab_id,
    });
    check(
      refused.isError &&
        /another Chrome Control MCP session/.test(refused.text),
      "one server cannot act on another server's tab",
      refused.text,
    );
    const stillOurs = await one.client.json("browser_get_value", {
      ref: input,
    });
    check(
      stillOurs.value === "alpha-typed",
      "and the first server's tab and refs are untouched by the second",
    );

    // -- File pickers, with no native dialog --------------------------------------------
    let uploads = (await two.client.tool("browser_snapshot")).text;
    await two.client.json("browser_click", {
      ref: refFor(uploads, "Attach a file"),
    });
    const attached = await two.client.tool("browser_upload", {
      paths: [upload],
    });
    check(
      !attached.isError,
      "a file input the page created and clicked is filled without a ref",
      attached.text,
    );
    const attachedText = await until(async () => {
      const read = await two.client.tool("browser_read", { format: "text" });
      return /attached: hello\.txt:12/.test(read.text) ? read.text : null;
    }, 5000);
    check(Boolean(attachedText), "the page received the file it asked for");

    uploads = (await two.client.tool("browser_snapshot")).text;
    const dropped = await two.client.tool("browser_upload", {
      ref: refFor(uploads, "Drop files here"),
      paths: [upload],
    });
    check(
      !dropped.isError && /"delivered_by":"drop"/.test(dropped.text),
      "a drop zone with no input is given the file by drag and drop",
      dropped.text,
    );
    check(
      Boolean(
        await until(async () => {
          const read = await two.client.tool("browser_read", {
            format: "text",
          });
          return /dropped: hello\.txt:12/.test(read.text);
        }, 5000),
      ),
      "the drop zone received the file",
    );

    uploads = (await two.client.tool("browser_snapshot")).text;
    await two.client.json("browser_click", {
      ref: refFor(uploads, "Open with picker"),
    });
    const picked = await two.client.tool("browser_upload", {
      paths: [upload],
    });
    check(
      !picked.isError,
      "a File System Access picker is answered with the agent's file",
      picked.text,
    );
    check(
      Boolean(
        await until(async () => {
          const read = await two.client.tool("browser_read", {
            format: "text",
          });
          return /picked: hello\.txt:12:hello upload/.test(read.text);
        }, 5000),
      ),
      "the page read the picked file's contents",
    );

    // -- A popup the agent's click opens ---------------------------------------------------
    // target=_blank implies noopener, so Chrome names no opener to an extension: the popup was left
    // behind as a stray tab, in front of the user. It must be the agent's, and the user's front tab
    // must stay in front.
    const popupSource = await two.client.json("browser_new_tab", {
      url: `${fixture.origin}/popup`,
    });
    const frontBefore = (await two.client.json("browser_tabs")).tabs.find(
      (t) => t.active,
    )?.tab_id;
    const sourceSnap = (
      await two.client.tool("browser_snapshot", {
        tab_id: popupSource.tab_id,
      })
    ).text;
    await two.client.json("browser_click", {
      ref: refFor(sourceSnap, "Open the popup"),
    });
    const afterPopup = await until(async () => {
      const now = await two.client.json("browser_tabs");
      return now.your_tabs.some((t) => /from=popup/.test(t.url)) ? now : null;
    }, 8000);
    check(
      Boolean(afterPopup),
      "a popup the agent's click opens is the agent's tab",
    );
    const frontAfter = (await two.client.json("browser_tabs")).tabs.find(
      (t) => t.active,
    )?.tab_id;
    check(
      frontAfter === frontBefore,
      "and the user's tab stays in front",
      JSON.stringify([frontBefore, frontAfter]),
    );

    // -- Letting go ------------------------------------------------------------------------
    const released = await one.client.json("browser_release", {
      tab_id: beta.tab_id,
    });
    const afterRelease = await one.client.json("browser_tabs");
    check(
      released.closed.includes(beta.tab_id) &&
        !afterRelease.tabs.some((t) => t.tab_id === beta.tab_id),
      "releasing one agent's tab closes it",
    );
    check(
      afterRelease.tabs.some((t) => t.tab_id === alpha.tab_id && t.held),
      "and leaves the other agent's tab alone",
    );

    await two.client.close();
    two = null;
    const cleaned = await until(async () => {
      const now = await one.client.json("browser_tabs");
      return !now.tabs.some((t) => t.tab_id === theirs.tab_id);
    }, CLEANUP_DEADLINE_MS);
    check(
      Boolean(cleaned),
      "a server that exits has the tabs it opened closed for it",
    );

    await one.client.json("browser_release", {});
    const finalTabs = await one.client.json("browser_tabs");
    check(
      !finalTabs.tabs.some((t) => t.tab_id === alpha.tab_id) &&
        !finalTabs.tabs.some((t) => String(t.group || "").startsWith("AI")),
      "releasing everything leaves no AI tab or group behind",
      JSON.stringify(finalTabs.tabs.map((t) => [t.tab_id, t.group])),
    );
  } catch (error) {
    failure = error;
  } finally {
    if (two) {
      await two.client.close();
    }
    await one.client.close();
    await fixture.close();
    await rm(scratch, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === 22,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
