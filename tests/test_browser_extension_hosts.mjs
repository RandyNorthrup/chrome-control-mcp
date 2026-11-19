// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Two applications, one extension: Chrome Control MCP's native host and S.A.K. Utility's.
//
// The extension serves both, each through a host of its own, and the two must never meet: a
// session sees only its own host's sessions and tabs, a tab the other host holds is refused
// without saying who holds it, every reply goes back on the port its command came in on, and
// the profile's account email is told to Chrome Control MCP alone. The toolbar switch is the
// user's and stops both. For the many users who have only Chrome Control MCP, S.A.K.'s host is
// not installed, and asking for it must cost nothing they can see: no log line, no tight loop.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PROTOCOL, command, fakeBrowser } from "./browser_model.mjs";
import {
  loadWorker,
  makeFakePort,
  makeMissingHostPort,
  settle,
} from "./extension_harness.mjs";

const EXPORTED = [
  "CC_HUB",
  "SAK_HUB",
  "setCurrentTab",
  "setBridgePaused",
  "groupTitle",
  "suppliedNumber",
  "groupUpdateFrom",
  "pendingLeases",
  "makeSession",
  "COMMAND_TABLE",
  "MAX_LIST_TABS",
  "reconnectHub",
  "reconnectOnActivity",
  "onActionClicked",
  "versionReload",
  "reloadWhenIdle",
  "RELOAD_QUIET_MS",
  "holdTab",
  "ensureAttached",
];
const LIVE = "sessions";

const MINUTE_MS = 60000;

// A browser with both hosts installed and one server attached on each. Both servers have the
// same pid, as two programs' servers can: the worker must still keep them apart.
async function bothHosts(options = {}) {
  const browser = fakeBrowser({
    exported: EXPORTED,
    live: LIVE,
    sakHost: true,
    ...options,
  });
  // S.A.K.'s host is first asked for once the stored interval has been read back.
  await settle();
  const cc = browser.ports[0];
  const sak = browser.sakPorts[0];
  assert.ok(cc && sak, "the worker opens a port to each host");
  for (const port of [cc, sak]) {
    port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
    port.emit({ type: "bridge_ready", protocol: PROTOCOL });
  }
  await settle();
  const sessions = [...browser.worker.sessions];
  return {
    ...browser,
    cc,
    sak,
    ccSession: sessions.find((s) => s.port === cc),
    sakSession: sessions.find((s) => s.port === sak),
  };
}

// The tab ids a browser_tabs reply lists.
function listed(reply) {
  assert.equal(reply.type, "result", JSON.stringify(reply));
  return reply.payload.tabs.map((tab) => tab.tab_id);
}

function attachFrame(port) {
  return port.posted.find((frame) => frame.type === "attach_session");
}

// A tab id no tab has, and the error @p cmd gets for it on @p port with @p asked substituted for
// that id: what a refusal of the other host's tab @p asked must read, word for word.
const NO_SUCH_TAB = 987654;
async function noTabError(port, cmd, asked, args = {}) {
  const reply = await command(port, cmd, { ...args, tab_id: NO_SUCH_TAB });
  assert.equal(reply.type, "error", JSON.stringify(reply));
  return reply.error.split(String(NO_SUCH_TAB)).join(String(asked));
}

test("each host gets its own session, even for a server with the same pid", async () => {
  const b = await bothHosts();
  assert.equal(b.worker.sessions.size, 2);
  assert.ok(b.ccSession && b.sakSession);
  assert.notEqual(b.ccSession, b.sakSession);
  // Each relay is answered with its own server, by the id it offered.
  assert.equal(attachFrame(b.cc).session, "100");
  assert.equal(attachFrame(b.sak).session, "100");
  // Inside the worker the two are different servers, so neither counts as already held.
  assert.notEqual(b.ccSession.serverId, b.sakSession.serverId);
  assert.equal(
    b.ccSession.serverId,
    "100",
    "Chrome Control MCP's keys are unchanged",
  );
  assert.equal(b.ccSession.surplus, false);
  assert.equal(b.sakSession.surplus, false);
});

test("a session lists its own tabs and the user's, never the other host's", async () => {
  const b = await bothHosts();
  const user = b.addTab({ active: true });
  const ccTab = b.addTab({});
  const sakTab = b.addTab({});
  b.worker.setCurrentTab(b.ccSession, b.copy(ccTab));
  b.worker.setCurrentTab(b.sakSession, b.copy(sakTab));
  await settle();

  const fromCc = listed(await command(b.cc, "listTabs"));
  assert.ok(fromCc.includes(user.id), "the user's tab is listed");
  assert.ok(fromCc.includes(ccTab.id), "its own tab is listed");
  assert.ok(!fromCc.includes(sakTab.id), "S.A.K.'s tab is not");

  const fromSak = listed(await command(b.sak, "listTabs"));
  assert.ok(fromSak.includes(user.id));
  assert.ok(fromSak.includes(sakTab.id));
  assert.ok(!fromSak.includes(ccTab.id), "Chrome Control MCP's tab is not");
});

test("a command naming the other host's tab is refused without saying who holds it", async () => {
  const b = await bothHosts();
  b.ccSession.label = "Codex";
  const ccTab = b.addTab({});
  b.worker.setCurrentTab(b.ccSession, b.copy(ccTab));
  await settle();

  const refused = await command(b.sak, "read", { tab_id: ccTab.id });
  assert.equal(refused.type, "error", JSON.stringify(refused));
  assert.doesNotMatch(refused.error, /Codex|Chrome Control MCP|server/);
  // Word for word what an id that names no tab at all gets: an id cannot be probed for whether the
  // other application is using it.
  assert.equal(refused.error, await noTabError(b.sak, "read", ccTab.id));
  assert.equal(b.sakSession.tabs.has(ccTab.id), false);
  assert.equal(b.ccSession.tabs.has(ccTab.id), true, "and the tab stays held");

  // Asked whether this profile has that tab, the answer is no.
  const found = await command(b.sak, "findTab", { tab_id: ccTab.id });
  assert.equal(found.payload.exists, false);
});

test("every reply goes back on the port its command came in on", async () => {
  const b = await bothHosts();
  const ccTab = b.addTab({});
  const sakTab = b.addTab({});
  b.worker.setCurrentTab(b.ccSession, b.copy(ccTab));
  b.worker.setCurrentTab(b.sakSession, b.copy(sakTab));
  await settle();
  const ccBefore = b.cc.posted.length;
  const sakBefore = b.sak.posted.length;

  const ccReply = await command(b.cc, "listTabs");
  const sakReply = await command(b.sak, "listTabs");

  const ccFrames = b.cc.posted.slice(ccBefore);
  const sakFrames = b.sak.posted.slice(sakBefore);
  assert.ok(ccFrames.some((frame) => frame.id === ccReply.id));
  assert.ok(sakFrames.some((frame) => frame.id === sakReply.id));
  assert.ok(
    !ccFrames.some((frame) => frame.id === sakReply.id),
    "nothing of S.A.K.'s exchange reaches Chrome Control MCP's port",
  );
  assert.ok(
    !sakFrames.some((frame) => frame.id === ccReply.id),
    "nothing of Chrome Control MCP's exchange reaches S.A.K.'s port",
  );
});

test("an offer from one host settles only that host's parked sessions", async () => {
  const b = await bothHosts();
  const ccTab = b.addTab({});
  b.worker.setCurrentTab(b.ccSession, b.copy(ccTab));
  await settle();
  // Chrome Control MCP's relay drops; its session waits, parked, for the next offer.
  b.cc.drop();
  await settle();
  assert.ok(b.worker.pendingLeases.has("100"), "the session is parked");

  // S.A.K.'s relay lists its own live servers. That says nothing about Chrome Control MCP's.
  b.sak.emit({ type: "bridge_servers", servers: [] });
  await settle();
  assert.ok(
    b.worker.pendingLeases.has("100"),
    "Chrome Control MCP's parked session is still waiting for its own host",
  );
  assert.ok(b.tabs.has(ccTab.id), "and its tab is still open");
});

test("the toolbar switch stops both hosts' sessions", async () => {
  const b = await bothHosts();
  await b.worker.setBridgePaused(true);
  assert.equal(b.cc.connected, false);
  assert.equal(b.sak.connected, false);
  assert.equal(b.worker.sessions.size, 0);
});

// The profile's account email names an unrenamed signed-in profile to Chrome Control MCP. S.A.K.
// must not learn it under any field: not profile_email, and not profile_name, which for such a
// profile IS the email. Every frame S.A.K.'s port carries is searched, after every command that
// reports the profile.
test("the profile's account email reaches S.A.K. in no frame and no reply", async () => {
  const EMAIL = "person@example.test";
  const b = await bothHosts({
    overrides: {
      "identity.getProfileUserInfo": () => Promise.resolve({ email: EMAIL }),
    },
  });
  const ccAttach = attachFrame(b.cc);
  assert.equal(ccAttach.profile_email, EMAIL);
  assert.equal(
    ccAttach.profile_name,
    EMAIL,
    "Chrome Control MCP's naming is unchanged",
  );

  const sakAttach = attachFrame(b.sak);
  assert.ok(sakAttach, "S.A.K.'s relay is answered");
  assert.equal("profile_email" in sakAttach, false);
  assert.match(sakAttach.profile_name, /^profile-[0-9a-f]{6}$/);

  const user = b.addTab({ active: true, title: "user page" });
  b.worker.setCurrentTab(b.sakSession, b.copy(b.addTab({})));
  await settle();
  const replies = [];
  for (const [cmd, args] of [
    ["profileState", {}],
    ["listTabs", {}],
    ["listWindows", {}],
    ["findTab", { tab_id: user.id }],
    ["read", {}],
  ]) {
    replies.push(await command(b.sak, cmd, args));
  }
  assert.equal(replies[0].payload.profile_name, sakAttach.profile_name);
  assert.equal(replies[1].payload.profile, sakAttach.profile_name);
  assert.equal(replies[2].payload.profile, sakAttach.profile_name);
  for (const frame of b.sak.posted) {
    assert.ok(
      !JSON.stringify(frame).includes(EMAIL),
      "S.A.K. was sent the email: " + JSON.stringify(frame),
    );
  }
  // Chrome Control MCP is still told it where it always was.
  const ccState = await command(b.cc, "profileState");
  assert.equal(ccState.payload.profile_email, EMAIL);
  assert.equal((await command(b.cc, "listTabs")).payload.profile, EMAIL);
});

test("a profile the user named is called by that name to both hosts", async () => {
  const b = await bothHosts({
    overrides: {
      "identity.getProfileUserInfo": () =>
        Promise.resolve({ email: "person@example.test" }),
      "storage.local.get": (key) =>
        Promise.resolve(
          [].concat(key).includes("chrome_control_mcp.profileName")
            ? { "chrome_control_mcp.profileName": "work" }
            : {},
        ),
    },
  });
  assert.equal(attachFrame(b.cc).profile_name, "work");
  assert.equal(attachFrame(b.sak).profile_name, "work");
  assert.equal("profile_email" in attachFrame(b.sak), false);
});

test("each host names its own tab groups", async () => {
  const b = await bothHosts();
  assert.equal(b.worker.groupTitle(b.ccSession, ""), "AI CONTROL");
  assert.equal(b.worker.groupTitle(b.sakSession, ""), "S.A.K. CONTROL");
  b.ccSession.label = "Codex";
  b.sakSession.label = "Assistant";
  assert.equal(b.worker.groupTitle(b.ccSession, ""), "AI \u00b7 Codex");
  assert.equal(
    b.worker.groupTitle(b.sakSession, ""),
    "S.A.K. \u00b7 Assistant",
  );
  assert.equal(
    b.worker.groupTitle(b.sakSession, "research"),
    "S.A.K. \u00b7 research",
  );
});

// What a held tab's refusal says names the asking session's own program: S.A.K.'s e2e and its
// assistant read "another S.A.K. assistant session", Chrome Control MCP's agents read what they
// always have.
test("a tab another session of the same host holds is refused in that host's words", () => {
  const worker = loadWorker(
    [
      "CC_HUB",
      "SAK_HUB",
      "makeSession",
      "makeTabState",
      "requireUnleasedTab",
      "protocolMismatchText",
    ],
    {},
    LIVE,
  );
  const tabId = 4242;
  for (const [hub, words, foreign] of [
    [worker.SAK_HUB, /driven by another S\.A\.K\. assistant session/, /MCP/],
    [
      worker.CC_HUB,
      /driven by another Chrome Control MCP session/,
      /S\.A\.K\./,
    ],
  ]) {
    worker.sessions.clear();
    const holder = worker.makeSession(hub);
    holder.label = "Helper";
    holder.tabs.set(tabId, worker.makeTabState(tabId, "opened"));
    worker.sessions.add(holder);
    const asking = worker.makeSession(hub);
    worker.sessions.add(asking);
    assert.throws(
      () => worker.requireUnleasedTab(asking, { id: tabId }),
      (error) => words.test(error.message) && !foreign.test(error.message),
    );
  }
  worker.sessions.clear();

  // A protocol mismatch says what to do with the program that asked.
  const sak = worker.protocolMismatchText(3, worker.SAK_HUB);
  assert.match(sak, /S\.A\.K\. Utility/);
  assert.doesNotMatch(sak, /Chrome Control MCP|editor/);
  const cc = worker.protocolMismatchText(3, worker.CC_HUB);
  assert.match(
    cc,
    /The Chrome Control MCP extension loaded in Chrome is older/,
  );
  assert.equal(worker.protocolMismatchText(3), cc);
});

// -- Chrome Control MCP users without S.A.K. ------------------------------------------------------

// The log lines that would be about S.A.K.'s host.
function sakLines(logged) {
  return logged.filter((entry) =>
    /S\.A\.K\.|native messaging host/.test(entry.map(String).join(" ")),
  );
}

function recordingConsole() {
  const logged = [];
  const record = (...args) => {
    logged.push(args);
  };
  return {
    logged,
    sink: {
      log: record,
      warn: record,
      error: record,
      info: record,
      debug: record,
    },
  };
}

test("without S.A.K. installed, its host is asked for rarely and silently", async () => {
  const { logged, sink } = recordingConsole();
  const ccPorts = [];
  let sakAttempts = 0;
  let sakInstalled = false;
  const overrides = {
    "runtime.connectNative": () => {
      const port = makeFakePort();
      ccPorts.push(port);
      return port;
    },
  };
  const worker = loadWorker(
    [
      "SAK_HUB",
      "reconnectHub",
      "reconnectOnActivity",
      "OPTIONAL_HOST_MISSING_MIN_MS",
      "OPTIONAL_HOST_MISSING_MAX_MS",
    ],
    overrides,
    LIVE,
    {
      sakHost: () => {
        sakAttempts += 1;
        return sakInstalled ? makeFakePort() : makeMissingHostPort(overrides);
      },
      console: sink,
    },
  );
  await settle();
  assert.equal(sakAttempts, 1, "asked for once at startup");
  assert.equal(
    worker.SAK_HUB.missingDelayMs,
    worker.OPTIONAL_HOST_MISSING_MIN_MS,
  );
  assert.equal(worker.sessions.size, 1, "no session is kept for it");

  // Tab events and alarm ticks while the wait runs start nothing.
  for (let i = 0; i < 200; i += 1) {
    worker.reconnectOnActivity();
    worker.reconnectHub(worker.SAK_HUB);
  }
  await settle();
  assert.equal(sakAttempts, 1, "nothing is asked while the wait runs");

  // Each wait that runs out allows exactly one attempt, and the next wait is twice as long, up to
  // six hours: a day without S.A.K. costs a handful of attempts, none of which starts a process.
  const waits = [];
  for (let round = 0; round < 8; round += 1) {
    worker.SAK_HUB.nextAttemptAt = Date.now() - 1; // the wait is over
    for (let i = 0; i < 50; i += 1) {
      worker.reconnectHub(worker.SAK_HUB);
      worker.reconnectOnActivity();
    }
    await settle();
    waits.push(worker.SAK_HUB.missingDelayMs / MINUTE_MS);
  }
  assert.equal(sakAttempts, 9, "one attempt per wait");
  assert.deepEqual(waits, [20, 40, 80, 160, 320, 360, 360, 360]);
  assert.equal(
    worker.OPTIONAL_HOST_MISSING_MAX_MS,
    360 * MINUTE_MS,
    "the longest wait is six hours",
  );
  assert.deepEqual(sakLines(logged), [], "nothing is logged about it");
  assert.equal(ccPorts.length, 1, "Chrome Control MCP's own host is untouched");

  // Installed later, the host answers at the next attempt, and the long wait is over.
  sakInstalled = true;
  worker.SAK_HUB.nextAttemptAt = Date.now() - 1;
  worker.reconnectHub(worker.SAK_HUB);
  await settle();
  const session = [...worker.sessions].find((s) => s.hub === worker.SAK_HUB);
  assert.ok(session && session.port, "S.A.K.'s host is reached");
  session.port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: [] });
  session.port.emit({ type: "bridge_ready", protocol: PROTOCOL });
  await settle();
  assert.equal(worker.SAK_HUB.missingDelayMs, 0);
});

test("a browser without S.A.K. sees only Chrome Control MCP's session", async () => {
  const { logged, sink } = recordingConsole();
  const b = fakeBrowser({ exported: EXPORTED, live: LIVE, console: sink });
  await settle();
  assert.equal(b.ports.length, 1);
  assert.equal(b.sakPorts.length, 0);
  assert.equal(b.worker.sessions.size, 1);
  assert.equal([...b.worker.sessions][0].hub, b.worker.CC_HUB);
  assert.deepEqual(sakLines(logged), []);
});

// -- Fixes folded in from S.A.K.'s copy of the extension ----------------------------------------

test("suppliedNumber reads only a number the caller supplied", () => {
  const b = fakeBrowser({ exported: EXPORTED, live: LIVE });
  const read = b.worker.suppliedNumber;
  for (const absent of [null, undefined, "", "   ", [], {}, true]) {
    assert.ok(Number.isNaN(read(absent)), JSON.stringify(absent));
  }
  assert.equal(read(0), 0);
  assert.equal(read(5), 5);
  assert.equal(read("7"), 7);
});

test("browser_window focus with window_id null asks for a window id", async () => {
  const b = await bothHosts();
  const reply = await command(b.cc, "window", {
    action: "focus",
    window_id: null,
  });
  assert.equal(reply.type, "error", JSON.stringify(reply));
  assert.match(reply.error, /needs window_id/);
});

test("a group colour Chrome does not know is refused before any tab is grouped", async () => {
  const b = await bothHosts();
  assert.throws(
    () => b.worker.groupUpdateFrom({ color: "chartreuse" }),
    /must be one of/,
  );
  const update = b.worker.groupUpdateFrom({ title: "Work", color: "blue" });
  assert.deepEqual(JSON.parse(JSON.stringify(update)), {
    title: "Work",
    color: "blue",
  });
  const groupedBefore = b.calls.grouped.length;
  const reply = await command(b.cc, "groupTabs", {
    tab_indices: [0],
    color: "chartreuse",
  });
  assert.equal(reply.type, "error");
  assert.match(reply.error, /must be one of/);
  assert.equal(b.calls.grouped.length, groupedBefore, "nothing was grouped");
});

// -- Isolation, both ways, for every command that names a tab or a window ---------------------------

// Both directions: S.A.K. asking about Chrome Control MCP's tab, and the other way round.
function directions(b) {
  return [
    {
      name: "S.A.K. -> Chrome Control MCP",
      port: b.sak,
      asker: b.sakSession,
      holder: b.ccSession,
      base: 1000,
    },
    {
      name: "Chrome Control MCP -> S.A.K.",
      port: b.cc,
      asker: b.ccSession,
      holder: b.sakSession,
      base: 2000,
    },
  ];
}

test("every tab-scoped command refuses the other host's tab exactly as it refuses no tab, both ways", async () => {
  const b = await bothHosts();
  const scoped = [...b.worker.COMMAND_TABLE.entries()]
    .filter(([, entry]) => entry.tab)
    .map(([cmd]) => cmd);
  assert.ok(
    scoped.length > 30,
    "the command table lists the tab-scoped commands",
  );
  for (const way of directions(b)) {
    const theirs = b.addTab({});
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    const own = b.addTab({});
    b.worker.setCurrentTab(way.asker, b.copy(own));
    await settle();
    const cdpBefore = b.calls.cdp.filter((c) => c.tabId === theirs.id).length;
    for (const cmd of scoped) {
      const reply = await command(way.port, cmd, { tab_id: theirs.id });
      assert.equal(
        reply.type,
        "error",
        `${way.name} ${cmd}: ${JSON.stringify(reply)}`,
      );
      assert.equal(
        reply.error,
        await noTabError(way.port, cmd, theirs.id),
        `${way.name} ${cmd}`,
      );
    }
    assert.equal(
      b.calls.cdp.filter((c) => c.tabId === theirs.id).length,
      cdpBefore,
      `${way.name}: nothing was sent to the other host's tab`,
    );
    assert.ok(
      way.holder.tabs.has(theirs.id),
      `${way.name}: the tab stays held`,
    );
    assert.ok(!way.asker.tabs.has(theirs.id));
  }
});

test("findTab, selectTab, closeTab and release by tab_id treat the other host's tab as no tab, both ways", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const theirs = b.addTab({});
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    await settle();
    // The whole reply, not one field: a reply shaped differently for the other host's tab than for
    // an id that names no tab would tell the two apart as surely as a different answer.
    // (The first call takes any tab ids the session was still to be told are gone, which a reply
    // carries once, so the two compared are asked in the same state.)
    await command(way.port, "findTab", { tab_id: NO_SUCH_TAB });
    const found = await command(way.port, "findTab", { tab_id: theirs.id });
    const none = await command(way.port, "findTab", { tab_id: NO_SUCH_TAB });
    assert.equal(found.type, "result", `${way.name}: ${JSON.stringify(found)}`);
    assert.deepEqual(
      { ...found, id: null },
      { ...none, id: null },
      `${way.name}: findTab`,
    );
    for (const cmd of ["selectTab", "closeTab", "release"]) {
      const reply = await command(way.port, cmd, { tab_id: theirs.id });
      assert.equal(
        reply.type,
        "error",
        `${way.name} ${cmd}: ${JSON.stringify(reply)}`,
      );
      assert.equal(
        reply.error,
        await noTabError(way.port, cmd, theirs.id),
        `${way.name} ${cmd}`,
      );
    }
    assert.ok(b.tabs.has(theirs.id), `${way.name}: the tab is still open`);
    assert.ok(
      way.holder.tabs.has(theirs.id),
      `${way.name}: and still the other host's`,
    );
    assert.equal(b.calls.removed.includes(theirs.id), false);
  }
});

test("a listing numbers only the tabs a session may see: no gap, no count of the other host's", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const windowId = way.base + 1;
    const user = b.addTab({ windowId });
    const theirs = b.addTab({ windowId });
    const own = b.addTab({ windowId });
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    b.worker.setCurrentTab(way.asker, b.copy(own));
    await settle();
    const listing = (await command(way.port, "listTabs")).payload;
    assert.deepEqual(
      // Array.from: an array of this realm, not the worker's, for a strict comparison.
      Array.from(listing.tabs, (t) => [t.index, t.tab_id]),
      [
        [0, user.id],
        [1, own.id],
      ],
      way.name,
    );
    assert.equal(
      listing.count,
      2,
      `${way.name}: the count leaves the other host's tab out`,
    );
    assert.equal(listing.capped, false);
    // The index of a tab, wherever a reply reports one, is the same numbering.
    const selected = await command(way.port, "selectTab", { index: 1 });
    assert.equal(selected.payload.tab_id, own.id, way.name);
    assert.equal(selected.payload.index, 1, way.name);
    const opened = await command(way.port, "newTab", {});
    assert.equal(
      opened.payload.index,
      2,
      `${way.name}: a new tab's index counts only the tabs the session may see`,
    );
    // Past the end is past the end, however many tabs Chrome has there.
    await command(way.port, "listTabs");
    const past = await command(way.port, "selectTab", { index: 3 });
    assert.equal(past.type, "error");
    assert.match(past.error, /No tab at index 3/);
    // Closing by index closes the tab shown there, never the other host's.
    const closed = await command(way.port, "closeTab", { index: 1 });
    assert.equal(closed.payload.tab_id, own.id, way.name);
    assert.equal(closed.payload.index, 1, way.name);
    assert.ok(
      b.tabs.has(theirs.id),
      `${way.name}: the other host's tab is still open`,
    );
  }
});

test("a listing's count and cap leave the other host's tabs out", async () => {
  const b = await bothHosts();
  const max = b.worker.MAX_LIST_TABS;
  const own = b.addTab({ windowId: 21 });
  b.worker.setCurrentTab(b.sakSession, b.copy(own));
  for (let i = 0; i < max - 1; i += 1) {
    b.addTab({ windowId: 21 });
  }
  for (let i = 0; i < 3; i += 1) {
    const theirs = b.addTab({ windowId: 21 });
    b.worker.setCurrentTab(b.ccSession, b.copy(theirs));
  }
  await settle();
  const listing = (await command(b.sak, "listTabs")).payload;
  assert.equal(listing.tabs.length, max);
  assert.equal(
    listing.count,
    max,
    "the other host's three tabs are not counted",
  );
  assert.equal(
    listing.capped,
    false,
    "and do not push the listing over its cap",
  );
});

test("group and ungroup by index reach only the tabs a session may see, both ways", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const windowId = way.base + 2;
    const user = b.addTab({ windowId });
    const theirs = b.addTab({ windowId });
    const own = b.addTab({ windowId });
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    b.worker.setCurrentTab(way.asker, b.copy(own));
    await settle();
    await command(way.port, "listTabs");
    const theirGroup = b.tabs.get(theirs.id).groupId;
    const grouped = await command(way.port, "groupTabs", {
      tab_indices: "0,1",
    });
    assert.equal(
      grouped.type,
      "result",
      `${way.name}: ${JSON.stringify(grouped)}`,
    );
    assert.equal(grouped.payload.tab_count, 2);
    assert.equal(b.tabs.get(user.id).groupId, grouped.payload.group_id);
    assert.equal(
      b.tabs.get(theirs.id).groupId,
      theirGroup,
      `${way.name}: the other host's tab was regrouped`,
    );
    await command(way.port, "listTabs");
    const beyond = await command(way.port, "ungroupTabs", { tab_indices: "2" });
    assert.equal(beyond.type, "error", way.name);
    assert.match(beyond.error, /No tab at index 2/);
    assert.equal(b.tabs.get(theirs.id).groupId, theirGroup, way.name);
  }
  // A listed index naming a tab another session of the same host drives is refused, in that
  // host's words: grouping it would take the tab out of that session's group under it.
  const own = b.addTab({ windowId: 3001 });
  const siblingTab = b.addTab({ windowId: 3001 });
  b.worker.setCurrentTab(b.ccSession, b.copy(own));
  const sibling = b.worker.makeSession(b.worker.CC_HUB);
  b.worker.sessions.add(sibling);
  b.worker.setCurrentTab(sibling, b.copy(siblingTab));
  await settle();
  const listing = (await command(b.cc, "listTabs")).payload.tabs;
  const at = listing.find((t) => t.tab_id === siblingTab.id);
  assert.ok(at && at.controlled_by_other_session, JSON.stringify(listing));
  const siblingGroup = b.tabs.get(siblingTab.id).groupId;
  for (const cmd of ["groupTabs", "ungroupTabs"]) {
    const refused = await command(b.cc, cmd, { tab_indices: String(at.index) });
    assert.equal(refused.type, "error", JSON.stringify(refused));
    assert.match(refused.error, /driven by another Chrome Control MCP session/);
    assert.equal(b.tabs.get(siblingTab.id).groupId, siblingGroup, cmd);
  }
});

test("group and ungroup with no indices refuse an active tab another session holds, both ways", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const windowId = way.base + 3;
    const own = b.addTab({ windowId });
    const theirs = b.addTab({ windowId, active: true });
    b.worker.setCurrentTab(way.asker, b.copy(own));
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    await settle();
    const theirGroup = b.tabs.get(theirs.id).groupId;
    assert.ok(theirGroup >= 0, "the holder's tab is in its group");
    for (const cmd of ["groupTabs", "ungroupTabs"]) {
      const reply = await command(way.port, cmd, {});
      assert.equal(
        reply.type,
        "error",
        `${way.name} ${cmd}: ${JSON.stringify(reply)}`,
      );
      assert.match(reply.error, /in use by another application/);
      assert.equal(
        b.tabs.get(theirs.id).groupId,
        theirGroup,
        `${way.name} ${cmd}: the other host's active tab was moved`,
      );
    }
  }
  // Another session of the SAME host holding the active tab is refused too, in that host's words.
  const own = b.addTab({ windowId: 43 });
  const held = b.addTab({ windowId: 43, active: true });
  b.worker.setCurrentTab(b.ccSession, b.copy(own));
  const sibling = b.worker.makeSession(b.worker.CC_HUB);
  b.worker.sessions.add(sibling);
  b.worker.setCurrentTab(sibling, b.copy(held));
  await settle();
  const reply = await command(b.cc, "groupTabs", {});
  assert.equal(reply.type, "error", JSON.stringify(reply));
  assert.match(reply.error, /driven by another Chrome Control MCP session/);
});

test("windows: the other host's own windows are not listed, and counts leave its tabs out, both ways", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const shared = way.base + 4;
    const alone = way.base + 5;
    const own = b.addTab({ windowId: shared });
    const theirsShared = b.addTab({ windowId: shared });
    b.addTab({ windowId: shared });
    const theirsAlone = b.addTab({ windowId: alone });
    b.worker.setCurrentTab(way.asker, b.copy(own));
    b.worker.setCurrentTab(way.holder, b.copy(theirsShared));
    b.worker.setCurrentTab(way.holder, b.copy(theirsAlone));
    await settle();
    const windows = (await command(way.port, "listWindows")).payload.windows;
    const ids = windows.map((w) => w.window_id);
    assert.ok(ids.includes(shared), way.name);
    assert.ok(
      !ids.includes(alone),
      `${way.name}: a window of only the other host's tabs is listed`,
    );
    assert.equal(
      windows.find((w) => w.window_id === shared).tab_count,
      2,
      `${way.name}: the shared window's count leaves the other host's tab out`,
    );
    // Not listed, so not addressable either.
    for (const action of ["focus", "close"]) {
      const reply = await command(way.port, "window", {
        action,
        window_id: alone,
      });
      assert.equal(reply.type, "error", way.name);
      assert.match(reply.error, /not in the current window listing/);
    }
    assert.ok(!b.calls.windowsRemoved.includes(alone), way.name);
  }
});

test("a window holding a tab another session or host drives is not closed, both ways", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const held = way.base + 6;
    const free = way.base + 7;
    const own = b.addTab({ windowId: held });
    const theirs = b.addTab({ windowId: held });
    const userOnly = b.addTab({ windowId: free });
    b.worker.setCurrentTab(way.asker, b.copy(own));
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    await settle();
    await command(way.port, "listWindows");
    const refused = await command(way.port, "window", {
      action: "close",
      window_id: held,
    });
    assert.equal(
      refused.type,
      "error",
      `${way.name}: ${JSON.stringify(refused)}`,
    );
    assert.match(refused.error, /not closed/);
    assert.ok(
      !b.calls.windowsRemoved.includes(held),
      `${way.name}: the window was closed`,
    );
    assert.ok(b.tabs.has(theirs.id) && way.holder.tabs.has(theirs.id));
    // A window with nothing anyone else holds still closes: the refusal is about the other's tab.
    const closed = await command(way.port, "window", {
      action: "close",
      window_id: free,
    });
    assert.equal(
      closed.type,
      "result",
      `${way.name}: ${JSON.stringify(closed)}`,
    );
    assert.ok(b.calls.windowsRemoved.includes(free));
    assert.ok(!b.tabs.has(userOnly.id));
  }
  // The same for another session of the same host.
  const own = b.addTab({ windowId: 91 });
  const held = b.addTab({ windowId: 91 });
  b.worker.setCurrentTab(b.ccSession, b.copy(own));
  const sibling = b.worker.makeSession(b.worker.CC_HUB);
  b.worker.sessions.add(sibling);
  b.worker.setCurrentTab(sibling, b.copy(held));
  await settle();
  await command(b.cc, "listWindows");
  const refused = await command(b.cc, "window", {
    action: "close",
    window_id: 91,
  });
  assert.equal(refused.type, "error", JSON.stringify(refused));
  assert.ok(!b.calls.windowsRemoved.includes(91));
});

test("window focus refuses an active tab the other host holds, and counts without its tabs", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const home = way.base + 8;
    const theirsFront = way.base + 9;
    const userFront = way.base + 10;
    const own = b.addTab({ windowId: home });
    b.worker.setCurrentTab(way.asker, b.copy(own));
    b.addTab({ windowId: theirsFront });
    const theirsActive = b.addTab({ windowId: theirsFront, active: true });
    b.worker.setCurrentTab(way.holder, b.copy(theirsActive));
    const userActive = b.addTab({ windowId: userFront, active: true });
    const theirs = b.addTab({ windowId: userFront });
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    await settle();
    await command(way.port, "listWindows");
    const refused = await command(way.port, "window", {
      action: "focus",
      window_id: theirsFront,
    });
    assert.equal(refused.type, "error", way.name);
    assert.equal(
      way.asker.currentTabId,
      own.id,
      `${way.name}: the session moved`,
    );
    const focused = await command(way.port, "window", {
      action: "focus",
      window_id: userFront,
    });
    assert.equal(
      focused.type,
      "result",
      `${way.name}: ${JSON.stringify(focused)}`,
    );
    assert.equal(
      focused.payload.tab_count,
      1,
      `${way.name}: the count leaves the other host's tab out`,
    );
    assert.equal(way.asker.currentTabId, userActive.id);
  }
});

// -- The profile's shared site state ----------------------------------------------------------------

test("cookies and site settings of a site the other host is working on are refused, both ways", async () => {
  const b = await bothHosts();
  for (const way of directions(b)) {
    const site = way.base === 1000 ? "mail.example.org" : "bank.example.net";
    const elsewhere = `https://elsewhere${way.base}.example.com`;
    const theirs = b.addTab({ url: `https://${site}/inbox` });
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    const own = b.addTab({ url: `${elsewhere}/` });
    b.worker.setCurrentTab(way.asker, b.copy(own));
    await settle();
    const reads = b.calls.cookieReads.length;
    const settings = b.calls.settings.length;
    const parent = site.split(".").slice(1).join(".");
    for (const url of [
      `https://${site}/`,
      `https://${parent}/account`,
      `https://login.${site}/`,
    ]) {
      for (const action of ["get", "remove", "set"]) {
        const reply = await command(way.port, "cookies", {
          action,
          url,
          name: "sid",
          value: "x",
        });
        assert.equal(
          reply.type,
          "error",
          `${way.name} ${action} ${url}: ${JSON.stringify(reply)}`,
        );
        assert.match(
          reply.error,
          /another application connected to this browser is working on that site/,
        );
      }
    }
    const permission = await command(way.port, "permission", {
      name: "camera",
      setting: "block",
      origin: `https://${site}`,
    });
    assert.equal(permission.type, "error", JSON.stringify(permission));
    assert.match(permission.error, /working on that site/);
    assert.equal(
      b.calls.cookieReads.length,
      reads,
      `${way.name}: a cookie was read`,
    );
    assert.deepEqual(b.calls.cookieSets, [], `${way.name}: a cookie was set`);
    assert.equal(
      b.calls.settings.length,
      settings,
      `${way.name}: a setting was changed`,
    );
    // Another site's are the session's to use, as before.
    const other = await command(way.port, "cookies", {
      action: "get",
      url: `${elsewhere}/`,
    });
    assert.equal(other.type, "result", `${way.name}: ${JSON.stringify(other)}`);
    const otherSetting = await command(way.port, "permission", {
      name: "camera",
      setting: "block",
      origin: elsewhere,
    });
    assert.equal(
      otherSetting.type,
      "result",
      `${way.name}: ${JSON.stringify(otherSetting)}`,
    );
  }
});

// The profile's cookie jar for the tests below: the sign-in cookie of a parent domain, which Chrome
// sends to every host under it; a cookie of the sibling site alone; one of the other site alone.
function signInJar() {
  return [
    { name: "SID", domain: ".example.org", value: "signed-in" },
    { name: "pref", domain: "accounts.example.org", value: "dark" },
    { name: "inbox", domain: "mail.example.org", value: "view" },
  ];
}

function cookieNames(reply) {
  assert.equal(reply.type, "result", JSON.stringify(reply));
  return reply.payload.cookies.map((cookie) => cookie.name).sort();
}

test("a get for a sibling site leaves out the cookies sent to the other host's site, both ways", async () => {
  for (const way of ["sak", "cc"]) {
    const b = await bothHosts({ cookies: signInJar() });
    const [asker, holder, holderPort] =
      way === "sak" ? [b.sak, b.ccSession, b.cc] : [b.cc, b.sakSession, b.sak];
    const theirs = b.addTab({ url: "https://mail.example.org/inbox" });
    b.worker.setCurrentTab(holder, b.copy(theirs));
    await settle();
    // accounts.example.org is neither mail.example.org nor above or below it, but .example.org's
    // sign-in cookie is sent to both.
    const reply = await command(asker, "cookies", {
      action: "get",
      url: "https://accounts.example.org/",
    });
    assert.deepEqual(cookieNames(reply), ["pref"], way);
    assert.equal(reply.payload.count, 1, way);
    assert.equal(reply.payload.withheld, 1, way);
    assert.doesNotMatch(JSON.stringify(reply), /signed-in/, way);
    // With nothing of the other host's there, the whole jar is the session's to read.
    const released = await command(holderPort, "release", {
      tab_id: theirs.id,
    });
    assert.equal(released.type, "result", JSON.stringify(released));
    const after = await command(asker, "cookies", {
      action: "get",
      url: "https://accounts.example.org/",
    });
    assert.deepEqual(cookieNames(after), ["SID", "pref"], way);
    assert.equal(after.payload.withheld, undefined, way);
  }
});

test("a remove or set through a sibling site cannot reach the other host's site's cookie, both ways", async () => {
  for (const way of ["sak", "cc"]) {
    const b = await bothHosts({ cookies: signInJar() });
    const [asker, holder] =
      way === "sak" ? [b.sak, b.ccSession] : [b.cc, b.sakSession];
    const theirs = b.addTab({ url: "https://mail.example.org/inbox" });
    b.worker.setCurrentTab(holder, b.copy(theirs));
    await settle();
    for (const action of ["remove", "set"]) {
      const reply = await command(asker, "cookies", {
        action,
        url: "https://accounts.example.org/",
        name: "SID",
        value: "replaced",
      });
      assert.equal(
        reply.type,
        "error",
        `${way} ${action}: ${JSON.stringify(reply)}`,
      );
      assert.match(
        reply.error,
        /also sent to a site another application connected to this browser is working on/,
      );
    }
    assert.deepEqual(b.calls.cookieRemovals, [], `${way}: nothing removed`);
    assert.deepEqual(b.calls.cookieSets, [], `${way}: nothing set`);
    // A cookie of the sibling's own is the session's to change.
    const removed = await command(asker, "cookies", {
      action: "remove",
      url: "https://accounts.example.org/",
      name: "pref",
    });
    assert.equal(removed.type, "result", `${way}: ${JSON.stringify(removed)}`);
    assert.equal(removed.payload.removed, true, way);
    const set = await command(asker, "cookies", {
      action: "set",
      url: "https://accounts.example.org/",
      name: "fresh",
      value: "1",
    });
    assert.equal(set.type, "result", `${way}: ${JSON.stringify(set)}`);
  }
});

test("a trailing dot on the url, the other host's tab or a cookie's domain does not get past the site check", async () => {
  for (const way of ["sak", "cc"]) {
    for (const [tabUrl, askedUrl] of [
      ["https://mail.example.org/inbox", "https://mail.example.org./"],
      ["https://mail.example.org./inbox", "https://mail.example.org/"],
      ["https://mail.example.org./inbox", "https://example.org./"],
    ]) {
      const b = await bothHosts({ cookies: signInJar() });
      const [asker, holder] =
        way === "sak" ? [b.sak, b.ccSession] : [b.cc, b.sakSession];
      const theirs = b.addTab({ url: tabUrl });
      b.worker.setCurrentTab(holder, b.copy(theirs));
      await settle();
      const reply = await command(asker, "cookies", {
        action: "get",
        url: askedUrl,
      });
      assert.equal(
        reply.type,
        "error",
        `${way} ${tabUrl} ${askedUrl}: ${JSON.stringify(reply)}`,
      );
      assert.match(reply.error, /working on that site/);
    }
    // A cookie whose domain carries the dot is still the parent domain's.
    const b = await bothHosts({
      cookies: [{ name: "SID", domain: ".example.org.", value: "signed-in" }],
    });
    const [asker, holder] =
      way === "sak" ? [b.sak, b.ccSession] : [b.cc, b.sakSession];
    const theirs = b.addTab({ url: "https://mail.example.org/inbox" });
    b.worker.setCurrentTab(holder, b.copy(theirs));
    await settle();
    const reply = await command(asker, "cookies", {
      action: "get",
      url: "https://accounts.example.org/",
    });
    assert.deepEqual(cookieNames(reply), [], way);
    assert.equal(reply.payload.withheld, 1, way);
  }
});

test("the site check reads a loading tab's address as well as the one it shows", async () => {
  const b = await bothHosts({ cookies: signInJar() });
  for (const way of directions(b)) {
    const theirs = b.addTab({
      url: "about:blank",
      pendingUrl: `https://mail${way.base}.example.org/inbox`,
    });
    b.worker.setCurrentTab(way.holder, b.copy(theirs));
    await settle();
    const reply = await command(way.port, "cookies", {
      action: "get",
      url: `https://mail${way.base}.example.org/`,
    });
    assert.equal(reply.type, "error", `${way.name}: ${JSON.stringify(reply)}`);
    assert.match(reply.error, /working on that site/);
    const permission = await command(way.port, "permission", {
      name: "camera",
      setting: "block",
      origin: `https://mail${way.base}.example.org`,
    });
    assert.equal(permission.type, "error", JSON.stringify(permission));
  }
});

// -- One host's reload never cuts the other off ------------------------------------------------------

test("a server's newer protocol reloads the extension only once nobody, of either host, is using it", async () => {
  const reloads = [];
  const local = new Map();
  const b = await bothHosts({
    overrides: {
      "runtime.reload": () => reloads.push(Date.now()),
      "storage.local.get": (key) =>
        Promise.resolve(local.has(key) ? { [key]: local.get(key) } : {}),
      "storage.local.set": (items) => {
        for (const [key, value] of Object.entries(items)) {
          local.set(key, value);
        }
        return Promise.resolve();
      },
    },
  });
  // S.A.K.'s assistant is at work in a tab.
  const sakTab = b.addTab({});
  b.worker.setCurrentTab(b.sakSession, b.copy(sakTab));
  await settle();
  // A newer Chrome Control MCP server starts; its relay speaks protocol 3.
  b.cc.emit({ type: "bridge_servers", servers: ["100", "200"] });
  await settle();
  const fresh = b.ports[b.ports.length - 1];
  assert.notEqual(fresh, b.cc, "a port is opened for the new server");
  fresh.emit({
    type: "bridge_offers",
    protocol: PROTOCOL,
    servers: ["100", "200"],
  });
  fresh.emit({ type: "bridge_ready", protocol: PROTOCOL + 1 });
  await settle();
  assert.deepEqual(reloads, [], "S.A.K.'s session was cut off by the reload");
  assert.equal(b.worker.versionReload.protocol, PROTOCOL + 1);
  // S.A.K. lets go of its tab; once the quiet period has passed, the reload goes ahead.
  await command(b.sak, "release", {});
  b.worker.versionReload.lastCommandEndedAt =
    Date.now() - b.worker.RELOAD_QUIET_MS - 1;
  await b.worker.reloadWhenIdle();
  await settle();
  assert.equal(reloads.length, 1);
  clearTimeout(b.worker.versionReload.timer);
});

// A command can start in the moment the reload waits for storage: the reload is then put off, the
// version it was for put back, and a later look still reloads.
test("a command that starts while storage answers stops the protocol reload, and a later look still reloads", async () => {
  const reloads = [];
  const local = new Map();
  let starting = false;
  let b = null;
  b = await bothHosts({
    overrides: {
      "runtime.reload": () => reloads.push(Date.now()),
      "storage.local.get": (key) => {
        if (starting) {
          b.worker.versionReload.commandsRunning += 1;
          starting = false;
        }
        return Promise.resolve(local.has(key) ? { [key]: local.get(key) } : {});
      },
      "storage.local.set": (items) => {
        for (const [key, value] of Object.entries(items)) {
          local.set(key, value);
        }
        return Promise.resolve();
      },
    },
  });
  b.cc.emit({ type: "bridge_servers", servers: ["100", "200"] });
  await settle();
  const fresh = b.ports[b.ports.length - 1];
  assert.notEqual(fresh, b.cc, "a port is opened for the new server");
  fresh.emit({
    type: "bridge_offers",
    protocol: PROTOCOL,
    servers: ["100", "200"],
  });
  starting = true;
  fresh.emit({ type: "bridge_ready", protocol: PROTOCOL + 1 });
  await settle();
  assert.deepEqual(
    reloads,
    [],
    "reloaded under a command that had just started",
  );
  assert.equal(
    local.get("chrome_control_mcp.reloadedForProtocol"),
    null,
    "the protocol it was for is put back",
  );
  b.worker.versionReload.commandsRunning -= 1;
  b.worker.versionReload.lastCommandEndedAt =
    Date.now() - b.worker.RELOAD_QUIET_MS - 1;
  await b.worker.reloadWhenIdle();
  await settle();
  assert.equal(reloads.length, 1);
  clearTimeout(b.worker.versionReload.timer);
});

// -- Server ids ---------------------------------------------------------------------------------------

test("a Chrome Control MCP relay cannot offer a server id that is S.A.K.'s key", async () => {
  const b = await bothHosts();
  b.cc.emit({ type: "bridge_servers", servers: ["100", "sak:5"] });
  await settle();
  // The id with the prefix separator is dropped: no port is opened for it.
  assert.equal(b.ports.length, 1, "a port was opened for 'sak:5'");
  // Offered to a fresh port, it is not taken either.
  b.worker.CC_HUB.nextAttemptAt = 0;
  b.worker.reconnectHub(b.worker.CC_HUB);
  b.worker.CC_HUB.lastSafetyProbeAt = 0;
  b.worker.reconnectHub(b.worker.CC_HUB);
  await settle();
  const probe = b.ports[b.ports.length - 1];
  assert.notEqual(probe, b.cc, "the safety probe opens a port");
  probe.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["sak:5"] });
  await settle();
  assert.equal(attachFrame(probe).session, "");
  for (const session of b.worker.sessions) {
    assert.notEqual(
      session.hub === b.worker.CC_HUB && session.serverId,
      "sak:5",
    );
  }
  // S.A.K.'s own server 5 is still S.A.K.'s.
  b.sak.emit({ type: "bridge_servers", servers: ["100", "5"] });
  await settle();
  const sakFresh = b.sakPorts[b.sakPorts.length - 1];
  assert.notEqual(sakFresh, b.sak);
  sakFresh.emit({
    type: "bridge_offers",
    protocol: PROTOCOL,
    servers: ["100", "5"],
  });
  await settle();
  assert.equal(attachFrame(sakFresh).session, "5");
  const sakFive = [...b.worker.sessions].find((s) => s.port === sakFresh);
  assert.equal(sakFive.serverId, "sak:5");
  assert.equal(sakFive.hub, b.worker.SAK_HUB);
});

// -- S.A.K.'s host when it cannot start, or has nothing to attach to ------------------------------------

test("S.A.K.'s host that cannot start is waited for like a missing one, silently", async () => {
  const { logged, sink } = recordingConsole();
  const overrides = {};
  let attempts = 0;
  const worker = loadWorker(
    ["SAK_HUB", "OPTIONAL_HOST_MISSING_MIN_MS", "reconnectHub"],
    overrides,
    LIVE,
    {
      sakHost: () => {
        attempts += 1;
        const port = makeFakePort();
        setTimeout(() => {
          overrides["runtime.lastError"] = {
            message: "Failed to start native messaging host.",
          };
          try {
            port.drop();
          } finally {
            delete overrides["runtime.lastError"];
          }
        }, 0);
        return port;
      },
      console: sink,
    },
  );
  await settle();
  assert.equal(attempts, 1);
  assert.equal(
    worker.SAK_HUB.missingDelayMs,
    worker.OPTIONAL_HOST_MISSING_MIN_MS,
  );
  for (let i = 0; i < 50; i += 1) {
    worker.reconnectHub(worker.SAK_HUB);
  }
  await settle();
  assert.equal(attempts, 1, "nothing is asked while the long wait runs");
  assert.deepEqual(sakLines(logged), []);
});

test("S.A.K.'s relay with nothing to attach to is asked for on a growing interval, up to ten minutes, silently", async () => {
  const { logged, sink } = recordingConsole();
  const ports = [];
  const worker = loadWorker(
    [
      "SAK_HUB",
      "RECONNECT_MAX_MS",
      "OPTIONAL_HOST_IDLE_MAX_MS",
      "reconnectHub",
    ],
    {},
    LIVE,
    {
      sakHost: () => {
        const port = makeFakePort();
        ports.push(port);
        return port;
      },
      console: sink,
    },
  );
  await settle();
  const delays = [];
  for (let round = 0; round < 12; round += 1) {
    const port = ports[ports.length - 1];
    // S.A.K. is not running: the relay offers nothing and exits.
    port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: [] });
    await settle();
    port.drop();
    await settle();
    delays.push(worker.SAK_HUB.reconnectDelayMs);
    // The retry timer's wait, as if it had passed.
    for (const session of [...worker.sessions]) {
      if (session.hub === worker.SAK_HUB && session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
        worker.sessions.delete(session);
      }
    }
    worker.SAK_HUB.nextAttemptAt = 0;
    worker.reconnectHub(worker.SAK_HUB);
    await settle();
  }
  assert.equal(ports.length, 13, "one attempt per round");
  assert.ok(
    delays[delays.length - 1] > worker.RECONNECT_MAX_MS,
    "it waits longer than two minutes",
  );
  assert.equal(delays[delays.length - 1], worker.OPTIONAL_HOST_IDLE_MAX_MS);
  assert.equal(worker.OPTIONAL_HOST_IDLE_MAX_MS, 10 * MINUTE_MS);
  assert.deepEqual(sakLines(logged), [], "nothing is logged about it");
});

// -- The administrator's switch (managed policy) ----------------------------------------------------

test("without the administrator's policy, S.A.K.'s host is never asked for, even when registered", async () => {
  const b = fakeBrowser({
    exported: EXPORTED,
    live: LIVE,
    sakHost: true,
    sakPolicy: false,
  });
  await settle();
  assert.equal(b.ports.length, 1, "Chrome Control MCP's host is asked for");
  for (let i = 0; i < 20; i += 1) {
    b.worker.reconnectHub(b.worker.SAK_HUB);
    b.worker.reconnectOnActivity();
  }
  // Not even for the user's click on the toolbar button: the policy is the administrator's.
  await b.worker.setBridgePaused(true);
  await b.worker.onActionClicked();
  await settle();
  assert.equal(
    b.sakPorts.length,
    0,
    "S.A.K.'s host was asked for without the policy",
  );
  assert.ok(b.ports.length > 1, "while Chrome Control MCP's was, on the click");
});

test("only the value true turns S.A.K.'s host on", async () => {
  for (const value of [1, "true", "yes", {}, null]) {
    const b = fakeBrowser({
      exported: EXPORTED,
      live: LIVE,
      sakHost: true,
      overrides: {
        "storage.managed.get": () => Promise.resolve({ sakHostEnabled: value }),
      },
    });
    await settle();
    b.worker.reconnectHub(b.worker.SAK_HUB);
    await settle();
    assert.equal(b.sakPorts.length, 0, JSON.stringify(value));
  }
});

test("the administrator turning the policy on connects at once; off ends S.A.K.'s sessions", async () => {
  const b = fakeBrowser({
    exported: EXPORTED,
    live: LIVE,
    sakHost: true,
    sakPolicy: false,
  });
  await settle();
  assert.equal(b.sakPorts.length, 0);
  b.fire(
    "storage.onChanged",
    { sakHostEnabled: { newValue: true } },
    "managed",
  );
  await settle();
  assert.equal(
    b.sakPorts.length,
    1,
    "turned on: S.A.K.'s host is asked for now",
  );
  const sak = b.sakPorts[0];
  sak.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
  sak.emit({ type: "bridge_ready", protocol: PROTOCOL });
  await settle();
  const session = [...b.worker.sessions].find((s) => s.port === sak);
  const tab = b.addTab({});
  b.worker.setCurrentTab(session, b.copy(tab));
  await settle();

  // A change in another storage area is not this switch.
  b.fire("storage.onChanged", { sakHostEnabled: { newValue: false } }, "local");
  await settle();
  assert.equal(sak.connected, true);

  b.fire(
    "storage.onChanged",
    { sakHostEnabled: { oldValue: true } },
    "managed",
  );
  await settle();
  assert.equal(sak.connected, false, "turned off: its port is closed");
  assert.ok(![...b.worker.sessions].some((s) => s.hub === b.worker.SAK_HUB));
  assert.ok(b.tabs.has(tab.id), "its tab goes back to the user, open");
  for (let i = 0; i < 10; i += 1) {
    b.worker.reconnectHub(b.worker.SAK_HUB);
  }
  await settle();
  assert.equal(b.sakPorts.length, 1, "and it is not asked for again");
});

// What an earlier worker saved for S.A.K.'s server 100: one tab it had borrowed (an adopted tab).
const LEASES_KEY = "chrome_control_mcp.leases";
function sakLeaseRecord(tabId) {
  return {
    [LEASES_KEY]: {
      "sak:100": {
        tabs: [[tabId, "adopted", "", null]],
        groups: [],
        colors: [],
        current: tabId,
        window: 1,
        label: "",
      },
    },
  };
}

test("a new worker lets go of S.A.K.'s parked tabs when the administrator's policy is off", async () => {
  for (const policy of [false, true]) {
    const b = fakeBrowser({
      exported: EXPORTED,
      live: LIVE,
      sakHost: true,
      sakPolicy: policy,
      overrides: {
        "storage.session.get": () => Promise.resolve(sakLeaseRecord(300)),
      },
    });
    // The tab is open as the new worker starts: Chrome kept it, as it keeps the worker's storage.
    b.addTab({ id: 300, url: "https://parked.example.org/" });
    await settle();
    const cc = b.ports[0];
    cc.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
    cc.emit({ type: "bridge_ready", protocol: PROTOCOL });
    await settle();
    const tabs = listed(await command(cc, "listTabs"));
    if (policy) {
      // On: the holdings wait, parked, for S.A.K.'s next offer, as before.
      assert.ok(b.worker.pendingLeases.has("sak:100"), "kept while on");
      assert.ok(!tabs.includes(300), "and still S.A.K.'s");
      continue;
    }
    // Off (removed while no worker ran, so no change event comes): S.A.K. is never asked for again,
    // and nothing it held may stay hidden from Chrome Control MCP on its account.
    assert.equal(b.worker.pendingLeases.has("sak:100"), false, "stood down");
    assert.ok(tabs.includes(300), "the tab is the user's again, listed");
    assert.ok(b.tabs.has(300), "and open");
    assert.equal(b.sakPorts.length, 0);
  }
});

test("a policy turned off that the worker already read as off still stands S.A.K.'s parked tabs down", async () => {
  // The worker read the policy as on, S.A.K.'s session parked (its port dropped), and the worker
  // then read the policy as off before Chrome's change event arrived.
  const b = await bothHosts();
  const tab = b.addTab({ url: "https://parked.example.org/" });
  b.worker.setCurrentTab(b.sakSession, b.copy(tab));
  await settle();
  b.sak.drop();
  await settle();
  assert.ok(b.worker.pendingLeases.has("sak:100"), "parked");
  b.worker.SAK_HUB.policyEnabled = false;
  b.fire(
    "storage.onChanged",
    { sakHostEnabled: { oldValue: true } },
    "managed",
  );
  await settle();
  assert.equal(b.worker.pendingLeases.has("sak:100"), false, "stood down");
  assert.ok(listed(await command(b.cc, "listTabs")).includes(tab.id));
});

test("a command that outlives its session takes no tab, group or debugger", async () => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  let b = null;
  b = await bothHosts({
    overrides: {
      // Chrome takes its time creating the tab, and the session ends meanwhile.
      "tabs.create": (props) =>
        gate.then(() => {
          const tab = b.addTab({
            windowId: props.windowId,
            url: props.url,
            active: props.active,
          });
          b.fire("tabs.onCreated", b.copy(tab));
          return b.copy(tab);
        }),
    },
  });
  const before = new Set(b.tabs.keys());
  const cdpBefore = b.calls.cdp.length;
  b.sak.emit({ type: "command", id: "late", cmd: "newTab" });
  await settle();
  b.fire(
    "storage.onChanged",
    { sakHostEnabled: { oldValue: true } },
    "managed",
  );
  await settle();
  open();
  await settle();
  await settle();
  const created = [...b.tabs.keys()].filter((id) => !before.has(id));
  assert.equal(created.length, 1, "Chrome opened the tab");
  const [id] = created;
  assert.equal(b.sakSession.tabs.has(id), false, "nobody holds it");
  assert.equal(b.tabs.get(id).groupId, -1, "it is in no group");
  assert.deepEqual(
    [...b.groups.values()].map((group) => group.title),
    [],
    "no group was made",
  );
  assert.equal(b.attached.has(id), false, "no debugger is on it");
  assert.equal(b.calls.cdp.length, cdpBefore, "nothing was sent to it");
});

test("an ended session holds no tab and attaches to none it still lists", async () => {
  const b = await bothHosts();
  const tab = b.addTab({});
  const session = b.worker.makeSession(b.worker.SAK_HUB);
  // A session part way through its stand-down: a tab still listed, not yet handed back.
  b.worker.holdTab(session, b.copy(tab), "adopted");
  session.ended = true;
  await assert.rejects(b.worker.ensureAttached(session, tab.id), /ended/);
  assert.equal(b.attached.has(tab.id), false);
  assert.deepEqual(
    b.calls.cdp.filter((call) => call.tabId === tab.id),
    [],
    "nothing was sent to the tab",
  );
  const other = b.addTab({});
  assert.throws(
    () => b.worker.holdTab(session, b.copy(other), "opened"),
    /ended/,
  );
  assert.equal(session.tabs.has(other.id), false);
});

test("while the policy is still being read, nothing asks for S.A.K.'s host", async () => {
  for (const policy of [{ sakHostEnabled: true }, {}]) {
    let answer;
    const managed = new Promise((resolve) => {
      answer = resolve;
    });
    const b = fakeBrowser({
      exported: EXPORTED,
      live: LIVE,
      sakHost: true,
      overrides: { "storage.managed.get": () => managed },
    });
    await settle();
    // The startup window: tab events, the alarm, and the user's own toolbar click (which clears
    // the optional host's stored wait, so only the policy holds it back) all fire before the
    // policy store has answered.
    for (let i = 0; i < 5; i += 1) {
      const tab = b.addTab({});
      b.fire("tabs.onUpdated", tab.id, { status: "loading" }, b.copy(tab));
      b.fire("tabs.onActivated", { tabId: tab.id, windowId: tab.windowId });
      b.worker.reconnectHub(b.worker.SAK_HUB);
    }
    await b.worker.setBridgePaused(true);
    await b.worker.onActionClicked();
    await settle();
    assert.equal(
      b.sakPorts.length,
      0,
      `${JSON.stringify(policy)}: asked for before the policy was read`,
    );
    answer(policy);
    await settle();
    assert.equal(
      b.sakPorts.length,
      policy.sakHostEnabled ? 1 : 0,
      `${JSON.stringify(policy)}: once read`,
    );
  }
});
