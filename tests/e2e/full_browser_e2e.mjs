// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "./fixture_server.mjs";

const EXPECTED_TOOLS = [
  "browser_extension_install", "browser_extension_uninstall", "browser_extension_status",
  "browser_navigate", "browser_snapshot", "browser_back", "browser_forward", "browser_reload",
  "browser_read", "browser_screenshot", "browser_click", "browser_type", "browser_press_key",
  "browser_scroll", "browser_dialog", "browser_click_at", "browser_hover", "browser_drag",
  "browser_select", "browser_set_value", "browser_media", "browser_tabs", "browser_select_tab",
  "browser_new_tab", "browser_close_tab", "browser_group_tabs", "browser_ungroup_tabs",
  "browser_windows", "browser_window", "browser_wait_for", "browser_get_value",
  "browser_get_attribute", "browser_box", "browser_focus", "browser_reveal", "browser_emulate",
  "browser_print", "browser_permission", "browser_storage", "browser_cookies",
  "browser_download", "browser_http_auth", "browser_js_click",
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class McpClient {
  constructor(executable) {
    this.child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.exited = false;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`Invalid MCP JSON: ${error.message}: ${line.slice(0, 500)}`));
        }
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
      }
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const error = new Error(`MCP exited code=${code} signal=${signal}; stderr=${this.stderr}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 45000) {
    if (this.exited) {
      return Promise.reject(new Error(`MCP already exited: ${this.stderr}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }).then((response) => {
      if (response.error) {
        throw new Error(`MCP ${method} error ${response.error.code}: ${response.error.message}`);
      }
      return response.result;
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    if (!this.exited) {
      this.child.stdin.end();
      await Promise.race([
        new Promise((resolve) => this.child.once("exit", resolve)),
        sleep(5000),
      ]);
    }
    if (!this.exited) {
      this.child.kill();
      await new Promise((resolve) => this.child.once("exit", resolve));
    }
  }
}

function textContent(result) {
  const block = Array.isArray(result.content)
    ? result.content.find((item) => item && item.type === "text")
    : null;
  return block && typeof block.text === "string" ? block.text : "";
}

function jsonContent(result) {
  const text = textContent(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON tool content, received: ${text.slice(0, 800)}`);
  }
}

function refFor(snapshot, accessibleName) {
  const line = snapshot.split(/\r?\n/).find(
    (candidate) => candidate.includes(`"${accessibleName}"`) && candidate.includes("[ref="),
  );
  if (!line) {
    throw new Error(`No ref found for accessible name "${accessibleName}". Snapshot: ${snapshot.slice(0, 6000)}`);
  }
  const match = line.match(/\[ref=(e\d+)\]/);
  if (!match) {
    throw new Error(`Malformed ref line for "${accessibleName}": ${line}`);
  }
  return match[1];
}

function assertIncludes(value, expected, message) {
  assert.ok(String(value).includes(expected), `${message}: expected ${JSON.stringify(expected)} in ${String(value).slice(0, 800)}`);
}

function assertSafeGeneratedPath(filePath, expectedNamePart, extension) {
  assert.equal(path.isAbsolute(filePath), true, `Generated path is not absolute: ${filePath}`);
  assertIncludes(path.basename(filePath).toLowerCase(), expectedNamePart.toLowerCase(), "Generated filename marker");
  assert.equal(path.extname(filePath).toLowerCase(), extension, `Generated file extension: ${filePath}`);
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");
  const executable = path.resolve(process.argv[2] || path.join(repoRoot, "dist", "chrome_control_mcp.exe"));
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

  const runTool = async (name, args, label = name, timeoutMs = 45000) => {
    const started = Date.now();
    const result = await client.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = textContent(result);
    if (result.isError) {
      throw new Error(`${label} failed: ${text}`);
    }
    seen.add(name);
    cases.push({ tool: name, case: label, milliseconds: Date.now() - started, status: "passed" });
    process.stderr.write(`PASS ${name} :: ${label}\n`);
    return result;
  };

  const snapshot = async (label) => textContent(await runTool("browser_snapshot", {}, label));
  const tabs = async (label) => jsonContent(await runTool("browser_tabs", {}, label));
  const closeFixtureTabs = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const listing = jsonContent(await client.request("tools/call", { name: "browser_tabs", arguments: {} }));
      const owned = listing.tabs.filter((tab) => String(tab.url || "").startsWith(fixture.origin));
      if (owned.length === 0) break;
      const target = owned.sort((a, b) => b.index - a.index)[0];
      await client.request("tools/call", { name: "browser_close_tab", arguments: { index: target.index } });
    }
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
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), "Live tool catalog drifted");
    assert.equal(new Set(names).size, 43);
    await sleep(3000);

    const extensionStatus = jsonContent(await runTool("browser_extension_status", {}, "extension status prepared"));
    assert.equal(extensionStatus.state, "prepared");
    assert.equal(extensionStatus.extension_present, true);
    const extensionInstall = jsonContent(await runTool("browser_extension_install", {}, "extension install idempotent"));
    assert.equal(extensionInstall.state, "prepared");

    const baselineTabs = await tabs("capture baseline tabs");
    const baselineActive = baselineTabs.tabs.find((tab) => tab.active);
    assert.ok(baselineActive, "No active baseline tab");
    originalActiveTabId = baselineActive.id;

    const baselineWindows = jsonContent(await runTool("browser_windows", {}, "capture baseline windows"));
    const baselineWindow = baselineWindows.windows.find((window) => window.focused)
      || baselineWindows.windows.find((window) => window.tab_count === baselineTabs.count)
      || [...baselineWindows.windows].sort((left, right) => (right.tab_count || 0) - (left.tab_count || 0))[0];
    assert.ok(baselineWindow, "No baseline browser window");
    originalWindowId = baselineWindow.window_id;

    const opened = jsonContent(await runTool("browser_new_tab", { url: `${fixture.origin}/` }, "open fixture tab"));
    assert.equal(opened.load_complete, true);
    assertIncludes(opened.url, fixture.origin, "Fixture tab URL");

    let page = await snapshot("snapshot fixture home");
    assertIncludes(page, "Chrome Control MCP E2E Fixture", "Fixture snapshot title");
    const pageTwoRef = refFor(page, "Fixture Page Two");
    const inputRef = refFor(page, "Fixture text input");
    const selectRef = refFor(page, "Fixture select");
    const multiSelectRef = refFor(page, "Fixture multiple select");
    const checkboxRef = refFor(page, "Fixture checkbox");
    const rangeRef = refFor(page, "Fixture range");
    const normalButtonRef = refFor(page, "Fixture click button");
    const jsButtonRef = refFor(page, "Fixture JS button");
    const coordinateButtonRef = refFor(page, "Fixture coordinate button");
    const promptButtonRef = refFor(page, "Open fixture prompt");
    const hoverRef = refFor(page, "Fixture hover target");
    const dragSourceRef = refFor(page, "Fixture drag source");
    const dragTargetRef = refFor(page, "Fixture drag target");
    const mediaRef = refFor(page, "Fixture audio");
    const scrollRegionRef = refFor(page, "Fixture scroll region");
    const deepTargetRef = refFor(page, "Fixture deep target");

    const textRead = jsonContent(await runTool("browser_read", { format: "text" }, "read page text"));
    assertIncludes(textRead.content, "Chrome Control MCP E2E Fixture", "Text read");
    const htmlRead = jsonContent(await runTool("browser_read", { format: "html" }, "read page HTML"));
    assertIncludes(htmlRead.content, "data-e2e=\"page-two\"", "HTML read");

    const attribute = jsonContent(await runTool(
      "browser_get_attribute", { ref: pageTwoRef, name: "data-e2e" }, "read element attribute",
    ));
    assert.equal(attribute.value, "page-two");

    const inputBox = jsonContent(await runTool("browser_box", { ref: inputRef }, "measure input box"));
    assert.equal(inputBox.laid_out, true);
    assert.ok(inputBox.width > 0 && inputBox.height > 0);
    const inputFocused = jsonContent(await runTool("browser_focus", { ref: inputRef }, "focus input"));
    assert.equal(inputFocused.focused, true);

    await runTool("browser_type", { ref: inputRef, text: "first value" }, "type initial value");
    let value = jsonContent(await runTool("browser_get_value", { ref: inputRef }, "read typed value"));
    assert.equal(value.value, "first value");
    await runTool("browser_press_key", { keys: "Control+A" }, "select input text with keyboard");
    await runTool("browser_type", { ref: inputRef, text: "replacement value" }, "replace selected value");
    value = jsonContent(await runTool("browser_get_value", { ref: inputRef }, "verify replacement value"));
    assert.equal(value.value, "replacement value");

    const selected = jsonContent(await runTool("browser_select", { ref: selectRef, value: "beta" }, "select single option"));
    assert.equal(selected.value, "beta");
    const multiSelected = jsonContent(await runTool(
      "browser_select", { ref: multiSelectRef, values: ["one", "three"] }, "select multiple options",
    ));
    assert.equal(multiSelected.multiple, true);

    const checked = jsonContent(await runTool("browser_set_value", { ref: checkboxRef, checked: true }, "check checkbox"));
    assert.equal(checked.checked, true);
    const ranged = jsonContent(await runTool("browser_set_value", { ref: rangeRef, value: "73" }, "set range value"));
    assert.equal(ranged.value, "73");

    await runTool("browser_click", { ref: normalButtonRef }, "click normal button");
    const normalWait = jsonContent(await runTool(
      "browser_wait_for", { text: "normal-clicked", timeout_ms: 3000 }, "wait for click result",
    ));
    assert.equal(normalWait.satisfied, true);

    await runTool("browser_reveal", { ref: hoverRef }, "reveal hover target");
    await runTool("browser_hover", { ref: hoverRef, duration_ms: 100 }, "hover target");
    const hoverWait = jsonContent(await runTool(
      "browser_wait_for", { text: "hovered", timeout_ms: 3000 }, "wait for hover result",
    ));
    assert.equal(hoverWait.satisfied, true);

    await runTool("browser_reveal", { ref: dragSourceRef }, "reveal drag targets");
    await runTool(
      "browser_drag", { ref: dragSourceRef, to_ref: dragTargetRef, steps: 8, hold_ms: 40 }, "drag source to target",
    );
    const dragWait = jsonContent(await runTool(
      "browser_wait_for", { text: "dragged", timeout_ms: 3000 }, "wait for drag result",
    ));
    assert.equal(dragWait.satisfied, true);

    await runTool("browser_reveal", { ref: mediaRef }, "reveal media control");
    const media = jsonContent(await runTool("browser_media", { ref: mediaRef, action: "volume", value: "0.4" }, "set media volume"));
    assert.equal(media.volume, 0.4);

    await runTool("browser_scroll", { ref: scrollRegionRef, direction: "down", amount: 180 }, "scroll nested region");
    const revealed = jsonContent(await runTool("browser_reveal", { ref: deepTargetRef }, "reveal deep target"));
    assert.equal(revealed.laid_out, true);

    page = await snapshot("refresh refs before dialog and JavaScript click");
    const promptRefFresh = refFor(page, "Open fixture prompt");
    const jsRefFresh = refFor(page, "Fixture JS button");
    const coordinateRefFresh = refFor(page, "Fixture coordinate button");
    await runTool("browser_reveal", { ref: promptRefFresh }, "reveal prompt button");
    const promptBox = jsonContent(await runTool("browser_box", { ref: promptRefFresh }, "verify prompt button geometry"));
    assert.equal(promptBox.occluded, false, `Prompt button remains occluded: ${JSON.stringify(promptBox)}`);
    await runTool("browser_dialog", { action: "accept", text: "E2E prompt value" }, "arm prompt acceptance");
    await runTool("browser_click", { ref: promptRefFresh }, "open and accept prompt");
    const dialog = jsonContent(await runTool("browser_dialog", {}, "read last dialog"));
    assert.equal(dialog.last_dialog.type, "prompt");
    assert.equal(dialog.last_dialog.accepted, true);
    const promptWait = jsonContent(await runTool(
      "browser_wait_for", { text: "prompt:E2E prompt value", timeout_ms: 3000 }, "wait for prompt result",
    ));
    assert.equal(promptWait.satisfied, true);

    await runTool("browser_reveal", { ref: jsRefFresh }, "reveal JavaScript-click target");
    await runTool("browser_js_click", { ref: jsRefFresh }, "JavaScript click fallback");
    const jsWait = jsonContent(await runTool(
      "browser_wait_for", { text: "js-clicked", timeout_ms: 3000 }, "wait for JavaScript click result",
    ));
    assert.equal(jsWait.satisfied, true);

    await runTool("browser_reveal", { ref: coordinateRefFresh }, "reveal coordinate-click target");
    const screenshot = await runTool("browser_screenshot", { full_page: false }, "capture viewport screenshot");
    const screenshotImage = screenshot.content.find((item) => item.type === "image");
    assert.equal(screenshotImage.mimeType, "image/png");
    assert.ok(screenshotImage.data.length > 100);
    if (showcaseDir) {
      const showcase = await runTool(
        "browser_screenshot",
        { full_page: false, include_control_overlay: true },
        "capture fixture screenshot with control overlay",
      );
      const showcaseImage = showcase.content.find((item) => item.type === "image");
      assert.equal(showcaseImage.mimeType, "image/png");
      await mkdir(showcaseDir, { recursive: true });
      await writeFile(
        path.join(showcaseDir, "chrome-control-overlay-fixture.png"),
        Buffer.from(showcaseImage.data, "base64"),
      );
    }
    const coordinateBox = jsonContent(await runTool("browser_box", { ref: coordinateRefFresh }, "measure coordinate target"));
    await runTool(
      "browser_click_at",
      { x: coordinateBox.center.x, y: coordinateBox.center.y },
      "coordinate click from screenshot geometry",
    );
    const coordinateWait = jsonContent(await runTool(
      "browser_wait_for", { text: "coordinate-clicked", timeout_ms: 3000 }, "wait for coordinate click result",
    ));
    assert.equal(coordinateWait.satisfied, true);

    const shadowWait = jsonContent(await runTool(
      "browser_wait_for", { selector: "#shadow-button", timeout_ms: 3000 }, "wait for shadow selector",
    ));
    assert.equal(shadowWait.satisfied, true);
    const networkWait = jsonContent(await runTool(
      "browser_wait_for", { network_idle: true, idle_ms: 250, timeout_ms: 5000 }, "wait for network idle",
    ));
    assert.equal(networkWait.satisfied, true);

    const emulated = jsonContent(await runTool(
      "browser_emulate",
      { width: 390, height: 844, device_scale_factor: 2, mobile: true, touch: true, user_agent: "ChromeControlMCP-E2E/1" },
      "apply mobile emulation",
    ));
    assert.equal(emulated.applied.width, 390);
    const emulationReset = jsonContent(await runTool("browser_emulate", { reset: true }, "reset emulation"));
    assert.equal(emulationReset.reset, true);

    const storageKey = `chrome-control-mcp-e2e-${process.pid}`;
    await runTool(
      "browser_storage",
      { action: "set", area: "local", key: storageKey, value: "stored-value", expect_origin: fixture.origin },
      "set local storage",
    );
    const storageGet = jsonContent(await runTool(
      "browser_storage",
      { action: "get", area: "local", key: storageKey, expect_origin: fixture.origin },
      "get local storage",
    ));
    assert.equal(storageGet.value, "stored-value");
    const storageKeys = jsonContent(await runTool(
      "browser_storage", { action: "keys", area: "local", expect_origin: fixture.origin }, "list local storage keys",
    ));
    assert.ok(storageKeys.keys.includes(storageKey));
    await runTool(
      "browser_storage",
      { action: "remove", area: "local", key: storageKey, expect_origin: fixture.origin },
      "remove local storage key",
    );
    await runTool(
      "browser_storage",
      { action: "set", area: "session", key: storageKey, value: "session-value", expect_origin: fixture.origin },
      "set session storage",
    );
    await runTool(
      "browser_storage", { action: "clear", area: "session", expect_origin: fixture.origin }, "clear session storage",
    );

    cookieName = `ccmcp_e2e_${process.pid}`;
    await runTool(
      "browser_cookies",
      { action: "set", url: `${fixture.origin}/`, name: cookieName, value: "cookie-value", path: "/", same_site: "lax" },
      "set fixture cookie",
    );
    const cookies = jsonContent(await runTool(
      "browser_cookies", { action: "get", url: `${fixture.origin}/` }, "read fixture cookies",
    ));
    assert.ok(cookies.cookies.some((cookie) => cookie.name === cookieName && cookie.value === "cookie-value"));
    const removedCookie = jsonContent(await runTool(
      "browser_cookies", { action: "remove", url: `${fixture.origin}/`, name: cookieName }, "remove fixture cookie",
    ));
    assert.equal(removedCookie.removed, true);
    cookieName = null;

    await runTool(
      "browser_permission", { name: "geolocation", setting: "block", origin: fixture.origin }, "block fixture geolocation",
    );
    await runTool(
      "browser_permission", { name: "geolocation", setting: "ask", origin: fixture.origin }, "restore fixture geolocation",
    );

    const downloadMarker = `chrome-control-mcp-e2e-${process.pid}`;
    const downloaded = jsonContent(await runTool(
      "browser_download",
      { url: `${fixture.origin}/download.txt`, filename: `ChromeControlMCP/${downloadMarker}.txt`, timeout_ms: 10000 },
      "download fixture file",
      20000,
    ));
    assert.equal(downloaded.ok, true);
    assertSafeGeneratedPath(downloaded.path, downloadMarker, ".txt");
    generatedFiles.add(downloaded.path);
    assert.equal(await readFile(downloaded.path, "utf8"), "chrome-control-mcp-e2e-download\n");

    const printed = jsonContent(await runTool(
      "browser_print", { print_background: true, page_ranges: "1", scale: 0.8 }, "print fixture PDF", 30000,
    ));
    assert.equal(printed.ok, true);
    assertSafeGeneratedPath(printed.saved, "page-", ".pdf");
    generatedFiles.add(printed.saved);
    const pdfHeader = (await readFile(printed.saved)).subarray(0, 5).toString("ascii");
    assert.equal(pdfHeader, "%PDF-");

    const navigated = jsonContent(await runTool(
      "browser_navigate", { url: `${fixture.origin}/page2` }, "navigate to page two",
    ));
    assertIncludes(navigated.url, "/page2", "Navigate result");
    const urlWait = jsonContent(await runTool(
      "browser_wait_for", { url_contains: "/page2", timeout_ms: 3000 }, "wait for page-two URL",
    ));
    assert.equal(urlWait.satisfied, true);
    assertIncludes(await snapshot("snapshot page two"), "Fixture history marker", "Page-two snapshot");
    const backed = jsonContent(await runTool("browser_back", {}, "history back"));
    assertIncludes(backed.url, fixture.origin, "Back URL");
    const forwarded = jsonContent(await runTool("browser_forward", {}, "history forward"));
    assertIncludes(forwarded.url, "/page2", "Forward URL");
    const reloaded = jsonContent(await runTool("browser_reload", {}, "reload page two"));
    assertIncludes(reloaded.url, "/page2", "Reload URL");
    await runTool("browser_navigate", { url: `${fixture.origin}/` }, "return to fixture home");

    await runTool(
      "browser_http_auth",
      { username: "e2e", password: "pass", origin: fixture.origin },
      "arm HTTP authentication",
    );
    await runTool("browser_navigate", { url: `${fixture.origin}/protected` }, "navigate through HTTP authentication");
    assertIncludes(await snapshot("snapshot authenticated page"), "AUTH OK", "Authenticated page");
    await runTool("browser_http_auth", { clear: true }, "clear HTTP authentication");

    await runTool("browser_new_tab", { url: `${fixture.origin}/page2?group=one` }, "open first group tab");
    await runTool("browser_new_tab", { url: `${fixture.origin}/page2?group=two` }, "open second group tab");
    let groupTabs = await tabs("list tabs before grouping");
    const groupCandidates = groupTabs.tabs.filter((tab) => String(tab.url).includes("group="));
    assert.equal(groupCandidates.length, 2);
    const grouped = jsonContent(await runTool(
      "browser_group_tabs",
      { tab_indices: groupCandidates.map((tab) => tab.index).join(","), title: "MCP E2E", color: "pink" },
      "group fixture tabs",
    ));
    assert.equal(grouped.tab_count, 2);
    groupTabs = await tabs("refresh tabs after grouping");
    const groupedCandidates = groupTabs.tabs.filter((tab) => String(tab.url).includes("group="));
    const ungrouped = jsonContent(await runTool(
      "browser_ungroup_tabs",
      { tab_indices: groupedCandidates.map((tab) => tab.index).join(",") },
      "ungroup fixture tabs",
    ));
    assert.equal(ungrouped.ungrouped, 2);

    let selectListing = await tabs("list tabs before selection");
    const primaryFixture = selectListing.tabs.find((tab) => tab.url === `${fixture.origin}/protected`);
    assert.ok(primaryFixture, "Primary fixture tab missing before selection");
    const selectedTab = jsonContent(await runTool(
      "browser_select_tab", { index: primaryFixture.index }, "select primary fixture tab",
    ));
    assert.equal(selectedTab.index, primaryFixture.index);

    for (const query of ["group=one", "group=two"]) {
      const listing = await tabs(`list tabs before closing ${query}`);
      const target = listing.tabs.find((tab) => String(tab.url).includes(query));
      assert.ok(target, `Missing tab ${query}`);
      const closed = jsonContent(await runTool("browser_close_tab", { index: target.index }, `close ${query} tab`));
      assert.equal(closed.index, target.index);
    }

    const windowsBeforeCreate = jsonContent(await runTool("browser_windows", {}, "list windows before create"));
    assert.ok(windowsBeforeCreate.windows.some((window) => window.window_id === originalWindowId));
    const newWindow = jsonContent(await runTool(
      "browser_window", { action: "new", url: `${fixture.origin}/page2?window=e2e` }, "create fixture window",
    ));
    createdWindowId = newWindow.window_id;
    assert.ok(Number.isInteger(createdWindowId));
    const windowsAfterCreate = jsonContent(await runTool("browser_windows", {}, "list windows after create"));
    assert.ok(windowsAfterCreate.windows.some((window) => window.window_id === createdWindowId));
    const windowFocused = jsonContent(await runTool(
      "browser_window", { action: "focus", window_id: originalWindowId }, "focus original window",
    ));
    assert.equal(windowFocused.focused, true);
    await runTool("browser_window", { action: "close", window_id: createdWindowId }, "close fixture window");
    createdWindowId = null;

    const uninstall = jsonContent(await runTool("browser_extension_uninstall", {}, "unregister extension bridge"));
    assert.equal(uninstall.state, "partial");
    const reinstall = jsonContent(await runTool("browser_extension_install", {}, "restore extension bridge"));
    assert.equal(reinstall.state, "prepared");
    const finalExtensionStatus = jsonContent(await runTool("browser_extension_status", {}, "verify restored extension state"));
    assert.equal(finalExtensionStatus.state, "prepared");

    await closeFixtureTabs();
    const finalTabs = await tabs("list tabs for original-tab restore");
    const original = finalTabs.tabs.find((tab) => tab.id === originalActiveTabId);
    if (original && !original.active) {
      await runTool("browser_select_tab", { index: original.index }, "restore original active tab");
    }

    const missing = EXPECTED_TOOLS.filter((name) => !seen.has(name));
    assert.deepEqual(missing, [], `Advertised tools not exercised: ${missing.join(", ")}`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (client && !client.exited) {
        if (createdWindowId !== null) {
          try {
            await client.request("tools/call", { name: "browser_windows", arguments: {} });
            await client.request("tools/call", {
              name: "browser_window", arguments: { action: "close", window_id: createdWindowId },
            });
          } catch {}
        }
        if (cookieName) {
          try {
            await client.request("tools/call", {
              name: "browser_cookies",
              arguments: { action: "remove", url: `${fixture.origin}/`, name: cookieName },
            });
          } catch {}
        }
        try { await closeFixtureTabs(); } catch {}
        try {
          const listing = jsonContent(await client.request("tools/call", { name: "browser_tabs", arguments: {} }));
          const original = listing.tabs.find((tab) => tab.id === originalActiveTabId);
          if (original && !original.active) {
            await client.request("tools/call", { name: "browser_select_tab", arguments: { index: original.index } });
          }
        } catch {}
        try { await client.request("tools/call", { name: "browser_extension_install", arguments: {} }); } catch {}
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
          if (error.code !== "ENOENT" && !failure) failure = error;
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
    chrome_state_restored: true,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failure) process.exitCode = 1;
}

await main();
