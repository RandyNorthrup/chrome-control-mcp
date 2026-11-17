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
  assert.match(refused.error, /in use by another application/);
  assert.doesNotMatch(refused.error, /Codex|Chrome Control MCP|server/);
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

test("the profile's account email is told to Chrome Control MCP only", async () => {
  const b = await bothHosts({
    overrides: {
      "identity.getProfileUserInfo": () =>
        Promise.resolve({ email: "person@example.test" }),
    },
  });
  assert.equal(attachFrame(b.cc).profile_email, "person@example.test");
  const sakAttach = attachFrame(b.sak);
  assert.ok(sakAttach, "S.A.K.'s relay is answered");
  assert.equal("profile_email" in sakAttach, false);
  assert.equal(typeof sakAttach.profile_name, "string");
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
