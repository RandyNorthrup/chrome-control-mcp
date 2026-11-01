// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The extension's half of Chrome profiles (docs/plans/chrome-profiles.md): each profile's instance
// says which profile it is -- the user's name for it, else the signed-in account's email, else a
// generated name kept in the profile -- when it attaches and in every listing, records when its
// windows take focus, and answers the server's two questions, profileState and findTab. The
// options page cleans and saves a name the same way the worker reads it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { PROTOCOL, command, fakeBrowser } from "./browser_model.mjs";
import { makeChromeStub, settle } from "./extension_harness.mjs";

// Built from code points: a right-to-left override, a bell, line breaks and a line separator
// around the words, each of which an agent must never be shown.
const RLO = String.fromCodePoint(0x202e);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const MISLEADING_RENAME = `${RLO}work${String.fromCodePoint(7)}\n\n home`;
const MISLEADING_OPTION = `${RLO}  work${String.fromCodePoint(7)}${LINE_SEPARATOR} stuff  `;
// Copied out of the worker's realm, where a strict deep-equal against this one's objects fails.
const plain = (value) => JSON.parse(JSON.stringify(value));
const NAME_KEY = "chrome_control_mcp.profileName";
const GENERATED_KEY = "chrome_control_mcp.profileGenerated";

// chrome.storage.local and .session as Maps, with the change events Chrome fires.
function storageArea(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: (keys) => {
      const wanted =
        keys === null || keys === undefined ? [...map.keys()] : [].concat(keys);
      return Promise.resolve(
        Object.fromEntries(
          wanted.filter((k) => map.has(k)).map((k) => [k, map.get(k)]),
        ),
      );
    },
    set: (items) => {
      for (const [k, v] of Object.entries(items)) {
        map.set(k, v);
      }
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const k of [].concat(keys)) {
        map.delete(k);
      }
      return Promise.resolve();
    },
  };
}

function listener() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    removeListener: () => {},
    fire: (...args) => fns.forEach((fn) => fn(...args)),
  };
}

// A profile whose account is @p email (or signed out), with @p local seeding its storage; reads of
// it wait for @p localReadsAfter when given, as a worker that has just started can.
function profileBrowser({
  email = "",
  local = {},
  localReadsAfter = null,
} = {}) {
  const localArea = storageArea(local);
  const sessionArea = storageArea();
  const storageChanged = listener();
  const focusChanged = listener();
  const b = fakeBrowser({
    exported: ["profileIdentity", "holdTab"],
    live: "sessions",
    overrides: {
      "identity.getProfileUserInfo": () =>
        Promise.resolve({ email, id: email ? "g-1" : "" }),
      "storage.local.get": localReadsAfter
        ? (keys) => localReadsAfter.then(() => localArea.get(keys))
        : localArea.get,
      "storage.local.set": localArea.set,
      "storage.local.remove": localArea.remove,
      "storage.session.get": sessionArea.get,
      "storage.session.set": sessionArea.set,
      "storage.onChanged": storageChanged,
      "windows.onFocusChanged": focusChanged,
      "windows.WINDOW_ID_NONE": -1,
    },
  });
  return { ...b, port: b.ports[0], localArea, storageChanged, focusChanged };
}

async function attached(b) {
  await settle(); // the identity loads as the worker starts
  b.port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
  b.port.emit({ type: "bridge_ready", protocol: PROTOCOL });
  await settle();
  return b.port.posted.find((frame) => frame.type === "attach_session");
}

test("a signed-in profile is called by its account email, and says so when it attaches", async () => {
  const b = profileBrowser({ email: "randy@work.example" });
  const attach = await attached(b);
  assert.equal(attach.profile_name, "randy@work.example");
  assert.equal(attach.profile_email, "randy@work.example");
});

test("the user's name for a profile wins over its email, and a rename lands at once", async () => {
  const b = profileBrowser({
    email: "randy@work.example",
    local: { [NAME_KEY]: "work" },
  });
  const attach = await attached(b);
  assert.equal(attach.profile_name, "work");
  assert.equal(attach.profile_email, "randy@work.example");

  // Renamed on the options page: the next listing says so, with nothing reloaded.
  b.localArea.map.set(NAME_KEY, "office");
  b.storageChanged.fire(
    { [NAME_KEY]: { oldValue: "work", newValue: "office" } },
    "local",
  );
  const listing = await command(b.port, "listTabs");
  assert.equal(listing.payload.profile, "office");
  // And text that would mislead an agent is cleaned away.
  b.storageChanged.fire(
    { [NAME_KEY]: { newValue: MISLEADING_RENAME } },
    "local",
  );
  assert.equal(
    (await command(b.port, "listTabs")).payload.profile,
    "work home",
  );
  // Cleared: back to the email.
  b.storageChanged.fire({ [NAME_KEY]: { oldValue: "office" } }, "local");
  assert.equal(
    (await command(b.port, "listWindows")).payload.profile,
    "randy@work.example",
  );
});

test("a port offered servers before the profile's name is read attaches once it is, named", async () => {
  let release;
  const storageAnswers = new Promise((resolve) => {
    release = resolve;
  });
  const b = profileBrowser({
    email: "randy@work.example",
    local: { [NAME_KEY]: "work" },
    localReadsAfter: storageAnswers,
  });
  // The relay's offer arrives as the worker starts, before storage has answered.
  b.port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
  await settle();
  assert.equal(
    b.port.posted.filter((frame) => frame.type === "attach_session").length,
    0,
  );
  release();
  await settle();
  const attach = b.port.posted.find((frame) => frame.type === "attach_session");
  assert.equal(attach && attach.session, "100");
  assert.equal(attach.profile_name, "work");
  assert.equal(attach.profile_email, "randy@work.example");
});

test("a signed-out, unnamed profile gets a generated name that stays the same", async () => {
  const first = profileBrowser();
  const attach = await attached(first);
  assert.match(attach.profile_name, /^profile-[0-9a-f]{6}$/);
  assert.equal(attach.profile_email, undefined);
  assert.equal(first.localArea.map.get(GENERATED_KEY), attach.profile_name);
  // The next worker -- a restart, an update -- reads the same name back.
  const again = profileBrowser({
    local: Object.fromEntries(first.localArea.map),
  });
  assert.equal((await attached(again)).profile_name, attach.profile_name);
});

test("profileState says the profile, and when one of its windows last took focus", async () => {
  const b = profileBrowser({ email: "me@home.example" });
  await attached(b);
  const before = await command(b.port, "profileState");
  assert.equal(before.payload.profile_name, "me@home.example");
  assert.equal(before.payload.focused_at, 0);
  assert.equal(before.payload.focused, true); // the model's window has focus
  b.focusChanged.fire(-1); // focus left Chrome, or went to another profile: not this one's
  assert.equal((await command(b.port, "profileState")).payload.focused_at, 0);
  const t0 = Date.now();
  b.focusChanged.fire(1);
  assert.ok((await command(b.port, "profileState")).payload.focused_at >= t0);
  b.focus(1, false);
  assert.equal((await command(b.port, "profileState")).payload.focused, false);
});

test("findTab says whether this profile has a tab, and whether the session holds it", async () => {
  const b = profileBrowser();
  await attached(b);
  const session = [...b.worker.sessions][0];
  const mine = b.addTab({});
  const theirs = b.addTab({});
  b.worker.holdTab(session, b.copy(mine), "opened");
  assert.deepEqual(
    plain((await command(b.port, "findTab", { tab_id: mine.id })).payload),
    {
      exists: true,
      held: true,
    },
  );
  assert.deepEqual(
    plain((await command(b.port, "findTab", { tab_id: theirs.id })).payload),
    {
      exists: true,
      held: false,
    },
  );
  assert.deepEqual(
    plain((await command(b.port, "findTab", { tab_id: 999999 })).payload),
    {
      exists: false,
      held: false,
    },
  );
});

test("the options page cleans a name the way the worker reads it, and saves or clears it", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    path.join(here, "..", "browser", "extension", "options.js"),
    "utf8",
  );
  const local = storageArea({ [GENERATED_KEY]: "profile-abc123" });
  const context = vm.createContext({
    chrome: makeChromeStub({
      "storage.local.get": local.get,
      "storage.local.set": local.set,
      "storage.local.remove": local.remove,
      "identity.getProfileUserInfo": () => Promise.resolve({ email: "" }),
    }),
  });
  vm.runInContext(source, context);
  assert.equal(context.cleanName(MISLEADING_OPTION), "work stuff");
  assert.equal(context.cleanName("x".repeat(500)).length, 64);
  assert.equal(await context.saveName("  personal "), "personal");
  assert.equal(local.map.get(NAME_KEY), "personal");
  const state = await context.loadState();
  assert.equal(context.currentName(state), "personal");
  assert.equal(await context.saveName("   "), "");
  assert.equal(local.map.has(NAME_KEY), false);
  assert.equal(
    context.currentName(await context.loadState()),
    "profile-abc123",
  );
});
