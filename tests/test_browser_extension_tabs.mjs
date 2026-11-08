// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Which tabs are the assistant's, and what happens to them.
//
// Each of these was reported from daily use, and each had the same shape: the worker inferred
// ownership from something that does not carry it. Chrome gives a tab an opener for the user's
// own Ctrl+T, so following openers moved the session onto the user's new tab and pulled it into
// the AI group. One "current tab" per server meant a second agent on the same server retargeted
// the first. Only one tab was ever marked, so closing it left the rest of the group unmarked, and
// only that one was ungrouped when the session ended, so the group outlived its owner.
//
// These drive the worker against a small model of the browser -- tabs, windows, groups, and the
// events Chrome fires -- so the assertions are about what the user would see in the tab strip.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL,
  attachedBrowser as attachBrowser,
  command,
} from "./browser_model.mjs";
import { settle } from "./extension_harness.mjs";

const EXPORTED = [
  "dispatchCommand",
  "handleCommand",
  "handleRelease",
  "holdTab",
  "setCurrentTab",
  "sweepIdleSessions",
  "standDownIdle",
  "noteOfferedServers",
  "probeForServers",
  "agentArg",
  "claimPopup",
  "agentColor",
  "presenceLook",
  "pendingLeases",
  "IDLE_RELEASE_MS",
];
const LIVE =
  "sessions, probeOpenedAt: () => probeOpenedAt, refused: () => refusedServers";

// The browser model, bound to the names this suite reads.
const attachedBrowser = (server = "100", options = {}) =>
  attachBrowser(server, { exported: EXPORTED, live: LIVE, ...options });

// -- The user's own tabs ------------------------------------------------------

test("the user's Ctrl+T from an AI tab neither moves the session nor joins the AI group", async () => {
  const b = await attachedBrowser();
  const aiTab = b.addTab({ active: true });
  b.worker.setCurrentTab(b.session, b.copy(aiTab));
  await settle();
  const groupId = b.tabs.get(aiTab.id).groupId;
  assert.ok(groupId >= 0, "the AI tab is in the AI group");

  // Ctrl+T: Chrome names the tab the user was looking at as the opener, and (when the group is
  // where the new tab lands) puts it in that group. No command of the session's is running.
  const userTab = b.addTab({
    active: true,
    openerTabId: aiTab.id,
    url: "",
    pendingUrl: "chrome://newtab/",
    groupId,
  });
  b.fire("tabs.onCreated", b.copy(userTab));
  await settle();

  assert.equal(
    b.session.currentTabId,
    aiTab.id,
    "the session stays on its own tab",
  );
  assert.equal(
    b.session.tabs.has(userTab.id),
    false,
    "the user's tab is not the session's",
  );
  assert.equal(
    b.tabs.get(userTab.id).groupId,
    -1,
    "and it is taken out of the AI group",
  );
});

test("a link the user middle-clicks in an AI tab between commands stays the user's", async () => {
  const b = await attachedBrowser();
  const aiTab = b.addTab({ active: false });
  b.worker.setCurrentTab(b.session, b.copy(aiTab));
  await settle();

  const opened = b.addTab({
    openerTabId: aiTab.id,
    url: "https://elsewhere.test/",
  });
  b.fire("tabs.onCreated", b.copy(opened));
  await settle();

  assert.equal(b.session.tabs.has(opened.id), false);
  assert.equal(b.session.currentTabId, aiTab.id);
});

test("a tab the agent's own click opens is the agent's, follows it, and is reported", async () => {
  const b = await attachedBrowser();
  const aiTab = b.addTab({ active: false });
  b.worker.setCurrentTab(b.session, b.copy(aiTab));
  await settle();

  // The click's page opens a foreground tab while the command is running, and the browser says
  // which tab it came from.
  b.session.openerUntil = Infinity;
  const popup = b.addTab({
    active: true,
    openerTabId: aiTab.id,
    url: "https://popup.test/",
  });
  b.fire("tabs.onCreated", b.copy(popup));
  b.fire("webNavigation.onCreatedNavigationTarget", {
    sourceTabId: aiTab.id,
    tabId: popup.id,
    url: "https://popup.test/",
  });
  await settle();
  b.session.openerUntil = 0;

  assert.equal(b.session.tabs.get(popup.id).origin, "opened");
  assert.equal(
    b.session.currentTabId,
    popup.id,
    "a foreground popup is where the click led",
  );
  const reply = await command(b.port, "listTabs");
  assert.deepEqual(
    Array.from(reply.payload.opened_tabs, (t) => t.tab_id),
    [popup.id],
    "the agent is told which tab its action opened",
  );
});

test("dragging a tab out of the AI group takes it back; dragging one in hands it over", async () => {
  const b = await attachedBrowser();
  const aiTab = b.addTab({ active: false });
  const spare = b.addTab({ active: false });
  b.worker.setCurrentTab(b.session, b.copy(aiTab));
  b.worker.holdTab(b.session, b.copy(spare), "opened");
  await settle();
  await settle();
  const groupId = b.tabs.get(aiTab.id).groupId;

  // The user drags the spare tab out (long after the worker's own grouping settled).
  await new Promise((r) => setTimeout(r, 1600));
  b.tabs.get(spare.id).groupId = -1;
  b.fire(
    "tabs.onUpdated",
    spare.id,
    { groupId: -1 },
    b.copy(b.tabs.get(spare.id)),
  );
  await settle();
  assert.equal(b.session.tabs.has(spare.id), false, "taken back by the user");
  assert.ok(b.tabs.has(spare.id), "and never closed for it");

  // And drags one of their own in.
  const theirs = b.addTab({ active: false });
  await new Promise((r) => setTimeout(r, 3100)); // older than Chrome's own auto-grouping window
  b.tabs.get(theirs.id).groupId = groupId;
  b.fire(
    "tabs.onUpdated",
    theirs.id,
    { groupId },
    b.copy(b.tabs.get(theirs.id)),
  );
  await settle();
  assert.equal(
    b.session.tabs.get(theirs.id).origin,
    "adopted",
    "handed over, as a borrowed tab",
  );
});

// A target=_blank link opens without an opener Chrome will name to an extension (measured on
// the-internet.herokuapp.com/windows: the popup arrived with none and was left behind as a stray
// tab), and it opens in FRONT, switching the user's view. The page's own request to open it --
// CDP Page.windowOpen -- is what ties it to the agent, in whichever order the two arrive.
async function popupScene() {
  const b = await attachedBrowser();
  const users = b.addTab({ active: true }); // what the user is looking at
  b.fire("tabs.onActivated", { tabId: users.id, windowId: 1 });
  const aiTab = b.addTab({});
  b.worker.holdTab(b.session, b.copy(aiTab), "opened", "web");
  await settle();
  b.session.openerUntil = Infinity; // a click is running
  const openPopup = () => {
    b.tabs.get(users.id).active = false;
    const popup = b.addTab({
      active: true,
      url: "",
      pendingUrl: "https://site.test/new",
    });
    b.fire("tabs.onActivated", { tabId: popup.id, windowId: 1 });
    b.fire("tabs.onCreated", b.copy(popup));
    return popup;
  };
  const windowOpen = () =>
    b.fire("debugger.onEvent", { tabId: aiTab.id }, "Page.windowOpen", {
      url: "https://site.test/new",
    });
  return { b, users, aiTab, openPopup, windowOpen };
}

test("a popup with no opener is claimed through the page's window request", async () => {
  const { b, users, openPopup, windowOpen } = await popupScene();
  windowOpen();
  const popup = openPopup();
  await settle();
  assert.equal(b.session.tabs.get(popup.id)?.origin, "opened");
  assert.equal(
    b.session.tabs.get(popup.id).agent,
    "web",
    "in the agent's group",
  );
  assert.equal(
    b.tabs.get(users.id).active,
    true,
    "the user's tab is put back in front",
  );
});

test("a popup goes to the agent whose page opened it, not to the agent whose tab is in front", async () => {
  // Chrome names the window's active tab as the opener of a link opened from a tab in the
  // background. Measured on the Linux runner: the tab in front was one agent's -- the user was
  // watching it -- and the popup another agent's click opened was taken by the first, whose own
  // click had finished a second before and so still counted as opening things.
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, "makeSession"],
  });
  const front = b.addTab({ active: true });
  b.worker.holdTab(b.session, b.copy(front), "opened", "alpha");
  b.fire("tabs.onActivated", { tabId: front.id, windowId: 1 });
  b.session.openerUntil = Date.now() + 2000; // its click has just finished
  // Another server's session, its click running in its own background tab.
  const other = b.worker.makeSession();
  other.port = { postMessage() {}, disconnect() {} };
  b.worker.sessions.add(other);
  const source = b.addTab({});
  b.worker.holdTab(other, b.copy(source), "opened", "beta");
  other.openerUntil = Infinity;
  await settle();

  const popup = b.addTab({
    active: false,
    openerTabId: front.id, // what Chrome reports: the tab in front
    url: "",
    pendingUrl: "https://popup.test/",
  });
  b.fire("tabs.onCreated", b.copy(popup));
  b.fire("webNavigation.onCreatedNavigationTarget", {
    sourceTabId: source.id, // what actually opened it
    tabId: popup.id,
    url: "https://popup.test/",
  });
  await settle();
  assert.equal(
    b.session.tabs.has(popup.id),
    false,
    "not the agent whose tab the user has in front",
  );
  assert.equal(
    other.tabs.get(popup.id)?.origin,
    "opened",
    "but the agent whose page opened it",
  );
  assert.equal(other.tabs.get(popup.id)?.openedFrom, source.id);
});

test("a popup is claimed even when its tab arrives before the window request", async () => {
  const { b, openPopup, windowOpen } = await popupScene();
  const popup = openPopup();
  await settle();
  assert.equal(b.session.tabs.has(popup.id), false, "nothing claims it yet");
  windowOpen();
  await settle();
  assert.equal(b.session.tabs.get(popup.id)?.origin, "opened");
});

test("a popup the browser says came from the agent's tab is claimed, blank or not", async () => {
  // Measured on a real site: the no-opener tab arrived blank, with no Page.windowOpen match, and
  // stayed behind in front of the user. The browser's own record names the source tab.
  const { b, users, aiTab, openPopup } = await popupScene();
  const popup = openPopup();
  b.tabs.get(popup.id).pendingUrl = undefined; // nothing to match by address
  b.fire("webNavigation.onCreatedNavigationTarget", {
    sourceTabId: aiTab.id,
    tabId: popup.id,
    url: "https://site.test/new",
  });
  await settle();
  assert.equal(b.session.tabs.get(popup.id)?.origin, "opened");
  assert.equal(
    b.tabs.get(users.id).active,
    true,
    "the user's tab is back in front",
  );
});

test("a popup Chrome brings forward only after it is claimed still goes back behind the user's tab", async () => {
  // The order a real profile showed: the browser reports the new tab, the worker claims it, and
  // only then does Chrome activate it. A restore armed only for an already-active tab never ran.
  const { b, users, aiTab } = await popupScene();
  const popup = b.addTab({ active: false, url: "" });
  b.fire("tabs.onCreated", b.copy(popup));
  b.fire("webNavigation.onCreatedNavigationTarget", {
    sourceTabId: aiTab.id,
    tabId: popup.id,
  });
  await settle();
  assert.equal(b.session.tabs.get(popup.id)?.origin, "opened");
  // Now Chrome puts it in front.
  b.tabs.get(users.id).active = false;
  b.tabs.get(popup.id).active = true;
  b.fire("tabs.onActivated", { tabId: popup.id, windowId: 1 });
  await settle();
  assert.equal(
    b.tabs.get(users.id).active,
    true,
    "the user's tab is put back in front",
  );
  assert.equal(
    b.session.currentTabId,
    popup.id,
    "and the agent follows its popup",
  );
});

test("a tab at the same address outside the agent's command stays the user's", async () => {
  const { b, openPopup, windowOpen } = await popupScene();
  b.session.openerUntil = 0; // no command running: the user opened it
  windowOpen();
  const popup = openPopup();
  await settle();
  assert.equal(b.session.tabs.has(popup.id), false);
});

// -- Several agents on one server ------------------------------------------------

test("a command naming a tab acts on that tab and leaves the current one alone", async () => {
  const b = await attachedBrowser();
  const tabA = b.addTab({});
  const tabB = b.addTab({});
  b.worker.holdTab(b.session, b.copy(tabA), "opened", "alpha");
  b.worker.setCurrentTab(b.session, b.copy(tabB), "beta");
  await settle();

  const reply = await command(b.port, "console", { tab_id: tabA.id });
  assert.equal(reply.type, "result");
  assert.equal(reply.tabId, tabA.id, "the reply names the tab acted on");
  assert.equal(
    b.session.currentTabId,
    tabB.id,
    "agent beta's current tab did not move",
  );
});

test("a tab the session does not hold is refused by id, and another session's names it busy", async () => {
  const b = await attachedBrowser();
  const free = b.addTab({});
  const refused = await command(b.port, "console", { tab_id: free.id });
  assert.equal(refused.type, "error");
  assert.match(refused.error, /not one of this session's tabs/);
});

test("each agent's tabs get their own group, in their own colour, matched on the page", async () => {
  const b = await attachedBrowser();
  const tabA = b.addTab({});
  const tabB = b.addTab({});
  b.worker.holdTab(b.session, b.copy(tabA), "opened", "research");
  b.worker.holdTab(b.session, b.copy(tabB), "opened", "writer");
  await settle();
  await settle();

  const groupA = b.groups.get(b.tabs.get(tabA.id).groupId);
  const groupB = b.groups.get(b.tabs.get(tabB.id).groupId);
  assert.notEqual(groupA.id, groupB.id, "one group per agent");
  assert.notEqual(groupA.color, groupB.color, "in different colours");
  assert.equal(groupA.title, "AI · research");
  assert.equal(groupB.title, "AI · writer");
  assert.equal(
    b.worker.presenceLook(tabA.id).label,
    "AI · research",
    "the page badge names it too",
  );
  assert.notEqual(
    b.worker.presenceLook(tabA.id).hex,
    b.worker.presenceLook(tabB.id).hex,
  );
});

test("an agent named in any script keeps its own group and its whole name", async () => {
  // The server accepts any printable name; the extension used to strip it to ASCII, so "café"
  // became "caf" and a name with no ASCII in it joined the session's shared group.
  const b = await attachedBrowser();
  const tabA = b.addTab({});
  const tabB = b.addTab({});
  const tabC = b.addTab({});
  b.worker.holdTab(
    b.session,
    b.copy(tabA),
    "opened",
    b.worker.agentArg({ agent: "café" }),
  );
  b.worker.holdTab(
    b.session,
    b.copy(tabB),
    "opened",
    b.worker.agentArg({ agent: "研究" }),
  );
  b.worker.holdTab(b.session, b.copy(tabC), "opened");
  await settle();
  await settle();

  const titleOf = (tab) => b.groups.get(b.tabs.get(tab.id).groupId).title;
  assert.equal(titleOf(tabA), "AI · café");
  assert.equal(titleOf(tabB), "AI · 研究");
  assert.notEqual(
    b.tabs.get(tabB.id).groupId,
    b.tabs.get(tabC.id).groupId,
    "a name with no ASCII is not the shared group",
  );
  assert.equal(b.worker.presenceLook(tabB.id).label, "AI · 研究");
});

// A browser whose tabGroups.update lands a while after it is called, as Chrome's does: long enough
// that a reply which does not wait for it goes out first.
const LABEL_DELAY_MS = 100;
async function slowLabellingBrowser() {
  let groups = null;
  const b = await attachedBrowser("100", {
    overrides: {
      "tabGroups.update": (id, props) =>
        new Promise((resolve) => {
          setTimeout(() => {
            Object.assign(groups.get(id), props);
            resolve({ ...groups.get(id) });
          }, LABEL_DELAY_MS);
        }),
    },
  });
  groups = b.groups;
  return b;
}

test("a new tab is in its agent's named group when browser_new_tab replies", async () => {
  // browser_new_tab used to reply once the page loaded, which a local page does in milliseconds,
  // and an immediate browser_tabs then listed the tab outside its group or under no name (a live
  // multi-agent run, 2026-11-07). What the strip shows is read the moment the reply is posted.
  const b = await slowLabellingBrowser();
  let atReply = null;
  const push = b.port.posted.push.bind(b.port.posted);
  b.port.posted.push = (frame) => {
    if (frame && frame.cmd === "newTab" && frame.payload) {
      const tab = b.tabs.get(frame.payload.tab_id);
      const group = tab ? b.groups.get(tab.groupId) : undefined;
      atReply = group ? group.title : null;
    }
    return push(frame);
  };

  const opened = await command(b.port, "newTab", { agent: "研究" });
  assert.equal(opened.payload.ok, true, JSON.stringify(opened));
  assert.equal(
    atReply,
    "AI · 研究",
    "grouped and named before the reply went out",
  );
});

test("browser_tabs lists a just-held tab in its named group", async () => {
  // Any path that holds a tab queues its grouping; a listing asked for at once waits for it.
  const b = await slowLabellingBrowser();
  const tab = b.addTab({});
  b.worker.holdTab(
    b.session,
    b.copy(tab),
    "opened",
    b.worker.agentArg({ agent: "研究" }),
  );
  const listing = await command(b.port, "listTabs");
  const row = listing.payload.tabs.find((t) => t.tab_id === tab.id);
  assert.equal(row.group, "AI · 研究", JSON.stringify(row));
});

test("a name is still bounded for the tab strip: no control characters, 24 characters at most", async () => {
  const { worker } = await attachedBrowser();
  assert.equal(worker.agentArg({ agent: "a\u202Eb\u0007c\u2028d" }), "abcd");
  assert.equal(worker.agentArg({ agent: "\u200F\u0000" }), undefined);
  // 25 astral characters: the cut is on code points, never inside a surrogate pair.
  assert.equal(worker.agentArg({ agent: "😀".repeat(25) }), "😀".repeat(24));
  assert.equal(worker.agentArg({ agent: "  ok  " }), "ok");
});

test("every held tab is attached and marked, not only the one being driven", async () => {
  // Closing the tab the session was driving used to leave the rest of its group unmarked.
  const b = await attachedBrowser();
  const tabA = b.addTab({});
  const tabB = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(tabA));
  b.worker.holdTab(b.session, b.copy(tabB), "opened");
  await settle();
  assert.ok(b.attached.has(tabA.id) && b.attached.has(tabB.id));

  await b.worker.dispatchCommand(b.session, "closeTab", { tab_id: tabA.id });
  await settle();
  assert.ok(
    b.attached.has(tabB.id),
    "the remaining tab stays attached and marked",
  );
  assert.equal(
    b.tabs.get(tabB.id).groupId >= 0,
    true,
    "and stays in the group",
  );
});

// -- Letting go ---------------------------------------------------------------------

test("release closes what the agent opened and hands back what it borrowed", async () => {
  const b = await attachedBrowser();
  b.addTab({}); // the user's own, untouched
  const borrowed = b.addTab({});
  const opened = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(borrowed));
  b.worker.holdTab(b.session, b.copy(opened), "opened");
  await settle();

  const result = await b.worker.handleRelease(b.session, {});
  await settle();

  assert.deepEqual(Array.from(result.closed), [opened.id]);
  assert.deepEqual(Array.from(result.handed_back), [borrowed.id]);
  assert.ok(b.tabs.has(borrowed.id), "a borrowed tab is never closed");
  assert.equal(b.tabs.get(borrowed.id).groupId, -1, "and leaves the AI group");
  assert.equal(b.attached.size, 0, "nothing stays attached");
  assert.equal(b.session.tabs.size, 0);
});

test("release never closes the tab the user is looking at, nor the browser's last tab", async () => {
  const b = await attachedBrowser();
  const watched = b.addTab({ active: true });
  const other = b.addTab({});
  b.worker.holdTab(b.session, b.copy(watched), "opened");
  b.worker.holdTab(b.session, b.copy(other), "opened");
  await settle();
  b.focus(1, true);

  const result = await b.worker.handleRelease(b.session, {});
  assert.ok(b.tabs.has(watched.id), "the tab in front of the user stays open");
  assert.deepEqual(Array.from(result.kept_open), [watched.id]);
  assert.ok(b.tabs.size >= 1, "the browser still has a tab");
});

test("releasing an agent's tab releases what it opened and that agent's other tabs, nobody else's", async () => {
  // Reported from daily use: an agent released its tab_id and left two of its tabs open -- the
  // popups its clicks had opened, held all day by a server that was still running.
  const b = await attachedBrowser();
  b.addTab({}); // the user's own
  const tab = (agent) => {
    const t = b.addTab({});
    b.worker.holdTab(b.session, b.copy(t), "opened", agent);
    return t;
  };
  const alpha = tab("alpha");
  const alphaSecond = tab("alpha");
  const beta = tab("beta");
  const unnamed = tab("");
  const unnamedOther = tab("");
  const popupOf = (opener) => {
    const p = b.addTab({ openerTabId: opener.id });
    b.worker.claimPopup(b.session, b.session.tabs.get(opener.id), b.copy(p));
    return p;
  };
  const alphaPopup = popupOf(alpha);
  const popupOfPopup = popupOf(alphaPopup);
  const unnamedPopup = popupOf(unnamed);
  await settle();

  const released = await b.worker.handleRelease(b.session, {
    tab_id: alpha.id,
  });
  await settle();
  assert.deepEqual(
    new Set(released.closed),
    new Set([alpha.id, alphaSecond.id, alphaPopup.id, popupOfPopup.id]),
    "the tab, the agent's other tab, and every page opened from them",
  );
  for (const t of [alpha, alphaSecond, alphaPopup, popupOfPopup]) {
    assert.ok(!b.tabs.has(t.id), "tab " + t.id + " is closed");
  }
  assert.ok(b.session.tabs.has(beta.id), "another agent's tab is untouched");
  assert.ok(b.tabs.has(beta.id));

  // An unnamed agent cannot be told apart from another on the same server: its tab and what that
  // tab opened go, and the other unnamed tab stays.
  const second = await b.worker.handleRelease(b.session, {
    tab_id: unnamed.id,
  });
  assert.deepEqual(
    new Set(second.closed),
    new Set([unnamed.id, unnamedPopup.id]),
  );
  assert.ok(b.session.tabs.has(unnamedOther.id));
});

test("a close Chrome refuses is retried; one that never succeeds is handed back, not called closed", async () => {
  const once = await attachedBrowser("100", { refuseRemovals: 1 });
  once.addTab({});
  const retried = once.addTab({});
  once.worker.holdTab(once.session, once.copy(retried), "opened");
  await settle();
  const first = await once.worker.handleRelease(once.session, {});
  assert.deepEqual(Array.from(first.closed), [retried.id]);
  assert.equal(first.not_closed, undefined);
  assert.ok(!once.tabs.has(retried.id), "closed on the second attempt");

  const never = await attachedBrowser("100", { refuseRemovals: Infinity });
  never.addTab({});
  const stuck = never.addTab({});
  never.worker.holdTab(never.session, never.copy(stuck), "opened");
  await settle();
  assert.ok(never.tabs.get(stuck.id).groupId >= 0, "it starts in the AI group");
  const result = await never.worker.handleRelease(never.session, {});
  await settle();
  assert.deepEqual(Array.from(result.closed), [], "never reported as closed");
  assert.deepEqual(Array.from(result.not_closed), [stuck.id]);
  assert.deepEqual(Array.from(result.kept_open), [stuck.id]);
  assert.ok(never.tabs.has(stuck.id), "still open, as Chrome left it");
  assert.equal(
    never.tabs.get(stuck.id).groupId,
    -1,
    "and out of the AI group, not left there with nobody holding it",
  );
  assert.equal(never.session.tabs.size, 0);
});

test("keep_open hands opened tabs to the user instead of closing them", async () => {
  const b = await attachedBrowser();
  b.addTab({});
  const opened = b.addTab({});
  b.worker.holdTab(b.session, b.copy(opened), "opened");
  await settle();

  const result = await b.worker.handleRelease(b.session, { keep_open: true });
  assert.deepEqual(Array.from(result.closed), []);
  assert.ok(b.tabs.has(opened.id));
});

test("a lost port parks the tabs; the server coming back resumes them", async () => {
  const b = await attachedBrowser("100");
  const tab = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(tab));
  await settle();

  b.port.drop();
  await settle();
  assert.ok(b.worker.pendingLeases.has("100"), "parked, not dropped");
  assert.ok(b.tabs.has(tab.id));

  // A new port reaches the same server, which is still running.
  b.worker.probeForServers({ force: true });
  const next = b.ports[b.ports.length - 1];
  next.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
  next.emit({ type: "bridge_ready", protocol: PROTOCOL });
  await settle();
  const resumed = [...b.worker.sessions].find((s) => s.port === next);
  assert.ok(resumed.tabs.has(tab.id), "the server's tabs are its again");
  assert.equal(resumed.currentTabId, tab.id);
  assert.equal(b.worker.pendingLeases.has("100"), false);
});

test("a server that is gone has its tabs cleaned up: opened closed, borrowed handed back", async () => {
  const b = await attachedBrowser("100");
  b.addTab({});
  const borrowed = b.addTab({});
  const opened = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(borrowed));
  b.worker.holdTab(b.session, b.copy(opened), "opened");
  await settle();

  b.port.drop();
  await settle();
  b.worker.noteOfferedServers(["200"]); // a relay lists the live servers; 100 is not among them
  await settle();
  await settle();

  assert.equal(b.tabs.has(opened.id), false, "the tab it opened is closed");
  assert.ok(b.tabs.has(borrowed.id), "the user's tab stays");
  assert.equal(b.tabs.get(borrowed.id).groupId, -1, "out of the AI group");
});

test("an idle session is stood down, keeps its tabs, and its next command resumes", async () => {
  const b = await attachedBrowser();
  const tab = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(tab));
  await settle();
  assert.ok(b.attached.has(tab.id));

  b.session.lastCommandAt = Date.now() - b.worker.IDLE_RELEASE_MS - 1;
  b.worker.sweepIdleSessions();
  await settle();
  await settle();
  assert.equal(
    b.attached.has(tab.id),
    false,
    "the debugger bar goes with the attachment",
  );
  assert.ok(b.session.tabs.has(tab.id), "the tab is still the session's");
  const group = b.groups.get(b.tabs.get(tab.id).groupId);
  assert.equal(group.color, "grey");
  assert.match(group.title, /idle/);

  await command(b.port, "console");
  await settle();
  assert.equal(b.session.idle, false);
  assert.ok(b.attached.has(tab.id), "picked back up");
  assert.notEqual(b.groups.get(b.tabs.get(tab.id).groupId).color, "grey");
});

// -- Replies -----------------------------------------------------------------------

test("a reply names its tab and that tab's epoch, and the tabs the session let go of", async () => {
  const b = await attachedBrowser();
  const keep = b.addTab({});
  const gone = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(keep));
  b.worker.holdTab(b.session, b.copy(gone), "opened");
  await settle();
  b.session.tabs.get(keep.id).domEpoch = 4;

  b.fire("tabs.onRemoved", gone.id, {});
  b.tabs.delete(gone.id);
  await settle();
  const reply = await command(b.port, "console");
  assert.equal(reply.tabId, keep.id);
  assert.equal(reply.domEpoch, 4);
  assert.deepEqual(Array.from(reply.goneTabIds), [gone.id]);

  const next = await command(b.port, "listTabs");
  assert.equal(next.goneTabIds, undefined, "reported once");
  assert.equal(next.tabId, undefined, "a command on no tab names none");
});

// -- File pickers ------------------------------------------------------------------

test("a file input the page opens during a command is caught and reported, not shown", async () => {
  const b = await attachedBrowser();
  const tab = b.addTab({});
  b.worker.setCurrentTab(b.session, b.copy(tab));
  await settle();

  b.session.openerUntil = Infinity;
  // Chrome reports the intercepted chooser through the debugger's event stream.
  b.fire("debugger.onEvent", { tabId: tab.id }, "Page.fileChooserOpened", {
    backendNodeId: 77,
    mode: "selectSingle",
  });
  const reply = await command(b.port, "listTabs");
  assert.equal(reply.payload.file_chooser.tab_id, tab.id);
  assert.match(reply.payload.file_chooser.note, /browser_upload/);
  assert.equal(b.session.tabs.get(tab.id).fileChooser.backendNodeId, 77);
});

// -- Not starting processes for nothing -----------------------------------------------

test("a relay's report of the same servers opens no port", async () => {
  // Every port is a process. A report that names only servers already held -- or one set aside
  // for refusing -- must cost nothing.
  const b = await attachedBrowser("100");
  const before = b.calls.connects;
  for (let i = 0; i < 20; i += 1) {
    b.port.emit({ type: "bridge_servers", servers: ["100"] });
  }
  await settle();
  assert.equal(b.calls.connects, before);
});

test("a new server is picked up by one probe, however many relays report it", async () => {
  const b = await attachedBrowser("100");
  const before = b.calls.connects;
  for (let i = 0; i < 5; i += 1) {
    b.port.emit({ type: "bridge_servers", servers: ["100", "200"] });
  }
  await settle();
  assert.equal(b.calls.connects - before, 1, "one probe, not one per report");
});

test("a server that refused is not asked again straight away", async () => {
  const b = await attachedBrowser("100");
  b.worker.probeForServers({ force: true });
  const probe = b.ports[b.ports.length - 1];
  probe.emit({
    type: "bridge_offers",
    protocol: PROTOCOL,
    servers: ["100", "300"],
  });
  probe.emit({ type: "bridge_unavailable", error: "Bridge protocol mismatch" });
  probe.drop();
  await settle();
  assert.ok(b.worker.refused().has("300"));

  const before = b.calls.connects;
  for (let i = 0; i < 10; i += 1) {
    b.port.emit({ type: "bridge_servers", servers: ["100", "300"] });
  }
  await settle();
  assert.equal(
    b.calls.connects,
    before,
    "the refusing server is left alone for a while",
  );
});

// -- A tab Chrome is not drawing, kept compositing while it is acted on -------------------------
//
// A background tab composites about once a second, and input acknowledgements, scroll animations
// and hover styles all wait for that tick: a hover measured 1,056 ms, a scroll by ref up to
// 3,092 ms. Input-driven commands run with a one-pixel screencast that keeps the tab compositing
// (51 ms and 76-101 ms), stopped when they finish, and never touching a recording's own cast.

const FRAME_EXPORTS = [
  "withFrames",
  "dispatchCommand",
  "COMMAND_TABLE",
  "captureScreenshotWithFrames",
];
const castCalls = (b) =>
  b.calls.cdp
    .filter(
      (c) =>
        c.method === "Page.startScreencast" ||
        c.method === "Page.stopScreencast",
    )
    .map((c) => c.method.replace("Page.", ""));

test("an action's reply says what it changed; a command that is not an action says nothing", async () => {
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, ...FRAME_EXPORTS, "CHANGE_COMMANDS"],
  });
  const tab = b.addTab({ url: "https://before.test/", title: "Before" });
  b.worker.holdTab(b.session, b.copy(tab), "opened");
  const leads = async () => {
    b.tabs.get(tab.id).url = "https://after.test/";
    b.tabs.get(tab.id).title = "After";
    return { ok: true };
  };
  b.worker.COMMAND_TABLE.set("probeAction", {
    fn: leads,
    tab: true,
    args: true,
  });
  b.worker.CHANGE_COMMANDS.add("probeAction");
  const acted = await b.worker.dispatchCommand(b.session, "probeAction", {
    tab_id: tab.id,
  });
  assert.equal(acted.changes.url, "https://after.test/");
  assert.equal(acted.changes.title, "After");
  b.tabs.get(tab.id).url = "https://before.test/";
  b.worker.COMMAND_TABLE.set("probeRead", { fn: leads, tab: true, args: true });
  const read = await b.worker.dispatchCommand(b.session, "probeRead", {
    tab_id: tab.id,
  });
  assert.equal("changes" in read, false, "a read does not report changes");
  b.worker.COMMAND_TABLE.delete("probeAction");
  b.worker.COMMAND_TABLE.delete("probeRead");
  b.worker.CHANGE_COMMANDS.delete("probeAction");
});

test("an input-driven command runs with the tab compositing, and the cast ends with it", async () => {
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, ...FRAME_EXPORTS],
  });
  const tab = b.addTab({});
  b.worker.holdTab(b.session, b.copy(tab), "opened");
  const seen = [];
  b.worker.COMMAND_TABLE.set("probeFrames", {
    fn: async () => {
      seen.push(castCalls(b).join(","));
      return { ok: true };
    },
    tab: true,
    args: true,
    frames: true,
  });
  await b.worker.dispatchCommand(b.session, "probeFrames", { tab_id: tab.id });
  assert.deepEqual(
    seen,
    ["startScreencast"],
    "the cast was running while the command acted",
  );
  assert.deepEqual(castCalls(b), ["startScreencast", "stopScreencast"]);
  const start = b.calls.cdp.find((c) => c.method === "Page.startScreencast");
  assert.equal(start.tabId, tab.id);
  assert.equal(
    start.params.maxWidth,
    1,
    "the smallest frame: it is not watched, only drawn",
  );
  b.worker.COMMAND_TABLE.delete("probeFrames");
});

test("the commands that send input or wait on the page moving are the ones kept compositing", async () => {
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, ...FRAME_EXPORTS],
  });
  const flagged = [...b.worker.COMMAND_TABLE]
    .filter(([, entry]) => entry.frames)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(flagged, [
    "click",
    "clickAt",
    "clipboard",
    "drag",
    "hover",
    "pressKey",
    "scroll",
    "select",
    "type",
    "upload",
  ]);
});

test("overlapping work on one tab shares one cast, stopped after the last of it", async () => {
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, ...FRAME_EXPORTS],
  });
  const tab = b.addTab({});
  b.worker.holdTab(b.session, b.copy(tab), "opened");
  let releaseFirst;
  const first = b.worker.withFrames(
    tab.id,
    () => new Promise((r) => (releaseFirst = r)),
  );
  await settle();
  const second = b.worker.withFrames(tab.id, async () => "second");
  assert.equal(await second, "second");
  assert.deepEqual(
    castCalls(b),
    ["startScreencast"],
    "still needed by the first",
  );
  releaseFirst("first");
  assert.equal(await first, "first");
  assert.deepEqual(castCalls(b), ["startScreencast", "stopScreencast"]);
});

test("a tab a recording is filming keeps the recording's cast: none started, none stopped", async () => {
  // A screenshot of a background tab used to start a one-pixel cast and stop it, which replaced
  // the recording's frame size and then ended its video.
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, ...FRAME_EXPORTS],
  });
  const tab = b.addTab({ active: false });
  b.worker.holdTab(b.session, b.copy(tab), "opened");
  b.session.recording = {
    id: "r1",
    tabId: tab.id,
    timeline: [],
    startedAt: Date.now(),
  };
  assert.equal(await b.worker.withFrames(tab.id, async () => "ran"), "ran");
  await b.worker.captureScreenshotWithFrames(tab.id, { format: "png" });
  assert.deepEqual(
    castCalls(b),
    [],
    "the recording's screencast is left exactly as it was",
  );
  assert.ok(
    b.calls.cdp.some((c) => c.method === "Page.captureScreenshot"),
    "the screenshot was still taken",
  );
  b.session.recording = null;
});

test("a browser that refuses the cast still runs the command, at the slower pace", async () => {
  const b = await attachedBrowser("100", {
    exported: [...EXPORTED, ...FRAME_EXPORTS],
    cdp: (_tabId, method) => {
      if (method === "Page.startScreencast") {
        throw new Error("Page.startScreencast is not supported");
      }
      return undefined;
    },
  });
  const tab = b.addTab({});
  b.worker.holdTab(b.session, b.copy(tab), "opened");
  assert.equal(await b.worker.withFrames(tab.id, async () => "ran"), "ran");
  assert.deepEqual(
    castCalls(b),
    ["startScreencast"],
    "and stops nothing it never started",
  );
});
