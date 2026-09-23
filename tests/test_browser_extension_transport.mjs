// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The service worker's native-messaging transport: connecting, the readiness handshake, and
// how a command frame is accepted or refused.
//
// WHY THIS EXISTS
// Nothing covered this layer. No test referenced onHostMessage, bridge_ready,
// BRIDGE_PROTOCOL, connectNative or postMessage; test_browser_extension_pure.mjs loads the
// same worker but deliberately scopes itself to functions that decide something without
// asking Chrome. That left the transport tri-state -- `port`, `health`, `bridgeReady` -- and
// every refusal built on it resting entirely on review.
//
// It matters now because that state is about to be moved into a per-session record so the
// worker can hold several assistant sessions at once. Each of these globals is a guard whose
// failure mode is SILENT: a command admitted without a handshake, or an error reply that
// never reaches the server, looks exactly like success from the outside. This file is the net
// under that refactor -- it pins the behaviour first, so the move can be shown to preserve it.
//
// Like the pure suite, the worker is evaluated as shipped; only chrome.runtime.connectNative
// is replaced, with a port a test can drive.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadWorker,
  makeFakePort,
  settle,
} from "./extension_harness.mjs";

// Functions reached directly. Everything else is driven through the port.
const EXPORTED = ["connect", "send", "health"];

// `port`, `bridgeReady` and `commandGeneration` are `let` bindings, so naming them in the
// epilogue would capture their value at load time rather than follow them. A closure reads
// them live.
const LIVE = "peek: () => ({ port, bridgeReady, commandGeneration, domEpoch })";

// Load the worker with a port under the test's control. The worker calls connect() at top
// level, so the port is already open and both listeners are registered when this returns.
//
// `attached` records every chrome.debugger.attach. A refusal has to be distinguishable from
// a command that ran and merely failed -- both put `{type:"error"}` on the wire -- and the
// attach is the first thing any real command does, so an empty list proves nothing ran.
function bootWorker() {
  const port = makeFakePort();
  const attached = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => port,
      "debugger.attach": (target) => {
        attached.push(target);
        return Promise.resolve();
      },
    },
    LIVE,
  );
  return { worker, port, attached };
}

// The protocol the shipped worker speaks. Deliberately written out rather than read from the
// worker: a test that imported the constant would agree with any value, including a wrong one.
const PROTOCOL = 1;

function ready(port, protocol = PROTOCOL) {
  port.emit({ type: "bridge_ready", protocol });
}

test("connect opens one native port and reuses it", () => {
  const { worker, port } = bootWorker();
  // The worker connected during evaluation; it must not open a second port when asked again.
  assert.equal(worker.peek().port, port);
  assert.equal(worker.connect(), port);
  assert.equal(worker.peek().port, port);
});

test("bridge_ready on the agreed protocol is what opens the bridge", () => {
  const { worker, port } = bootWorker();
  assert.equal(worker.peek().bridgeReady, false, "closed until handshook");

  ready(port);

  assert.equal(worker.peek().bridgeReady, true);
  assert.equal(worker.health.connected, true);
  assert.equal(worker.health.bridge, "ready");
  assert.equal(worker.health.error, null);
  assert.deepEqual(port.posted, [], "readiness is not acknowledged on the wire");
});

test("a protocol the worker does not speak leaves the bridge closed", async () => {
  // A skew has to STOP something to be a check at all. The host announcing a version this
  // worker does not speak must not get commands executed on its say-so.
  const { worker, port, attached } = bootWorker();

  ready(port, PROTOCOL + 1);

  assert.equal(worker.peek().bridgeReady, false);
  assert.match(String(worker.health.error), /protocol mismatch/i);
  assert.match(String(worker.health.error), new RegExp(String(PROTOCOL + 1)));

  port.emit({ type: "command", id: "b-1", cmd: "snapshot" });
  await settle();

  assert.equal(port.posted.length, 1, "exactly one refusal, and no retry");
  assert.equal(port.lastPosted().type, "error");
  assert.equal(port.lastPosted().id, "b-1", "the refusal is correlated");
  assert.match(String(port.lastPosted().error), /protocol mismatch/i);
  assert.deepEqual(attached, [], "the command must never have reached the browser");
});

test("a command arriving before any handshake is refused, not run", async () => {
  const { worker, port, attached } = bootWorker();
  assert.equal(worker.peek().bridgeReady, false);

  port.emit({ type: "command", id: "b-7", cmd: "snapshot" });
  await settle();

  assert.equal(port.posted.length, 1);
  assert.equal(port.lastPosted().type, "error");
  assert.equal(port.lastPosted().id, "b-7");
  assert.equal(port.lastPosted().cmd, "snapshot");
  // Refused, not merely failed. Both shapes are `{type:"error"}` on the wire, so the reason
  // has to say which happened, and the browser has to be untouched.
  assert.match(
    String(port.lastPosted().error),
    /readiness handshake/i,
    "the refusal must name the missing handshake",
  );
  assert.deepEqual(attached, [], "the command must never have reached the browser");
});

test("a command frame with no usable id is dropped in silence", async () => {
  // There is no id to correlate a refusal against, so answering would put a frame on the
  // wire that the server cannot match to anything -- which desynchronizes the exchange.
  const { port } = bootWorker();
  ready(port);

  port.emit({ type: "command", cmd: "snapshot" });
  port.emit({ type: "command", id: "", cmd: "snapshot" });
  port.emit({ type: "command", id: 42, cmd: "snapshot" });
  await settle();

  assert.deepEqual(port.posted, []);
});

test("a command frame with no cmd is refused with its id echoed", async () => {
  const { port } = bootWorker();
  ready(port);

  port.emit({ type: "command", id: "b-2" });
  await settle();

  assert.equal(port.posted.length, 1);
  assert.equal(port.lastPosted().type, "error");
  assert.equal(port.lastPosted().id, "b-2");
});

test("bridge_unavailable closes the bridge and says why", async () => {
  const { worker, port } = bootWorker();
  ready(port);
  assert.equal(worker.peek().bridgeReady, true);

  port.emit({ type: "bridge_unavailable", error: "no server published a record" });
  await settle();

  assert.equal(worker.peek().bridgeReady, false);
  assert.equal(worker.health.connected, false);
  assert.equal(worker.health.bridge, "unavailable");
  assert.match(String(worker.health.error), /no server published a record/);
});

test("cancel retires the current command generation and is never answered", async () => {
  // A polling handler holds the generation it started under; the bump is what makes it
  // abandon instead of driving the page after the server has given up on the exchange.
  const { worker, port } = bootWorker();
  ready(port);
  const before = worker.peek().commandGeneration;

  port.emit({ type: "cancel" });
  await settle();

  assert.ok(
    worker.peek().commandGeneration > before,
    "cancel must retire the generation",
  );
  assert.deepEqual(port.posted, [], "a cancel is not replied to");
});

test("an unrecognised frame type changes nothing", async () => {
  // This is what makes the protocol extensible: a frame a worker does not know must not
  // disconnect it, refuse anything, or alter the transport state.
  const { worker, port } = bootWorker();
  ready(port);
  const before = worker.peek();

  port.emit({ type: "attach_session", session: "12345" });
  port.emit({ type: "something_from_a_later_version" });
  await settle();

  const after = worker.peek();
  assert.equal(after.bridgeReady, before.bridgeReady);
  assert.equal(after.commandGeneration, before.commandGeneration);
  assert.equal(after.domEpoch, before.domEpoch);
  assert.equal(worker.health.connected, true);
  assert.deepEqual(port.posted, []);
  assert.equal(port.connected, true, "and the port stays up");
});

test("a message that is not an object is ignored", async () => {
  const { worker, port } = bootWorker();
  ready(port);

  for (const junk of [null, undefined, "command", 7, true]) {
    port.emit(junk);
  }
  await settle();

  assert.equal(worker.peek().bridgeReady, true);
  assert.deepEqual(port.posted, []);
});

test("losing the port closes the bridge and drops the transport state", async () => {
  const { worker, port } = bootWorker();
  ready(port);
  assert.equal(worker.peek().bridgeReady, true);

  port.drop();
  await settle();

  assert.equal(worker.peek().port, null, "no port to post a stale reply on");
  assert.equal(worker.peek().bridgeReady, false, "the next host must handshake again");
  assert.equal(worker.health.connected, false);
});

test("a reply that cannot be delivered tears the port down at once", async () => {
  // The reply IS the exchange. A frame that never reaches the relay leaves the server
  // waiting out its whole deadline and then reporting a transport reset for a delivery
  // failure already known here -- so the port goes down immediately instead.
  const { worker, port } = bootWorker();
  ready(port);

  port.disconnect(); // postMessage now throws, as Chrome's does on a dead port
  port.emit({ type: "command", id: "b-9" }); // no cmd: replies without touching the browser
  await settle();

  assert.equal(worker.peek().port, null);
  assert.equal(worker.peek().bridgeReady, false);
  assert.equal(worker.health.connected, false);
  assert.match(String(worker.health.error), /could not be delivered/i);
});
