// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Chrome profiles chosen per call (docs/plans/chrome-profiles.md), in a live browser. Two cases,
// chosen by how isolated_run.mjs starts the browser:
//
//   --headed --second-profile="Profile 2"   two profiles of one Chrome, each with the extension,
//                                           both served by one server: names, the options page,
//                                           new tabs by profile and by last focus, calls that
//                                           follow their tab, merged listings, release, and one
//                                           profile leaving without disturbing the other
//   --extension-version=1.0.0 --extension-strip-permissions=identity,identity.email
//                                           the update that brings profiles: an extension without
//                                           the identity permissions reloads itself into files
//                                           that ask for them, and must come back enabled
//
// Headed needs a display: on Linux, under xvfb-run. Headless Chrome cannot open a second profile.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { devtoolsEndpoint, evaluateIn, targets } from "./devtools.mjs";
import { startFixtureServer } from "./fixture_server.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const WORKER_URL =
  "chrome-extension://iojehhmnaigcejfcpmilpclmeljhlkaa/background.js";
const GENERATED_KEY = "chrome_control_mcp.profileGenerated";

async function until(probe, deadlineMs, stepMs = 250) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() - started >= deadlineMs) {
      return null;
    }
    await sleep(stepMs);
  }
}

async function workers(endpoint) {
  return (await targets(endpoint)).filter(
    (entry) => entry.type === "service_worker" && entry.url === WORKER_URL,
  );
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const executable = path.resolve(
    process.argv[2] ||
      path.join(
        scriptDir,
        "..",
        "..",
        "build",
        process.platform === "win32"
          ? path.join("Release", "chrome_control_mcp.exe")
          : "chrome_control_mcp",
      ),
  );
  assert.ok(existsSync(executable), `MCP executable not found: ${executable}`);
  const checks = [];
  const check = (condition, label, detail = "") => {
    checks.push({ check: label, status: condition ? "passed" : "failed" });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition || !detail ? "" : ` -- ${detail}`}\n`,
    );
  };
  const twoProfiles = Boolean(
    process.env.CHROME_CONTROL_MCP_E2E_SECOND_PROFILE,
  );
  const fixture = await startFixtureServer();
  const server = new McpClient(executable);
  let failure = null;
  let expected = 0;
  try {
    await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "profiles", version: "1" },
    });
    const status = async () =>
      (await server.json("browser_extension_status")).running;
    const endpoint = await devtoolsEndpoint();
    if (twoProfiles) {
      expected = 14;
      await twoProfileCase({ server, status, endpoint, fixture, check });
    } else {
      expected = 4;
      await upgradeCase({ status, endpoint, check });
    }
  } catch (error) {
    failure = error;
  } finally {
    await server.close();
    await fixture.close();
  }
  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === expected,
    case: twoProfiles ? "two-profiles" : "upgrade",
    checks,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

async function twoProfileCase({ server, status, endpoint, fixture, check }) {
  const both = await until(async () => {
    const running = await status();
    return running.profiles.length === 2 ? running : null;
  }, 180000);
  assert.ok(both, "the two profiles did not both connect within 180 s");
  check(true, "one server serves both profiles' extensions at once");

  // Which worker is which profile: each reads back its own generated name.
  const sws = await workers(endpoint);
  assert.equal(sws.length, 2, "expected one extension worker per profile");
  const generatedOf = async (sw) =>
    evaluateIn(
      sw.webSocketDebuggerUrl,
      `chrome.storage.local.get(${JSON.stringify(GENERATED_KEY)}).then((r) => r[${JSON.stringify(GENERATED_KEY)}])`,
    );
  const names = await Promise.all(sws.map(generatedOf));
  const listed = both.profiles.map((p) => p.name).sort();
  check(
    names.every((n) => /^profile-[0-9a-f]{6}$/.test(n)) &&
      names[0] !== names[1] &&
      JSON.stringify([...names].sort()) === JSON.stringify(listed),
    "signed out and unnamed, each profile has its own generated name",
    JSON.stringify({ names, listed }),
  );

  // Rename each through its own options page, as the user would.
  const rename = async (sw, name) => {
    const tabId = await evaluateIn(
      sw.webSocketDebuggerUrl,
      `chrome.tabs.create({ url: chrome.runtime.getURL("options.html"), active: false }).then((t) => t.id)`,
    );
    const page = await until(
      async () =>
        (await targets(endpoint)).find(
          (t) => t.type === "page" && t.url.endsWith("/options.html"),
        ),
      15000,
    );
    assert.ok(page, "the options page did not open");
    // Listed is not loaded: ask until the page has parsed and shown the profile's name, through
    // any navigation that replaces the document being asked.
    const ready = await until(
      async () =>
        (await evaluateIn(
          page.webSocketDebuggerUrl,
          `document.readyState === "complete" && Boolean(document.getElementById("current") && document.getElementById("current").textContent)`,
        ).catch(() => false)) || null,
      10000,
    );
    assert.ok(ready, "the options page did not show the profile's name");
    const shown = await evaluateIn(
      page.webSocketDebuggerUrl,
      `(async () => {
         // The target can be listed before its document has parsed: wait for the element too.
         const current = () => document.getElementById("current");
         for (let i = 0; i < 40 && !(current() && current().textContent); i += 1) {
           await new Promise((r) => setTimeout(r, 100));
         }
         document.getElementById("name").value = ${JSON.stringify(name)};
         document.getElementById("save").click();
         await new Promise((r) => setTimeout(r, 500));
         return document.getElementById("current").textContent;
       })()`,
    );
    await evaluateIn(
      sw.webSocketDebuggerUrl,
      `chrome.tabs.remove(${tabId}).then(() => true)`,
    );
    await until(
      async () =>
        !(await targets(endpoint)).some((t) => t.url.endsWith("/options.html")),
      5000,
    );
    return shown;
  };
  const [work, personal] = sws;
  const shownWork = await rename(work, "work");
  const shownPersonal = await rename(personal, "personal");
  const listing = await server.json("browser_tabs");
  const after = await status();
  check(
    shownWork === "work" &&
      shownPersonal === "personal" &&
      JSON.stringify(listing.profiles) ===
        JSON.stringify(["work", "personal"]) &&
      JSON.stringify(after.profiles.map((p) => p.name)) ===
        JSON.stringify(["work", "personal"]),
    "each profile renamed on its options page is called so at once, with nothing reloaded",
    JSON.stringify({
      shownWork,
      shownPersonal,
      listing: listing.profiles,
      status: after.profiles,
    }),
  );

  const hasTab = async (sw, id) =>
    evaluateIn(
      sw.webSocketDebuggerUrl,
      `chrome.tabs.get(${id}).then(() => true, () => false)`,
    );
  const openIn = async (args) =>
    (await server.json("browser_new_tab", args)).tab_id;

  const p = await openIn({ url: `${fixture.origin}/`, profile: "personal" });
  const w = await openIn({ url: `${fixture.origin}/`, profile: "WORK" });
  check(
    (await hasTab(personal, p)) &&
      !(await hasTab(work, p)) &&
      (await hasTab(work, w)) &&
      !(await hasTab(personal, w)),
    "a new tab opens in the profile named, matched without regard to case",
    JSON.stringify({ p, w }),
  );
  const unknown = await server.tool("browser_new_tab", { profile: "school" });
  check(
    unknown.isError &&
      unknown.text.includes("work") &&
      unknown.text.includes("personal"),
    "a profile that is not connected is refused, naming those that are",
    unknown.text,
  );

  // No profile named: the one whose window the user was last in.
  const focus = async (sw) =>
    evaluateIn(
      sw.webSocketDebuggerUrl,
      `chrome.windows.getAll().then((ws) => chrome.windows.update(ws[0].id, { focused: true })).then(() => true)`,
    );
  await focus(work);
  await sleep(500);
  const inWork = await openIn({});
  await focus(personal);
  await sleep(500);
  const inPersonal = await openIn({});
  check(
    (await hasTab(work, inWork)) && (await hasTab(personal, inPersonal)),
    "with no profile named, a new tab opens in the profile whose window was last focused",
    JSON.stringify({ inWork, inPersonal }),
  );

  // Calls follow their tab, including a tab the server has never seen in a reply.
  const read = async (tab) => server.tool("browser_read", { tab_id: tab });
  const navigated = await server.tool("browser_navigate", {
    tab_id: p,
    url: `${fixture.origin}/page2`,
  });
  const readP = await read(p);
  check(
    !navigated.isError && readP.text.includes("Fixture history marker"),
    "a call naming a tab goes to the profile holding it",
    readP.text.slice(0, 200),
  );
  const unseen = await evaluateIn(
    personal.webSocketDebuggerUrl,
    `chrome.tabs.create({ url: ${JSON.stringify(`${fixture.origin}/page2`)}, active: false }).then((t) => t.id)`,
  );
  await sleep(1000);
  // A tab the user opened in personal, which no reply has named: taking it has to find its profile.
  const taken = await server.tool("browser_select_tab", { tab_id: unseen });
  const readUnseen = await read(unseen);
  check(
    !taken.isError &&
      !readUnseen.isError &&
      readUnseen.text.includes("Fixture history marker"),
    "a tab the server has never seen is found in its profile",
    JSON.stringify({
      taken: taken.text.slice(0, 160),
      read: readUnseen.text.slice(0, 160),
    }),
  );

  const tabs = await server.json("browser_tabs");
  const where = new Map(tabs.your_tabs.map((t) => [t.tab_id, t.profile]));
  check(
    where.get(p) === "personal" && where.get(w) === "work",
    "browser_tabs lists every profile's tabs, each naming its profile",
    JSON.stringify([...where]),
  );
  const windows = await server.json("browser_windows");
  check(
    new Set(windows.windows.map((x) => x.profile)).size === 2,
    "browser_windows lists every profile's windows, each naming its profile",
    JSON.stringify(windows.windows.map((x) => x.profile)),
  );

  const released = await server.json("browser_release", {});
  check(
    released.profiles.length === 2 &&
      !(await hasTab(personal, p)) &&
      !(await hasTab(work, w)),
    "browser_release without a tab lets go in every profile",
    JSON.stringify(released),
  );

  // One profile leaving must not disturb the other: refs in work survive personal going.
  const w2 = await openIn({ url: `${fixture.origin}/`, profile: "work" });
  const snapshot = (await server.tool("browser_snapshot", { tab_id: w2 })).text;
  const ref = refFor(snapshot, "Fixture Page Two");
  await openIn({ url: `${fixture.origin}/`, profile: "personal" });
  await evaluateIn(
    personal.webSocketDebuggerUrl,
    "setTimeout(() => chrome.runtime.reload(), 100); true",
  ).catch(() => {});
  const one = await until(async () => {
    const running = await status();
    return running.profiles.length === 1 ? running : null;
  }, 30000);
  const box = ref
    ? await server.tool("browser_box", { tab_id: w2, ref })
    : { isError: true, text: "no ref" };
  check(
    one && one.profiles[0].name === "work" && !box.isError,
    "a profile leaving takes nothing of the other's: its refs still work",
    JSON.stringify({
      profiles: one && one.profiles,
      ref,
      box: box.text.slice(0, 120),
    }),
  );
  const status2 = await status();
  check(
    status2.profiles.length === 1 &&
      status2.profiles[0].extension_version === status2.server_version,
    "browser_extension_status lists the profiles still connected, with their versions",
    JSON.stringify(status2.profiles),
  );
  await server.json("browser_release", {});
  check(true, "releasing at the end leaves nothing held");
}

async function upgradeCase({ status, endpoint, check }) {
  const attached = await until(async () => {
    const running = await status();
    return running.connected ? running : null;
  }, 180000);
  assert.ok(attached, "the extension did not attach within 180 s");
  const [before] = await workers(endpoint);
  const identityBefore = await evaluateIn(
    before.webSocketDebuggerUrl,
    "typeof chrome.identity",
  );
  check(
    identityBefore === "undefined" &&
      /^profile-[0-9a-f]{6}$/.test(attached.profiles[0].name),
    "without the identity permissions the extension still names its profile",
    JSON.stringify({ identityBefore, profiles: attached.profiles }),
  );
  // A port with no work: the extension's probe for new servers, finding the one server already
  // held, answers its offer with no session. Its relay must connect nowhere -- served, it would be
  // a second connection of this profile, answering for its tabs and then going away mid-call.
  await evaluateIn(
    before.webSocketDebuggerUrl,
    "probeForServers({ force: true }); true",
  );
  let probed = null;
  for (let waited = 0; waited < 5000; waited += 250) {
    probed = await status();
    if (probed.profiles.length !== 1) {
      break;
    }
    await sleep(250);
  }
  check(
    probed.connected &&
      probed.profiles.length === 1 &&
      probed.connections === attached.connections,
    "a port the extension has no server for never becomes a second connection",
    JSON.stringify({
      profiles: probed.profiles,
      connections: [attached.connections, probed.connections],
    }),
  );
  // The installed files gain the permissions, as the update that brings profiles does.
  const folder = process.env.CHROME_CONTROL_MCP_E2E_EXTENSION;
  const manifestPath = path.join(folder, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.permissions = [
    ...new Set([...manifest.permissions, "identity", "identity.email"]),
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // Left alone, it reloads itself into them (the installed copy is newer than its 1.0.0).
  const back = await until(
    async () => {
      const running = await status();
      const [now] = await workers(endpoint);
      // The new connection up, and the old one gone, so the name read below is the new one's.
      return now &&
        now.id !== before.id &&
        running.connected &&
        running.connections > attached.connections &&
        running.profiles.length === 1
        ? now
        : null;
    },
    90000,
    500,
  );
  check(
    back !== null,
    "it reloads itself into files that ask for more permissions and comes back enabled",
    JSON.stringify({ back: Boolean(back) }),
  );
  const identityAfter = back
    ? await evaluateIn(
        back.webSocketDebuggerUrl,
        "typeof chrome.identity.getProfileUserInfo",
      )
    : null;
  const after = await status();
  check(
    identityAfter === "function" &&
      after.profiles.length === 1 &&
      after.profiles[0].name === attached.profiles[0].name,
    "after the update it has the identity permission and keeps its profile's name",
    JSON.stringify({ identityAfter, profiles: after.profiles }),
  );
}

await main();
