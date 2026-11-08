// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// What an action changed, said in its own reply; a snapshot returned in the same call; a page
// that has not changed answered in one line; and a form filled in one call.
//
// Each action's reply carries `changes`: `dom` ("none", "some", "many" or "new document") and,
// only when they happened, `url`, `title`, `dialog`, `console_errors` and `focus`. The fixture's
// buttons each cause one of them, and the page's own status line says what the form received.
//
// Usage: node tests/e2e/action_changes_e2e.mjs [path/to/chrome_control_mcp]
// Run it through isolated_run.mjs to drive a dedicated browser instead of the user's own.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";

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
      ...(condition ? {} : { detail: String(detail).slice(0, 2000) }),
    });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition ? "" : ` -- ${String(detail).slice(0, 2000)}`}\n`,
    );
  };
  let failure = null;

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "chrome-control-mcp-action-changes-e2e",
        version: "1",
      },
    });
    await waitForExtensionAttached((name, args) => client.tool(name, args));

    const opened = await client.json("browser_new_tab", {
      url: `${fixture.origin}/actions`,
    });
    const tab = opened.tab_id;
    let snapshot = (await client.tool("browser_snapshot", { tab_id: tab }))
      .text;
    const click = async (name, extra = {}) => {
      const reply = await client.tool("browser_click", {
        tab_id: tab,
        ref: refFor(snapshot, name),
        ...extra,
      });
      if (reply.isError) {
        throw new Error(`clicking "${name}" failed: ${reply.text}`);
      }
      return reply.text;
    };
    const changesOf = (text) => JSON.parse(text.split("\n")[0]).changes || {};

    // -- what each action changed --------------------------------------------------------------
    let changes = changesOf(await click("Do nothing"));
    check(
      changes.dom === "none" && !changes.url && !changes.dialog,
      "a click that changes nothing says dom: none, and nothing else",
      JSON.stringify(changes),
    );
    changes = changesOf(await click("Add items"));
    check(
      changes.dom === "some",
      "a click that adds a few nodes says dom: some",
      JSON.stringify(changes),
    );
    changes = changesOf(await click("Add many"));
    check(
      changes.dom === "many",
      "a click that adds hundreds of nodes says dom: many",
      JSON.stringify(changes),
    );
    changes = changesOf(await click("Show alert"));
    check(
      changes.dialog &&
        changes.dialog.type === "alert" &&
        changes.dialog.message === "Saved",
      "a click that opens a dialog says which, and what it said",
      JSON.stringify(changes),
    );
    changes = changesOf(await click("Log an error"));
    check(
      changes.console_errors === 1,
      "a click that logs an error counts it",
      JSON.stringify(changes),
    );
    changes = changesOf(await click("Focus the name"));
    check(
      changes.focus === 'textbox "Name"',
      "a click that moves focus names the element that has it",
      JSON.stringify(changes),
    );
    changes = changesOf(await click("Next page"));
    check(
      changes.dom === "new document" &&
        String(changes.url || "").endsWith("/page2") &&
        changes.title === "Fixture Page Two",
      "a click that navigates says new document, with the address and title",
      JSON.stringify(changes),
    );

    // -- a snapshot in the same call ------------------------------------------------------------
    const back = await client.tool("browser_back", {
      tab_id: tab,
      snapshot: true,
    });
    const [backJson, ...backRest] = back.text.split("\n");
    const backSnapshot = backRest.join("\n");
    check(
      !back.isError &&
        JSON.parse(backJson).changes.dom === "new document" &&
        backSnapshot.includes("[ref=") &&
        backSnapshot.includes('"Add a button"'),
      "an action asked for a snapshot returns the page after it, refs and all",
      back.text.slice(0, 600),
    );
    snapshot = backSnapshot;
    const usable = await client.tool("browser_click", {
      tab_id: tab,
      ref: refFor(backSnapshot, "Do nothing"),
    });
    check(
      !usable.isError,
      "the refs in that snapshot work at once, with no browser_snapshot between",
      usable.text,
    );

    // -- a page that has not changed -------------------------------------------------------------
    const first = (
      await client.tool("browser_snapshot", { tab_id: tab, if_changed: true })
    ).text;
    const second = (
      await client.tool("browser_snapshot", { tab_id: tab, if_changed: true })
    ).text;
    check(
      /unchanged since snapshot \d+ \(\d+ elements\)/.test(second) &&
        second.length < 400,
      "a snapshot of a page that has not changed is one line",
      second.slice(0, 400),
    );
    // The first may already be one line: it repeats the snapshot the back action returned. Its
    // refs are that snapshot's, still in hand.
    void first;
    await click("Add a button");
    const third = (
      await client.tool("browser_snapshot", { tab_id: tab, if_changed: true })
    ).text;
    const marked = third.split("\n").filter((line) => line.includes("*[ref="));
    check(
      marked.length === 1 && marked[0].includes('"Added button 1"'),
      "a changed page comes back whole, with only the new ref marked",
      marked.join(" | ") || third.slice(0, 600),
    );
    snapshot = third;

    // -- a form in one call -----------------------------------------------------------------------
    const fields = [
      { ref: refFor(snapshot, "Name"), value: "Ada" },
      { ref: refFor(snapshot, "Size"), value: "Large" },
      { ref: refFor(snapshot, "Subscribe"), value: "true" },
      { ref: refFor(snapshot, "Pro"), value: "true" },
      { ref: refFor(snapshot, "Notes"), value: "hello" },
    ];
    const filled = await client.tool("browser_fill_form", {
      tab_id: tab,
      fields,
    });
    const filledReply = filled.isError ? {} : JSON.parse(filled.text);
    const formStatus = async () =>
      (
        await client.json("browser_read", { tab_id: tab, format: "text" })
      ).content.match(/form: [^\n]*/)?.[0];
    const statusAfter = await formStatus();
    check(
      !filled.isError &&
        filledReply.filled === 5 &&
        statusAfter ===
          "form: name=Ada;size=l;subscribe=yes;plan=pro;notes=hello",
      "a text field, a select, a checkbox, a radio and a textarea fill in one call",
      filled.text + " / " + statusAfter,
    );
    const halfway = await client.tool("browser_fill_form", {
      tab_id: tab,
      fields: [
        { ref: refFor(snapshot, "Name"), value: "Grace" },
        { ref: refFor(snapshot, "Locked"), value: "x" },
        { ref: refFor(snapshot, "Size"), value: "Small" },
      ],
    });
    const statusHalfway = await formStatus();
    check(
      halfway.isError &&
        /field 2 \(e\d+\): it is disabled/.test(halfway.text) &&
        /The 1 field before it was filled/.test(halfway.text) &&
        String(statusHalfway).includes("name=Grace;size=l;"),
      "a field that cannot be filled stops the form there, and says which and how far it got",
      halfway.text + " / " + statusHalfway,
    );
    const noOption = await client.tool("browser_fill_form", {
      tab_id: tab,
      fields: [{ ref: refFor(snapshot, "Size"), value: "Huge" }],
    });
    check(
      noOption.isError && /has no option "Huge"/.test(noOption.text),
      "a select asked for an option it does not have says so",
      noOption.text,
    );

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
    ok: failure === null && failed.length === 0 && checks.length === 14,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
