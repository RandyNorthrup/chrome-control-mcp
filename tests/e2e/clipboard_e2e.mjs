// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Each agent's own clipboard, in a live browser. Two servers, three agents: each copies, cuts and
// pastes -- by key, by browser_clipboard, and through a page's own copy and paste buttons -- into
// editors that take a paste the three ways real editors do. Throughout, a sentinel the "user" put
// on the browser's own clipboard must stay there, and no agent may ever paste it: nothing an agent
// does may read or write the clipboard the user and every other agent share.
//
// Usage: node tests/e2e/isolated_run.mjs --chrome=<Chrome for Testing> tests/e2e/clipboard_e2e.mjs
// Needs the dedicated browser's DevTools (isolated_run passes CHROME_USER_DATA_DIR), for the two
// things no agent may do: put the sentinel on the clipboard as the user, and look at a page's own
// functions after the agent handed its tab back.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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

async function startServer(executable, name) {
  const client = new McpClient(executable);
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name, version: "1" },
  });
  return client;
}

// The dedicated browser's DevTools endpoint, from the port file Chrome writes into its profile.
async function devtoolsEndpoint() {
  const profile = process.env.CHROME_USER_DATA_DIR;
  assert.ok(
    profile,
    "CHROME_USER_DATA_DIR is not set; run through isolated_run.mjs",
  );
  const file = path.join(profile, "DevToolsActivePort");
  assert.ok(
    await until(() => existsSync(file), 15000),
    "the browser wrote no DevToolsActivePort",
  );
  const [port, browserPath] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  return { port: Number(port), browserPath };
}

function socketTo(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
    }
  };
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools socket failed"));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`DevTools ${method} timed out`));
        }
      }, 15000);
    });
  return opened.then(() => ({ send, close: () => socket.close() }));
}

async function pageSocket(endpoint, urlPart) {
  const list = await (
    await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)
  ).json();
  const target = list.find(
    (entry) => entry.type === "page" && entry.url.includes(urlPart),
  );
  assert.ok(target, `No page at ${urlPart}`);
  return socketTo(target.webSocketDebuggerUrl);
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

// Whether the page in @p page runs the browser's own clipboard functions.
const NATIVE_CLIPBOARD =
  "[String(Clipboard.prototype.writeText), String(Clipboard.prototype.readText)," +
  " String(Document.prototype.execCommand)].every((s) => s.includes('[native code]'))";

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
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ccm-clipboard-"));
  const image = path.join(scratch, "dot.png");
  const imageBytes = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360f8cfc0f01f0005fe02fea7d6a4" +
      "0b0000000049454e44ae426082",
    "hex",
  );
  await writeFile(image, imageBytes);
  const sentinel = "USER-CLIPBOARD-SENTINEL-" + Date.now();
  const checks = [];
  const check = (condition, label, detail = "") => {
    checks.push({ check: label, status: condition ? "passed" : "failed" });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition || !detail ? "" : ` -- ${detail}`}\n`,
    );
  };
  let failure = null;
  const one = await startServer(executable, "clipboard-one");
  let two = null;
  let user = null;
  let browser = null;

  try {
    await waitForExtensionAttached((name, args) => one.tool(name, args));
    const endpoint = await devtoolsEndpoint();

    // -- The user's clipboard ---------------------------------------------------------
    // A page the user opened, given what a page needs to use the clipboard, puts the sentinel on
    // the browser's own clipboard. The grant lasts only while the DevTools connection that made it
    // stays open, so it stays open for the whole run.
    browser = await socketTo(
      `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`,
    );
    await browser.send("Browser.grantPermissions", {
      origin: fixture.origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await fetch(
      `http://127.0.0.1:${endpoint.port}/json/new?${fixture.origin}/page2?user=sentinel`,
      { method: "PUT" },
    );
    user = await until(
      () => pageSocket(endpoint, "user=sentinel").catch(() => null),
      10000,
    );
    // The new tab starts as about:blank, which is not a secure context and has no clipboard API;
    // wait for the page itself.
    await until(
      () =>
        evaluate(
          user,
          "location.href.includes('user=sentinel') && document.readyState === 'complete'",
        ).catch(() => false),
      10000,
    );
    await user.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const systemClipboard = () =>
      evaluate(user, "navigator.clipboard.readText()").catch(
        (e) => "unreadable: " + e.message,
      );
    await evaluate(
      user,
      `navigator.clipboard.writeText(${JSON.stringify(sentinel)})`,
    );
    check(
      (await systemClipboard()) === sentinel,
      "the user's clipboard holds the sentinel before any agent runs",
    );

    // -- One agent: write, then paste into every kind of editor --------------------------
    const alpha = await one.json("browser_new_tab", {
      url: `${fixture.origin}/clipboard?who=alpha`,
      agent: "alpha",
    });
    const at = (tab) => ({ tab_id: tab.tab_id });
    const snap = async (tab) =>
      (await one.tool("browser_snapshot", at(tab))).text;
    // The page's text, out of browser_read's JSON reply.
    const read = async (client, tab) =>
      (await client.json("browser_read", { format: "text", ...at(tab) }))
        .content;
    const key = (client, tab, keys) =>
      client.json("browser_press_key", { keys, ...at(tab) });
    // One status line, trimmed: rendered text drops the trailing space of an empty "field: ".
    const statusOf = (text, name) =>
      (text.match(new RegExp(`${name}:[^\\n]*`)) || [""])[0].trim();

    const text = "alpha line one\nalpha line two";
    const html = "<p><b>alpha</b> line one</p><p>alpha line two</p>";
    const written = await one.json("browser_clipboard", {
      action: "write",
      text,
      html,
      paths: [image],
      ...at(alpha),
    });
    check(
      written.text_length === text.length &&
        written.files.length === 1 &&
        written.files[0].type === "image/png",
      "browser_clipboard writes text, HTML and an image to the agent's clipboard",
      JSON.stringify(written),
    );

    let s = await snap(alpha);
    await one.json("browser_click", { ref: refFor(s, "Rich editor") });
    await key(one, alpha, "Control+V");
    const rich = await until(async () => {
      const line = statusOf(await read(one, alpha), "rich");
      return line.includes("text=") ? line : null;
    }, 5000);
    check(
      Boolean(rich) &&
        rich.includes("text=alpha line one") &&
        rich.includes("html=<p><b>alpha</b> line one") &&
        rich.includes(`files=dot.png:${imageBytes.length}:image/png`),
      "an editor that reads the paste event gets text, HTML and the image file",
      rich,
    );

    await one.json("browser_click", { ref: refFor(s, "Beforeinput editor") });
    await key(one, alpha, "Control+V");
    const before = await until(async () => {
      const line = statusOf(await read(one, alpha), "beforeinput");
      return line.includes("alpha") || line.includes("no data") ? line : null;
    }, 5000);
    check(
      Boolean(before) &&
        before.includes("beforeinput: alpha line one") &&
        before.includes("files=1"),
      "an editor that reads beforeinput insertFromPaste gets the data transfer",
      before,
    );

    await one.json("browser_click", { ref: refFor(s, "Bare editor") });
    await key(one, alpha, "Control+V");
    const bare = await until(async () => {
      const line = statusOf(await read(one, alpha), "bare");
      return line.includes("alpha") ? line : null;
    }, 5000);
    check(
      bare === "bare: alpha line one / alpha line two",
      "a bare editable region gets the text typed in, line by line",
      bare,
    );

    // -- Editors inside frames ------------------------------------------------------------
    // A same-origin frame (as TinyMCE's editor is): the paste reaches it whole, files and all.
    s = await snap(alpha);
    await one.json("browser_click", {
      ref: refFor(s, "Focus the framed editor"),
    });
    await key(one, alpha, "Control+V");
    const framed = await until(async () => {
      const line = statusOf(await read(one, alpha), "frame");
      return line.includes("alpha") ? line : null;
    }, 5000);
    check(
      framed === "frame: alpha line one / alpha line two|files=1",
      "an editor inside a same-origin frame gets the paste, files included",
      framed,
    );
    // A frame from another site, which no page script can reach, focused the way an agent reaches
    // one -- by its position in a screenshot: the text is typed into its field.
    await one.json("browser_scroll", {
      direction: "up",
      amount: 5000,
      ...at(alpha),
    });
    const box = await until(async () => {
      const m = /cross-box: (\d+),(\d+)/.exec(await read(one, alpha));
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    }, 3000);
    await one.tool("browser_screenshot", at(alpha));
    await one.json("browser_click_at", { x: box.x, y: box.y, ...at(alpha) });
    const typed = await key(one, alpha, "Control+V");
    const crossLine = await until(async () => {
      const line = statusOf(await read(one, alpha), "cross");
      return line.includes("alpha") ? line : null;
    }, 5000);
    check(
      typed.clipboard.taken_by === "inserted" &&
        crossLine === "cross: alpha line one / alpha line two",
      "a field inside a frame from another site gets the text typed in",
      JSON.stringify([typed.clipboard, crossLine]),
    );

    // -- Copy, cut and paste by key in a text field ----------------------------------------
    await one.json("browser_click", { ref: refFor(s, "Plain field") });
    await key(one, alpha, "Control+A");
    const copied = await key(one, alpha, "Control+C");
    const afterCopy = await one.json("browser_clipboard", {
      action: "read",
      ...at(alpha),
    });
    check(
      copied.clipboard.copy === true &&
        afterCopy.text === "copy me from the field",
      "Control+C copies the field's selection to the agent's clipboard",
      JSON.stringify([copied.clipboard, afterCopy.text]),
    );
    await key(one, alpha, "Control+A");
    const cut = await key(one, alpha, "Control+X");
    const emptied = await until(async () => {
      const line = statusOf(await read(one, alpha), "field");
      return line === "field:" ? line : null;
    }, 5000);
    check(
      cut.clipboard.cut === true && Boolean(emptied),
      "Control+X takes the selection out of the field",
      JSON.stringify(cut.clipboard),
    );
    await key(one, alpha, "Control+V");
    const restored = await until(async () => {
      const line = statusOf(await read(one, alpha), "field");
      return line === "field: copy me from the field" ? line : null;
    }, 5000);
    check(Boolean(restored), "Control+V pastes it back");

    // -- The page's own copy and paste buttons ------------------------------------------
    s = await snap(alpha);
    const execClick = await one.json("browser_click", {
      ref: refFor(s, "Copy with execCommand"),
    });
    const afterExec = await until(async () => {
      const clip = await one.json("browser_clipboard", {
        action: "read",
        ...at(alpha),
      });
      return clip.text === "exec-copied-text" ? clip : null;
    }, 5000);
    check(
      Boolean(afterExec) &&
        statusOf(await read(one, alpha), "exec") === "exec: true",
      "a copy button using execCommand copies to the agent's clipboard",
      JSON.stringify(execClick),
    );
    await one.json("browser_click", {
      ref: refFor(s, "Copy with clipboard API"),
    });
    const asyncStatus = await until(async () => {
      const line = statusOf(await read(one, alpha), "async");
      return line !== "async: none" ? line : null;
    }, 5000);
    const afterAsync = await one.json("browser_clipboard", {
      action: "read",
      ...at(alpha),
    });
    check(
      asyncStatus === "async: ok" && afterAsync.text === "async-copied-text",
      "a copy button using navigator.clipboard copies to the agent's clipboard",
      JSON.stringify([asyncStatus, afterAsync.text]),
    );
    await one.json("browser_click", {
      ref: refFor(s, "Paste with clipboard API"),
    });
    const readStatus = await until(async () => {
      const line = statusOf(await read(one, alpha), "read");
      return line !== "read: none" ? line : null;
    }, 5000);
    check(
      readStatus === "read: async-copied-text",
      "a paste button reading navigator.clipboard gets the agent's clipboard",
      readStatus,
    );
    await one.json("browser_click", {
      ref: refFor(s, "Read clipboard in 3 seconds"),
    });
    const timerStatus = await until(async () => {
      const line = statusOf(await read(one, alpha), "timer");
      return line !== "timer: armed" && line !== "timer: none" ? line : null;
    }, 8000);
    check(
      timerStatus === "timer: NotAllowedError",
      "a page reading the clipboard on its own, outside any agent command, is refused",
      timerStatus,
    );

    // -- Another agent on the same server -----------------------------------------------
    // Its tab starts elsewhere and navigates to the clipboard page, so that page's document is
    // created after the tab was taken: only the stand-in registered for new documents reaches it.
    const beta = await one.json("browser_new_tab", {
      url: `${fixture.origin}/page2`,
      agent: "beta",
    });
    await one.json("browser_navigate", {
      url: `${fixture.origin}/clipboard?who=beta`,
      ...at(beta),
    });
    const betaEmpty = await one.json("browser_clipboard", {
      action: "read",
      ...at(beta),
    });
    check(betaEmpty.empty === true, "a second agent's clipboard starts empty");
    const betaSnap = await snap(beta);
    await one.json("browser_click", { ref: refFor(betaSnap, "Plain field") });
    await key(one, beta, "Control+A");
    const betaPaste = await key(one, beta, "Control+V");
    check(
      betaPaste.clipboard.pasted === false &&
        statusOf(await read(one, beta), "field") ===
          "field: copy me from the field",
      "and its paste finds nothing of the first agent's",
      JSON.stringify(betaPaste.clipboard),
    );
    await one.json("browser_clipboard", {
      action: "write",
      text: "beta text",
      ...at(beta),
    });
    await key(one, beta, "Control+V");
    const betaField = await until(async () => {
      const line = statusOf(await read(one, beta), "field");
      return line === "field: beta text" ? line : null;
    }, 5000);
    const alphaStill = await one.json("browser_clipboard", {
      action: "read",
      ...at(alpha),
    });
    check(
      Boolean(betaField) && alphaStill.text === "async-copied-text",
      "each agent pastes its own, and neither changes the other's",
      JSON.stringify([betaField, alphaStill.text]),
    );
    const betaButtons = await snap(beta);
    await one.json("browser_click", {
      ref: refFor(betaButtons, "Copy with execCommand"),
    });
    const betaCopied = await until(async () => {
      const clip = await one.json("browser_clipboard", {
        action: "read",
        ...at(beta),
      });
      return clip.text === "exec-copied-text" ? clip : null;
    }, 5000);
    check(
      Boolean(betaCopied),
      "in a page loaded after the agent took the tab, a copy button copies to that agent's clipboard",
    );

    // -- An agent on a second server ----------------------------------------------------
    // It has the same name as the first server's beta, whose clipboard is full: a clipboard is
    // the agent's on one server, not whoever is called "beta" anywhere.
    two = await startServer(executable, "clipboard-two");
    await waitForExtensionAttached((name, args) => two.tool(name, args));
    const gamma = await two.json("browser_new_tab", {
      url: `${fixture.origin}/clipboard?who=gamma`,
      agent: "beta",
    });
    const gammaRead = await two.json("browser_clipboard", {
      action: "read",
      ...at(gamma),
    });
    const gammaSnap = (await two.tool("browser_snapshot", at(gamma))).text;
    await two.json("browser_click", { ref: refFor(gammaSnap, "Plain field") });
    const gammaPaste = await key(two, gamma, "Control+V");
    check(
      gammaRead.empty === true && gammaPaste.clipboard.pasted === false,
      "an agent on another server sees nothing of the first server's clipboards",
      JSON.stringify([gammaRead, gammaPaste.clipboard]),
    );

    // -- The user's clipboard, untouched ------------------------------------------------
    check(
      (await systemClipboard()) === sentinel,
      "after all of it, the user's clipboard still holds the sentinel",
      await systemClipboard(),
    );
    const everything = [
      await read(one, alpha),
      await read(one, beta),
      await read(two, gamma),
    ].join("\n");
    check(
      !everything.includes(sentinel),
      "and no agent's page ever received it",
    );

    // -- Handing back and letting go -----------------------------------------------------
    const alphaPage = await pageSocket(endpoint, "who=alpha");
    const standInBefore = !(await evaluate(alphaPage, NATIVE_CLIPBOARD));
    await one.json("browser_release", { ...at(alpha), keep_open: true });
    const nativeAfter = await until(
      () => evaluate(alphaPage, NATIVE_CLIPBOARD),
      5000,
    );
    alphaPage.close();
    check(
      standInBefore && Boolean(nativeAfter),
      "a tab handed back runs the browser's own clipboard functions again",
      JSON.stringify([standInBefore, nativeAfter]),
    );
    const alphaAgain = await one.json("browser_new_tab", {
      url: `${fixture.origin}/page2`,
      agent: "alpha",
    });
    const alphaCleared = await one.json("browser_clipboard", {
      action: "read",
      ...at(alphaAgain),
    });
    const betaKept = await one.json("browser_clipboard", {
      action: "read",
      ...at(beta),
    });
    check(
      alphaCleared.empty === true && betaKept.text === "exec-copied-text",
      "an agent that let go of its last tab let go of its clipboard; the other kept its own",
      JSON.stringify([alphaCleared, betaKept.text]),
    );

    await one.json("browser_release", {});
    await two.json("browser_release", {});
    const finalTabs = await one.json("browser_tabs");
    check(
      !finalTabs.tabs.some((t) => String(t.group || "").startsWith("AI")),
      "releasing everything leaves no AI tab or group behind",
    );
  } catch (error) {
    failure = error;
  } finally {
    if (user) {
      user.close();
    }
    if (browser) {
      browser.close();
    }
    if (two) {
      await two.close();
    }
    await one.close();
    await fixture.close();
    await rm(scratch, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === 24,
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
