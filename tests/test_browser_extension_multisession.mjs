// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Serving more than one assistant session from one service worker.
//
// One port per server, one session per port. Two editors driving two MCP
// servers get a session each rather than contending for a single one, and the
// thing that has to hold is that they stay apart: a tab one session is driving
// must not be taken by the other, because both would keep a snapshot, a ref
// index and a screenshot transform that the other silently invalidates.
//
// These drive the worker through its ports, exactly as the relay does.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWorker, makeFakePort, settle } from "./extension_harness.mjs";

const EXPORTED = [
  "connect",
  "handleSelectTab",
  "leaseHolder",
  "requireUnleasedTab",
];
const LIVE = "sessions, ports: () => [...sessions].map((s) => s.port)";
const PROTOCOL = 1;

// Every connectNative hands back a fresh port, so opening a second one is
// observable rather than aliasing the first.
function bootWorker() {
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
  return { worker, opened };
}

const offer = (port, servers) =>
  port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers });

function answers(port) {
  return port.posted.filter((f) => f.type === "attach_session");
}

test("two servers get a port each", async () => {
  const { worker, opened } = bootWorker();
  assert.equal(opened.length, 1, "one port is open before any offer");

  offer(opened[0], ["100", "200"]);
  await settle();

  // The first port takes one server and opens a port for the other, rather than
  // waiting for the alarm to notice that a second editor is running.
  assert.equal(answers(opened[0])[0].session, "100");
  assert.equal(
    opened.length,
    2,
    "a second port was opened for the second server",
  );

  offer(opened[1], ["100", "200"]);
  await settle();

  assert.equal(
    answers(opened[1])[0].session,
    "200",
    "the second port takes the server the first did not",
  );
  assert.equal(worker.sessions.size, 2);
  assert.equal(opened.length, 2, "and no third port is opened for two servers");
});

test("a port with no server left to take goes away instead of retrying", async () => {
  // The alarm opens a probe port to notice servers that started later. When
  // every offered server is already held that probe has no work, and retrying
  // it would open a surplus host process every two seconds forever.
  const { worker, opened } = bootWorker();
  offer(opened[0], ["100"]);
  await settle();
  assert.equal(worker.sessions.size, 1);

  worker.connect(); // stands in for the alarm's probe
  await settle();
  assert.equal(opened.length, 2);

  offer(opened[1], ["100"]);
  await settle();

  assert.equal(
    answers(opened[1])[0].session,
    "",
    "it asks for no server, so the relay exits rather than waiting",
  );

  opened[1].drop();
  await settle();

  assert.equal(worker.sessions.size, 1, "the surplus session is discarded");
  assert.equal(opened.length, 2, "and nothing reconnects in its place");
});

test("an offer with no servers at all still reconnects", async () => {
  // Nothing published yet is the case the reconnect cycle exists for, and it
  // has to stay distinguishable from "everything is already taken".
  const { worker, opened } = bootWorker();
  offer(opened[0], []);
  await settle();

  assert.equal(answers(opened[0])[0].session, "");
  assert.equal(worker.sessions.size, 1, "the session is kept, to retry with");
});

// -- leases ------------------------------------------------------------------

// Put two sessions in place, each attached to a server, and give the first one
// a tab so the second has something to collide with.
async function twoSessions(tabId) {
  const { worker, opened } = bootWorker();
  offer(opened[0], ["100", "200"]);
  await settle();
  offer(opened[1], ["100", "200"]);
  await settle();
  const [first, second] = [...worker.sessions];
  first.sessionTabId = tabId;
  return { worker, first, second };
}

test("selecting a tab the other session drives is refused", async () => {
  // The whole path, not just the predicate: browser_select_tab resolves an
  // index against this session's own listing and then takes the tab.
  const { worker, second } = await twoSessionsWithBrowser(7);
  second.sessionTabId = 9; // it has a tab of its own, in the same window
  second.sessionWindowId = 1;
  second.lastTabListing = {
    windowId: 1,
    entries: [
      { index: 0, id: 7 },
      { index: 1, id: 9 },
    ],
  };

  await assert.rejects(
    () => worker.handleSelectTab(second, { index: 0 }),
    /driven by another Chrome Control MCP session/,
    "the tab the first session holds is refused",
  );
  assert.equal(second.sessionTabId, 9, "and the session did not move to it");

  // Its own tab is still selectable, so the refusal is about the lease and not
  // about selection being broken.
  const taken = await worker.handleSelectTab(second, { index: 1 });
  assert.equal(taken.ok, true);
  assert.equal(second.sessionTabId, 9);
});

// The same two sessions, plus enough of chrome.tabs for a real selection to
// resolve: two tabs in one window, the first held by the first session.
async function twoSessionsWithBrowser(tabId) {
  const tabs = [
    { id: tabId, index: 0, windowId: 1, title: "held", url: "https://a.test/" },
    { id: 9, index: 1, windowId: 1, title: "free", url: "https://b.test/" },
  ];
  const opened = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => {
        const port = makeFakePort();
        opened.push(port);
        return port;
      },
      "tabs.query": () => Promise.resolve(tabs),
      "tabs.get": (id) =>
        Promise.resolve(tabs.find((t) => t.id === id) ?? null),
      "windows.get": (id) => Promise.resolve({ id }),
    },
    LIVE,
  );
  offer(opened[0], ["100", "200"]);
  await settle();
  offer(opened[1], ["100", "200"]);
  await settle();
  const [first, second] = [...worker.sessions];
  first.sessionTabId = tabId;
  first.sessionWindowId = 1;
  return { worker, first, second };
}

test("a session cannot adopt a tab another session already holds", async () => {
  const { worker, second } = await twoSessions(7);
  // The refusal names the other session so "busy" reads differently from
  // "gone", which are the two reasons a tab can be unavailable.
  assert.throws(
    () => worker.requireUnleasedTab(second, { id: 7 }),
    /driven by another Chrome Control MCP session/,
  );
  // Its own tab, and an unheld one, are both fine.
  const [first] = [...worker.sessions];
  worker.requireUnleasedTab(first, { id: 7 });
  worker.requireUnleasedTab(second, { id: 8 });
});

test("a tab held by another session is marked in the listing, not hidden", async () => {
  // The operator can see the whole window either way. What changes is that
  // selecting one of these is refused, and a listing giving no reason for that
  // refusal would read as a bug.
  const { worker, second } = await twoSessions(7);
  assert.ok(worker.leaseHolder(7, second), "held by the other session");
  assert.equal(worker.leaseHolder(8, second), null, "nothing holds this one");
  const [first] = [...worker.sessions];
  assert.equal(worker.leaseHolder(7, first), null, "not held against itself");
});
