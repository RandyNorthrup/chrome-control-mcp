// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import {
  jsonContent,
  lineFor,
  McpClient,
  refFor,
  textContent,
} from "./mcp_client.mjs";

const EXPECTED_TOOLS = [
  "browser_extension_install",
  "browser_extension_uninstall",
  "browser_extension_status",
  "browser_navigate",
  "browser_snapshot",
  "browser_find",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_read",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_scroll",
  "browser_dialog",
  "browser_click_at",
  "browser_hover",
  "browser_drag",
  "browser_select",
  "browser_set_value",
  "browser_fill_form",
  "browser_media",
  "browser_tabs",
  "browser_select_tab",
  "browser_new_tab",
  "browser_close_tab",
  "browser_group_tabs",
  "browser_ungroup_tabs",
  "browser_windows",
  "browser_window",
  "browser_wait_for",
  "browser_get_value",
  "browser_get_attribute",
  "browser_box",
  "browser_focus",
  "browser_reveal",
  "browser_emulate",
  "browser_print",
  "browser_permission",
  "browser_storage",
  "browser_cookies",
  "browser_download",
  "browser_http_auth",
  "browser_js_click",
  "browser_upload",
  "browser_console",
  "browser_network",
  "browser_record_start",
  "browser_record_stop",
];

// Advertised, and deliberately NOT driven here. Kept as an explicit list rather
// than a loosened assertion: a tool that appears in neither list is one nobody
// decided about, and that still fails this suite.
//
// This list is the reason the suite exists in its current shape. It used to
// demand that the live catalog equal EXPECTED_TOOLS exactly, so adding a tool
// without driving it aborted the run at its first assertion, before a single
// tool was exercised. That is what the update tools and then the recording
// tools did -- and the CI step piped this suite into tee without pipefail, so
// the failure was reported as success for every release since.
const NOT_EXERCISED_HERE = new Map([
  ["browser_update_check", "reaches the network; covered by test_updater"],
  ["browser_update_status", "reads the install layout, not the browser"],
  ["browser_update_apply", "replaces the program on disk; never in a test run"],
  [
    "browser_release",
    "closes the tabs this suite works in; driven by multi_agent_e2e.mjs",
  ],
  [
    "browser_clipboard",
    "needs a second agent and the user's clipboard to mean anything; driven by clipboard_e2e.mjs",
  ],
]);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function assertIncludes(value, expected, message) {
  assert.ok(
    String(value).includes(expected),
    `${message}: expected ${JSON.stringify(expected)} in ${String(value).slice(0, 800)}`,
  );
}

function assertSafeGeneratedPath(filePath, expectedNamePart, extension) {
  assert.equal(
    path.isAbsolute(filePath),
    true,
    `Generated path is not absolute: ${filePath}`,
  );
  assertIncludes(
    path.basename(filePath).toLowerCase(),
    expectedNamePart.toLowerCase(),
    "Generated filename marker",
  );
  assert.equal(
    path.extname(filePath).toLowerCase(),
    extension,
    `Generated file extension: ${filePath}`,
  );
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");
  const executable = path.resolve(
    process.argv[2] ||
      path.join(
        repoRoot,
        "dist",
        process.platform === "win32"
          ? "chrome_control_mcp.exe"
          : "chrome_control_mcp",
      ),
  );
  const showcaseDir = process.env.CHROME_CONTROL_MCP_SHOWCASE_DIR
    ? path.resolve(process.env.CHROME_CONTROL_MCP_SHOWCASE_DIR)
    : null;
  assert.ok(existsSync(executable), `MCP executable not found: ${executable}`);

  const fixture = await startFixtureServer();
  const client = new McpClient(executable);
  const seen = new Set();
  const cases = [];
  const generatedFiles = new Set();
  let originalActiveTabId = null;
  let originalActiveTabUrl = null;
  let originalWindowId = null;
  let createdWindowId = null;
  let cookieName = null;
  let failure = null;
  let attachMilliseconds = null;
  let fixtureTabsClosed = false;
  // The session starts in the user's window, moves to the one it creates, and is sent back.
  let sessionIsInUsersWindow = true;
  const platformNotes = [];

  // The tab the user had in front when the run began. The session works in tabs it opened in the
  // background; after every call the user's tab must still be the one in front of its window.
  const userTabInFront = async (label) => {
    const listing = jsonContent(
      await client.request("tools/call", {
        name: "browser_tabs",
        arguments: {},
      }),
    );
    const userTab = listing.tabs.find((tab) => tab.id === originalActiveTabId);
    if (!userTab) {
      // browser_tabs lists the SESSION's window. While the session is working in a window of its
      // own, the user's tab is simply not in this listing; anywhere else, it is gone.
      if (sessionIsInUsersWindow) {
        // Which tab was taken for the user's, and what the window holds now: without both, a
        // failure here cannot say whether a tool closed a tab or the baseline caught the wrong one.
        const now = listing.tabs
          .map((tab) => `${tab.id}${tab.active ? "*" : ""} ${tab.url}`)
          .join("; ");
        throw new Error(
          `${label} closed the user's tab (${originalActiveTabId} ${originalActiveTabUrl}); the window now holds: ${now}`,
        );
      }
      return;
    }
    if (!userTab.active) {
      const front = listing.tabs.find((tab) => tab.active);
      throw new Error(
        `${label} changed the user's tab: ${front ? front.url : "no tab"} is in front`,
      );
    }
  };

  const runTool = async (name, args, label = name, timeoutMs = 45000) => {
    const started = Date.now();
    const result = await client.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    const text = textContent(result);
    if (result.isError) {
      throw new Error(`${label} failed: ${text}`);
    }
    // browser_dialog arms a response for the NEXT command alone; a listing here would be that
    // command and spend the arm. It never touches a tab, and the next call's check follows.
    if (originalActiveTabId !== null && name !== "browser_dialog") {
      await userTabInFront(label);
    }
    seen.add(name);
    cases.push({
      tool: name,
      case: label,
      milliseconds: Date.now() - started,
      status: "passed",
    });
    process.stderr.write(`PASS ${name} :: ${label}\n`);
    return result;
  };

  const snapshot = async (label) =>
    textContent(await runTool("browser_snapshot", {}, label));
  const tabs = async (label) =>
    jsonContent(await runTool("browser_tabs", {}, label));
  // Closes every fixture tab and answers whether any is left, so the report states what happened
  // rather than a constant.
  const closeFixtureTabs = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const listing = jsonContent(
        await client.request("tools/call", {
          name: "browser_tabs",
          arguments: {},
        }),
      );
      const owned = listing.tabs.filter((tab) =>
        String(tab.url || "").startsWith(fixture.origin),
      );
      if (owned.length === 0) {
        break;
      }
      const target = owned.sort((a, b) => b.index - a.index)[0];
      await client.request("tools/call", {
        name: "browser_close_tab",
        arguments: { index: target.index },
      });
    }
    const left = jsonContent(
      await client.request("tools/call", {
        name: "browser_tabs",
        arguments: {},
      }),
    ).tabs.filter((tab) => String(tab.url || "").startsWith(fixture.origin));
    return left.length === 0;
  };

  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chrome-control-mcp-full-e2e", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "chrome-control-mcp");
    client.notify("notifications/initialized");

    const catalog = await client.request("tools/list");
    const names = catalog.tools.map((tool) => tool.name).sort();
    // Everything this suite drives must still be there,
    assert.deepEqual(
      names.filter((name) => !NOT_EXERCISED_HERE.has(name)),
      [...EXPECTED_TOOLS].sort(),
      "Live tool catalog drifted",
    );
    // and every tool the server offers must be one somebody decided about.
    assert.deepEqual(
      names.filter(
        (name) =>
          !EXPECTED_TOOLS.includes(name) && !NOT_EXERCISED_HERE.has(name),
      ),
      [],
      "A tool is advertised that this suite neither drives nor excuses",
    );
    attachMilliseconds = await waitForExtensionAttached(async (name, args) => {
      const result = await client.request("tools/call", {
        name,
        arguments: args,
      });
      return { isError: Boolean(result.isError), text: textContent(result) };
    });

    const extensionStatus = jsonContent(
      await runTool(
        "browser_extension_status",
        {},
        "extension status prepared",
      ),
    );
    assert.equal(extensionStatus.state, "prepared");
    assert.equal(extensionStatus.extension_present, true);
    const extensionInstall = jsonContent(
      await runTool(
        "browser_extension_install",
        {},
        "extension install idempotent",
      ),
    );
    assert.equal(extensionInstall.state, "prepared");

    let baselineTabs = await tabs("capture baseline tabs");
    // The harness opens chrome://extensions to turn Developer mode on and closes it before the
    // suite starts. Gone from DevTools' target list, it can still be listed -- active -- for a
    // moment by the tabs the extension sees (measured: one run in eight took it as the user's
    // tab, which then vanished). It is never the user's tab, so the baseline waits it out.
    const harnessPage = (listing) =>
      String(
        (listing.tabs.find((tab) => tab.active) || {}).url || "",
      ).startsWith("chrome://extensions");
    for (let wait = 0; wait < 50 && harnessPage(baselineTabs); wait += 1) {
      await sleep(100);
      baselineTabs = jsonContent(
        await client.request("tools/call", {
          name: "browser_tabs",
          arguments: {},
        }),
      );
    }
    const baselineActive = baselineTabs.tabs.find((tab) => tab.active);
    assert.ok(baselineActive, "No active baseline tab");
    originalActiveTabId = baselineActive.id;
    originalActiveTabUrl = baselineActive.url;

    const baselineWindows = jsonContent(
      await runTool("browser_windows", {}, "capture baseline windows"),
    );
    const baselineWindow =
      baselineWindows.windows.find((window) => window.focused) ||
      baselineWindows.windows.find(
        (window) => window.tab_count === baselineTabs.count,
      ) ||
      [...baselineWindows.windows].sort(
        (left, right) => (right.tab_count || 0) - (left.tab_count || 0),
      )[0];
    assert.ok(baselineWindow, "No baseline browser window");
    originalWindowId = baselineWindow.window_id;
    // Which Chrome window (if any) holds OS focus right now. Nothing the session does may change
    // it: the user keeps typing wherever they were.
    const osFocus = (listing) =>
      listing.windows
        .filter((window) => window.focused)
        .map((window) => window.window_id);
    let baselineOsFocus = osFocus(baselineWindows);
    if (baselineOsFocus.length === 0) {
      // Every later comparison is [] against [], which no focus change could fail. Recorded, so
      // the report does not read as proof that focus stayed put.
      platformNotes.push(
        "no window reported OS focus: the focus checks compared nothing",
      );
    }
    // Focus changes land asynchronously (a compositor grants them a frame or two later), so let
    // them settle before reading: an immediate read would pass a steal that is still in flight.
    const assertOsFocusUnchanged = async (label) => {
      await sleep(1000);
      const now = jsonContent(await runTool("browser_windows", {}, label));
      assert.deepEqual(
        osFocus(now),
        baselineOsFocus,
        `OS focus moved (${label})`,
      );
    };

    const opened = jsonContent(
      await runTool(
        "browser_new_tab",
        { url: `${fixture.origin}/` },
        "open fixture tab",
      ),
    );
    assert.equal(opened.load_complete, true);
    assertIncludes(opened.url, fixture.origin, "Fixture tab URL");

    let page = await snapshot("snapshot fixture home");
    assertIncludes(
      page,
      "Chrome Control MCP E2E Fixture",
      "Fixture snapshot title",
    );
    const pageTwoRef = refFor(page, "Fixture Page Two");
    const inputRef = refFor(page, "Fixture text input");
    const selectRef = refFor(page, "Fixture select");
    const multiSelectRef = refFor(page, "Fixture multiple select");
    const checkboxRef = refFor(page, "Fixture checkbox");
    const rangeRef = refFor(page, "Fixture range");
    const normalButtonRef = refFor(page, "Fixture click button");
    refFor(page, "Fixture JS button");
    refFor(page, "Fixture coordinate button");
    refFor(page, "Open fixture prompt");
    const hoverRef = refFor(page, "Fixture hover target");
    const dragSourceRef = refFor(page, "Fixture drag source");
    const dragTargetRef = refFor(page, "Fixture drag target");
    const mediaRef = refFor(page, "Fixture audio");
    const scrollRegionRef = refFor(page, "Fixture scroll region");
    const deepTargetRef = refFor(page, "Fixture deep target");
    // Controls the page wires up itself. Nothing about their role or focusability says they can
    // be acted on -- to the accessibility tree they are "generic" -- so before the capture read
    // Chrome's own isClickable, the page's own handler attributes and the computed cursor, they
    // reached the model as scenery it could see and not touch. refFor throws when a name has no
    // ref, so these four lines ARE the assertion.
    const wiredClickRef = refFor(page, "Fixture wired click");
    const wiredHoverRef = refFor(page, "Fixture wired hover");
    const pointerCardRef = refFor(page, "Fixture pointer card");
    // And the reason each one earned it, which is what tells a reader why a "generic" has a ref.
    assertIncludes(
      lineFor(page, "Fixture wired click"),
      "clickable",
      "the click-wired div says why it is actionable",
    );
    assertIncludes(
      lineFor(page, "Fixture wired hover"),
      "hoverable",
      "the hover-wired div says why it is actionable",
    );
    assertIncludes(
      lineFor(page, "Fixture pointer card"),
      "pointer",
      "the styled card says why it is actionable",
    );
    // cursor is INHERITED: the child inside the card computes "pointer" too, and promoting on the
    // computed value alone would turn one clickable card into a ref for every part of it.
    assert.equal(
      lineFor(page, "Fixture pointer card child"),
      null,
      "the child inside the pointer card must not earn a ref of its own",
    );

    const textRead = jsonContent(
      await runTool("browser_read", { format: "text" }, "read page text"),
    );
    assertIncludes(
      textRead.content,
      "Chrome Control MCP E2E Fixture",
      "Text read",
    );
    const htmlRead = jsonContent(
      await runTool("browser_read", { format: "html" }, "read page HTML"),
    );
    assertIncludes(htmlRead.content, 'data-e2e="page-two"', "HTML read");

    const attribute = jsonContent(
      await runTool(
        "browser_get_attribute",
        { ref: pageTwoRef, name: "data-e2e" },
        "read element attribute",
      ),
    );
    assert.equal(attribute.value, "page-two");

    const inputBox = jsonContent(
      await runTool("browser_box", { ref: inputRef }, "measure input box"),
    );
    assert.equal(inputBox.laid_out, true);
    assert.ok(inputBox.width > 0 && inputBox.height > 0);
    const inputFocused = jsonContent(
      await runTool("browser_focus", { ref: inputRef }, "focus input"),
    );
    assert.equal(inputFocused.focused, true);

    await runTool(
      "browser_type",
      { ref: inputRef, text: "first value" },
      "type initial value",
    );
    let value = jsonContent(
      await runTool("browser_get_value", { ref: inputRef }, "read typed value"),
    );
    assert.equal(value.value, "first value");
    // Select All is Command+A on macOS; Control+A there moves to the start of the
    // paragraph, exactly as it does for a person typing.
    await runTool(
      "browser_press_key",
      { keys: process.platform === "darwin" ? "Meta+A" : "Control+A" },
      "select input text with keyboard",
    );
    await runTool(
      "browser_type",
      { ref: inputRef, text: "replacement value" },
      "replace selected value",
    );
    value = jsonContent(
      await runTool(
        "browser_get_value",
        { ref: inputRef },
        "verify replacement value",
      ),
    );
    assert.equal(value.value, "replacement value");

    const selected = jsonContent(
      await runTool(
        "browser_select",
        { ref: selectRef, value: "beta" },
        "select single option",
      ),
    );
    assert.equal(selected.value, "beta");
    const multiSelected = jsonContent(
      await runTool(
        "browser_select",
        { ref: multiSelectRef, values: ["one", "three"] },
        "select multiple options",
      ),
    );
    assert.equal(multiSelected.multiple, true);

    const checked = jsonContent(
      await runTool(
        "browser_set_value",
        { ref: checkboxRef, checked: true },
        "check checkbox",
      ),
    );
    assert.equal(checked.checked, true);
    const ranged = jsonContent(
      await runTool(
        "browser_set_value",
        { ref: rangeRef, value: "73" },
        "set range value",
      ),
    );
    assert.equal(ranged.value, "73");
    // The same two controls again, in one call, at the values they already hold: what the rest of
    // the suite reads from them stays as it was.
    const formFilled = jsonContent(
      await runTool(
        "browser_fill_form",
        {
          fields: [
            { ref: selectRef, value: "Beta" },
            { ref: checkboxRef, value: "true" },
          ],
        },
        "fill a select and a checkbox in one call",
      ),
    );
    assert.equal(formFilled.filled, 2);
    assert.equal(typeof formFilled.changes.dom, "string");

    // A real file, from this machine's disk, into the page's own file input. The page reports
    // back what IT received, so the check is the page's view of the bytes rather than the
    // tool's account of them: a tool that reported success while delivering nothing, or half a
    // file, or a file under the wrong name, fails here.
    const uploadDir = await mkdtemp(path.join(tmpdir(), "ccm-upload-"));
    const uploadPath = path.join(uploadDir, "fixture-upload.txt");
    const uploadBody = `chrome-control-mcp upload ${Date.now()}`;
    await writeFile(uploadPath, uploadBody, "utf8");
    try {
      const fileInputRef = refFor(page, "Fixture file input");
      const uploaded = jsonContent(
        await runTool(
          "browser_upload",
          { ref: fileInputRef, paths: [uploadPath] },
          "upload a file to the file input",
        ),
      );
      assert.equal(uploaded.files.length, 1);
      assert.equal(uploaded.files[0].name, "fixture-upload.txt");
      assert.equal(uploaded.files[0].size, Buffer.byteLength(uploadBody));
      const sawFile = jsonContent(
        await runTool(
          "browser_wait_for",
          {
            text: `file:fixture-upload.txt:${Buffer.byteLength(uploadBody)}:${uploadBody}`,
            timeout_ms: 3000,
          },
          "the page read the uploaded file's own bytes",
        ),
      );
      assert.equal(sawFile.satisfied, true);

      // The case that matters on the real web: the input is display:none behind a styled
      // label, so it has no box and no accessibility node. Both ways of naming it must work --
      // the label a person would click, and the input itself, which only reaches the snapshot
      // because file inputs are collected whether the page shows them or not.
      const hiddenBody = `hidden pick ${Date.now()}`;
      const hiddenPath = path.join(uploadDir, "hidden-upload.txt");
      await writeFile(hiddenPath, hiddenBody, "utf8");

      const labelRef = refFor(page, "Fixture hidden file picker");
      const viaLabel = jsonContent(
        await runTool(
          "browser_upload",
          { ref: labelRef, paths: [hiddenPath] },
          "upload through the control that opens a hidden input",
        ),
      );
      assert.equal(viaLabel.files[0].name, "hidden-upload.txt");
      const sawHidden = jsonContent(
        await runTool(
          "browser_wait_for",
          {
            text: `hidden:hidden-upload.txt:${Buffer.byteLength(hiddenBody)}:${hiddenBody}`,
            timeout_ms: 3000,
          },
          "the page read the file delivered through its label",
        ),
      );
      assert.equal(sawHidden.satisfied, true);

      // And by naming the hidden input directly, which the snapshot flags as hidden.
      const snapshotText = textContent(
        await runTool("browser_snapshot", {}, "snapshot names hidden inputs"),
      );
      assert.match(
        snapshotText,
        /filechooser "Fixture hidden file input" \[ref=e\d+\] \(hidden\)/,
      );
      const hiddenRef = refFor(snapshotText, "Fixture hidden file input");
      const secondBody = `named directly ${Date.now()}`;
      const secondPath = path.join(uploadDir, "direct-upload.txt");
      await writeFile(secondPath, secondBody, "utf8");
      const viaInput = jsonContent(
        await runTool(
          "browser_upload",
          { ref: hiddenRef, paths: [secondPath] },
          "upload to a hidden input named directly",
        ),
      );
      assert.equal(viaInput.files[0].name, "direct-upload.txt");
      const sawSecond = jsonContent(
        await runTool(
          "browser_wait_for",
          {
            text: `hidden:direct-upload.txt:${Buffer.byteLength(secondBody)}:${secondBody}`,
            timeout_ms: 3000,
          },
          "the page read the file put straight into its hidden input",
        ),
      );
      assert.equal(sawSecond.satisfied, true);
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }

    await runTool(
      "browser_click",
      { ref: normalButtonRef },
      "click normal button",
    );
    const normalWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { text: "normal-clicked", timeout_ms: 3000 },
        "wait for click result",
      ),
    );
    assert.equal(normalWait.satisfied, true);

    await runTool("browser_reveal", { ref: hoverRef }, "reveal hover target");
    await runTool(
      "browser_hover",
      { ref: hoverRef, duration_ms: 100 },
      "hover target",
    );
    const hoverWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { text: "hovered", timeout_ms: 3000 },
        "wait for hover result",
      ),
    );
    assert.equal(hoverWait.satisfied, true);

    await runTool(
      "browser_reveal",
      { ref: dragSourceRef },
      "reveal drag targets",
    );
    await runTool(
      "browser_drag",
      { ref: dragSourceRef, to_ref: dragTargetRef, steps: 8, hold_ms: 40 },
      "drag source to target",
    );
    const dragWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { text: "dragged", timeout_ms: 3000 },
        "wait for drag result",
      ),
    );
    assert.equal(dragWait.satisfied, true);

    await runTool("browser_reveal", { ref: mediaRef }, "reveal media control");
    const media = jsonContent(
      await runTool(
        "browser_media",
        { ref: mediaRef, action: "volume", value: "0.4" },
        "set media volume",
      ),
    );
    assert.equal(media.volume, 0.4);

    // What the page said, and what it fetched. Both exist because the alternative an agent
    // reaches for is arbitrary JavaScript evaluation, which would void most of this project's
    // defenses at once. The fixture's diagnostics button produces one of each kind in a single
    // click: a log, an error the page printed, a request that 404s, and an exception nobody
    // catches.
    const diagnosticsRef = refFor(page, "Fixture diagnostics");
    await runTool(
      "browser_reveal",
      { ref: diagnosticsRef },
      "reveal diagnostics",
    );
    await runTool(
      "browser_click",
      { ref: diagnosticsRef },
      "click diagnostics",
    );
    // The uncaught throw is queued on a timer and the 404 has to reach the server, so neither is
    // in the buffer the instant the click returns.
    await sleep(1200);

    const consoleReply = jsonContent(
      await runTool("browser_console", {}, "read the page's console"),
    );
    const consoleText = consoleReply.entries
      .map((entry) => entry.text)
      .join("\n");
    assertIncludes(
      consoleText,
      "fixture console line",
      "console.log was captured",
    );
    assertIncludes(
      consoleText,
      "fixture console error",
      "console.error was captured",
    );
    // The one that matters most: a click that appears to do nothing usually threw, and until
    // this tool existed nothing could see it.
    assertIncludes(
      consoleText,
      "fixture uncaught failure",
      "an uncaught exception was captured",
    );
    const thrown = consoleReply.entries.find((entry) =>
      entry.text.includes("fixture uncaught failure"),
    );
    assert.equal(thrown.level, "error", "an uncaught throw is an error");
    assert.equal(
      thrown.source,
      "exception",
      "and is marked as an exception, not a log",
    );

    // A level filter answers a narrower question, and an unknown level is refused rather than
    // silently answering the wider one.
    const onlyErrors = jsonContent(
      await runTool(
        "browser_console",
        { level: "error" },
        "read only console errors",
      ),
    );
    assert.equal(
      onlyErrors.entries.every((entry) => entry.level === "error"),
      true,
      "a level filter returns only that level",
    );
    const badLevel = await client.tool("browser_console", {
      level: "catastrophe",
    });
    assert.equal(badLevel.isError, true, "an unknown console level is refused");

    const network = jsonContent(
      await runTool(
        "browser_network",
        { limit: 200 },
        "read the page's requests",
      ),
    );
    assert.ok(
      network.total > 0,
      // Everything the reply knows, because "no requests" has several very different causes:
      // nothing was recorded, the ring discarded them, or they are still in flight.
      `no requests were recorded at all: ${JSON.stringify(network)}`,
    );
    const urls = network.requests.map((request) => request.url);
    assert.ok(
      urls.some((url) => url.startsWith(fixture.origin)),
      `no request to the fixture was listed; got ${JSON.stringify(urls.slice(0, 10))}`,
    );
    // Inline content is not network activity, and the media element's controls alone load dozens
    // of data: icons -- enough to fill the ring and push out everything the page really asked
    // for, which is exactly what happened the first time this ran.
    assert.equal(
      urls.some((url) => url.startsWith("data:") || url.startsWith("blob:")),
      false,
      "data: and blob: URLs must not crowd out real requests",
    );
    // A form POST that redirects is TWO hops under one requestId. Logging only the hop that
    // survived meant a POST 302 was reported as the GET that followed -- which defeats the one
    // thing the tool is for, confirming that a form actually posted.
    const posted = network.requests.find(
      (request) =>
        request.method === "POST" && request.url.includes("/api/redirect"),
    );
    assert.ok(
      posted,
      `the redirecting POST was not logged: ${JSON.stringify(network.requests.map((r) => r.method + " " + r.url))}`,
    );
    assert.equal(
      posted.status,
      302,
      "and it is logged with the redirect status",
    );
    assert.ok(
      String(posted.redirected_to).includes("/api/landed"),
      `the redirect target is not reported: ${JSON.stringify(posted)}`,
    );
    // The hop it redirected to is its own entry, so both are visible.
    assert.ok(
      network.requests.some((request) => request.url.includes("/api/landed")),
      "the request the redirect landed on is logged too",
    );

    const failures = jsonContent(
      await runTool(
        "browser_network",
        { failed_only: true },
        "read only failed requests",
      ),
    );
    const missingRequest = failures.requests.find((request) =>
      request.url.includes("/api/missing"),
    );
    assert.ok(
      missingRequest,
      `the 404 was not reported: ${JSON.stringify(failures)}`,
    );
    assert.equal(
      missingRequest.status,
      404,
      "and it is reported with its status",
    );
    assert.equal(missingRequest.method, "GET");

    // Recording, end to end. It shipped in 1.5.0 with no live coverage at all -- the suite said
    // so in NOT_EXERCISED_HERE -- so a start that failed on its first real call was exactly how
    // "canvas.captureStream is not a function" reached a release.
    const recordingName = `e2e-${Date.now()}.webm`;
    const started = jsonContent(
      await runTool(
        "browser_record_start",
        { filename: recordingName },
        "start recording",
      ),
    );
    assert.equal(started.ok, true, "recording started");
    // A second start must be refused rather than silently replacing the first.
    const secondStart = await client.tool("browser_record_start", {});
    assert.equal(
      secondStart.isError,
      true,
      "a second recording for the same session is refused",
    );
    // Something for the video to contain.
    await runTool("browser_reveal", { ref: hoverRef }, "move while recording");
    await sleep(1500);
    const stopped = jsonContent(
      await runTool("browser_record_stop", {}, "stop recording"),
    );
    assertSafeGeneratedPath(stopped.path, "e2e-", ".webm");
    const video = await stat(stopped.path);
    // A zero-byte file is what a recorder that captured nothing writes; the tool is supposed to
    // refuse that rather than hand back an empty video.
    assert.ok(
      video.size > 1024,
      `recording is too small to contain anything: ${video.size} bytes`,
    );
    assert.ok(stopped.duration_ms > 0, "the recording reports a duration");
    // The timeline is what makes the video readable against what drove it.
    const timeline = JSON.parse(await readFile(stopped.timeline_path, "utf8"));
    assert.ok(
      Array.isArray(timeline.commands) && timeline.commands.length > 0,
      "the timeline lists the commands that ran while recording",
    );
    // Stopping when nothing is recording is an error, not an empty file.
    const stopAgain = await client.tool("browser_record_stop", {});
    assert.equal(stopAgain.isError, true, "a second stop is refused");

    // The box the server resolves for this ref, taken before the scroll. When the scroll reports
    // that it moved nothing, the question is always whether it was aimed at this element at all,
    // and the reply's own point can only be read against the box it was supposed to come from.
    const scrollRegionBox = jsonContent(
      await runTool(
        "browser_box",
        { ref: scrollRegionRef },
        "box of the nested scroll region",
      ),
    );
    // Where an element INSIDE the scroller sits before the wheel. What the reply claims has to
    // match what the page did, and a scroll that reports 0 for a container it just moved is the
    // fault this measures: the scrollers were matched between the two reads by a name that
    // counted ancestors up from whatever the point landed on, so scrolling the content out from
    // under the point renamed the very container that had moved. The rows inside the region are
    // deliberately of different depths for that reason.
    const nested = jsonContent(
      await runTool(
        "browser_scroll",
        { ref: scrollRegionRef, direction: "down", amount: 180 },
        "scroll nested region",
      ),
    );
    assert.equal(nested.settled, true, "The nested scroll never came to rest");
    assert.ok(
      nested.scrolled.y > 0,
      `The nested region did not scroll: ${JSON.stringify(nested)}; ` +
        `the ref ${scrollRegionRef} resolves to ${JSON.stringify(scrollRegionBox)}; ` +
        `it was read off ${JSON.stringify(lineFor(page, "Fixture scroll region"))}`,
    );
    // What the reply claims, against what the page did -- the check that catches a scroll
    // reporting 0 for a container it has just moved.
    //
    // Measured across a SECOND scroll, because aiming at a ref reveals it first: on the call
    // above that reveal scrolled the page by 726 before the wheel moved the container by 180, so
    // measuring across it measures two scrolls and compares them against one. By now the region
    // is in view and its reveal has nothing left to do, which is what makes the two numbers
    // comparable. The rows inside it are of differing depths on purpose: the element under the
    // action point changes as the content moves, which is exactly what used to rename the
    // scroller between the two reads and cost the reply its distance.
    const deepBefore = jsonContent(
      await runTool(
        "browser_box",
        { ref: deepTargetRef },
        "box inside the nested scroller, before",
      ),
    );
    const nestedAgain = jsonContent(
      await runTool(
        "browser_scroll",
        { ref: scrollRegionRef, direction: "down", amount: 180 },
        "scroll nested region again",
      ),
    );
    const deepAfter = jsonContent(
      await runTool(
        "browser_box",
        { ref: deepTargetRef },
        "box inside the nested scroller, after",
      ),
    );
    assert.ok(
      nestedAgain.scrolled.y > 0,
      `The second nested scroll moved nothing: ${JSON.stringify(nestedAgain)}`,
    );
    assert.ok(
      Math.abs(deepBefore.y - deepAfter.y - nestedAgain.scrolled.y) <= 1,
      `The nested scroll reported ${JSON.stringify(nestedAgain.scrolled)} but the content ` +
        `inside it moved ${deepBefore.y - deepAfter.y}px`,
    );
    // The reply says the page is already where it says it is -- measured on the page, not taken
    // from the reply: an element's box must have moved by exactly what the scroll reported.
    // Revealed first, so the scroll's own bringing-into-view does not move the page as well.
    await runTool(
      "browser_reveal",
      { ref: pageTwoRef },
      "reveal the page-scroll anchor",
    );
    const beforeScroll = jsonContent(
      await runTool("browser_box", { ref: hoverRef }, "box before page scroll"),
    );
    // Over an element outside the nested scroller: a wheel latches onto the scroller under it, and
    // the one scrolled a moment ago is at its end.
    const pageScroll = jsonContent(
      await runTool(
        "browser_scroll",
        { ref: pageTwoRef, direction: "down", amount: 200 },
        "scroll the page",
      ),
    );
    assert.ok(
      pageScroll.scrolled.y > 0,
      `The page did not scroll: ${JSON.stringify(pageScroll)}`,
    );
    const afterScroll = jsonContent(
      await runTool("browser_box", { ref: hoverRef }, "box after page scroll"),
    );
    assert.equal(
      pageScroll.settled,
      true,
      "The page scroll never came to rest",
    );
    assert.ok(
      Math.abs(beforeScroll.y - afterScroll.y - pageScroll.scrolled.y) <= 1,
      `Scroll reported ${JSON.stringify(pageScroll.scrolled)} but the page moved ` +
        `${beforeScroll.y - afterScroll.y}px`,
    );
    await runTool(
      "browser_scroll",
      { direction: "up", amount: 100000 },
      "scroll back to the top",
    );

    // A ref that cannot be acted on is no better than no ref. Both of these are driven through
    // the ordinary tools, and the page is asked what happened.
    await runTool(
      "browser_click",
      { ref: wiredClickRef },
      "click the div the page wired to a click",
    );
    let wiredState = jsonContent(
      await runTool(
        "browser_read",
        { format: "text" },
        "read after wired click",
      ),
    );
    assertIncludes(
      wiredState.content,
      "wired-clicked",
      "the click reached the div's own handler",
    );
    await runTool(
      "browser_hover",
      { ref: wiredHoverRef },
      "hover the div the page wired to a hover",
    );
    wiredState = jsonContent(
      await runTool(
        "browser_read",
        { format: "text" },
        "read after wired hover",
      ),
    );
    assertIncludes(
      wiredState.content,
      "wired-hovered",
      "the hover reached the div's own handler",
    );
    await runTool(
      "browser_click",
      { ref: pointerCardRef },
      "click the card that only looks clickable",
    );
    wiredState = jsonContent(
      await runTool(
        "browser_read",
        { format: "text" },
        "read after card click",
      ),
    );
    assertIncludes(
      wiredState.content,
      "card-clicked",
      "the click reached the card's own handler",
    );
    const revealed = jsonContent(
      await runTool(
        "browser_reveal",
        { ref: deepTargetRef },
        "reveal deep target",
      ),
    );
    assert.equal(revealed.laid_out, true);

    page = await snapshot("refresh refs before dialog and JavaScript click");
    const promptRefFresh = refFor(page, "Open fixture prompt");
    const jsRefFresh = refFor(page, "Fixture JS button");
    const coordinateRefFresh = refFor(page, "Fixture coordinate button");
    await runTool(
      "browser_reveal",
      { ref: promptRefFresh },
      "reveal prompt button",
    );
    const promptBox = jsonContent(
      await runTool(
        "browser_box",
        { ref: promptRefFresh },
        "verify prompt button geometry",
      ),
    );
    assert.equal(
      promptBox.occluded,
      false,
      `Prompt button remains occluded: ${JSON.stringify(promptBox)}`,
    );
    await runTool(
      "browser_dialog",
      { action: "accept", text: "E2E prompt value" },
      "arm prompt acceptance",
    );
    await runTool(
      "browser_click",
      { ref: promptRefFresh },
      "open and accept prompt",
    );
    const dialog = jsonContent(
      await runTool("browser_dialog", {}, "read last dialog"),
    );
    assert.equal(dialog.last_dialog.type, "prompt");
    assert.equal(dialog.last_dialog.accepted, true);
    const promptWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { text: "prompt:E2E prompt value", timeout_ms: 3000 },
        "wait for prompt result",
      ),
    );
    assert.equal(promptWait.satisfied, true);

    await runTool(
      "browser_reveal",
      { ref: jsRefFresh },
      "reveal JavaScript-click target",
    );
    await runTool(
      "browser_js_click",
      { ref: jsRefFresh },
      "JavaScript click fallback",
    );
    const jsWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { text: "js-clicked", timeout_ms: 3000 },
        "wait for JavaScript click result",
      ),
    );
    assert.equal(jsWait.satisfied, true);

    await runTool(
      "browser_reveal",
      { ref: coordinateRefFresh },
      "reveal coordinate-click target",
    );
    const screenshot = await runTool(
      "browser_screenshot",
      { full_page: false },
      "capture viewport screenshot",
    );
    const screenshotImage = screenshot.content.find(
      (item) => item.type === "image",
    );
    assert.equal(screenshotImage.mimeType, "image/png");
    assert.ok(screenshotImage.data.length > 100);
    if (showcaseDir) {
      const showcase = await runTool(
        "browser_screenshot",
        { full_page: false, include_control_overlay: true },
        "capture fixture screenshot with control overlay",
      );
      const showcaseImage = showcase.content.find(
        (item) => item.type === "image",
      );
      assert.equal(showcaseImage.mimeType, "image/png");
      await mkdir(showcaseDir, { recursive: true });
      await writeFile(
        path.join(showcaseDir, "chrome-control-overlay-fixture.png"),
        Buffer.from(showcaseImage.data, "base64"),
      );
    }
    const coordinateBox = jsonContent(
      await runTool(
        "browser_box",
        { ref: coordinateRefFresh },
        "measure coordinate target",
      ),
    );
    // browser_box geometry is CSS px; browser_click_at takes screenshot px. screenshot_center
    // is the bridge between them, and only it lands on a display scaled away from 100%.
    assert.ok(coordinateBox.screenshot_center, "box reports screenshot_center");
    await runTool(
      "browser_click_at",
      coordinateBox.screenshot_center,
      "coordinate click from screenshot geometry",
    );
    const coordinateWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { text: "coordinate-clicked", timeout_ms: 3000 },
        "wait for coordinate click result",
      ),
    );
    assert.equal(coordinateWait.satisfied, true);

    // The same screenshot -> box -> click_at path across display scales and viewport sizes:
    // 100%/125%/150% desktops, Retina, and dense phones. Each step first resets the result text
    // (JS click) so only a click that lands on the coordinate button at THIS scale satisfies the
    // wait, and checks the PNG headers independently: the view an agent is shown is one pixel per
    // CSS pixel (every viewport here is within its 1568 cap), and a presentation is the viewport
    // times the scale, saved to a file.
    const scaleMatrix = [
      { device_scale_factor: 1, width: 1280, height: 800 },
      { device_scale_factor: 1.25, width: 1024, height: 768 },
      { device_scale_factor: 1.5, width: 800, height: 600 },
      { device_scale_factor: 2, width: 390, height: 844 },
      { device_scale_factor: 3, width: 360, height: 640 },
    ];
    for (const metrics of scaleMatrix) {
      const tag = `${metrics.device_scale_factor}x ${metrics.width}x${metrics.height}`;
      await runTool("browser_emulate", metrics, `emulate ${tag}`);
      page = await snapshot(`refresh refs at ${tag}`);
      const jsRefAtScale = refFor(page, "Fixture JS button");
      const coordinateRefAtScale = refFor(page, "Fixture coordinate button");
      await runTool(
        "browser_js_click",
        { ref: jsRefAtScale },
        `reset at ${tag}`,
      );
      assert.equal(
        jsonContent(
          await runTool(
            "browser_wait_for",
            { text: "js-clicked", timeout_ms: 3000 },
            `reset observed at ${tag}`,
          ),
        ).satisfied,
        true,
      );
      await runTool(
        "browser_reveal",
        { ref: coordinateRefAtScale },
        `reveal at ${tag}`,
      );
      const shotAtScale = await runTool(
        "browser_screenshot",
        { full_page: false },
        `screenshot at ${tag}`,
      );
      const png = Buffer.from(
        shotAtScale.content.find((item) => item.type === "image").data,
        "base64",
      );
      assert.ok(
        Math.abs(png.readUInt32BE(16) - metrics.width) <= 1 &&
          Math.abs(png.readUInt32BE(20) - metrics.height) <= 1,
        `view PNG ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} at ${tag}`,
      );
      const presented = jsonContent(
        await runTool(
          "browser_screenshot",
          { full_page: false, purpose: "presentation" },
          `presentation screenshot at ${tag}`,
        ),
      );
      assertSafeGeneratedPath(presented.saved, "screenshot-", ".png");
      generatedFiles.add(presented.saved);
      const presentedPng = await readFile(presented.saved);
      assert.ok(
        Math.abs(
          presentedPng.readUInt32BE(16) -
            Math.round(metrics.width * metrics.device_scale_factor),
        ) <= 1 && presentedPng.readUInt32BE(16) === presented.width,
        `presentation PNG width ${presentedPng.readUInt32BE(16)} at ${tag}`,
      );
      const boxAtScale = jsonContent(
        await runTool(
          "browser_box",
          { ref: coordinateRefAtScale },
          `measure at ${tag}`,
        ),
      );
      // Chrome carries the scale as a float32, so 1 reads back as 1.0000000298.
      assert.ok(
        Math.abs(boxAtScale.dpr - metrics.device_scale_factor) < 1e-3,
        `dpr ${boxAtScale.dpr} at ${tag}`,
      );
      await runTool(
        "browser_click_at",
        boxAtScale.screenshot_center,
        `coordinate click at ${tag}`,
      );
      assert.equal(
        jsonContent(
          await runTool(
            "browser_wait_for",
            { text: "coordinate-clicked", timeout_ms: 3000 },
            `coordinate click landed at ${tag}`,
          ),
        ).satisfied,
        true,
        `coordinate click missed at ${tag}`,
      );
    }
    await runTool("browser_emulate", { reset: true }, "reset scale matrix");

    const shadowWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { selector: "#shadow-button", timeout_ms: 3000 },
        "wait for shadow selector",
      ),
    );
    assert.equal(shadowWait.satisfied, true);
    const networkWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { network_idle: true, idle_ms: 250, timeout_ms: 5000 },
        "wait for network idle",
      ),
    );
    assert.equal(networkWait.satisfied, true);

    const emulated = jsonContent(
      await runTool(
        "browser_emulate",
        {
          width: 390,
          height: 844,
          device_scale_factor: 2,
          mobile: true,
          touch: true,
          user_agent: "ChromeControlMCP-E2E/1",
        },
        "apply mobile emulation",
      ),
    );
    assert.equal(emulated.applied.width, 390);
    const emulationReset = jsonContent(
      await runTool("browser_emulate", { reset: true }, "reset emulation"),
    );
    assert.equal(emulationReset.reset, true);

    const storageKey = `chrome-control-mcp-e2e-${process.pid}`;
    await runTool(
      "browser_storage",
      {
        action: "set",
        area: "local",
        key: storageKey,
        value: "stored-value",
        expect_origin: fixture.origin,
      },
      "set local storage",
    );
    const storageGet = jsonContent(
      await runTool(
        "browser_storage",
        {
          action: "get",
          area: "local",
          key: storageKey,
          expect_origin: fixture.origin,
        },
        "get local storage",
      ),
    );
    assert.equal(storageGet.value, "stored-value");
    const storageKeys = jsonContent(
      await runTool(
        "browser_storage",
        { action: "keys", area: "local", expect_origin: fixture.origin },
        "list local storage keys",
      ),
    );
    assert.ok(storageKeys.keys.includes(storageKey));
    await runTool(
      "browser_storage",
      {
        action: "remove",
        area: "local",
        key: storageKey,
        expect_origin: fixture.origin,
      },
      "remove local storage key",
    );
    await runTool(
      "browser_storage",
      {
        action: "set",
        area: "session",
        key: storageKey,
        value: "session-value",
        expect_origin: fixture.origin,
      },
      "set session storage",
    );
    await runTool(
      "browser_storage",
      { action: "clear", area: "session", expect_origin: fixture.origin },
      "clear session storage",
    );

    cookieName = `ccmcp_e2e_${process.pid}`;
    await runTool(
      "browser_cookies",
      {
        action: "set",
        url: `${fixture.origin}/`,
        name: cookieName,
        value: "cookie-value",
        path: "/",
        same_site: "lax",
      },
      "set fixture cookie",
    );
    const cookies = jsonContent(
      await runTool(
        "browser_cookies",
        { action: "get", url: `${fixture.origin}/` },
        "read fixture cookies",
      ),
    );
    assert.ok(
      cookies.cookies.some(
        (cookie) =>
          cookie.name === cookieName && cookie.value === "cookie-value",
      ),
    );
    const removedCookie = jsonContent(
      await runTool(
        "browser_cookies",
        { action: "remove", url: `${fixture.origin}/`, name: cookieName },
        "remove fixture cookie",
      ),
    );
    assert.equal(removedCookie.removed, true);
    cookieName = null;

    await runTool(
      "browser_permission",
      { name: "geolocation", setting: "block", origin: fixture.origin },
      "block fixture geolocation",
    );
    await runTool(
      "browser_permission",
      { name: "geolocation", setting: "ask", origin: fixture.origin },
      "restore fixture geolocation",
    );

    const downloadMarker = `chrome-control-mcp-e2e-${process.pid}`;
    const downloaded = jsonContent(
      await runTool(
        "browser_download",
        {
          url: `${fixture.origin}/download.txt`,
          filename: `ChromeControlMCP/${downloadMarker}.txt`,
          timeout_ms: 10000,
        },
        "download fixture file",
        20000,
      ),
    );
    assert.equal(downloaded.ok, true);
    assertSafeGeneratedPath(downloaded.path, downloadMarker, ".txt");
    generatedFiles.add(downloaded.path);
    assert.equal(
      await readFile(downloaded.path, "utf8"),
      "chrome-control-mcp-e2e-download\n",
    );

    const printed = jsonContent(
      await runTool(
        "browser_print",
        { print_background: true, page_ranges: "1", scale: 0.8 },
        "print fixture PDF",
        30000,
      ),
    );
    assert.equal(printed.ok, true);
    assertSafeGeneratedPath(printed.saved, "page-", ".pdf");
    generatedFiles.add(printed.saved);
    const pdfHeader = (await readFile(printed.saved))
      .subarray(0, 5)
      .toString("ascii");
    assert.equal(pdfHeader, "%PDF-");

    const navigated = jsonContent(
      await runTool(
        "browser_navigate",
        { url: `${fixture.origin}/page2` },
        "navigate to page two",
      ),
    );
    assertIncludes(navigated.url, "/page2", "Navigate result");
    const urlWait = jsonContent(
      await runTool(
        "browser_wait_for",
        { url_contains: "/page2", timeout_ms: 3000 },
        "wait for page-two URL",
      ),
    );
    assert.equal(urlWait.satisfied, true);
    assertIncludes(
      await snapshot("snapshot page two"),
      "Fixture history marker",
      "Page-two snapshot",
    );
    const backed = jsonContent(
      await runTool("browser_back", {}, "history back"),
    );
    assertIncludes(backed.url, fixture.origin, "Back URL");
    const forwarded = jsonContent(
      await runTool("browser_forward", {}, "history forward"),
    );
    assertIncludes(forwarded.url, "/page2", "Forward URL");
    const reloaded = jsonContent(
      await runTool("browser_reload", {}, "reload page two"),
    );
    assertIncludes(reloaded.url, "/page2", "Reload URL");
    await runTool(
      "browser_navigate",
      { url: `${fixture.origin}/` },
      "return to fixture home",
    );

    await runTool(
      "browser_http_auth",
      { username: "e2e", password: "pass", origin: fixture.origin },
      "arm HTTP authentication",
    );
    await runTool(
      "browser_navigate",
      { url: `${fixture.origin}/protected` },
      "navigate through HTTP authentication",
    );
    assertIncludes(
      await snapshot("snapshot authenticated page"),
      "AUTH OK",
      "Authenticated page",
    );
    await runTool(
      "browser_http_auth",
      { clear: true },
      "clear HTTP authentication",
    );

    await runTool(
      "browser_new_tab",
      { url: `${fixture.origin}/page2?group=one` },
      "open first group tab",
    );
    await runTool(
      "browser_new_tab",
      { url: `${fixture.origin}/page2?group=two` },
      "open second group tab",
    );
    let groupTabs = await tabs("list tabs before grouping");
    const groupCandidates = groupTabs.tabs.filter((tab) =>
      String(tab.url).includes("group="),
    );
    assert.equal(groupCandidates.length, 2);
    const grouped = jsonContent(
      await runTool(
        "browser_group_tabs",
        {
          tab_indices: groupCandidates.map((tab) => tab.index).join(","),
          title: "MCP E2E",
          color: "pink",
        },
        "group fixture tabs",
      ),
    );
    assert.equal(grouped.tab_count, 2);
    groupTabs = await tabs("refresh tabs after grouping");
    const groupedCandidates = groupTabs.tabs.filter((tab) =>
      String(tab.url).includes("group="),
    );
    const ungrouped = jsonContent(
      await runTool(
        "browser_ungroup_tabs",
        { tab_indices: groupedCandidates.map((tab) => tab.index).join(",") },
        "ungroup fixture tabs",
      ),
    );
    assert.equal(ungrouped.ungrouped, 2);

    const selectListing = await tabs("list tabs before selection");
    const primaryFixture = selectListing.tabs.find(
      (tab) => tab.url === `${fixture.origin}/protected`,
    );
    assert.ok(primaryFixture, "Primary fixture tab missing before selection");
    const selectedTab = jsonContent(
      await runTool(
        "browser_select_tab",
        { index: primaryFixture.index },
        "select primary fixture tab",
      ),
    );
    assert.equal(selectedTab.index, primaryFixture.index);
    await assertOsFocusUnchanged("OS focus after selecting a tab");

    for (const query of ["group=one", "group=two"]) {
      const listing = await tabs(`list tabs before closing ${query}`);
      const target = listing.tabs.find((tab) =>
        String(tab.url).includes(query),
      );
      assert.ok(target, `Missing tab ${query}`);
      const closed = jsonContent(
        await runTool(
          "browser_close_tab",
          { index: target.index },
          `close ${query} tab`,
        ),
      );
      assert.equal(closed.index, target.index);
    }

    const windowsBeforeCreate = jsonContent(
      await runTool("browser_windows", {}, "list windows before create"),
    );
    assert.ok(
      windowsBeforeCreate.windows.some(
        (window) => window.window_id === originalWindowId,
      ),
    );
    // The session lands in the window this creates, so the user's tab leaves the listing from
    // here until it is sent back.
    sessionIsInUsersWindow = false;
    const newWindow = jsonContent(
      await runTool(
        "browser_window",
        { action: "new", url: `${fixture.origin}/page2?window=e2e` },
        "create fixture window",
      ),
    );
    createdWindowId = newWindow.window_id;
    assert.ok(Number.isInteger(createdWindowId));
    const windowsAfterCreate = jsonContent(
      await runTool("browser_windows", {}, "list windows after create"),
    );
    assert.ok(
      windowsAfterCreate.windows.some(
        (window) => window.window_id === createdWindowId,
      ),
    );
    // A new OS window is the one action a compositor may focus against Chrome's request
    // (Hyprland focuses every newly mapped window). The tool must say so rather than take focus
    // silently; on Windows, macOS, X11, and focus-stealing-prevention compositors it never does.
    if (newWindow.took_os_focus) {
      // Checked against the browser's own listing rather than taken on the tool's word: a tool
      // that stole focus could otherwise excuse itself from every check below by saying so.
      assert.ok(
        windowsAfterCreate.windows.some(
          (window) => window.window_id === createdWindowId && window.focused,
        ),
        "The tool reported took_os_focus for a window the browser does not list as focused",
      );
      process.stderr.write(
        "NOTE compositor focused the new window despite focused:false (reported by the tool)\n",
      );
      baselineOsFocus = [createdWindowId];
      platformNotes.push(
        "compositor focused new window; reported as took_os_focus",
      );
    }
    await assertOsFocusUnchanged("OS focus after opening a window");
    const retargeted = jsonContent(
      await runTool(
        "browser_window",
        { action: "focus", window_id: originalWindowId },
        "retarget session to original window",
      ),
    );
    assert.equal(retargeted.session_window, true);
    sessionIsInUsersWindow = true;
    // Back in the user's window, their tab must be there and in front: the check above stood down
    // while the session was away, so this is where that gap is closed.
    await userTabInFront("the session returning to the user's window");
    const retargetedTabs = await tabs("list tabs after window retarget");
    assert.ok(
      retargetedTabs.tabs.some((tab) => tab.id === originalActiveTabId),
      "Session did not move to the original window",
    );
    await assertOsFocusUnchanged("OS focus after window retarget");
    await runTool(
      "browser_window",
      { action: "close", window_id: createdWindowId },
      "close fixture window",
    );
    createdWindowId = null;

    // browser_find, the snapshot's options and paged, scoped reads
    // (docs/plans/lean-observations.md), on a page of their own in a tab of their own.
    const findTab = jsonContent(
      await runTool(
        "browser_new_tab",
        { url: `${fixture.origin}/find` },
        "open the find page",
      ),
    ).tab_id;
    const at = { tab_id: findTab };
    await runTool(
      "browser_wait_for",
      { ...at, text: "sent: no" },
      "the find page loaded",
    );
    const refused = async (name, args, label, pattern) => {
      const began = Date.now();
      const result = await client.request("tools/call", {
        name,
        arguments: args,
      });
      const text = textContent(result);
      assert.ok(result.isError, `${label}: not refused: ${text.slice(0, 300)}`);
      assert.match(text, pattern, `${label}: ${text.slice(0, 300)}`);
      seen.add(name);
      cases.push({
        tool: name,
        case: label,
        milliseconds: Date.now() - began,
        status: "passed",
      });
      process.stderr.write(`PASS ${name} :: ${label}\n`);
      return text;
    };
    const found = textContent(
      await runTool(
        "browser_find",
        { ...at, text: "Send message" },
        "find by visible text",
      ),
    );
    assert.match(
      found,
      /\nFound 2 matches for text "Send message":\n- button "Send message" \[ref=e\d+\]/,
      `the exact match comes first: ${found.slice(0, 600)}`,
    );
    assert.match(
      found,
      /\n {4}in: dialog "Messages" \[ref=e\d+\]/,
      `a match names the dialog it sits in: ${found.slice(0, 600)}`,
    );
    const sendRef = refFor(found, "Send message");
    await runTool(
      "browser_click",
      { ...at, ref: sendRef },
      "click a find result with no snapshot between",
    );
    await runTool(
      "browser_wait_for",
      { ...at, text: "sent: yes" },
      "the click on a find result reached its button",
    );
    assert.match(
      textContent(
        await runTool(
          "browser_find",
          { ...at, text: "View replies (1)" },
          "find a name with brackets and a count",
        ),
      ),
      /- link "View replies \(1\)" \[ref=e\d+\]/,
    );
    assert.match(
      textContent(
        await runTool(
          "browser_find",
          { ...at, query: "Send message button" },
          "find by a phrase whose role word filters",
        ),
      ),
      /Found 1 match for query "Send message button":\n- button "Send message"/,
    );
    const below = textContent(
      await runTool(
        "browser_find",
        { ...at, regex: "^load" },
        "find by pattern, below the fold",
      ),
    );
    assert.match(
      below,
      /- button "Load more" \[ref=e\d+\]\n {4}off-screen/,
      `an element below the fold says so: ${below.slice(0, 600)}`,
    );
    assert.match(
      textContent(
        await runTool(
          "browser_find",
          { ...at, text: "Sned mesage" },
          "find with no match names the closest",
        ),
      ),
      /No element matches text "Sned mesage"\. Closest names: "Send message"/,
    );
    await refused(
      "browser_find",
      at,
      "find with nothing to look for is refused",
      /text[\s\S]*query[\s\S]*regex/,
    );
    await refused(
      "browser_find",
      { ...at, regex: "([a" },
      "find with a broken pattern is refused",
      /does not compile/,
    );

    const dialogRef = (found.match(/in: dialog "Messages" \[ref=(e\d+)\]/) ||
      [])[1];
    const scoped = textContent(
      await runTool(
        "browser_snapshot",
        { ...at, ref: dialogRef },
        "snapshot one region by ref",
      ),
    );
    assert.match(
      scoped,
      /\nshown: \d+ of \d+ lines\n- dialog "Messages" \[ref=/,
    );
    assert.ok(
      !scoped.includes("Load more"),
      "a region's snapshot shows that region alone",
    );
    assert.equal(
      refFor(scoped, "Send message"),
      sendRef,
      "a region's snapshot gives the page's own refs",
    );
    const interactive = textContent(
      await runTool(
        "browser_snapshot",
        { ...at, filter: "interactive" },
        "snapshot the interactive elements",
      ),
    );
    assert.ok(
      !interactive.includes("- statictext") &&
        interactive.includes('button "Load more"'),
      interactive.slice(0, 2000),
    );
    const onScreen = textContent(
      await runTool(
        "browser_snapshot",
        { ...at, filter: "viewport" },
        "snapshot what is on screen",
      ),
    );
    assert.ok(
      onScreen.includes('button "Send message"') &&
        !onScreen.includes('button "Load more"') &&
        /lines off-screen/.test(onScreen),
      onScreen.slice(0, 2000),
    );
    const capped = textContent(
      await runTool(
        "browser_snapshot",
        { ...at, max_chars: 1500 },
        "snapshot within a character cap",
      ),
    );
    assert.ok(
      /lines omitted: browser_snapshot ref=e\d+/.test(capped) &&
        capped.includes("shortened to fit max_chars 1500") &&
        capped.includes("- contentinfo"),
      `the cap collapses regions, not the tail: ${capped.slice(0, 2500)}`,
    );

    const firstPage = jsonContent(
      await runTool("browser_read", at, "read the first page of a long page"),
    );
    assert.ok(
      firstPage.offset === 0 &&
        firstPage.content.length === 30000 &&
        firstPage.next_offset === 30000 &&
        firstPage.total > 30000 &&
        firstPage.total < 60000,
      JSON.stringify({ ...firstPage, content: firstPage.content.length }),
    );
    const secondPage = jsonContent(
      await runTool(
        "browser_read",
        { ...at, offset: firstPage.next_offset },
        "read the next page",
      ),
    );
    assert.ok(
      secondPage.offset === 30000 &&
        secondPage.next_offset === undefined &&
        firstPage.content.length + secondPage.content.length ===
          firstPage.total,
      JSON.stringify({ ...secondPage, content: secondPage.content.length }),
    );
    const story = jsonContent(
      await runTool(
        "browser_read",
        { ...at, selector: "#story" },
        "read one element by selector",
      ),
    );
    assert.ok(
      story.scope === "selector" &&
        story.content.startsWith("Story") &&
        !story.content.includes("Load more"),
      story.content.slice(0, 200),
    );
    const mainText = jsonContent(
      await runTool(
        "browser_read",
        { ...at, mode: "main", max_chars: 200000 },
        "read the main content",
      ),
    );
    assert.ok(
      mainText.content.includes("Inbox") &&
        !mainText.content.includes("Privacy") &&
        !mainText.content.includes("Home"),
      mainText.content.slice(0, 200),
    );
    const dialogText = jsonContent(
      await runTool(
        "browser_read",
        { ...at, ref: dialogRef },
        "read one element by ref",
      ),
    );
    assert.ok(
      dialogText.content.includes("sent: yes") &&
        !dialogText.content.includes("Story"),
      dialogText.content.slice(0, 200),
    );
    await refused(
      "browser_read",
      { ...at, offset: firstPage.total + 10 },
      "a read past the end is refused",
      /past the end/,
    );
    await refused(
      "browser_read",
      { ...at, selector: "#nothing-here" },
      "a selector that matches nothing is refused",
      /No element matches the selector/,
    );

    // A find's refs go stale with the page, exactly as a snapshot's do.
    await runTool(
      "browser_navigate",
      { ...at, url: `${fixture.origin}/find` },
      "load the find page again",
    );
    await refused(
      "browser_click",
      { ...at, ref: sendRef },
      "a find ref from before a navigation is refused",
      /snapshot/i,
    );
    await runTool("browser_close_tab", at, "close the find page");

    const uninstall = jsonContent(
      await runTool(
        "browser_extension_uninstall",
        {},
        "unregister extension bridge",
      ),
    );
    assert.equal(uninstall.state, "partial");
    const reinstall = jsonContent(
      await runTool(
        "browser_extension_install",
        {},
        "restore extension bridge",
      ),
    );
    assert.equal(reinstall.state, "prepared");
    const finalExtensionStatus = jsonContent(
      await runTool(
        "browser_extension_status",
        {},
        "verify restored extension state",
      ),
    );
    assert.equal(finalExtensionStatus.state, "prepared");

    fixtureTabsClosed = await closeFixtureTabs();
    const finalTabs = await tabs("list tabs after the run");
    const original = finalTabs.tabs.find(
      (tab) => tab.id === originalActiveTabId,
    );
    assert.ok(original, "The user's tab is gone");
    assert.equal(original.active, true, "The user's tab is not in front");

    const missing = EXPECTED_TOOLS.filter((name) => !seen.has(name));
    assert.deepEqual(
      missing,
      [],
      `Advertised tools not exercised: ${missing.join(", ")}`,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (client && !client.exited) {
        if (createdWindowId !== null) {
          try {
            await client.request("tools/call", {
              name: "browser_windows",
              arguments: {},
            });
            await client.request("tools/call", {
              name: "browser_window",
              arguments: { action: "close", window_id: createdWindowId },
            });
          } catch (cleanupError) {
            failure ||= cleanupError;
          }
        }
        if (cookieName) {
          try {
            await client.request("tools/call", {
              name: "browser_cookies",
              arguments: {
                action: "remove",
                url: `${fixture.origin}/`,
                name: cookieName,
              },
            });
          } catch (cleanupError) {
            failure ||= cleanupError;
          }
        }
        try {
          fixtureTabsClosed = await closeFixtureTabs();
        } catch (cleanupError) {
          failure ||= cleanupError;
        }
        try {
          await client.request("tools/call", {
            name: "browser_extension_install",
            arguments: {},
          });
        } catch (cleanupError) {
          failure ||= cleanupError;
        }
      }
    } finally {
      await client.close();
      await fixture.close();
      for (const filePath of generatedFiles) {
        try {
          const info = await stat(filePath);
          assert.equal(info.isFile(), true);
          await unlink(filePath);
        } catch (error) {
          if (error.code !== "ENOENT" && !failure) {
            failure = error;
          }
        }
      }
    }
  }

  const report = {
    ok: failure === null,
    executable,
    fixture_origin: fixture.origin,
    advertised_tool_count: EXPECTED_TOOLS.length,
    exercised_tool_count: seen.size,
    exercised_tools: [...seen].sort(),
    case_count: cases.length,
    cases,
    generated_files_cleaned: [...generatedFiles],
    chrome_state_restored: fixtureTabsClosed,
    platform_notes: platformNotes,
    extension_attach_milliseconds: attachMilliseconds,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failure) {
    process.exitCode = 1;
  }
}

await main();
