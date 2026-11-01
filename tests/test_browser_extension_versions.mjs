// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The extension's half of noticing a version gap (docs/plans/extension-version.md): it says its
// own version when it attaches, and reloads itself -- once, and only while nobody is using it --
// when the relay reports a newer installed copy, so an update that keeps the bridge protocol no
// longer leaves Chrome running the old extension until someone happens to press reload.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PROTOCOL, command, fakeBrowser } from "./browser_model.mjs";
import { settle } from "./extension_harness.mjs";

const EXPORTED = [
  "holdTab",
  "versionReload",
  "reloadForNewerInstall",
  "RELOAD_QUIET_MS",
];
const LIVE = "sessions";
const KEY = "chrome_control_mcp.reloadedForVersion";
const RUNNING = "1.9.0";

// A browser whose extension's manifest says RUNNING, with chrome.storage.local and
// runtime.reload observable. @p stored seeds storage; @p onGet runs inside storage.get, as
// anything else that happens while storage answers would.
function browserAt({ stored = {}, onGet = () => {} } = {}) {
  const storage = new Map(Object.entries(stored));
  const reloads = [];
  const b = fakeBrowser({
    exported: EXPORTED,
    live: LIVE,
    overrides: {
      "runtime.getManifest": () => ({ version: RUNNING }),
      "runtime.reload": () => reloads.push(storage.get(KEY)),
      "storage.local.get": (key) => {
        onGet();
        return Promise.resolve(
          storage.has(key) ? { [key]: storage.get(key) } : {},
        );
      },
      "storage.local.set": (items) => {
        for (const [key, value] of Object.entries(items)) {
          storage.set(key, value);
        }
        return Promise.resolve();
      },
    },
  });
  const port = b.ports[0];
  const ready = async (version) => {
    port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
    port.emit({ type: "bridge_ready", protocol: PROTOCOL, version });
    await settle();
  };
  // The quiet period, as if it had passed: the look runs now rather than RELOAD_QUIET_MS on.
  const quietPassed = () => {
    b.worker.versionReload.lastCommandEndedAt =
      Date.now() - b.worker.RELOAD_QUIET_MS - 1;
  };
  const look = async () => {
    await b.worker.reloadForNewerInstall();
    await settle();
  };
  const stopTimer = () => clearTimeout(b.worker.versionReload.timer);
  return { ...b, port, storage, reloads, ready, quietPassed, look, stopTimer };
}

test("the extension says its own version when it attaches", async () => {
  const b = browserAt();
  b.port.emit({ type: "bridge_offers", protocol: PROTOCOL, servers: ["100"] });
  await settle();
  const attach = b.port.posted.find((frame) => frame.type === "attach_session");
  assert.equal(attach.session, "100");
  assert.equal(attach.version, RUNNING);
});

test("a newer install reloads an idle extension once, a quiet period after it is reported", async () => {
  const b = browserAt();
  await b.ready("1.9.1");
  // Not at once: the look is a quiet period away, so a call waiting on the bridge goes first.
  assert.deepEqual(b.reloads, []);
  assert.notEqual(b.worker.versionReload.timer, null);
  assert.equal(b.worker.versionReload.newer, "1.9.1");
  b.quietPassed();
  await b.look();
  // Once, with the version it reloaded for already remembered across the reload.
  assert.deepEqual(b.reloads, ["1.9.1"]);
  assert.equal(b.storage.get(KEY), "1.9.1");
  b.stopTimer();
});

test("nobody's work is cut off: not while a tab is held, a command runs, or one just ended", async () => {
  const b = browserAt();
  await b.ready("1.9.1");
  const session = [...b.worker.sessions][0];

  // An agent holds a tab.
  const tab = b.addTab({});
  b.worker.holdTab(session, b.copy(tab), "opened");
  b.quietPassed();
  await b.look();
  assert.deepEqual(b.reloads, [], "reloaded under an agent's tab");

  // It lets go of it -- by a command, so the quiet period starts now.
  const released = await command(b.port, "release", { tab_id: tab.id });
  assert.equal(released.type, "result", JSON.stringify(released));
  assert.equal(session.tabs.size, 0);
  await b.look();
  assert.deepEqual(b.reloads, [], "reloaded straight after a command");

  // A command still running.
  b.quietPassed();
  b.worker.versionReload.commandsRunning += 1;
  await b.look();
  assert.deepEqual(b.reloads, [], "reloaded under a running command");
  b.worker.versionReload.commandsRunning -= 1;

  // All of it over: now it reloads.
  await b.look();
  assert.deepEqual(b.reloads, ["1.9.1"]);
  b.stopTimer();
});

test("a command that starts while storage answers stops the reload, and a later look still reloads", async () => {
  let starting = false;
  const b = browserAt({
    onGet: () => {
      if (starting) {
        starting = false;
        b.worker.versionReload.commandsRunning += 1; // a command arrived meanwhile
      }
    },
  });
  await b.ready("1.9.1");
  b.quietPassed();
  starting = true;
  await b.look();
  assert.deepEqual(b.reloads, []);
  // Put back, so this version has not been used up by a reload that never happened.
  assert.equal(b.storage.get(KEY), null);
  b.worker.versionReload.commandsRunning -= 1;
  await b.look();
  assert.deepEqual(b.reloads, ["1.9.1"]);
  b.stopTimer();
});

test("once per version: still older after reloading for it, it does not loop; a newer one reloads again", async () => {
  // It reloaded for 1.9.1 before and came back still 1.9.0: the folder was not updated.
  const b = browserAt({ stored: { [KEY]: "1.9.1" } });
  await b.ready("1.9.1");
  b.quietPassed();
  await b.look();
  await b.look();
  assert.deepEqual(b.reloads, []);
  assert.equal(b.worker.versionReload.newer, null);

  // A later install is worth one more.
  await b.ready("1.9.2");
  b.quietPassed();
  await b.look();
  assert.deepEqual(b.reloads, ["1.9.2"]);
  b.stopTimer();
});

test("an install the same age or older, or one that does not say, never reloads", async () => {
  for (const version of [
    RUNNING,
    "1.8.9",
    "0.9.99",
    undefined,
    "",
    "1.9.1\n",
    "v1.9.1",
    "1.10",
    2,
  ]) {
    const b = browserAt();
    await b.ready(version);
    b.quietPassed();
    await b.look();
    assert.deepEqual(b.reloads, [], `reloaded for ${JSON.stringify(version)}`);
    assert.equal(b.worker.versionReload.newer, null);
    assert.equal(b.worker.versionReload.timer, null);
  }
});
