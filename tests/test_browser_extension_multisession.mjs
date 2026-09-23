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

// -- The dispatcher contract -------------------------------------------------
//
// dispatchCommand builds its argument list positionally:
//
//   const params = [session];
//   if (entry.tab) params.push(await activeTabId(session));
//   if (entry.args) params.push(args);
//
// so every handler must declare exactly those parameters, session first. A
// handler that omits it still runs: it receives the session as its tabId and
// the tab id as its args, and JavaScript reports nothing. browser_navigate
// shipped that way in 1.5.0 -- handleNavigate(tabId, args) read args.url off a
// tab id, found undefined, and told the caller its URL was not http(s).
//
// ESLint cannot see it. A handler that never mentions `session` has no
// undefined reference for no-undef to catch, which is exactly the case that
// went out. This check is structural instead: it compares each entry's
// declared arity against what the dispatcher will hand it.

const EXPECTED_ARITY_EXPORTS = ["COMMAND_TABLE"];

function commandTable() {
  return loadWorker(EXPECTED_ARITY_EXPORTS, {
    "runtime.connectNative": () => makeFakePort(),
  }).COMMAND_TABLE;
}

test("every command handler takes exactly what the dispatcher passes it", () => {
  const table = commandTable();
  const wrong = [];
  for (const [cmd, entry] of table) {
    const expected = 1 + (entry.tab ? 1 : 0) + (entry.args ? 1 : 0);
    if (entry.fn.length !== expected) {
      wrong.push(
        `${cmd}: dispatcher passes ${expected} argument(s), handler declares ${entry.fn.length}`,
      );
    }
  }
  assert.deepEqual(wrong, [], wrong.join("; "));
});

test("the command table is not empty, so the check above cannot pass vacuously", () => {
  const table = commandTable();
  assert.ok(table.size > 30, `only ${table.size} commands in the table`);
  assert.ok(table.has("navigate"));
});

// -- Asking which window must not take a tab ---------------------------------
//
// sessionWindow() answers "which window is this session working in". Every
// caller -- listing tabs, resolving an index, opening a tab -- wants only the
// id. It used to get one by calling activeTab(), which ADOPTS the user's
// active tab as the session's and refuses when another session already holds
// it. So while one session drove the tab in front, a second could not list
// tabs and could not open one of its own: browser_new_tab failed with "that
// tab is being driven by another session", advising the caller to open a new
// tab, which is what it had just refused.

const WINDOW_EXPORTS = ["connect", "sessionWindow", "leaseHolder", "sessions"];

function bootWithFrontTab(frontTab) {
  const opened = [];
  const worker = loadWorker(
    WINDOW_EXPORTS,
    {
      "runtime.connectNative": () => {
        const port = makeFakePort();
        opened.push(port);
        return port;
      },
      "debugger.attach": () => Promise.resolve(),
      "debugger.detach": () => Promise.resolve(),
      "tabs.query": () => Promise.resolve([frontTab]),
      "tabs.get": (id) =>
        id === frontTab.id
          ? Promise.resolve(frontTab)
          : Promise.reject(new Error("gone")),
      "windows.getLastFocused": () =>
        Promise.resolve({ id: frontTab.windowId }),
    },
    LIVE,
  );
  return { worker, opened };
}

test("a session can name its window while another session holds the tab in front", async () => {
  const front = { id: 7, windowId: 42, url: "https://example.com/", index: 0 };
  const { worker, opened } = bootWithFrontTab(front);

  offer(opened[0], ["100", "200"]);
  await settle();
  offer(opened[1], ["100", "200"]);
  await settle();
  assert.equal(worker.sessions.size, 2);

  const [first, second] = [...worker.sessions];
  // The first session is driving the tab the user is looking at.
  first.sessionTabId = front.id;
  first.sessionWindowId = front.windowId;
  assert.equal(worker.leaseHolder(front.id, second), first);

  // The second session has no tab of its own yet, which is exactly when it
  // needs to open one.
  assert.equal(second.sessionTabId, null);
  assert.equal(
    await worker.sessionWindow(second),
    front.windowId,
    "asking which window must not be refused over a tab it is not taking",
  );
  // And asking must not have quietly taken the tab either.
  assert.equal(
    second.sessionTabId,
    null,
    "the session adopted a tab it was not given",
  );
  assert.equal(
    worker.leaseHolder(front.id, second),
    first,
    "the lease changed hands",
  );
});
