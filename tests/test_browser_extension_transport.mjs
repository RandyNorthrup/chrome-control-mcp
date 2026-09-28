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

import { loadWorker, makeFakePort, settle } from "./extension_harness.mjs";

// Functions reached directly. Everything else is driven through the port.
const EXPORTED = [
  "connect",
  "send",
  "setBridgePaused",
  "reconnectOnActivity",
  "RECONNECT_MIN_MS",
  "RECONNECT_MAX_MS",
];

// A session's fields are reassigned as the bridge comes and goes, so naming them in the
// epilogue would capture their values at load time rather than follow them; a closure reads
// them live.
//
// The worker serves a SET of sessions now, one per native port. These tests drive a single
// port, so `peek` reports that session, and `sessions` itself is exposed because "how many
// ports did the worker open" is the question a surplus or duplicate one shows up in.
const LIVE =
  "sessions, peek: () => { const s = [...sessions][0]; return s ? {" +
  " port: s.port, bridgeReady: s.bridgeReady," +
  " commandGeneration: s.commandGeneration, domEpoch: s.domEpoch," +
  " serverId: s.serverId, health: s.health, surplus: s.surplus } : {}; }," +
  " retryDelay: () => reconnectDelayMs, paused: () => bridgePaused";

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

// A browser with no MCP server running must not spawn a native host process every couple of
// seconds for as long as it is open.
//
// Every attempt starts a process: connectNative launches the host, which looks for a published
// server, finds none, says so and exits. The retry was a flat 2 s armed by its own disconnect, and
// ordinary browsing added one attempt per tab event on top -- which on a real machine was loud
// enough to interfere with unrelated work, and the way out was to disable the extension.
test("a bridge that never answers is asked for less and less often", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const opened = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => {
        const port = makeFakePort();
        opened.push(port);
        return port;
      },
    },
    LIVE,
  );
  const min = worker.RECONNECT_MIN_MS;

  // The worker connects at load. Nothing answers, and the host goes away.
  assert.equal(opened.length, 1);
  assert.equal(worker.retryDelay(), min, "it starts at the short interval");
  opened[0].drop();

  // The first retry still comes at the SHORT interval: a server that was a moment from starting,
  // or has only just gone, is picked up quickly. It is the run of failures after this that earns
  // the waiting.
  t.mock.timers.tick(min - 1);
  assert.equal(opened.length, 1, "not before the interval is up");
  t.mock.timers.tick(1);
  assert.equal(opened.length, 2, "and once it is");

  // That attempt fails too, so the next one waits twice as long -- and the tick that would have
  // been enough a moment ago is not any more.
  opened[1].drop();
  t.mock.timers.tick(min);
  assert.equal(opened.length, 2, "the interval doubled");
  t.mock.timers.tick(min);
  assert.equal(opened.length, 3);

  // And again, until it stops growing. Each round doubles, so a browser left open with no server
  // ends up asking a couple of times an hour rather than thirty times a minute.
  let delay = min * 2;
  for (let round = 0; round < 8; round++) {
    opened[opened.length - 1].drop();
    delay = Math.min(delay * 2, worker.RECONNECT_MAX_MS);
    t.mock.timers.tick(delay);
  }
  assert.equal(
    worker.retryDelay(),
    worker.RECONNECT_MAX_MS,
    "the interval is capped rather than growing without end",
  );
});

// The path that made the old interval moot. tabs.onUpdated and tabs.onActivated fire constantly
// while somebody browses, and each one used to be an unconditional attempt -- so the 2 s timer was
// never the fastest thing asking.
test("ordinary browsing does not get to bypass the interval", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const opened = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => {
        const port = makeFakePort();
        opened.push(port);
        return port;
      },
    },
    LIVE,
  );
  opened[0].drop();
  assert.equal(opened.length, 1);

  // A hundred tab events inside the waiting interval are a hundred refusals, not a hundred
  // processes.
  for (let event = 0; event < 100; event++) {
    worker.reconnectOnActivity();
  }
  assert.equal(opened.length, 1, "no attempt is made inside the interval");

  // Once it has passed, browsing is a perfectly good reason to try again -- that is what it is
  // there for, so a bridge that came up is noticed without waiting for the alarm.
  t.mock.timers.tick(worker.RECONNECT_MIN_MS);
  assert.equal(opened.length, 2, "the scheduled retry ran");
  opened[1].drop();
  t.mock.timers.tick(worker.RECONNECT_MIN_MS * 2);
  const before = opened.length;
  worker.reconnectOnActivity();
  assert.ok(
    opened.length >= before,
    "browsing after the interval may attempt again",
  );
});

// A bridge that answers has to put the interval back, or the growth is a one-way ratchet: an
// editor started after a long quiet spell would be found two minutes later instead of at once.
test("a bridge that answers puts the interval back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const opened = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => {
        const port = makeFakePort();
        opened.push(port);
        return port;
      },
    },
    LIVE,
  );
  // Fail a few times so the interval has grown well past its floor.
  for (let round = 0; round < 3; round++) {
    opened[opened.length - 1].drop();
    t.mock.timers.tick(worker.RECONNECT_MAX_MS);
  }
  assert.ok(worker.retryDelay() > worker.RECONNECT_MIN_MS, "the interval grew");

  // Now a host answers.
  opened[opened.length - 1].emit({ type: "bridge_ready", protocol: PROTOCOL });
  assert.equal(
    worker.retryDelay(),
    worker.RECONNECT_MIN_MS,
    "and a bridge that answered resets it",
  );
});

// The switch, because backing off is not the same as being able to stop it. Somebody whose work
// this interferes with should be able to turn it off without uninstalling the extension.
test("pausing closes the bridge and stops every attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const opened = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => {
        const port = makeFakePort();
        opened.push(port);
        return port;
      },
      "debugger.attach": () => Promise.resolve(),
      "debugger.detach": () => Promise.resolve(),
    },
    LIVE,
  );
  opened[0].emit({ type: "bridge_ready", protocol: PROTOCOL });
  assert.equal(worker.paused(), false);
  assert.equal([...worker.sessions].length, 1);

  await worker.setBridgePaused(true);
  assert.equal(worker.paused(), true);
  assert.equal(
    opened[0].connected,
    false,
    "the open port is closed, not just left idle",
  );
  assert.equal([...worker.sessions].length, 0);

  // Nothing reaches for the bridge while it is off -- not the timer, not browsing, and not an
  // attempt that asks to skip the waiting. A pause the extension can talk itself out of is not a
  // pause.
  const whilePaused = opened.length;
  t.mock.timers.tick(worker.RECONNECT_MAX_MS * 2);
  worker.reconnectOnActivity();
  assert.equal(
    worker.connect({ force: true }),
    null,
    "even a forced attempt is refused",
  );
  assert.equal(opened.length, whilePaused, "no host process while paused");

  // And resuming works.
  await worker.setBridgePaused(false);
  assert.equal(worker.paused(), false);
  assert.notEqual(worker.connect({ force: true }), null);
  assert.equal(opened.length, whilePaused + 1);
});

test("connecting gives the port a session of its own", () => {
  const { worker, port } = bootWorker();
  // The worker connected during evaluation. A port IS a session: Chrome starts
  // a separate host process per port and the relay behind it attaches to
  // exactly one server, so a second port is a second session rather than a
  // second route to the first.
  assert.equal(worker.sessions.size, 1);
  assert.equal(worker.peek().port, port);

  worker.connect();

  assert.equal(worker.sessions.size, 2, "a second port is a second session");
});

test("bridge_ready on the agreed protocol is what opens the bridge", () => {
  const { worker, port } = bootWorker();
  assert.equal(worker.peek().bridgeReady, false, "closed until handshook");

  ready(port);

  assert.equal(worker.peek().bridgeReady, true);
  assert.equal(worker.peek().health.connected, true);
  assert.equal(worker.peek().health.bridge, "ready");
  assert.equal(worker.peek().health.error, null);
  assert.deepEqual(
    port.posted,
    [],
    "readiness is not acknowledged on the wire",
  );
});

test("a protocol the worker does not speak leaves the bridge closed", async () => {
  // A skew has to STOP something to be a check at all. The host announcing a version this
  // worker does not speak must not get commands executed on its say-so.
  const { worker, port, attached } = bootWorker();

  ready(port, PROTOCOL + 1);

  assert.equal(worker.peek().bridgeReady, false);
  assert.match(String(worker.peek().health.error), /protocol mismatch/i);
  assert.match(
    String(worker.peek().health.error),
    new RegExp(String(PROTOCOL + 1)),
  );

  port.emit({ type: "command", id: "b-1", cmd: "snapshot" });
  await settle();

  assert.equal(port.posted.length, 1, "exactly one refusal, and no retry");
  assert.equal(port.lastPosted().type, "error");
  assert.equal(port.lastPosted().id, "b-1", "the refusal is correlated");
  assert.match(String(port.lastPosted().error), /protocol mismatch/i);
  assert.deepEqual(
    attached,
    [],
    "the command must never have reached the browser",
  );
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
  assert.deepEqual(
    attached,
    [],
    "the command must never have reached the browser",
  );
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

  port.emit({
    type: "bridge_unavailable",
    error: "no server published a record",
  });
  await settle();

  assert.equal(worker.peek().bridgeReady, false);
  assert.equal(worker.peek().health.connected, false);
  assert.equal(worker.peek().health.bridge, "unavailable");
  assert.match(
    String(worker.peek().health.error),
    /no server published a record/,
  );
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

test("the worker answers a bridge offer with the server it will attach to", async () => {
  // The relay asks which server this port should take, because the worker has
  // no filesystem access and cannot discover one for itself.
  const { worker, port } = bootWorker();
  assert.deepEqual(port.posted, [], "nothing is sent before being asked");

  port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["4242"] });
  await settle();

  assert.equal(port.posted.length, 1);
  assert.equal(port.lastPosted().type, "attach_session");
  assert.equal(port.lastPosted().session, "4242");
  assert.equal(worker.peek().serverId, "4242");
  // Answering an offer is not a handshake: commands stay refused until the
  // relay has actually reached that server and said so.
  assert.equal(worker.peek().bridgeReady, false);
});

test("an offer with no servers is still answered, so the relay is not left waiting", async () => {
  // The relay's wait for this answer is bounded and a timeout is reported as
  // the extension being too old. Staying silent because there was nothing to
  // choose would produce exactly that misleading diagnosis.
  const { worker, port } = bootWorker();

  port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: [] });
  await settle();

  assert.equal(port.posted.length, 1);
  assert.equal(port.lastPosted().type, "attach_session");
  assert.equal(port.lastPosted().session, "");
  assert.equal(worker.peek().serverId, "");
});

test("the worker never speaks first on this channel", async () => {
  // A frame sent unprompted would be read by an older relay as the reply to a
  // command it had not sent, putting every later exchange one step out of
  // phase. Connecting, and a readiness handshake, must both stay silent.
  const { port } = bootWorker();
  await settle();
  assert.deepEqual(port.posted, [], "connecting sends nothing");

  ready(port);
  await settle();
  assert.deepEqual(port.posted, [], "bridge_ready is not acknowledged either");
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
  assert.equal(worker.peek().health.connected, true);
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
  assert.equal(
    worker.peek().bridgeReady,
    false,
    "the next host must handshake again",
  );
  assert.equal(worker.peek().health.connected, false);
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
  assert.equal(worker.peek().health.connected, false);
  assert.match(String(worker.peek().health.error), /could not be delivered/i);
});
