// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// What a session stops believing about a tab when its debugger attachment to that tab ends.
//
// The attachment can end two ways: this worker detaches on purpose (the session lets go of the
// tab, goes idle, or the bridge goes away), or the browser detaches for us -- the user closed the
// tab, opened DevTools, or Chrome tore the target down. The tab is in the same state afterwards
// either way, because what is no longer true does not depend on who ended it.
//
// It had two spellings once. detachAll() cleared thirteen things; the onDetach listener cleared
// ten of them, and the three it forgot were the ones with no visible symptom: a polling handler
// kept driving a tab nothing was attached to, a User-Agent captured from a previous page was
// restored over the next one, and a half-delivered upload survived into the next session.
//
// A session now holds several tabs, each attached on its own. What ends with one attachment is
// that tab's page state -- and nothing of any other tab's, which is the whole point of holding
// them separately: two agents on two tabs of one session must not blank each other's snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWorker, makeFakePort } from "./extension_harness.mjs";

const EXPORTED = ["detachTab", "standDown", "makeTabState"];

// The one session this suite drives, so a reset can be asserted field by field.
const LIVE = "only: () => [...sessions][0]";

function bootWorker() {
  const port = makeFakePort();
  // The worker registers its onDetach handler at load; capturing it here is how a test plays
  // the part of the browser tearing a target down.
  let detachListener = null;
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => port,
      "debugger.onDetach": {
        addListener: (fn) => {
          detachListener = fn;
        },
      },
      "debugger.detach": () => Promise.resolve(),
      "debugger.sendCommand": () => Promise.resolve({}),
      "tabs.get": (id) => Promise.resolve({ id, windowId: 1, index: 0 }),
      "tabs.query": () => Promise.resolve([]),
      "tabs.ungroup": () => Promise.resolve(),
      "tabs.remove": () => Promise.resolve(),
    },
    LIVE,
  );
  return { worker, port, detach: () => detachListener };
}

// A held, attached tab in the state a live attachment leaves behind, so a reset has something to
// clear. These are the exact fields the two paths once disagreed about, plus enough context to
// tell a real reset from an accidental one.
function occupyTab(worker, session, tabId) {
  const state = worker.makeTabState(tabId, "opened");
  session.tabs.set(tabId, state);
  state.attached = true;
  state.lastSnapshotEpoch = state.domEpoch;
  state.lastShot = { epoch: state.domEpoch };
  state.pendingDialogPolicy = { accept: true, origin: "https://example.test" };
  state.lastDialog = { type: "confirm", message: "gone", accepted: true };
  state.inflightRequests.add("request-1");
  state.networkInstrumented = true;
  state.originalUserAgent = "Mozilla/5.0 (the page we no longer drive)";
  state.httpAuthCreds = { username: "u", password: "p", origin: "https://x" };
  state.lastFetchError = "a paused request we never answered";
  state.fileChooser = { kind: "input", backendNodeId: 7, multiple: false };
  return state;
}

// Everything a finished attachment must stop asserting about its tab, as (name, predicate) so
// both paths can be held to the same list rather than to two copies of it.
const CLEARED = [
  ["lastSnapshotEpoch", (t) => t.lastSnapshotEpoch === null],
  ["lastShot", (t) => t.lastShot === null],
  ["pendingDialogPolicy", (t) => t.pendingDialogPolicy === null],
  ["lastDialog", (t) => t.lastDialog === null],
  ["inflightRequests", (t) => t.inflightRequests.size === 0],
  ["networkInstrumented", (t) => t.networkInstrumented === false],
  ["originalUserAgent", (t) => t.originalUserAgent === null],
  ["httpAuthCreds", (t) => t.httpAuthCreds === null],
  ["lastFetchError", (t) => t.lastFetchError === null],
  ["fileChooser", (t) => t.fileChooser === null],
  ["attached", (t) => t.attached === false],
];

function assertReleased(session, state, before, how) {
  for (const [name, holds] of CLEARED) {
    assert.ok(holds(state), `${how} must clear ${name}`);
  }
  assert.ok(
    state.domEpoch > before.domEpoch,
    `${how} must retire the DOM generation the refs were captured against`,
  );
  assert.ok(
    session.commandGeneration > before.commandGeneration,
    `${how} must retire the command generation a polling handler is watching`,
  );
}

test("detaching on purpose releases everything the attachment asserted", async () => {
  const { worker } = bootWorker();
  const session = worker.only();
  const state = occupyTab(worker, session, 41);
  const before = {
    domEpoch: state.domEpoch,
    commandGeneration: session.commandGeneration,
  };

  await worker.detachTab(session, state);

  assertReleased(session, state, before, "detachTab");
});

test("the browser detaching releases exactly the same things", async () => {
  // The user closing the tab or opening DevTools is not a lesser event than letting go of it. A
  // field cleared by one path and not the other is a tab that half survives its own end.
  const { worker, detach } = bootWorker();
  const session = worker.only();
  const state = occupyTab(worker, session, 41);
  const before = {
    domEpoch: state.domEpoch,
    commandGeneration: session.commandGeneration,
  };

  const listener = detach();
  assert.ok(listener, "the worker must register an onDetach listener");
  listener({ tabId: 41 });

  assertReleased(session, state, before, "onDetach");
  assert.ok(
    session.tabs.has(41),
    "the tab is still held; only the debugger let go",
  );
});

test("a detach of some other tab is not this session's business", async () => {
  // The listener fires for every target the extension is attached to. Reacting to one this
  // session never held would retire a live command generation and blank a valid snapshot.
  const { worker, detach } = bootWorker();
  const session = worker.only();
  const state = occupyTab(worker, session, 41);
  const before = {
    domEpoch: state.domEpoch,
    commandGeneration: session.commandGeneration,
  };

  detach()({ tabId: 999 });

  assert.equal(state.attached, true, "the attachment is untouched");
  assert.equal(state.domEpoch, before.domEpoch);
  assert.equal(session.commandGeneration, before.commandGeneration);
  assert.equal(state.networkInstrumented, true);
  assert.equal(state.inflightRequests.size, 1);
});

test("one tab's detach leaves the session's other tabs exactly as they were", async () => {
  // Two agents on two tabs of one session. When the user opens DevTools on agent A's tab, agent
  // B's snapshot, dialog arm and network log must survive -- this was impossible while the
  // session held one attachment, since moving to a second tab detached the first.
  const { worker, detach } = bootWorker();
  const session = worker.only();
  occupyTab(worker, session, 41);
  const other = occupyTab(worker, session, 42);
  const otherEpoch = other.domEpoch;

  detach()({ tabId: 41 });

  assert.equal(other.attached, true);
  assert.equal(other.domEpoch, otherEpoch, "the other tab's refs stay valid");
  assert.equal(other.lastSnapshotEpoch, otherEpoch);
  assert.ok(other.pendingDialogPolicy, "the other tab's dialog arm survives");
  assert.equal(other.inflightRequests.size, 1);
});

test("a half-delivered upload survives one tab's detach and goes with the session", async () => {
  // Upload pieces belong to the session (they arrive before the command that names a tab), so a
  // DevTools detach on some other tab must not drop another agent's file mid-delivery -- but the
  // session ending must, so the user's bytes never outlive the session that was sending them.
  const { worker } = bootWorker();
  const session = worker.only();
  const state = occupyTab(worker, session, 41);
  session.uploadChunks.set("upload-1", ["half a file"]);

  await worker.detachTab(session, state);
  assert.equal(session.uploadChunks.size, 1);

  await worker.standDown(session, { closeOpened: false });
  assert.equal(session.uploadChunks.size, 0);
  assert.equal(session.tabs.size, 0);
});
