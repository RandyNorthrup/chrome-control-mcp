// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// What a session stops believing when its debugger attachment ends.
//
// The attachment can end two ways: this worker detaches on purpose (a tab switch, the bridge
// going away), or the browser detaches for us -- the user closed the tab, opened DevTools, or
// Chrome tore the target down. The session is in the same state afterwards either way, because
// what is no longer true does not depend on who ended it.
//
// It had two spellings. detachAll() cleared thirteen things; the onDetach listener cleared ten
// of them, and the three it forgot were the ones with no visible symptom: a polling handler
// kept driving a tab nothing was attached to, a User-Agent captured from a previous page was
// restored over the next one, and a half-delivered upload survived into the next session.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWorker, makeFakePort } from "./extension_harness.mjs";

const EXPORTED = ["detachAll"];

// The session itself, so a reset can be asserted field by field. It is one object that is
// never reassigned, so naming it in the epilogue gives a live view.
const LIVE = "session";

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
    },
    LIVE,
  );
  return { worker, port, detach: () => detachListener };
}

// Put the session into the state a live attachment leaves behind, so a reset has something to
// clear. These are the exact fields the two paths disagreed about, plus enough context to tell
// a real reset from an accidental one.
function occupySession(session, tabId) {
  session.attachedTabId = tabId;
  session.lastSnapshotTabId = tabId;
  session.lastSnapshotEpoch = session.domEpoch;
  session.lastShot = { tabId, epoch: session.domEpoch };
  session.pendingDialogPolicy = {
    accept: true,
    origin: "https://example.test",
  };
  session.lastDialog = { type: "confirm", message: "gone", accepted: true };
  session.inflightRequests.add("request-1");
  session.networkInstrumented = true;
  session.originalUserAgent = "Mozilla/5.0 (the page we no longer drive)";
  session.httpAuthCreds = { username: "u", password: "p", origin: "https://x" };
  session.lastFetchError = "a paused request we never answered";
  session.uploadChunks.set("upload-1", ["half a file"]);
}

// Everything a finished attachment must stop asserting, as (name, predicate) so both paths can
// be held to the same list rather than to two copies of it.
const CLEARED = [
  ["lastSnapshotTabId", (s) => s.lastSnapshotTabId === null],
  ["lastSnapshotEpoch", (s) => s.lastSnapshotEpoch === null],
  ["lastShot", (s) => s.lastShot === null],
  ["pendingDialogPolicy", (s) => s.pendingDialogPolicy === null],
  ["lastDialog", (s) => s.lastDialog === null],
  ["inflightRequests", (s) => s.inflightRequests.size === 0],
  ["networkInstrumented", (s) => s.networkInstrumented === false],
  ["originalUserAgent", (s) => s.originalUserAgent === null],
  ["httpAuthCreds", (s) => s.httpAuthCreds === null],
  ["lastFetchError", (s) => s.lastFetchError === null],
  ["uploadChunks", (s) => s.uploadChunks.size === 0],
];

function assertReleased(session, before, how) {
  for (const [name, holds] of CLEARED) {
    assert.ok(holds(session), `${how} must clear ${name}`);
  }
  assert.ok(
    session.domEpoch > before.domEpoch,
    `${how} must retire the DOM generation the refs were captured against`,
  );
  assert.ok(
    session.commandGeneration > before.commandGeneration,
    `${how} must retire the command generation a polling handler is watching`,
  );
  assert.equal(session.attachedTabId, null, `${how} must drop the attachment`);
}

test("detaching on purpose releases everything the attachment asserted", async () => {
  const { worker } = bootWorker();
  const { session } = worker;
  occupySession(session, 41);
  const before = {
    domEpoch: session.domEpoch,
    commandGeneration: session.commandGeneration,
  };

  await worker.detachAll("switching tabs");

  assertReleased(session, before, "detachAll");
});

test("the browser detaching releases exactly the same things", async () => {
  // The user closing the tab or opening DevTools is not a lesser event than a tab switch. A
  // field cleared by one path and not the other is a session that half survives its own end.
  const { worker, detach } = bootWorker();
  const { session } = worker;
  occupySession(session, 41);
  const before = {
    domEpoch: session.domEpoch,
    commandGeneration: session.commandGeneration,
  };

  const listener = detach();
  assert.ok(listener, "the worker must register an onDetach listener");
  listener({ tabId: 41 });

  assertReleased(session, before, "onDetach");
});

test("a detach of some other tab is not this session's business", async () => {
  // The listener fires for every target the extension is attached to. Reacting to one this
  // session never held would retire a live command generation and blank a valid snapshot.
  const { worker, detach } = bootWorker();
  const { session } = worker;
  occupySession(session, 41);
  const before = {
    domEpoch: session.domEpoch,
    commandGeneration: session.commandGeneration,
  };

  detach()({ tabId: 999 });

  assert.equal(session.attachedTabId, 41, "the attachment is untouched");
  assert.equal(session.domEpoch, before.domEpoch);
  assert.equal(session.commandGeneration, before.commandGeneration);
  assert.equal(session.networkInstrumented, true);
  assert.equal(session.inflightRequests.size, 1);
});
