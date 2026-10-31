// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Each agent's own clipboard, and the system clipboard nobody's agent touches.
//
// Agents shared the operating system's one clipboard with each other and with the user: one
// agent's Ctrl+V pasted another's copy, or the user's, and a page's copy button clicked by an agent
// wrote the user's clipboard. These drive the worker through real command frames against the
// browser model; what a page does with a copy or a paste is scripted through the debugger, and the
// assertions are about which clipboard an operation reached -- and that no copy, cut or paste ever
// went to Chrome as a key, which is the only way the system clipboard could be read or written.

import { test } from "node:test";
import assert from "node:assert/strict";

import { attachedBrowser, command } from "./browser_model.mjs";
import { settle } from "./extension_harness.mjs";

const EXPORTED = ["holdTab", "handleRelease", "clipboardChord"];
const LIVE = "sessions";
const CLIPBOARD_BINDING = "__chrome_control_mcp_clipboard_call__";

// A browser whose pages answer copy and paste as @p page says: page.copy is what a copy finds
// (text, html, from, editable), page.paste how the page takes a paste (handled, editable, field).
// Every paste the page is offered is recorded with what it was offered.
async function browserWithPage(page) {
  const offered = [];
  const settled = [];
  const b = await attachedBrowser("100", {
    exported: EXPORTED,
    live: LIVE,
    cdp: (tabId, method, params) => {
      if (method === "Runtime.evaluate" && params.expression === "document") {
        return { result: { objectId: "doc-" + tabId } };
      }
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).includes("document.activeElement;")
      ) {
        return { result: { value: { tag: "textarea", id: "", name: "" } } };
      }
      if (method === "Runtime.callFunctionOn" && params.executionContextId) {
        // Copied into this realm: the worker's arrays fail a strict deep-equal against ours.
        settled.push(Array.from(params.arguments, (a) => a.value));
        return {};
      }
      if (method === "Runtime.callFunctionOn") {
        const fn = String(params.functionDeclaration);
        if (fn.includes("function agentCopyFn")) {
          return { result: { value: page.copy } };
        }
        if (fn.includes("function agentPasteFn")) {
          offered.push({ tabId, clip: params.arguments[0].value });
          return { result: { value: page.paste } };
        }
      }
      return undefined;
    },
  });
  const hold = (agent) => {
    const tab = b.addTab({});
    b.worker.holdTab(b.session, b.copy(tab), "opened", agent);
    return tab;
  };
  const sent = (method) => b.calls.cdp.filter((c) => c.method === method);
  return { ...b, offered, settled, hold, sent };
}

const field = { handled: "none", editable: true, field: true };

test("copy, cut and paste chords are answered here and never reach Chrome as keys", async () => {
  const b = await browserWithPage({
    copy: { text: "x", html: "", from: "selection", editable: false },
    paste: field,
  });
  const tab = b.hold("alpha");
  await settle();
  const chords = [
    "Control+C",
    "Meta+C",
    "Control+X",
    "Meta+X",
    "Control+V",
    "Meta+V",
    "Control+Shift+V",
    "Meta+Shift+V",
    "Shift+Insert",
    "Control+Insert",
    "Shift+Delete",
  ];
  for (const keys of chords) {
    const reply = await command(b.port, "pressKey", { keys, tab_id: tab.id });
    assert.equal(reply.type, "result", keys + ": " + reply.error);
    assert.ok(reply.payload.clipboard, keys + " answered from the clipboard");
  }
  assert.equal(
    b.sent("Input.dispatchKeyEvent").length,
    0,
    "not one of them was sent to Chrome as a key",
  );

  // Any other chord is still a key press.
  await command(b.port, "pressKey", { keys: "Control+A", tab_id: tab.id });
  assert.ok(b.sent("Input.dispatchKeyEvent").length > 0);
  assert.equal(b.worker.clipboardChord({ code: "KeyA" }, 2), null);
});

test("each agent pastes its own clipboard, never another agent's", async () => {
  const b = await browserWithPage({
    copy: { text: "alpha's secret", html: "", from: "selection" },
    paste: field,
  });
  const alpha = b.hold("alpha");
  const beta = b.hold("beta");
  await settle();

  const copied = await command(b.port, "pressKey", {
    keys: "Control+C",
    tab_id: alpha.id,
  });
  assert.equal(copied.payload.clipboard.copy, true);

  const empty = await command(b.port, "pressKey", {
    keys: "Control+V",
    tab_id: beta.id,
  });
  assert.equal(empty.payload.clipboard.pasted, false, "beta's is empty");
  assert.equal(b.offered.length, 0, "and beta's page was offered nothing");

  await command(b.port, "clipboard", {
    action: "write",
    text: "beta's own",
    tab_id: beta.id,
  });
  await command(b.port, "pressKey", { keys: "Control+V", tab_id: beta.id });
  await command(b.port, "pressKey", { keys: "Control+V", tab_id: alpha.id });
  assert.deepEqual(
    b.offered.map((o) => [o.tabId, o.clip.text]),
    [
      [beta.id, "beta's own"],
      [alpha.id, "alpha's secret"],
    ],
  );
  const read = await command(b.port, "clipboard", {
    action: "read",
    tab_id: beta.id,
  });
  assert.equal(read.payload.text, "beta's own");
  assert.ok(!JSON.stringify(read.payload).includes("secret"));
});

test("a page's clipboard call is honoured only inside the agent's own command on that tab", async () => {
  const b = await browserWithPage({ copy: {}, paste: field });
  const tab = b.hold("alpha");
  await settle();
  const pageCalls = (payload, contextId = 7) =>
    b.fire("debugger.onEvent", { tabId: tab.id }, "Runtime.bindingCalled", {
      name: CLIPBOARD_BINDING,
      payload: JSON.stringify(payload),
      executionContextId: contextId,
    });

  // A timer on the page, with no command of the agent's running: refused, nothing stored.
  pageCalls({ id: 1, op: "write", text: "written by itself" });
  await settle();
  assert.deepEqual(b.settled.pop().slice(1, 3), [1, false]);
  const nothing = await command(b.port, "clipboard", {
    action: "read",
    tab_id: tab.id,
  });
  assert.equal(nothing.payload.empty, true);

  // The agent's click: the page's copy button writes the agent's clipboard, and says so on the
  // command's reply.
  b.session.tabs.get(tab.id).inputUntil = Date.now() + 2000;
  pageCalls({ id: 2, op: "write", text: "the link" });
  await settle();
  assert.deepEqual(b.settled.pop().slice(1, 3), [2, true]);
  pageCalls({ id: 3, op: "read" });
  await settle();
  const answer = b.settled.pop();
  assert.equal(answer[2], true);
  assert.equal(answer[3].text, "the link");
  const read = await command(b.port, "clipboard", {
    action: "read",
    tab_id: tab.id,
  });
  assert.equal(read.payload.text, "the link");
  assert.equal(read.payload.page_clipboard.page_wrote.text_length, 8);

  // A page that sends something malformed, or too much, is refused whole.
  pageCalls({ id: 4, op: "write", files: [{ type: "image/png", data: "%%" }] });
  pageCalls({ id: 5, op: "write", text: "x".repeat(2 * 1024 * 1024 + 1) });
  await settle();
  assert.deepEqual(
    b.settled.splice(0).map((s) => [s[1], s[2]]),
    [
      [4, false],
      [5, false],
    ],
  );
});

test("a paste the page does not take is typed: whole into a field, line by line elsewhere", async () => {
  const text = "line one\nline two";
  const intoField = await browserWithPage({ copy: {}, paste: field });
  const t1 = intoField.hold("a");
  await settle();
  await command(intoField.port, "clipboard", {
    action: "write",
    text,
    tab_id: t1.id,
  });
  await command(intoField.port, "clipboard", {
    action: "paste",
    tab_id: t1.id,
  });
  assert.deepEqual(
    intoField.sent("Input.insertText").map((c) => c.params.text),
    [text],
  );

  const rich = await browserWithPage({
    copy: {},
    paste: { handled: "none", editable: true, field: false },
  });
  const t2 = rich.hold("a");
  await settle();
  await command(rich.port, "clipboard", {
    action: "write",
    text,
    tab_id: t2.id,
  });
  rich.calls.cdp.length = 0;
  await command(rich.port, "clipboard", { action: "paste", tab_id: t2.id });
  assert.deepEqual(
    rich.sent("Input.insertText").map((c) => c.params.text),
    ["line one", "line two"],
  );
  const enters = rich
    .sent("Input.dispatchKeyEvent")
    .filter((c) => c.params.type === "keyDown");
  assert.equal(enters.length, 1);
  assert.equal(enters[0].params.key, "Enter");
  assert.equal(enters[0].params.modifiers, 8, "Shift+Enter: never a send");

  const taken = await browserWithPage({
    copy: {},
    paste: { handled: "page", via: "paste" },
  });
  const t3 = taken.hold("a");
  await settle();
  await command(taken.port, "clipboard", {
    action: "write",
    text,
    html: "<b>line</b>",
    tab_id: t3.id,
  });
  const reply = await command(taken.port, "pressKey", {
    keys: "Control+Shift+V",
    tab_id: t3.id,
  });
  assert.equal(reply.payload.clipboard.taken_by, "page");
  assert.equal(taken.sent("Input.insertText").length, 0, "nothing typed");
  assert.equal(
    taken.offered[0].clip.html,
    "",
    "a plain paste offers no markup",
  );
});

test("copying nothing leaves the clipboard as it was; a cut takes the selection out", async () => {
  const b = await browserWithPage({
    copy: { text: "", html: "", from: "selection" },
    paste: field,
  });
  const tab = b.hold("a");
  await settle();
  await command(b.port, "clipboard", {
    action: "write",
    text: "kept",
    tab_id: tab.id,
  });
  const reply = await command(b.port, "pressKey", {
    keys: "Control+C",
    tab_id: tab.id,
  });
  assert.equal(reply.payload.clipboard.copy, false);
  const read = await command(b.port, "clipboard", {
    action: "read",
    tab_id: tab.id,
  });
  assert.equal(read.payload.text, "kept");

  const cut = await browserWithPage({
    copy: { text: "gone", html: "", from: "selection", editable: true },
    paste: field,
  });
  const t2 = cut.hold("a");
  await settle();
  const cutReply = await command(cut.port, "pressKey", {
    keys: "Control+X",
    tab_id: t2.id,
  });
  assert.equal(cutReply.payload.clipboard.cut, true);
  assert.equal(cutReply.payload.clipboard.removed, true);
  const backspace = cut
    .sent("Input.dispatchKeyEvent")
    .filter((c) => c.params.type === "keyDown");
  assert.deepEqual(
    backspace.map((c) => c.params.key),
    ["Backspace"],
    "the selection deleted as a trusted key would delete it",
  );
});

test("an agent that lets go of its last tab lets go of its clipboard; others keep theirs", async () => {
  const b = await browserWithPage({ copy: {}, paste: field });
  const alpha = b.hold("alpha");
  const alphaTwo = b.hold("alpha");
  const beta = b.hold("beta");
  await settle();
  for (const [tab, text] of [
    [alpha, "a"],
    [beta, "b"],
  ]) {
    await command(b.port, "clipboard", {
      action: "write",
      text,
      tab_id: tab.id,
    });
  }
  await b.worker.handleRelease(b.session, { tab_id: alpha.id });
  assert.ok(
    !b.session.tabs.has(alphaTwo.id),
    "releasing alpha takes all its tabs",
  );
  assert.equal(b.session.clipboards.has("alpha"), false);
  assert.equal(b.session.clipboards.get("beta").text, "b");

  await b.worker.handleRelease(b.session, {});
  assert.equal(b.session.clipboards.size, 0, "a session stood down holds none");
});

test("a clipboard refuses what it cannot hold, and keeps what it had", async () => {
  const b = await browserWithPage({ copy: {}, paste: field });
  const tab = b.hold("a");
  await settle();
  await command(b.port, "clipboard", {
    action: "write",
    text: "before",
    tab_id: tab.id,
  });
  const tooBig = await command(b.port, "clipboard", {
    action: "write",
    text: "x".repeat(2 * 1024 * 1024 + 1),
    tab_id: tab.id,
  });
  assert.equal(tooBig.type, "error");
  assert.match(tooBig.error, /larger than a clipboard holds/);
  const nothing = await command(b.port, "clipboard", {
    action: "write",
    text: "",
    tab_id: tab.id,
  });
  assert.equal(nothing.type, "error");
  const read = await command(b.port, "clipboard", {
    action: "read",
    tab_id: tab.id,
  });
  assert.equal(read.payload.text, "before");
});
