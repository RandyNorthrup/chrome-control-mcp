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
import { jsonContent, McpClient, refFor, textContent } from "./mcp_client.mjs";

const EXPECTED_TOOLS = [
  "browser_extension_install",
  "browser_extension_uninstall",
  "browser_extension_status",
  "browser_navigate",
  "browser_snapshot",
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
];

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
        throw new Error(`${label} closed the user's tab`);
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
    assert.deepEqual(
      names,
      [...EXPECTED_TOOLS].sort(),
      "Live tool catalog drifted",
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

    const baselineTabs = await tabs("capture baseline tabs");
    const baselineActive = baselineTabs.tabs.find((tab) => tab.active);
    assert.ok(baselineActive, "No active baseline tab");
    originalActiveTabId = baselineActive.id;

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
      `The nested region did not scroll: ${JSON.stringify(nested)}`,
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
    // wait, and checks the PNG header independently: a screenshot is viewport x scale pixels.
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
        Math.abs(
          png.readUInt32BE(16) -
            Math.round(metrics.width * metrics.device_scale_factor),
        ) <= 1,
        `PNG width ${png.readUInt32BE(16)} at ${tag}`,
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
