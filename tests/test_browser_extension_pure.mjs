// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Unit tests for the pure decision functions inside the browser-control service worker.
//
// WHY THIS EXISTS
// browser/extension/background.js drives a real user's browser over the DevTools protocol,
// parses page-controlled data, and holds every fail-closed guard in the browser surface --
// and until this file existed, NO gate had ever seen it. clang-format, clang-tidy, cppcheck
// and lizard are all wired to C/C++ by construction, and there was no test harness of any
// kind, so ~3300 lines of privileged JavaScript rested entirely on review (R5-G21-9).
//
// The worker is loaded and evaluated AS SHIPPED rather than split into a testable module.
// Extracting the pure functions into their own file would have meant changing the artifact
// that is staged and loaded, and then testing the copy instead of the thing that
// runs. background.js only touches chrome at top level to register listeners and to call
// connect(), so a recording stub satisfies it and every top-level function becomes callable.
// The consequence worth stating: these tests exercise the exact bytes that ship.
//
// Scope is deliberately the PURE functions -- the ones that decide something without asking
// Chrome. Those are where the refusals live (an unnamed pointer button, a non-http URL, a
// navigation that has not actually landed), and a refusal that silently becomes a default is
// the failure mode this repo cares most about.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadWorker as loadWorkerFrom,
  makeFakePort,
  workerSource,
} from "./extension_harness.mjs";

// The names pulled out of the worker's scope. Anything not listed here stays private to the
// worker, which keeps this file from quietly becoming a second copy of its API.
const EXPORTED = [
  "normalizeUrl",
  "tabSettledAt",
  "stripFragment",
  "sameProcessUrls",
  "capFrameUrls",
  "collectFrameUrls",
  "countFrames",
  "parseModifiers",
  "mouseButton",
  "clickCountOf",
  "documentHitPoint",
  "quadPoint",
  "quadCenter",
  "scrollDistance",
  "scrollRoom",
  "handleScroll",
  "pointLandsOnFn",
  "cursorNudgeScript",
  "controlPresenceScript",
  "boundedText",
  "pushBounded",
  "isInlineRequestUrl",
  "selectOptionFn",
  "SETTINGS_BY_PERMISSION",
  "INTERACTABLE_ROLES",
  "consoleArgText",
  "topFrameOf",
  "handleConsole",
  "handleNetwork",
  "handleDrag",
  "scrollContextFn",
  "boundedMs",
  "boundedCount",
  "CLICK_SAMPLES",
  "shotMatchesRender",
  "makeTabState",
  "scrollAmountPx",
  "selectCallArgs",
  "originsMatch",
  "defaultDialogAccept",
  "transientReadError",
  "isEditableRole",
  "axValue",
  "MAX_OMITTED_FRAMES",
  "COMMAND_TABLE",
  "dispatchCommand",
  "axNodeToCapture",
  "indexProps",
  "AX_VALUE_MAX_CHARS",
  "printPageOptions",
  "buildBoundsMap",
  "buildNodes",
  "MAX_CAPTURE_NODES",
  "MAC_EDITING_COMMANDS",
  "macEditingCommands",
  "keyDownEvent",
  "raceDeadline",
  "tabIsOnScreen",
  "captureScreenshotWithFrames",
  "FRAME_FORCING_SCREENCAST",
  "handleUploadChunk",
  "assembleUpload",
  "clearUploads",
  "MAX_UPLOAD_CHUNKS",
  "resolveFileInputFrom",
  "collectFileInputs",
  "MAX_FILE_INPUT_NODES",
  "MAX_UPLOADS_IN_FLIGHT",
  "makeSession",
  "scrollerPathFn",
  "SCROLLER_PATH_SOURCE",
  "scrollMovedFn",
  "scrollEndScript",
  "buildActionableMap",
  "hasPointerHandlerAttr",
  "hasUsableBox",
  "handleCommand",
  "startProgressBeat",
  "stopProgressBeat",
  "PROGRESS_BEAT_MS",
];

function loadWorker(overrides = {}) {
  return loadWorkerFrom(EXPORTED, overrides);
}

const w = loadWorker();

// A tab the session holds with the debugger on it, as the dispatcher leaves it before a handler
// runs: a handler only ever acts on a tab its session holds.
function holdAttached(session, tabId) {
  const tab = w.makeTabState(tabId, "opened");
  tab.attached = true;
  session.tabs.set(tabId, tab);
  return tab;
}

test("storage uses debugger-allowed domains, never blocked DOMStorage", () => {
  assert.doesNotMatch(workerSource, /["']DOMStorage\./);
  assert.match(workerSource, /Page\.createIsolatedWorld/);
});

// Values the worker returns are built with the vm realm's intrinsics, so an array it
// created has a different Array.prototype than one written here. deepStrictEqual compares
// prototypes and rejects them as unequal even when every element matches -- which reads
// like a real failure and invites "fixing" it by weakening the assertion to a loose
// compare. Round-tripping through JSON re-creates the value with this realm's intrinsics,
// so the comparison stays strict and only the realm boundary is removed. Safe here because
// every asserted shape is plain strings, numbers and arrays.
function crossRealm(value) {
  return JSON.parse(JSON.stringify(value));
}

test("normalizeUrl refuses every scheme that is not http(s)", () => {
  // The model must not be able to drive the tab to a script or a local file. These are
  // refusals, not sanitizations: there is no "safe" rewrite of javascript: to fall back to.
  for (const hostile of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/System32/config/SAM",
    "chrome://settings",
    "vbscript:msgbox(1)",
    "  JAVASCRIPT:alert(1)  ",
  ]) {
    assert.equal(w.normalizeUrl(hostile), null, `must refuse ${hostile}`);
  }
});

test("normalizeUrl accepts http(s) and upgrades a bare host", () => {
  assert.equal(
    w.normalizeUrl("https://example.com/a"),
    "https://example.com/a",
  );
  assert.equal(w.normalizeUrl("HTTP://example.com"), "HTTP://example.com");
  assert.equal(w.normalizeUrl("example.com"), "https://example.com");
  assert.equal(w.normalizeUrl("example.com/path"), "https://example.com/path");
  assert.equal(w.normalizeUrl(""), null);
  assert.equal(w.normalizeUrl(null), null);
  assert.equal(w.normalizeUrl("not a url"), null);
});

test("tabSettledAt does not mistake the PREVIOUS document for the new one", () => {
  // The bug this guards: between requesting a navigation and reading the tab, the browser
  // may not have started it, and the old document is "complete" too. Settling on that
  // reports the page the caller navigated AWAY from as the freshly loaded one.
  const prior = "https://old.example/page";
  assert.equal(
    w.tabSettledAt({ status: "complete", url: prior }, prior),
    false,
  );
  assert.equal(
    w.tabSettledAt({ status: "complete", url: "https://new.example/" }, prior),
    true,
  );
  // A pending navigation disqualifies the read regardless of status.
  assert.equal(
    w.tabSettledAt(
      {
        status: "complete",
        url: "https://new.example/",
        pendingUrl: "https://x/",
      },
      prior,
    ),
    false,
  );
  assert.equal(
    w.tabSettledAt({ status: "loading", url: "https://new.example/" }, prior),
    false,
  );
  assert.equal(w.tabSettledAt(null, prior), false);
});

test("tabSettledAt treats an unreadable prior url as unresolved, not as settled", () => {
  // priorUrl null means a tab created for this navigation: no previous document exists to
  // be confused with, so any non-empty url is the navigation having landed.
  assert.equal(
    w.tabSettledAt({ status: "complete", url: "https://new.example/" }, null),
    true,
  );
  assert.equal(w.tabSettledAt({ status: "complete", url: "" }, null), false);
  // A prior url that is neither a string nor null cannot establish "this is no longer it",
  // so the shortcut is withheld rather than guessed at.
  assert.equal(
    w.tabSettledAt(
      { status: "complete", url: "https://new.example/" },
      undefined,
    ),
    false,
  );
  assert.equal(
    w.tabSettledAt({ status: "complete", url: "https://new.example/" }, 42),
    false,
  );
});

test("mouseButton refuses an unrecognized button instead of defaulting to left", () => {
  // A right-click silently downgraded to a left-click opens no context menu and reports
  // success for an action that never happened.
  assert.equal(w.mouseButton(undefined), "left");
  assert.equal(w.mouseButton(""), "left");
  assert.equal(w.mouseButton("RIGHT"), "right");
  assert.equal(w.mouseButton("middle"), "middle");
  assert.throws(() => w.mouseButton("side"), /Unknown button/);
  assert.throws(() => w.mouseButton("leftt"), /Unknown button/);
});

test("clickCountOf refuses a count that is not a real click gesture", () => {
  assert.equal(w.clickCountOf(undefined), 1);
  assert.equal(w.clickCountOf(2), 2);
  assert.equal(w.clickCountOf("3"), 3);
  assert.throws(() => w.clickCountOf(4), /click_count/);
  assert.throws(() => w.clickCountOf(0), /click_count/);
  assert.throws(() => w.clickCountOf("many"), /click_count/);
});

test("documentHitPoint converts visual-viewport coordinates through pinch and scroll", () => {
  const at = (scrollX, scrollY, offsetX = 0, offsetY = 0) => ({
    ok: true,
    scrollX,
    scrollY,
    offsetX,
    offsetY,
  });
  assert.deepEqual(crossRealm(w.documentHitPoint(1075, 380, at(9, 142))), {
    x: 1084,
    y: 522,
  });
  assert.deepEqual(crossRealm(w.documentHitPoint(10.6, 20.4, at(0, 0))), {
    x: 11,
    y: 20,
  });
  // Measured in Chrome 153 at a 1.5x pinch: the box-model quad centre of a target at client
  // (466, 284) was (332.8, 200.8), the visual viewport sitting at (133.18, 83.18) in the layout
  // viewport -- and DOM.getNodeForLocation named the target only at the client point.
  assert.deepEqual(
    crossRealm(w.documentHitPoint(332.8, 200.8, at(0, 0, 133.18, 83.18))),
    { x: 466, y: 284 },
  );
  assert.deepEqual(
    crossRealm(w.documentHitPoint(332.8, 200.8, at(10, 200, 133.18, 83.18))),
    { x: 476, y: 484 },
  );
  assert.equal(w.documentHitPoint(1, 2, { ...at(0, 0), ok: false }), null);
  assert.equal(w.documentHitPoint(NaN, 2, at(0, 0)), null);
  // A pinch offset the page did not report is not zero.
  assert.equal(
    w.documentHitPoint(1, 2, { ok: true, scrollX: 0, scrollY: 0 }),
    null,
  );
});

test("quadPoint samples inside axis-aligned and rotated boxes", () => {
  const box = [10, 20, 50, 20, 50, 60, 10, 60];
  assert.deepEqual(crossRealm(w.quadCenter(box)), { x: 30, y: 40 });
  assert.deepEqual(
    crossRealm(w.quadPoint(box, 0.5, 0.5)),
    crossRealm(w.quadCenter(box)),
  );
  assert.deepEqual(crossRealm(w.quadPoint(box, 0.25, 0.75)), { x: 20, y: 50 });
  // A square turned 45 degrees: corners clockwise from the one that was top-left.
  const diamond = [30, 0, 60, 30, 30, 60, 0, 30];
  assert.deepEqual(crossRealm(w.quadPoint(diamond, 0.5, 0.5)), {
    x: 30,
    y: 30,
  });
  assert.deepEqual(crossRealm(w.quadPoint(diamond, 1, 0)), { x: 60, y: 30 });
  assert.deepEqual(crossRealm(w.quadPoint(diamond, 0, 1)), { x: 0, y: 30 });
});

test("CLICK_SAMPLES tries the centre first and stays inside the box", () => {
  assert.deepEqual(crossRealm(w.CLICK_SAMPLES[0]), [0.5, 0.5]);
  const keys = new Set(w.CLICK_SAMPLES.map(([u, v]) => `${u},${v}`));
  assert.equal(keys.size, w.CLICK_SAMPLES.length);
  for (const [u, v] of w.CLICK_SAMPLES) {
    assert.ok(u > 0 && u < 1 && v > 0 && v < 1, `${u},${v} is on the edge`);
  }
});

test("shotMatchesRender sees a pinch, not only a scroll or zoom", () => {
  const shot = {
    dpr: 2,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    scrollX: 0,
    scrollY: 10,
    href: "https://example.test/",
    width: 800,
    height: 600,
    epoch: 0,
  };
  const now = { ...shot, ok: true };
  // A screenshot's coordinates are meaningful only against the DOM generation
  // it was captured at, so the check is against the tab it was taken of.
  const tab = w.makeTabState(1, "opened");
  assert.equal(w.shotMatchesRender(tab, shot, now), true);
  assert.equal(w.shotMatchesRender(tab, shot, { ...now, scale: 1.5 }), false);
  assert.equal(w.shotMatchesRender(tab, shot, { ...now, offsetX: 133 }), false);
  assert.equal(w.shotMatchesRender(tab, shot, { ...now, offsetY: 76 }), false);
  assert.equal(w.shotMatchesRender(tab, shot, { ...now, dpr: 2.2 }), false);
  assert.equal(w.shotMatchesRender(tab, shot, { ...now, ok: false }), false);
  // A navigation since the capture retires it, whatever the geometry says.
  tab.domEpoch += 1;
  assert.equal(w.shotMatchesRender(tab, shot, now), false);
});

// A DOM just real enough for the naming walk: tag, id, parent, and the sibling links it counts
// through. Nothing here is a scroller or has a size -- the question is only what an element is
// CALLED, which is the whole of the bug below.
function fakeTree(spec, parent = null) {
  const node = {
    tagName: spec.tag,
    id: spec.id || "",
    parentElement: parent,
    children: [],
    getRootNode() {
      return { host: null };
    },
  };
  node.children = (spec.kids || []).map((kid) => fakeTree(kid, node));
  node.firstElementChild = node.children[0] || null;
  for (let i = 0; i < node.children.length; i++) {
    node.children[i].nextElementSibling = node.children[i + 1] || null;
  }
  return node;
}
const findByTag = (root, tag) => {
  if (root.tagName === tag) {
    return root;
  }
  for (const kid of root.children) {
    const hit = findByTag(kid, tag);
    if (hit) {
      return hit;
    }
  }
  return null;
};

// Found on a real page: browser_scroll aimed at a ref inside a nested scroll container reported
// "scrolled 0" while the element visibly moved.
//
// The scrollers were named by counting ancestors up from whatever the point landed on
// ("scroller-2:DIV"). That count belongs to the CONTENT under the point, not to the scroller:
// scroll the content and the point lands on a different element inside the same container, so the
// same container comes back under a different name. scrollDistance matches by name, found no
// entry from before, and reported 0 for a scroll it had just performed.
test("a scroller is named by where it sits, not by what is under the point", () => {
  const page = fakeTree({
    tag: "HTML",
    kids: [
      {
        tag: "BODY",
        kids: [
          {
            tag: "DIV",
            id: "list",
            kids: [{ tag: "P", kids: [{ tag: "SPAN" }] }, { tag: "ARTICLE" }],
          },
        ],
      },
    ],
  });
  const scroller = findByTag(page, "DIV");
  // The point started on the SPAN two levels inside the scroller and, after the wheel, landed
  // straight on the scroller itself. The old name moved with it; the path does not.
  const name = w.scrollerPathFn(scroller);
  assert.equal(
    name,
    w.scrollerPathFn(scroller),
    "the same element, the same name",
  );
  assert.match(name, /DIV#list/);
  // Two different scrollers must not collide, or one's offset counts as the other's distance.
  assert.notEqual(
    w.scrollerPathFn(findByTag(page, "ARTICLE")),
    w.scrollerPathFn(findByTag(page, "P")),
  );
  // And the name is what scrollDistance matches on: same name, real movement reported.
  assert.deepEqual(
    crossRealm(
      w.scrollDistance(
        [
          ["visual-viewport", 0, 0],
          [name, 0, 0],
        ],
        [
          ["visual-viewport", 0, 0],
          [name, 0, 260],
        ],
      ),
    ),
    { x: 0, y: 260 },
  );
});

test("the naming walk crosses a shadow boundary and terminates", () => {
  const host = fakeTree({ tag: "BODY", kids: [{ tag: "MY-WIDGET" }] });
  const widget = findByTag(host, "MY-WIDGET");
  // An element inside the widget's shadow root: no parentElement, reached through .host.
  const inner = {
    tagName: "DIV",
    id: "",
    parentElement: null,
    children: [],
    getRootNode: () => ({ host: widget }),
  };
  const name = w.scrollerPathFn(inner);
  assert.match(name, /shadow/, "the boundary is part of the identity");
  assert.match(name, /MY-WIDGET/, "and so is the host it sits in");
  // A getRootNode that answers with itself would spin forever without the guard.
  const loop = { tagName: "DIV", id: "", parentElement: null, children: [] };
  loop.getRootNode = () => ({ host: loop });
  assert.equal(typeof w.scrollerPathFn(loop), "string");
});

// Found on a real page: an element a page wires up itself -- a div with a click handler, a card
// with cursor:pointer -- reaches the accessibility tree as "generic" with no name, which the
// capture dropped. The model was shown scenery where the page had a button, and the only way to
// reach it was a pixel read off a screenshot.
//
// The signals here were measured against a real Chrome before being relied on, and the fixture
// below is that measurement written down: isClickable covers an inline onclick AND an
// addEventListener wiring, and covers neither a hover-only handler nor a styled card.
test("the elements a page wires to the pointer earn a ref", () => {
  const strings = [
    "id",
    "onclick",
    "onmouseenter",
    "cursor",
    "pointer",
    "auto",
    "card",
  ];
  const snapshot = {
    strings,
    documents: [
      {
        nodes: {
          // 0 body, 1 click-wired div, 2 hover-only div, 3 pointer card, 4 its child, 5 plain
          parentIndex: [-1, 0, 0, 0, 3, 0],
          backendNodeId: [10, 11, 12, 13, 14, 15],
          attributes: [[], [1, 5], [2, 5], [], [], []],
          isClickable: { index: [1] },
        },
        layout: {
          nodeIndex: [0, 1, 2, 3, 4, 5],
          styles: [[5], [5], [5], [4], [4], [5]],
        },
      },
    ],
  };
  const wired = crossRealm(
    Object.fromEntries(w.buildActionableMap(snapshot).entries()),
  );
  assert.equal(wired["11"], "click", "Chrome's own isClickable is the signal");
  assert.equal(wired["12"], "hover", "a hover handler is nothing else's job");
  assert.equal(wired["13"], "pointer", "the card is what a click belongs on");
  // cursor is INHERITED: the child of a pointer card computes "pointer" too, and promoting on
  // the computed value alone would turn one clickable card into a ref for every part of it.
  assert.equal(wired["14"], undefined, "not the child inside the card");
  assert.equal(wired["15"], undefined, "and not plain scenery");
});

test("a wired element still needs a box worth aiming at", () => {
  const bounds = new Map([
    [11, { x: 0, y: 0, width: 80, height: 24 }],
    [12, { x: 0, y: 0, width: 0, height: 0 }],
  ]);
  assert.equal(w.hasUsableBox(bounds, 11), true);
  assert.equal(w.hasUsableBox(bounds, 12), false, "laid out to nothing");
  assert.equal(w.hasUsableBox(bounds, 99), false, "no layout at all");
  assert.equal(w.hasUsableBox(bounds, null), false, "no backend id");

  const node = (backend) => ({
    role: { value: "generic" },
    name: { value: "" },
    properties: [],
    backendDOMNodeId: backend,
  });
  const wired = new Map([
    [11, "click"],
    [12, "click"],
  ]);
  const shown = crossRealm(w.axNodeToCapture(node(11), 0, bounds, wired));
  assert.equal(shown.interactable, true);
  assert.equal(shown.wired, "click", "the renderer says why it carries a ref");
  // Sized to nothing: no tool could aim at it, so it stays dropped as it was before.
  assert.equal(w.axNodeToCapture(node(12), 0, bounds, wired), null);
  // And a role that was never wired is untouched by any of this.
  assert.equal(w.axNodeToCapture(node(99), 0, bounds, wired), null);
});

test("a role that already earns a ref is not re-labelled as wired", () => {
  const bounds = new Map([[21, { x: 0, y: 0, width: 60, height: 20 }]]);
  const button = {
    role: { value: "button" },
    name: { value: "Save" },
    properties: [],
    backendDOMNodeId: 21,
  };
  const rec = crossRealm(
    w.axNodeToCapture(button, 0, bounds, new Map([[21, "click"]])),
  );
  assert.equal(rec.interactable, true);
  assert.equal(rec.wired, undefined, "a button is a button, not a wired div");
});

test("only real handler attributes count as wiring", () => {
  const strings = [
    "onmouseenter",
    "x",
    "onload",
    "data-onclick",
    "ONMOUSEDOWN",
  ];
  assert.equal(w.hasPointerHandlerAttr([0, 1], strings), true);
  assert.equal(
    w.hasPointerHandlerAttr([4, 1], strings),
    true,
    "case-insensitive",
  );
  assert.equal(
    w.hasPointerHandlerAttr([2, 1], strings),
    false,
    "onload is not a pointer",
  );
  assert.equal(
    w.hasPointerHandlerAttr([3, 1], strings),
    false,
    "nor an attribute merely named so",
  );
  assert.equal(w.hasPointerHandlerAttr(undefined, strings), false);
});

// The host's reply budget was being spent as a work budget: 30 s of silence on the pipe tore the
// connection down, while handlers are allowed far longer by design (browser_download polls to
// 120 s). A slow page or a loaded machine therefore surfaced as "browser did not reply within
// 30000 ms (connection reset)" -- a transport failure reported for work that was going fine.
//
// The beat is what tells silence and slowness apart. Its two rules are that it only speaks to a
// host that asked (an older server would read an unknown frame type as the reply to the command
// it is waiting for) and that it NEVER speaks after the reply (the host has moved on, and a late
// beat would answer whatever command comes next).
test("a command that is still working beats, only when the host asked", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  // Loaded after the timers are mocked: the harness hands the worker the globals it has then.
  const worker = loadWorker();
  const session = worker.makeSession();
  session.port = makeFakePort();

  const beat = worker.startProgressBeat(session, {
    progress: true,
    id: "b-7",
    cmd: "download",
  });
  assert.notEqual(beat, null);
  t.mock.timers.tick(worker.PROGRESS_BEAT_MS * 3 + 1);
  const beats = session.port.posted.filter((f) => f.type === "progress");
  assert.equal(beats.length, 3);
  // Addressed like every other frame: the host correlates it to the command it is waiting on.
  assert.equal(beats[0].id, "b-7");
  assert.equal(beats[0].cmd, "download");
  assert.equal(typeof beats[0].elapsed_ms, "number");

  worker.stopProgressBeat(beat);
  t.mock.timers.tick(worker.PROGRESS_BEAT_MS * 5);
  assert.equal(
    session.port.posted.filter((f) => f.type === "progress").length,
    3,
    "not one beat after the command stopped",
  );

  // A host that did not ask is one that would not understand the answer.
  const quiet = worker.makeSession();
  quiet.port = makeFakePort();
  assert.equal(
    worker.startProgressBeat(quiet, { id: "b-8", cmd: "read" }),
    null,
  );
  t.mock.timers.tick(worker.PROGRESS_BEAT_MS * 4);
  assert.deepEqual(quiet.port.posted, []);
  // And stopping a beat that was never started is not a crash.
  worker.stopProgressBeat(null);
});

test("a command that fails still leaves no beat running behind it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const worker = loadWorker();
  const session = worker.makeSession();
  session.port = makeFakePort();

  // An unknown command fails inside runCommand. The reply is built in a catch and sent after the
  // beat has been stopped -- sending it inside the try would leave a window in which the interval
  // can still fire, which is the one thing this must never do.
  await worker.handleCommand(session, {
    type: "command",
    id: "b-9",
    cmd: "no-such-command",
    progress: true,
  });
  assert.equal(session.port.posted.length, 1);
  assert.equal(session.port.lastPosted().type, "error");
  assert.equal(session.port.lastPosted().id, "b-9");
  t.mock.timers.tick(worker.PROGRESS_BEAT_MS * 6);
  assert.equal(
    session.port.posted.length,
    1,
    "the failure path clears the interval too",
  );
});

// From a CI failure at 200% zoom under a pinch: browser_scroll answered "settled, scrolled 0" and
// the page then moved 100px more, so the next step read a stale position and the scroll after it
// over-reported by exactly that 100.
//
// One mismatch produced both halves. The in-page rest detector resolved when the serialized offsets
// DIFFERED from the ones read before the wheel -- and the chain under the point changes composition
// as content moves, so a scroller entering or leaving it makes a different string without anything
// having moved. scrollDistance, which matches only the names present in both reads, correctly
// reported 0. So the wheel was declared at rest before it had moved anything.
test("rest means a scroller moved, not that the list looks different", () => {
  const before = [
    ["visual-viewport", 0, 0],
    ["BODY/DIV[0]#list", 0, 100],
    ["page", 0, 613],
  ];

  // Nothing moved: not rest, whatever else changed about the list.
  assert.equal(w.scrollMovedFn(before, before), false);

  // A scroller that was not under the point before is now, and one that was has gone. No offset
  // that both reads can see has changed -- which is precisely the case that used to read as rest.
  const shuffled = [
    ["visual-viewport", 0, 0],
    ["BODY/DIV[1]#other", 0, 4000],
    ["page", 0, 613],
  ];
  assert.equal(
    w.scrollMovedFn(before, shuffled),
    false,
    "a different chain is not a moved page",
  );
  // And scrollDistance agrees, which is the point: one rule, two callers.
  assert.deepEqual(crossRealm(w.scrollDistance(before, shuffled)), {
    x: 0,
    y: 0,
  });

  // Real movement, of any scroller in the chain, is rest.
  assert.equal(
    w.scrollMovedFn(before, [
      ["visual-viewport", 0, 0],
      ["BODY/DIV[0]#list", 0, 340],
      ["page", 0, 613],
    ]),
    true,
    "the inner scroller moved",
  );
  assert.equal(
    w.scrollMovedFn(before, [
      ["visual-viewport", 0, 0],
      ["BODY/DIV[0]#list", 0, 100],
      ["page", 0, 0],
    ]),
    true,
    "the page moved",
  );
  // The pinched viewport panning counts too: it is what the wheel spent.
  assert.equal(
    w.scrollMovedFn(before, [
      ["visual-viewport", 0, 100],
      ["BODY/DIV[0]#list", 0, 100],
      ["page", 0, 613],
    ]),
    true,
    "the visual viewport panned",
  );
});

// The watcher is a string built for the page, so what matters is that the page can run it and that
// it carries everything it calls. A missing prelude is a ReferenceError inside a listener, where
// nothing would report it -- the scroll would simply never settle.
test("the rest detector carries every function it calls", () => {
  const script = w.scrollEndScript(10, 20, [["page", 0, 0]]);
  for (const needed of ["scrollerPathFn", "scrollMovedFn"]) {
    assert.ok(
      script.includes("var " + needed + "="),
      needed + " must travel with the script",
    );
  }
  // Runnable in a realm that has none of the worker's scope: the page is exactly that.
  const run = new Function(
    "window",
    "document",
    "getComputedStyle",
    "addEventListener",
    "removeEventListener",
    "setTimeout",
    "return " + script,
  );
  const ends = [];
  const promise = run(
    { visualViewport: { offsetLeft: 0, offsetTop: 0 } },
    { elementFromPoint: () => null, scrollingElement: null },
    () => ({ overflowX: "visible", overflowY: "visible" }),
    (_type, fn) => ends.push(fn),
    () => {},
    (fn) => {
      // The page's own give-up timer. Called at once here so the promise settles.
      fn();
    },
  );
  assert.ok(promise instanceof Promise);
  assert.equal(ends.length, 1, "it listens for exactly one scrollend");
});

test("scrollDistance matches scrollers by name, and counts each once", () => {
  const before = [
    ["visual-viewport", 0, 0],
    ["scroller-2:DIV#list", 0, 100],
    ["page", 0, 500],
  ];
  // The page scroller moved 200; the inner one did not.
  assert.deepEqual(
    crossRealm(
      w.scrollDistance(before, [
        ["visual-viewport", 0, 0],
        ["scroller-2:DIV#list", 0, 100],
        ["page", 0, 700],
      ]),
    ),
    { x: 0, y: 200 },
  );
  // The chain under the point changed: the inner scroller is gone and another is in its place.
  // Only what can be matched counts; a stranger's offset is not somebody else's distance.
  assert.deepEqual(
    crossRealm(
      w.scrollDistance(before, [
        ["visual-viewport", 0, 0],
        ["scroller-2:DIV#other", 0, 4000],
        ["page", 0, 700],
      ]),
    ),
    { x: 0, y: 200 },
  );
  // A page whose root is its own scroller appears in the chain AND as the page scroller; counting
  // it twice would report double the distance the content actually moved.
  assert.deepEqual(
    crossRealm(
      w.scrollDistance(
        [
          ["visual-viewport", 0, 0],
          ["page", 0, 0],
        ],
        [
          ["visual-viewport", 0, 0],
          ["page", 0, 300],
        ],
      ),
    ),
    { x: 0, y: 300 },
  );
});

// The reply's own diagnosis. A scroll that moved nothing is either an edge already reached or a
// wheel that never landed on the scroller, and before `room` the reply said "scrolled 0" for both.
test("scrollRoom counts the travel left the way the wheel is pushing", () => {
  // [name, scrollTop, maximum scrollTop]
  const context = {
    hit: "DIV#region",
    scrollers: [
      ["scroller-0:DIV#region", 40, 600],
      ["page", 200, 1000],
    ],
  };
  // Downwards (positive delta) what is left is max - top, summed over the chain.
  assert.equal(w.scrollRoom(context, 180), 560 + 800);
  // Upwards it is what has already been scrolled past.
  assert.equal(w.scrollRoom(context, -180), 40 + 200);
  // At the bottom of everything, a downward wheel has nowhere to go -- and THAT is what makes
  // "scrolled 0" an answer rather than a fault.
  assert.equal(
    w.scrollRoom(
      { hit: null, scrollers: [["scroller-0:DIV#region", 600, 600]] },
      180,
    ),
    0,
  );
  // An overscrolled offset (a rubber-band, a stale read) must not report negative room and
  // cancel out another scroller's real travel.
  assert.equal(
    w.scrollRoom(
      {
        hit: null,
        scrollers: [
          ["scroller-0:DIV#over", 700, 600],
          ["page", 0, 300],
        ],
      },
      180,
    ),
    300,
  );
  // Nothing scrollable under the point at all.
  assert.equal(w.scrollRoom({ hit: "BODY", scrollers: [] }, 180), 0);
});

// scrollContextFn is serialized into the page, so it is tested against a DOM shaped like the one
// it meets there rather than against the worker's globals.
test("scrollContextFn names what the wheel lands on and the chain under it", () => {
  const make = (tag, id, overflow, scrollTop, scrollHeight, clientHeight) => ({
    tagName: tag,
    id,
    overflow,
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    parentElement: null,
    getRootNode: () => null,
  });
  const region = make("DIV", "region", "auto", 40, 756, 142);
  const outer = make("DIV", "", "visible", 0, 100, 100);
  const body = make("BODY", "", "visible", 0, 100, 100);
  const page = make("HTML", "", "visible", 200, 2000, 800);
  region.parentElement = outer;
  outer.parentElement = body;
  body.parentElement = null;

  const sandbox = {
    window: { visualViewport: { offsetLeft: 0, offsetTop: 0 } },
    document: {
      elementFromPoint: () => region,
      scrollingElement: page,
    },
    getComputedStyle: (e) => ({ overflowX: e.overflow, overflowY: e.overflow }),
  };
  // Built exactly as the worker builds it for the page: the naming walk is a separate function,
  // and an injected function cannot call one that stayed behind in the worker. Using the SAME
  // constant the product uses is the point -- a prelude that stops being sent would fail here
  // with the ReferenceError the page would throw, rather than passing on a copy.
  const run = new Function(
    "window",
    "document",
    "getComputedStyle",
    `${w.SCROLLER_PATH_SOURCE}` +
      `return (${w.scrollContextFn.toString()})(10, 20);`,
  );
  const context = crossRealm(
    run(sandbox.window, sandbox.document, sandbox.getComputedStyle),
  );
  assert.equal(context.hit, "DIV#region");
  // The scrollable region under the point, and the page scroller, each once; the non-scrolling
  // ancestors in between are not scrollers and must not appear. The region is named by where it
  // sits in the document -- not by how far it was from the point, which is what used to rename it
  // mid-scroll and cost the reply its distance.
  assert.deepEqual(context.scrollers, [
    ["BODY/DIV[0]/DIV#region", 40, 756 - 142],
    ["page", 200, 2000 - 800],
  ]);
  // The wheel moved the content, so the point now lands on the region itself rather than on
  // something inside it. The chain is shorter by one -- and the region must still come back under
  // the name it had, or scrollDistance matches nothing and reports a scroll that happened as 0.
  const inner = make("SPAN", "", "visible", 0, 10, 10);
  inner.parentElement = region;
  const deeper = crossRealm(
    run(
      sandbox.window,
      { elementFromPoint: () => inner, scrollingElement: page },
      sandbox.getComputedStyle,
    ),
  );
  assert.equal(
    deeper.scrollers[0][0],
    context.scrollers[0][0],
    "the same container, whatever the point landed on",
  );
  // A point over nothing at all still reports the page, and says it hit nothing.
  const empty = crossRealm(
    run(
      sandbox.window,
      { elementFromPoint: () => null, scrollingElement: page },
      sandbox.getComputedStyle,
    ),
  );
  assert.equal(empty.hit, null);
  assert.deepEqual(empty.scrollers, [["page", 200, 1200]]);
});

// A scroll aimed at a named element must land ON that element. Bringing it into view moves the
// page, and until this guard existed the box could be read while the page was still settling: the
// point stayed put in the viewport, the element slid out from under it, and the wheel scrolled
// whatever had moved into that spot while the reply named the element the caller asked for. On the
// macOS runner that was DIV#shadow-host, a different section of the page.
function scrollWorker(
  hitAnswers,
  scrollers = [["BODY/DIV[0]#scroll-region", 0, 600]],
) {
  const calls = [];
  const hits = hitAnswers.slice();
  const sendCommand = (_target, method, params) => {
    calls.push({ method, params });
    if (method === "DOM.getBoxModel") {
      return Promise.resolve({
        model: { content: [10, 20, 40, 20, 40, 60, 10, 60] },
      });
    }
    if (method === "DOM.resolveNode") {
      return Promise.resolve({ object: { objectId: "target-1" } });
    }
    if (method === "Runtime.callFunctionOn") {
      const answer = hits.shift();
      return Promise.resolve({ result: { value: answer } });
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression || "");
      // viewportState, which decides whether the element's centre is on screen. Tested before
      // the settle read because its expression mentions window.scrollX too.
      if (expression.includes("dpr:")) {
        return Promise.resolve({
          result: {
            value: {
              dpr: 1,
              sx: 0,
              sy: 0,
              href: "https://example.test/",
              iw: 1280,
              ih: 800,
              vs: 1,
              vl: 0,
              vt: 0,
            },
          },
        });
      }
      // settleScroll's offsets: the same answer twice means the page has stopped.
      if (expression.includes("window.scrollX")) {
        return Promise.resolve({ result: { value: [0, 0, 0, 0] } });
      }
      // armScrollEnd and every page-timed wait. Answering null is "no scrollend arrived",
      // which is what a scroll that moves nothing produces. Matched before the offset reads
      // because the scrollend script carries scrollOffsetsFn's source inside it.
      if (expression.includes("new Promise")) {
        return Promise.resolve({ result: { value: null } });
      }
      // scrollContextFn: what the wheel lands on, and the travel left under it.
      if (expression.includes("scrollers")) {
        return Promise.resolve({
          result: {
            value: { hit: "DIV#scroll-region", scrollers },
          },
        });
      }
      // scrollOffsetsFn: the offsets before and after the wheel.
      if (expression.includes("visual-viewport")) {
        return Promise.resolve({
          result: {
            value: [
              ["visual-viewport", 0, 0],
              ["page", 0, 0],
            ],
          },
        });
      }
      // The scrollend race, and the page-timed waits, resolve immediately as "nothing moved".
      return Promise.resolve({ result: { value: null } });
    }
    return Promise.resolve({});
  };
  const worker = loadWorker({
    "debugger.sendCommand": sendCommand,
    "tabs.get": () => Promise.resolve({ id: 1, url: "https://example.test/" }),
  });
  return { worker, calls };
}

// Reported twice by CI, on two platforms and two configurations: browser_scroll answered
// `scrolled 0, settled true` and the page then moved. At 25% zoom a request of 200 is 800 CSS px
// of travel and the scroll is animated, so nothing had happened yet when the reply was built. The
// reply called that rest -- on the reasoning that a wheel which moved nothing has nothing to come
// to rest, which is true at an edge and wrong when the wheel simply has not been acted on. The
// next call then read a position the page had already left.
//
// `room` is what tells the two apart, and it was already in the reply.
test("nothing moved with room left is waited out, not called rest", async () => {
  // Offsets never change and no scrollend arrives: the shape of a wheel whose scroll has not
  // begun. Room remains, so this is not an edge.
  const pending = scrollWorker(
    [{ hit: "DIV#scroll-region", target: "DIV#scroll-region", onTarget: true }],
    [["BODY/DIV[0]#scroll-region", 0, 600]],
  );
  const session = pending.worker.makeSession();
  holdAttached(session, 1);
  session.tabs.get(1).lastSnapshotEpoch = session.tabs.get(1).domEpoch;
  const reply = crossRealm(
    await pending.worker.handleScroll(session, 1, {
      backendNodeId: 7,
      direction: "down",
      amount: 180,
    }),
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.room, 600, "the chain still had somewhere to go");
  assert.deepEqual(reply.scrolled, { x: 0, y: 0 });
  // It waited for the page before answering: the reads that did that are the evidence, because a
  // reply built straight from the first read is exactly what shipped.
  const offsetReads = pending.calls.filter(
    (call) =>
      call.method === "Runtime.evaluate" &&
      String(call.params.expression).includes("visual-viewport") &&
      !String(call.params.expression).includes("new Promise"),
  ).length;
  assert.ok(
    offsetReads > 2,
    `the reply was built without waiting for the page (${offsetReads} offset reads)`,
  );
});

test("nothing moved with nowhere to go is answered at once", async () => {
  // At the bottom: top === max, so a downward wheel has no room. Nothing moving IS the answer
  // here, and waiting for it would only make every edge scroll slower.
  const atEdge = scrollWorker(
    [{ hit: "DIV#scroll-region", target: "DIV#scroll-region", onTarget: true }],
    [["BODY/DIV[0]#scroll-region", 600, 600]],
  );
  const session = atEdge.worker.makeSession();
  holdAttached(session, 1);
  session.tabs.get(1).lastSnapshotEpoch = session.tabs.get(1).domEpoch;
  const reply = crossRealm(
    await atEdge.worker.handleScroll(session, 1, {
      backendNodeId: 7,
      direction: "down",
      amount: 180,
    }),
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.room, 0, "an edge already reached");
  assert.equal(reply.settled, true);
  assert.deepEqual(reply.scrolled, { x: 0, y: 0 });
  const offsetReads = atEdge.calls.filter(
    (call) =>
      call.method === "Runtime.evaluate" &&
      String(call.params.expression).includes("visual-viewport") &&
      !String(call.params.expression).includes("new Promise"),
  ).length;
  assert.ok(
    offsetReads <= 2,
    `an edge should not be waited out (${offsetReads} offset reads)`,
  );
});

test("a scroll whose point misses its element is refused, not aimed at a stranger", async () => {
  // Off target both times: the page is moving under the point, and no wheel should be sent.
  const missed = scrollWorker([
    { hit: "DIV#shadow-host", target: "DIV#scroll-region", onTarget: false },
    { hit: "DIV#shadow-host", target: "DIV#scroll-region", onTarget: false },
  ]);
  const session = missed.worker.makeSession();
  holdAttached(session, 1);
  // requireSnapshotTab: the ref must come from a snapshot of THIS tab, at the DOM the page is
  // still on.
  session.tabs.get(1).lastSnapshotEpoch = session.tabs.get(1).domEpoch;
  await assert.rejects(
    () =>
      missed.worker.handleScroll(session, 1, {
        backendNodeId: 7,
        direction: "down",
        amount: 180,
      }),
    // It names what it hit instead: without that, the reply said "scrolled 0" and the cause
    // was invisible.
    /aimed at DIV#scroll-region: the point on it \(\d+, \d+\) lands on DIV#shadow-host/,
  );
  assert.equal(
    missed.calls.some((c) => c.params && c.params.type === "mouseWheel"),
    false,
    "no wheel may be dispatched once the point is known to miss",
  );
  // The box is taken twice: once, then again after the point is found to have slipped off.
  assert.equal(
    missed.calls.filter((c) => c.method === "DOM.getBoxModel").length,
    2,
  );
});

test("a point that slips once is re-resolved and the scroll goes ahead", async () => {
  const recovered = scrollWorker([
    { hit: "DIV#shadow-host", target: "DIV#scroll-region", onTarget: false },
    { hit: "DIV#scroll-region", target: "DIV#scroll-region", onTarget: true },
  ]);
  const session = recovered.worker.makeSession();
  holdAttached(session, 1);
  // requireSnapshotTab: the ref must come from a snapshot of THIS tab, at the DOM the page is
  // still on.
  session.tabs.get(1).lastSnapshotEpoch = session.tabs.get(1).domEpoch;
  const reply = crossRealm(
    await recovered.worker.handleScroll(session, 1, {
      backendNodeId: 7,
      direction: "down",
      amount: 180,
    }),
  );
  assert.equal(reply.ok, true);
  assert.equal(
    recovered.calls.some((c) => c.params && c.params.type === "mouseWheel"),
    true,
    "the second point is on the element, so the wheel is sent",
  );
  // The box was taken again after the first point was found to have slipped: without that the
  // wheel would go to the same stale point a second time and miss in exactly the same way.
  assert.equal(
    recovered.calls.filter((c) => c.method === "DOM.getBoxModel").length,
    2,
  );
  // And the wheel went to the re-read point, not the first one.
  const wheel = recovered.calls.find(
    (c) => c.params && c.params.type === "mouseWheel",
  );
  assert.equal(
    recovered.calls.filter((c) => c.method === "Runtime.callFunctionOn").length,
    2,
    "the element is asked again after the box is re-read",
  );
  assert.ok(wheel.params.deltaY > 0, "a down scroll pushes the content down");
});

// document.elementFromPoint reports the HOST for a point inside a shadow tree, and Node.contains
// stops at the shadow boundary. A guard built on contains() alone therefore calls every element
// in a shadow root a miss -- including the fixture's own shadow button.
test("the hit test climbs out of a shadow tree instead of calling it a miss", () => {
  const host = { tagName: "DIV", id: "shadow-host", parentNode: null };
  const shadowRoot = { host, parentNode: null };
  const button = {
    tagName: "BUTTON",
    id: "shadow-button",
    parentNode: shadowRoot,
  };
  const elsewhere = { tagName: "DIV", id: "far-away", parentNode: null };

  const run = (target, hit) => {
    const call = new Function(
      "window",
      "document",
      "target",
      `return (${w.pointLandsOnFn.toString()}).call(target, 10, 20);`,
    );
    return crossRealm(
      call(
        { visualViewport: { offsetLeft: 0, offsetTop: 0 } },
        { elementFromPoint: () => hit },
        target,
      ),
    );
  };

  // The point is inside the shadow tree, so the page reports the host. The button is still what
  // the wheel will reach.
  const inShadow = run(button, host);
  assert.equal(inShadow.onTarget, true);
  assert.equal(inShadow.hit, "DIV#shadow-host");
  assert.equal(inShadow.target, "BUTTON#shadow-button");

  // The ordinary case: the point lands on the element itself.
  assert.equal(run(button, button).onTarget, true);

  // And a genuine miss is still a miss -- the climb must not make everything match.
  const missed = run(button, elsewhere);
  assert.equal(missed.onTarget, false);
  assert.equal(missed.hit, "DIV#far-away");

  // Nothing under the point at all.
  const nothing = run(button, null);
  assert.equal(nothing.onTarget, false);
  assert.equal(nothing.hit, null);
  assert.equal(nothing.target, "BUTTON#shadow-button");
});

// The per-step cursor update. The full overlay script reparses an SVG and rewrites three
// elements' styles; a 60-step drag ran that 60 times, and a drag has already come within the
// bridge's 30 s reply budget on a loaded runner.
test("the cursor nudge moves an existing cursor and admits when there is none", () => {
  const script = w.cursorNudgeScript(120, 80);
  // Only the two numbers are interpolated, and both arrive already rounded. The arrow's tip is at
  // (2,1) in its 24-unit viewBox, rendered at 24px, so the offsets are exactly -2 and -1.
  assert.ok(script.includes("118"), "x is offset to the arrow's tip");
  assert.ok(script.includes("79"), "y is offset to the arrow's tip");
  // The nudge and the full build MUST place the tip identically, or the cursor jumps by a couple
  // of pixels depending on which path happened to draw it -- and which one runs depends only on
  // whether the overlay already existed.
  const full = w.controlPresenceScript(120, 80);
  assert.ok(
    full.includes("118") && full.includes("79"),
    "the full overlay build uses the same tip offset as the nudge",
  );
  // A Trusted Types page (YouTube, Gmail, Chrome's error pages) refuses an innerHTML assignment and
  // throws, which left the cursor undrawn and put an exception the extension caused into the page's
  // console. The overlay is built node by node instead.
  assert.ok(
    !full.includes("innerHTML"),
    "the overlay must not use innerHTML; Trusted Types pages reject it",
  );
  // It must not rebuild anything: those are the costs it exists to avoid.
  for (const expensive of ["innerHTML", "cssText", "svg", "@keyframes"]) {
    assert.ok(
      !script.includes(expensive),
      `the nudge must not ${expensive}; that is the full overlay's job`,
    );
  }

  const run = (cursor) =>
    new Function("document", "window", `return ${script};`)(
      { getElementById: () => cursor },
      { visualViewport: { offsetLeft: 0, offsetTop: 0 } },
    );

  // Nothing to move: it says so, and the caller builds the overlay instead of assuming it moved.
  assert.equal(run(null), false);

  // A cursor that is there gets positioned, and the script confirms it.
  const cursor = { style: {} };
  assert.equal(run(cursor), true);
  assert.equal(cursor.style.transform, "translate(118px,79px)");

  // A non-finite point is coerced rather than injected as code.
  const nonsense = w.cursorNudgeScript(Number.NaN, Number.POSITIVE_INFINITY);
  assert.ok(nonsense.includes("-2"), "a NaN x becomes 0, then the tip offset");
  assert.ok(!/NaN|Infinity/.test(nonsense));
});

// A drag fires every step's commands before it awaits any of them. A rejection arriving while an
// earlier step is still being awaited has no handler attached yet, and V8 raises
// unhandledrejection at the next microtask checkpoint -- which in a service worker is something
// the runtime may tear the worker down over. The drag then stops answering and the bridge blames
// the transport: "browser did not reply within 30000 ms (connection reset)".
test("a drag that fails mid-path raises no unhandled rejection", async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let moves = 0;
    const sendCommand = (_target, method, params) => {
      if (
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseMoved"
      ) {
        moves += 1;
        // Everything after the second step fails, as a detach mid-drag would.
        if (moves > 2) {
          return Promise.reject(new Error("Detached while handling command."));
        }
      }
      if (method === "DOM.getBoxModel") {
        return Promise.resolve({
          model: { content: [10, 20, 40, 20, 40, 60, 10, 60] },
        });
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression || "");
        if (expression.includes("dpr:")) {
          return Promise.resolve({
            result: {
              value: {
                dpr: 1,
                sx: 0,
                sy: 0,
                href: "https://example.test/",
                iw: 1280,
                ih: 800,
                vs: 1,
                vl: 0,
                vt: 0,
              },
            },
          });
        }
        // The cursor nudge: report the overlay present so no rebuild is needed.
        if (expression.includes("getElementById")) {
          return Promise.resolve({ result: { value: true } });
        }
        return Promise.resolve({ result: { value: [0, 0, 0, 0] } });
      }
      return Promise.resolve({});
    };
    const worker = loadWorker({
      "debugger.sendCommand": sendCommand,
      "tabs.get": () =>
        Promise.resolve({ id: 1, url: "https://example.test/" }),
    });
    const session = worker.makeSession();
    holdAttached(session, 1);
    session.tabs.get(1).lastSnapshotEpoch = session.tabs.get(1).domEpoch;

    await assert.rejects(() =>
      worker.handleDrag(session, 1, {
        backendNodeId: 7,
        to_backendNodeId: 8,
        steps: 10,
      }),
    );

    // Let every microtask settle; an unhandled rejection would be reported by now.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      seen.map((error) => String(error && error.message)),
      [],
      "a drag's in-flight commands must be handled the moment they are created",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// Everything in a console entry is written by the PAGE. A message is text the site chose, and a
// request URL is a string the site chose; both arrive unbounded.
test("page text is bounded, flattened, and says when it was cut", () => {
  assert.equal(w.boundedText("  hello\n  world  ", 100), "hello world");
  assert.equal(w.boundedText(null, 100), "");
  assert.equal(w.boundedText(undefined, 100), "");
  // A message that was cut and one that happened to end there must not read the same.
  const long = w.boundedText("x".repeat(50), 10);
  assert.equal(long.length, 11);
  assert.ok(long.endsWith("\u2026"), "truncation is marked");
  assert.ok(!w.boundedText("x".repeat(10), 10).endsWith("\u2026"));
});

test("a ring drops the oldest and reports that it had to", () => {
  const ring = [];
  assert.equal(w.pushBounded(ring, 1, 3), 0);
  assert.equal(w.pushBounded(ring, 2, 3), 0);
  assert.equal(w.pushBounded(ring, 3, 3), 0);
  // Full: the next push costs the oldest entry, and says so.
  assert.equal(w.pushBounded(ring, 4, 3), 1);
  assert.deepEqual(crossRealm(ring), [2, 3, 4]);
});

// CDP hands console arguments as RemoteObjects. Rendering one as "[object Object]" throws away
// the only useful part -- an Error's class and message live in its description.
test("a console argument keeps the part worth reading", () => {
  assert.equal(w.consoleArgText({ type: "string", value: "hi" }), "hi");
  assert.equal(w.consoleArgText({ type: "number", value: 42 }), "42");
  assert.equal(
    w.consoleArgText({
      type: "object",
      className: "TypeError",
      description: "TypeError: x is not a function",
    }),
    "TypeError: x is not a function",
  );
  assert.equal(
    w.consoleArgText({ type: "number", unserializableValue: "NaN" }),
    "NaN",
  );
  assert.equal(w.consoleArgText({ type: "undefined" }), "[undefined]");
  assert.equal(w.consoleArgText(null), "");
  // A value that IS falsy is still a value, not an absent one.
  assert.equal(w.consoleArgText({ type: "boolean", value: false }), "false");
});

test("a stack trace reports its top frame, one-based, or nothing", () => {
  assert.equal(
    w.topFrameOf({
      callFrames: [
        { url: "https://x.test/a.js", lineNumber: 41 },
        { url: "https://x.test/b.js", lineNumber: 7 },
      ],
    }),
    "https://x.test/a.js:42",
  );
  // CDP counts lines from zero and humans do not.
  assert.equal(
    w.topFrameOf({
      callFrames: [{ url: "https://x.test/a.js", lineNumber: 0 }],
    }),
    "https://x.test/a.js:1",
  );
  assert.equal(w.topFrameOf({ callFrames: [] }), null);
  assert.equal(w.topFrameOf(null), null);
  assert.equal(w.topFrameOf({ callFrames: [{ lineNumber: 3 }] }), null);
});

function readerWorker() {
  const worker = loadWorker({
    "debugger.sendCommand": () => Promise.resolve({}),
    "tabs.get": () => Promise.resolve({ id: 1, url: "https://example.test/" }),
  });
  const session = worker.makeSession();
  holdAttached(session, 1);
  return { worker, session };
}

// An empty list has two very different meanings, and a reply that cannot tell them apart is worse
// than useless: "the page logged nothing" and "the errors scrolled off" lead somewhere different.
test("browser_console separates silence from lost history", async () => {
  const { worker, session } = readerWorker();
  for (let i = 0; i < 5; i += 1) {
    session.tabs.get(1).consoleEntries.push({
      level: "log",
      text: "m" + i,
      source: "console",
      at: null,
    });
  }
  session.tabs.get(1).consoleEntries.push({
    level: "error",
    text: "TypeError: x is not a function",
    source: "exception",
    at: "https://x.test/a.js:42",
  });
  session.tabs.get(1).consoleDropped = 7;

  const all = crossRealm(await worker.handleConsole(session, 1, {}));
  assert.equal(all.total, 6);
  assert.equal(all.entries.length, 6);
  assert.equal(all.omitted, 0);
  // The buffer had already thrown 7 away before this call; saying nothing about that would let a
  // model conclude the page was quiet.
  assert.equal(all.dropped, 7);

  // Newest last, and a limit takes the NEWEST, not the first ones recorded.
  const tail = crossRealm(await worker.handleConsole(session, 1, { limit: 2 }));
  assert.equal(tail.entries.length, 2);
  assert.equal(tail.entries[1].text, "TypeError: x is not a function");
  assert.equal(tail.omitted, 4);

  const errors = crossRealm(
    await worker.handleConsole(session, 1, { level: "error" }),
  );
  assert.equal(errors.entries.length, 1);
  assert.equal(errors.entries[0].source, "exception");

  // A level that is not a level is refused: answering with everything would silently answer a
  // different question.
  await assert.rejects(
    () => worker.handleConsole(session, 1, { level: "catastrophe" }),
    /level must be one of/,
  );

  const drained = crossRealm(
    await worker.handleConsole(session, 1, { clear: true }),
  );
  assert.equal(drained.cleared, true);
  assert.equal(session.tabs.get(1).consoleEntries.length, 0);
  assert.equal(session.tabs.get(1).consoleDropped, 0);
});

// The media element's own controls load dozens of data: icons. Logging them filled the ring and
// pushed out every request the page actually made -- the live suite saw a network log that was
// nothing but base64 SVG. They are still counted as activity, because network_idle must wait for
// them; they are only kept out of the log.
test("inline content is not a network request", () => {
  assert.equal(w.isInlineRequestUrl("data:image/svg+xml;base64,AAAA"), true);
  assert.equal(w.isInlineRequestUrl("blob:https://x.test/abc"), true);
  // Case is not a promise the page makes.
  assert.equal(w.isInlineRequestUrl("DATA:text/plain,hi"), true);
  assert.equal(w.isInlineRequestUrl("https://x.test/real.png"), false);
  assert.equal(w.isInlineRequestUrl("http://x.test/"), false);
  // A scheme that merely STARTS with the letters is a different scheme.
  assert.equal(w.isInlineRequestUrl("database://x.test/"), false);
  assert.equal(w.isInlineRequestUrl(""), false);
  assert.equal(w.isInlineRequestUrl(null), false);
  assert.equal(w.isInlineRequestUrl(undefined), false);
});

test("browser_network reports failures, and what is still in flight", async () => {
  const { worker, session } = readerWorker();
  session.tabs.get(1).networkEntries.push(
    {
      method: "GET",
      url: "https://x.test/ok",
      type: "Document",
      status: 200,
      mime_type: "text/html",
      failed: false,
      error: null,
      ms: 12,
    },
    {
      method: "POST",
      url: "https://x.test/save",
      type: "XHR",
      status: 500,
      mime_type: "application/json",
      failed: false,
      error: null,
      ms: 40,
    },
    {
      method: "GET",
      url: "https://x.test/gone",
      type: "Image",
      status: null,
      mime_type: null,
      failed: true,
      error: "net::ERR_NAME_NOT_RESOLVED",
      ms: 3,
    },
  );
  session.tabs.get(1).networkPending.set("req-9", {
    method: "GET",
    url: "https://x.test/slow",
    startedMs: Date.now(),
  });

  const all = crossRealm(await worker.handleNetwork(session, 1, {}));
  assert.equal(all.requests.length, 3);
  // A list of completed requests says nothing about the one still running; without this an empty
  // reply reads as "the page asked for nothing".
  assert.equal(all.in_flight, 1);

  // Both kinds of "went wrong": a transport failure with no status, and a status the server sent.
  const bad = crossRealm(
    await worker.handleNetwork(session, 1, { failed_only: true }),
  );
  assert.equal(bad.requests.length, 2);
  assert.deepEqual(
    bad.requests.map((r) => r.url),
    ["https://x.test/save", "https://x.test/gone"],
  );
  // A failed request has no status; reporting 0 would read as a server answering 0.
  assert.equal(bad.requests[1].status, null);
  assert.equal(bad.requests[1].error, "net::ERR_NAME_NOT_RESOLVED");

  const drained = crossRealm(
    await worker.handleNetwork(session, 1, { clear: true }),
  );
  assert.equal(drained.cleared, true);
  assert.equal(session.tabs.get(1).networkEntries.length, 0);
});

// Found on a Windows VM driving real sites: a label copied out of the snapshot did not select
// the option it named. Plenty of pages write &nbsp; between words for alignment, which puts
// U+00A0 in option.text while the snapshot renders an ordinary space, and a === comparison makes
// those two different strings.
test("an option label matches across the whitespace the page chose", () => {
  const options = [
    { value: "ny", text: "New York", label: "New York" },
    { value: "la", text: "Los\u00a0Angeles", label: "Los\u00a0Angeles" },
  ];
  const makeSelect = (multiple) => ({
    tagName: "SELECT",
    multiple,
    options,
    selectedIndex: -1,
    dispatchEvent() {},
  });

  // The function is built in THIS realm because it constructs Event, which the page has and the
  // worker's realm does not. Same source either way -- it is read off the shipped worker.
  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const select = new Function(
    "Event",
    `return (${w.selectOptionFn.toString()});`,
  )(FakeEvent);
  const pick = (mode, value, label, index, values) =>
    crossRealm(
      select.call(makeSelect(false), mode, value, label, index, values),
    );

  // The label as the snapshot shows it selects the option the page spells with a NBSP.
  const chosen = pick("label", undefined, "Los Angeles", undefined, undefined);
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  // An ordinary label still matches, and a label that names nothing still fails.
  assert.equal(pick("label", undefined, "New York").ok, true);
  assert.equal(pick("label", undefined, "Boston").ok, false);

  // Multi-select matches by the same rule, or the same label works singly and not in a list.
  const many = crossRealm(
    select.call(makeSelect(true), "values", undefined, undefined, undefined, [
      "Los Angeles",
    ]),
  );
  assert.equal(many.ok, true, JSON.stringify(many));
  assert.equal(many.selected.length, 1);
});

// Chrome takes a different set of values per permission type. Passing one it does not take came
// back as "Invalid invocation: Error at property 'setting': Value must be one of allow, block",
// which names neither the tool, the permission, nor what would have worked.
test("the per-permission setting table says what Chrome accepts", () => {
  const table = crossRealm(w.SETTINGS_BY_PERMISSION);
  // These three are on-or-off: there is no prompt to show, so "ask" is rejected by the API
  // rather than treated as a default.
  for (const type of ["javascript", "images", "popups"]) {
    assert.deepEqual(table[type], ["allow", "block"], type);
    assert.equal(table[type].includes("ask"), false, type + " cannot ask");
  }
  // Anything not listed falls back to the full set, which is what a prompt-capable permission
  // like geolocation needs.
  assert.equal(table.location, undefined);
  assert.equal(table.notifications, undefined);
});

// browser_media exists to drive these, and without a ref it cannot be aimed at one. A <video>
// whose controls the page draws itself is not focusable and carries no AX value, so it was shown
// to the model as scenery it could see and not touch.
test("media elements are interactable enough to earn a ref", () => {
  const roles = crossRealm([...w.INTERACTABLE_ROLES]);
  assert.ok(
    roles.includes("video"),
    "a video must be reachable by browser_media",
  );
  assert.ok(roles.includes("audio"), "and so must an audio element");
  // The set is still about things you act on, not scenery.
  for (const scenery of ["generic", "paragraph", "image", "main"]) {
    assert.equal(
      roles.includes(scenery),
      false,
      scenery + " is not interactable",
    );
  }
});

test("boundedMs and boundedCount refuse what they cannot honour", () => {
  assert.equal(w.boundedMs(undefined, 40, 5000, "dwell"), 40);
  assert.equal(w.boundedMs(0, 40, 5000, "dwell"), 0); // a given 0 is not the default
  assert.equal(w.boundedMs(250, 40, 5000, "dwell"), 250);
  assert.throws(() => w.boundedMs("soon", 40, 5000, "dwell"), /dwell/);
  assert.throws(() => w.boundedMs(-1, 40, 5000, "dwell"), /dwell/);
  assert.throws(() => w.boundedMs(5001, 40, 5000, "dwell"), /dwell/);
  assert.equal(w.boundedCount(undefined, 12, 2, 60, "steps"), 12);
  assert.equal(w.boundedCount(2, 12, 2, 60, "steps"), 2);
  assert.throws(() => w.boundedCount(1, 12, 2, 60, "steps"), /steps/);
  assert.throws(() => w.boundedCount(2.5, 12, 2, 60, "steps"), /steps/);
  assert.throws(() => w.boundedCount("lots", 12, 2, 60, "steps"), /steps/);
});

test("parseModifiers refuses an unknown modifier rather than dropping it", () => {
  // A dropped modifier turns ctrl+click into a plain click: a different action, reported
  // as the one that was asked for.
  assert.equal(w.parseModifiers(undefined), 0);
  assert.equal(w.parseModifiers(""), 0);
  const ctrl = w.parseModifiers("ctrl");
  const shift = w.parseModifiers("shift");
  assert.ok(ctrl > 0 && shift > 0);
  assert.equal(w.parseModifiers("ctrl+shift"), ctrl | shift);
  assert.equal(w.parseModifiers("CTRL + SHIFT"), ctrl | shift);
  assert.throws(() => w.parseModifiers("hyper"), /Unknown modifier/);
  assert.throws(() => w.parseModifiers("ctrl+hyper"), /Unknown modifier/);
});

test("scrollAmountPx refuses a non-positive or non-finite distance", () => {
  assert.ok(w.scrollAmountPx(undefined) > 0);
  assert.equal(w.scrollAmountPx(120), 120);
  assert.throws(() => w.scrollAmountPx(0), /positive/);
  assert.throws(() => w.scrollAmountPx(-40), /positive/);
  assert.throws(() => w.scrollAmountPx("lots"), /positive/);
  assert.throws(() => w.scrollAmountPx(Infinity), /positive/);
});

test("selectCallArgs requires exactly one selection criterion", () => {
  assert.throws(() => w.selectCallArgs({}), /needs one of/);
  assert.throws(
    () => w.selectCallArgs({ value: "", label: "" }),
    /needs one of/,
  );
  assert.throws(
    () => w.selectCallArgs({ value: "a", index: 2 }),
    /exactly one/,
  );
  assert.throws(
    () => w.selectCallArgs({ label: "a", values: ["b"] }),
    /exactly one/,
  );

  assert.deepEqual(crossRealm(w.selectCallArgs({ value: "a" })), [
    "value",
    "a",
    "",
    -1,
    [],
  ]);
  assert.deepEqual(crossRealm(w.selectCallArgs({ label: "L" })), [
    "label",
    "",
    "L",
    -1,
    [],
  ]);
  // index 0 is a real choice and must not be read as "absent".
  assert.deepEqual(crossRealm(w.selectCallArgs({ index: 0 })), [
    "index",
    "",
    "",
    0,
    [],
  ]);
  assert.deepEqual(crossRealm(w.selectCallArgs({ values: ["x", 2] })), [
    "values",
    "",
    "",
    -1,
    ["x", "2"],
  ]);
});

test("capFrameUrls reports truncation explicitly instead of just returning fewer frames", () => {
  // A caller that cannot tell a complete list from a capped one treats "these are the
  // frames" and "these are some of the frames" as the same answer.
  const cap = w.MAX_OMITTED_FRAMES;
  const many = [];
  for (let i = 0; i < cap + 5; i++) {
    many.push(`https://f${i}.example/`);
  }

  const capped = w.capFrameUrls(many, null);
  assert.equal(capped.frames.length, cap);
  assert.equal(capped.truncated, true);

  const few = w.capFrameUrls(
    ["https://a.example/", "https://b.example/"],
    null,
  );
  assert.equal(few.frames.length, 2);
  assert.equal(few.truncated, false);
});

test("capFrameUrls drops non-http, already-covered and duplicate frames", () => {
  const covered = new Set(["https://covered.example/"]);
  const out = w.capFrameUrls(
    [
      "https://covered.example/", // already captured
      "https://covered.example/#anchor", // same document, fragment only
      "about:blank", // not http(s)
      "data:text/html,x", // not http(s)
      "https://kept.example/",
      "https://kept.example/", // duplicate
    ],
    covered,
  );
  assert.deepEqual(crossRealm(out.frames), ["https://kept.example/"]);
  assert.equal(out.truncated, false);
});

test("frame tree walking counts and collects every nested frame", () => {
  const tree = {
    frame: { url: "https://root.example/" },
    childFrames: [
      {
        frame: { url: "https://a.example/" },
        childFrames: [{ frame: { url: "https://a1.example/" } }],
      },
      { frame: { url: "https://b.example/" } },
    ],
  };
  assert.equal(w.countFrames(tree), 4);
  assert.equal(w.countFrames(null), 0);

  const urls = []; // built here, so this one is already same-realm
  w.collectFrameUrls(tree, urls);
  assert.deepEqual(urls, [
    "https://root.example/",
    "https://a.example/",
    "https://a1.example/",
    "https://b.example/",
  ]);
});

test("sameProcessUrls resolves documentURL through the shared string table", () => {
  // DOMSnapshot stores documentURL as an INDEX into snapshot.strings, not as a string.
  const snapshot = {
    strings: ["https://one.example/page#frag", "https://two.example/"],
    documents: [
      { documentURL: 0 },
      { documentURL: 1 },
      { documentURL: 99 },
      {},
    ],
  };
  const urls = w.sameProcessUrls(snapshot);
  assert.ok(urls.has("https://one.example/page")); // fragment stripped
  assert.ok(urls.has("https://two.example/"));
  assert.equal(urls.size, 2); // out-of-range index and missing key contribute nothing
  assert.equal(w.sameProcessUrls(null).size, 0);
});

test("originsMatch compares origins, and falls back to equality only when unparseable", () => {
  assert.equal(
    w.originsMatch("https://x.example/a", "https://x.example/b"),
    true,
  );
  assert.equal(
    w.originsMatch("https://x.example/", "http://x.example/"),
    false,
  );
  assert.equal(
    w.originsMatch("https://x.example/", "https://y.example/"),
    false,
  );
  assert.equal(w.originsMatch("", "https://x.example/"), false);
  assert.equal(w.originsMatch(null, null), false);
  assert.equal(w.originsMatch("not-a-url", "not-a-url"), true);
});

test("defaultDialogAccept only auto-accepts dialogs with nothing to decide", () => {
  // alert and beforeunload have no meaningful "cancel"; confirm and prompt do, and
  // answering those on the user's behalf is a decision the extension must not make.
  assert.equal(w.defaultDialogAccept("alert"), true);
  assert.equal(w.defaultDialogAccept("beforeunload"), true);
  assert.equal(w.defaultDialogAccept("confirm"), false);
  assert.equal(w.defaultDialogAccept("prompt"), false);
});

// A CDP accessibility node, in the shape Chrome actually sends: role/name are wrapped
// values, and properties is a list of {name, value:{value}} rather than a plain object.
function axNode(role, name, properties, extra) {
  return {
    role: { value: role },
    name: { value: name },
    properties: properties.map(([n, v]) => ({ name: n, value: { value: v } })),
    ...(extra || {}),
  };
}

test("indexProps cannot have its prototype set by a property name", () => {
  // The keys are property names from the accessibility tree and the values are read back by
  // name. On a plain object literal, "__proto__" would set the map's prototype instead of
  // becoming a key, and a later lookup for a state the page never set would resolve through
  // an object the page chose.
  const evil = [
    { name: "__proto__", value: { value: { disabled: true } } },
    { name: "focusable", value: { value: true } },
  ];
  const props = indexPropsOf(evil);
  assert.equal(
    Object.getPrototypeOf(props),
    null,
    "props must have no prototype",
  );
  assert.equal(
    props.disabled,
    undefined,
    "a state the page never set must not resolve",
  );
  assert.equal(props.focusable, true);
});

function indexPropsOf(properties) {
  return w.indexProps(properties);
}

test("axNodeToCapture reports ARIA mixed as its own state, never as a boolean", () => {
  // "mixed" is a partially-checked control. Collapsing it to true or false states something
  // about the control that is not true.
  const mixed = w.axNodeToCapture(
    axNode("checkbox", "Select all", [["checked", "mixed"]]),
    0,
    new Map(),
  );
  assert.equal(mixed.mixed, true);
  assert.equal(
    "checked" in mixed,
    false,
    "mixed must not also claim a checked boolean",
  );

  const checked = w.axNodeToCapture(
    axNode("checkbox", "A", [["checked", true]]),
    0,
    new Map(),
  );
  assert.equal(checked.checked, true);
  assert.equal("mixed" in checked, false);

  const unchecked = w.axNodeToCapture(
    axNode("checkbox", "B", [["checked", false]]),
    0,
    new Map(),
  );
  assert.equal(unchecked.checked, false);

  // A control with no checked property must claim neither.
  const plain = w.axNodeToCapture(axNode("button", "Go", []), 0, new Map());
  assert.equal("checked" in plain, false);
  assert.equal("mixed" in plain, false);
});

test("axNodeToCapture flags a truncated value instead of silently shortening it", () => {
  const long = "x".repeat(w.AX_VALUE_MAX_CHARS + 25);
  const rec = w.axNodeToCapture(
    axNode("textbox", "Notes", [], { value: { value: long } }),
    0,
    new Map(),
  );
  assert.equal(rec.value.length, w.AX_VALUE_MAX_CHARS);
  assert.equal(rec.value_truncated, true);

  const short = w.axNodeToCapture(
    axNode("textbox", "Notes", [], { value: { value: "abc" } }),
    0,
    new Map(),
  );
  assert.equal(short.value, "abc");
  assert.equal("value_truncated" in short, false);
});

test("axNodeToCapture omits a state the page never reported", () => {
  // Absent and false are different facts. A fabricated false would tell the model the page
  // said something it did not.
  const rec = w.axNodeToCapture(
    axNode("button", "Go", [["focusable", true]]),
    3,
    new Map(),
  );
  for (const never of [
    "disabled",
    "readonly",
    "required",
    "busy",
    "selected",
    "pressed",
    "invalid",
    "expanded",
    "editable",
  ]) {
    assert.equal(
      never in rec,
      false,
      `${never} must be absent when unreported`,
    );
  }
  assert.equal(rec.depth, 3);
  assert.equal(rec.interactable, true);
  assert.equal(rec.visible, true);
});

test("axNodeToCapture applies the state table and drops ignored nodes", () => {
  const rec = w.axNodeToCapture(
    axNode("textbox", "Email", [
      ["disabled", true],
      ["required", true],
      ["invalid", "spelling"],
      ["selected", "true"],
      ["expanded", false],
      ["busy", false],
    ]),
    0,
    new Map(),
  );
  assert.equal(rec.disabled, true);
  assert.equal(rec.required, true);
  assert.equal(
    rec.invalid,
    true,
    "invalid carries a reason string, not just true",
  );
  assert.equal(rec.selected, true);
  assert.equal(
    rec.expanded,
    false,
    "a collapsed control is not the same as no state",
  );
  assert.equal("busy" in rec, false, "an explicit false must not set the flag");
  assert.equal(rec.editable, true, "textbox is editable by role");

  assert.equal(w.axNodeToCapture({ ignored: true }, 0, new Map()), null);
});

test("axNodeToCapture attaches geometry only for a real backend node id", () => {
  const bounds = { x: 1, y: 2, w: 3, h: 4 };
  const withId = w.axNodeToCapture(
    axNode("button", "Go", [], { backendDOMNodeId: 7 }),
    0,
    new Map([[7, bounds]]),
  );
  assert.equal(withId.backendNodeId, 7);
  assert.deepEqual(crossRealm(withId.bounds), bounds);

  // Known id, no bounds recorded: the id is still reported, bounds are simply absent.
  const noBounds = w.axNodeToCapture(
    axNode("button", "Go", [], { backendDOMNodeId: 9 }),
    0,
    new Map(),
  );
  assert.equal(noBounds.backendNodeId, 9);
  assert.equal("bounds" in noBounds, false);

  const noId = w.axNodeToCapture(axNode("button", "Go", []), 0, new Map());
  assert.equal("backendNodeId" in noId, false);
});

test("the command table cannot be reached through the prototype chain", async () => {
  // cmd arrives from the native-messaging relay, so the lookup must only ever find keys
  // that were deliberately put in the table. Written as an object literal instead of a Map,
  // every one of these names would resolve to an inherited value, pass the "known command?"
  // test, and then be invoked.
  for (const inherited of [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    assert.equal(
      w.COMMAND_TABLE.get(inherited),
      undefined,
      `${inherited} must not resolve to a command`,
    );
    await assert.rejects(
      () => w.dispatchCommand(inherited, {}),
      /Unknown command/,
      `${inherited} must be refused`,
    );
  }
  await assert.rejects(
    () => w.dispatchCommand("nosuchcommand", {}),
    /Unknown command/,
  );
});

test("every command table entry declares a callable handler", () => {
  assert.ok(w.COMMAND_TABLE.size >= 40, "the table lost entries");
  for (const [name, entry] of w.COMMAND_TABLE) {
    assert.equal(typeof entry.fn, "function", `${name} has no handler`);
    assert.equal(typeof entry.tab, "boolean", `${name} does not declare tab`);
    assert.equal(typeof entry.args, "boolean", `${name} does not declare args`);
  }
});

test("small pure helpers behave at their edges", () => {
  assert.equal(
    w.stripFragment("https://x.example/a#b#c"),
    "https://x.example/a",
  );
  assert.equal(w.stripFragment("https://x.example/a"), "https://x.example/a");

  assert.equal(w.isEditableRole("textbox"), true);
  assert.equal(w.isEditableRole("searchbox"), true);
  assert.equal(w.isEditableRole("button"), false);

  assert.equal(w.axValue({ value: "v" }), "v");
  assert.equal(w.axValue({ value: 0 }), "0");
  assert.equal(w.axValue({ value: null }), "");
  assert.equal(w.axValue(undefined), "");

  const err = w.transientReadError("try again");
  assert.equal(err.transient, true);
  assert.equal(err.message, "try again");
});

test("printPageOptions maps only recognized fields and pins the safe defaults", () => {
  // An empty request prints with the fixed transfer mode and backgrounds on; nothing else leaks.
  assert.deepEqual(crossRealm(w.printPageOptions({})), {
    transferMode: "ReturnAsBase64",
    printBackground: true,
  });
  // print_background is on unless EXACTLY false (a missing/true/truthy value stays on).
  assert.equal(
    w.printPageOptions({ print_background: false }).printBackground,
    false,
  );
  assert.equal(
    w.printPageOptions({ print_background: true }).printBackground,
    true,
  );
  assert.equal(
    w.printPageOptions({ print_background: "no" }).printBackground,
    true,
  );
  // landscape is copied only when it is a real boolean.
  assert.equal(w.printPageOptions({ landscape: true }).landscape, true);
  assert.equal("landscape" in w.printPageOptions({ landscape: "yes" }), false);
});

test("printPageOptions enforces the scale and paper-size bounds", () => {
  assert.equal(w.printPageOptions({ scale: 1.5 }).scale, 1.5);
  assert.equal(w.printPageOptions({ scale: 0.1 }).scale, 0.1); // inclusive lower bound
  assert.equal(w.printPageOptions({ scale: 2 }).scale, 2); // inclusive upper bound
  assert.equal("scale" in w.printPageOptions({ scale: null }), false);
  for (const bad of [0.05, 2.5, "abc", NaN, Infinity]) {
    assert.throws(
      () => w.printPageOptions({ scale: bad }),
      /scale must be between 0.1 and 2/,
    );
  }
  // Paper dimensions must be a finite positive number of inches.
  const opts = w.printPageOptions({ paper_width: 8.5, paper_height: 11 });
  assert.equal(opts.paperWidth, 8.5);
  assert.equal(opts.paperHeight, 11);
  assert.equal(
    "paperWidth" in w.printPageOptions({ paper_width: null }),
    false,
  );
  for (const bad of [0, -1, "x", NaN]) {
    assert.throws(
      () => w.printPageOptions({ paper_width: bad }),
      /paper_width must be a positive number of inches/,
    );
  }
});

test("buildBoundsMap rounds each node's layout box and skips unusable entries", () => {
  const snapshot = {
    documents: [
      {
        nodes: { backendNodeId: [100, 200, 300] },
        layout: {
          nodeIndex: [0, 1, 2],
          bounds: [[1.4, 2.6, 3.5, 4.5], [10, 20, 30, 40], null],
        },
      },
      null, // a null document is skipped
      { nodes: { backendNodeId: [9] } }, // no layout -> skipped
    ],
  };
  const map = w.buildBoundsMap(snapshot);
  // 100 and 200 carve out; 300's bounds were null, so it is dropped, not defaulted to zeros.
  assert.equal(map.size, 2);
  assert.deepEqual(crossRealm(map.get(100)), {
    x: 1,
    y: 3,
    width: 4,
    height: 5,
  });
  assert.deepEqual(crossRealm(map.get(200)), {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  });
  assert.equal(map.get(300), undefined);
  // A missing/empty snapshot yields an empty map, never a throw.
  assert.equal(w.buildBoundsMap(null).size, 0);
  assert.equal(w.buildBoundsMap({}).size, 0);
});

test("buildBoundsMap drops a node whose backend id is undefined", () => {
  // nodeIndex points past the backendNodeId array: the entry has no stable id, so it must be
  // dropped rather than keyed on undefined.
  const snapshot = {
    documents: [
      {
        nodes: { backendNodeId: [42] },
        layout: {
          nodeIndex: [0, 7],
          bounds: [
            [0, 0, 1, 1],
            [5, 5, 5, 5],
          ],
        },
      },
    ],
  };
  const map = w.buildBoundsMap(snapshot);
  assert.equal(map.size, 1);
  assert.deepEqual(crossRealm(map.get(42)), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
});

// A named node always survives axNodeToCapture (only unnamed structural filler is dropped), so a
// button with a name and an id makes every fixture node emit and isolates buildNodes' walk order.
function walkNode(id, name, childIds) {
  return axNode("button", name, [], { nodeId: id, childIds });
}

test("buildNodes walks the AX tree in pre-order with correct depth", () => {
  const axTree = {
    nodes: [
      walkNode("root", "R", ["a", "b"]),
      walkNode("a", "A", ["a1"]),
      walkNode("b", "B", []),
      walkNode("a1", "A1", []),
    ],
  };
  const { nodes, truncated } = w.buildNodes(axTree, new Map());
  // Depth-first, document order: the whole of a's subtree comes before sibling b.
  assert.deepEqual(crossRealm(nodes.map((n) => [n.name, n.depth])), [
    ["R", 0],
    ["A", 1],
    ["A1", 2],
    ["B", 1],
  ]);
  assert.equal(truncated, false);
});

test("buildNodes emits a shared descendant once and never loops", () => {
  // "shared" is a child of both x and y (a DAG); the seen-set must emit it once and the walk must
  // terminate. An empty tree and a missing tree yield an empty, non-truncated result.
  const axTree = {
    nodes: [
      walkNode("root", "R", ["x", "y"]),
      walkNode("x", "X", ["shared"]),
      walkNode("y", "Y", ["shared"]),
      walkNode("shared", "S", []),
    ],
  };
  const { nodes } = w.buildNodes(axTree, new Map());
  assert.equal(nodes.filter((n) => n.name === "S").length, 1);
  assert.deepEqual(crossRealm(nodes.map((n) => n.name)), ["R", "X", "S", "Y"]);
  assert.deepEqual(crossRealm(w.buildNodes({ nodes: [] }, new Map())), {
    nodes: [],
    truncated: false,
  });
  assert.deepEqual(crossRealm(w.buildNodes(null, new Map())), {
    nodes: [],
    truncated: false,
  });
});

test("buildNodes caps the emitted set at MAX_CAPTURE_NODES and reports truncation", () => {
  // A wide tree past the cap: the output stops at MAX_CAPTURE_NODES and truncated flags the drop,
  // so the caller never presents a partial outline as the whole page.
  const childIds = [];
  const nodesArr = [walkNode("root", "R", childIds)];
  for (let i = 0; i < w.MAX_CAPTURE_NODES + 200; i++) {
    const id = "c" + i;
    childIds.push(id);
    nodesArr.push(walkNode(id, "N" + i, []));
  }
  const { nodes, truncated } = w.buildNodes({ nodes: nodesArr }, new Map());
  assert.equal(nodes.length, w.MAX_CAPTURE_NODES);
  assert.equal(truncated, true);
});

// -- macOS editing commands ----------------------------------------------------
// On macOS a synthetic key event never passes through the operating system's key bindings, so
// Command+A reaches the page and selects nothing unless the keyDown names the command. These
// tests hold the chord -> command mapping to Chromium's macOS bindings, and keep it OFF the
// other platforms, where the renderer maps chords itself.

test("macEditingCommands names the macOS command for Command chords", () => {
  const meta = 4;
  const shift = 8;
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyA", meta)), [
    "selectAll",
  ]);
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyC", meta)), ["copy"]);
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyV", meta)), ["paste"]);
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyZ", meta)), ["undo"]);
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyZ", meta | shift)), [
    "redo",
  ]);
  assert.deepEqual(crossRealm(w.macEditingCommands("Backspace", 0)), [
    "deleteBackward",
  ]);
});

test("macEditingCommands gives Control+A its macOS meaning, not Windows' select-all", () => {
  const control = 2;
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyA", control)), [
    "moveToBeginningOfParagraph",
  ]);
});

test("macEditingCommands drops text-inserting commands and unbound chords", () => {
  const control = 2;
  // insertNewline: the key's own text inserts the newline
  assert.deepEqual(crossRealm(w.macEditingCommands("Enter", 0)), []);
  // ['insertNewlineIgnoringFieldEditor:', 'moveBackward:'] keeps only the second
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyO", control)), [
    "moveBackward",
  ]);
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyA", 0)), []);
  assert.deepEqual(crossRealm(w.macEditingCommands("KeyQ", 4)), []);
});

test("keyDownEvent carries editing commands on macOS only", () => {
  const def = { key: "a", code: "KeyA", keyCode: 65, text: "a" };
  const onMac = w.keyDownEvent(def, 4, true);
  assert.deepEqual(crossRealm(onMac.commands), ["selectAll"]);
  assert.equal(onMac.text, undefined); // a Command chord types nothing
  const offMac = w.keyDownEvent(def, 2, false);
  assert.equal(offMac.commands, undefined);
  assert.equal(offMac.modifiers, 2);
  assert.equal(offMac.code, "KeyA");
  const plain = w.keyDownEvent(def, 0, true);
  assert.equal(plain.commands, undefined);
  assert.equal(plain.text, "a");
});

test("MAC_EDITING_COMMANDS is Chromium's macOS table, entry for entry", () => {
  const table = w.MAC_EDITING_COMMANDS;
  // Prototype-less, like every other caller-indexed table in the worker
  assert.equal(Object.getPrototypeOf(table), null);
  assert.equal(Object.keys(table).length, 114);
  for (const [chord, binding] of Object.entries(table)) {
    const selectors = Array.isArray(binding) ? binding : [binding];
    for (const selector of selectors) {
      assert.match(selector, /^[a-z][A-Za-z]*:$/, `${chord} -> ${selector}`);
    }
  }
});

// -- capturing a tab Chrome is not drawing ----------------------------------
//
// Chrome answers Page.captureScreenshot only once the tab produces a compositor frame, and the
// tab this session works in is ordinarily not the one in front. A capture that waits on a frame
// that never comes used to run out the app's transport deadline, which reset the bridge and ended
// the session; these tests hold the shape of the fix: force frames when the tab is not on screen,
// bound every wait, and never leave a screencast running.

function captureHarness({ tab, window: windowInfo, capture }) {
  const calls = [];
  const overrides = {
    "tabs.get": async (tabId) => {
      calls.push({ method: "tabs.get", tabId });
      if (!tab) {
        throw new Error("no such tab");
      }
      return { id: tabId, ...tab };
    },
    "windows.get": async (windowId) => {
      calls.push({ method: "windows.get", windowId });
      if (!windowInfo) {
        throw new Error("no such window");
      }
      return { id: windowId, ...windowInfo };
    },
    "debugger.sendCommand": async (_target, method, params) => {
      calls.push({ method, params });
      if (method === "Page.captureScreenshot") {
        return capture();
      }
      return {};
    },
  };
  return { calls, worker: loadWorker(overrides) };
}

const methodsOf = (calls) => calls.map((call) => call.method);

test("raceDeadline reports the value when the command answers", async () => {
  const raced = await w.raceDeadline(Promise.resolve("answered"), 1000);
  // Field by field: the worker's own realm builds this object, and a literal out here is never
  // deep-equal to one of its objects.
  assert.equal(raced.value, "answered");
  assert.equal(raced.timedOut, undefined);
});

test("raceDeadline reports a timeout instead of waiting forever", async () => {
  const raced = await w.raceDeadline(new Promise(() => {}), 10);
  assert.equal(raced.timedOut, true);
  assert.equal(raced.value, undefined);
});

test("raceDeadline still fails when the command itself fails", async () => {
  await assert.rejects(
    () => w.raceDeadline(Promise.reject(new Error("detached")), 1000),
    /detached/,
  );
});

test("raceDeadline leaves no unhandled rejection behind an abandoned command", async () => {
  const rejections = [];
  const record = (reason) => rejections.push(reason);
  process.on("unhandledRejection", record);
  try {
    let fail = null;
    const abandoned = new Promise((_resolve, reject) => {
      fail = reject;
    });
    assert.equal((await w.raceDeadline(abandoned, 10)).timedOut, true);
    fail(new Error("the debugger detached after we gave up"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", record);
  }
  assert.deepEqual(rejections, []);
});

test("a tab in front of a normal window counts as on screen", async () => {
  const { worker } = captureHarness({
    tab: { active: true, windowId: 7 },
    window: { state: "normal" },
    capture: () => ({ data: "png" }),
  });
  assert.equal(await worker.tabIsOnScreen(1), true);
});

test("a background tab, a minimized window, and a vanished tab are not on screen", async () => {
  const background = captureHarness({
    tab: { active: false, windowId: 7 },
    window: { state: "normal" },
    capture: () => ({ data: "png" }),
  });
  assert.equal(await background.worker.tabIsOnScreen(1), false);

  const minimized = captureHarness({
    tab: { active: true, windowId: 7 },
    window: { state: "minimized" },
    capture: () => ({ data: "png" }),
  });
  assert.equal(await minimized.worker.tabIsOnScreen(1), false);

  const gone = captureHarness({
    tab: null,
    window: null,
    capture: () => ({ data: "png" }),
  });
  assert.equal(await gone.worker.tabIsOnScreen(1), false);
});

test("a tab on screen is captured directly, with no screencast", async () => {
  const { calls, worker } = captureHarness({
    tab: { active: true, windowId: 7 },
    window: { state: "normal" },
    capture: () => ({ data: "on-screen" }),
  });
  const shot = await worker.captureScreenshotWithFrames(1, { format: "png" });
  assert.deepEqual(shot, { data: "on-screen" });
  assert.deepEqual(
    methodsOf(calls).filter((method) => method.startsWith("Page.")),
    ["Page.captureScreenshot"],
  );
});

test("a tab that is not on screen is captured with frames forced, and the cast is stopped", async () => {
  const { calls, worker } = captureHarness({
    tab: { active: false, windowId: 7 },
    window: { state: "normal" },
    capture: () => ({ data: "forced" }),
  });
  const shot = await worker.captureScreenshotWithFrames(1, { format: "png" });
  assert.deepEqual(shot, { data: "forced" });
  assert.deepEqual(
    methodsOf(calls).filter((method) => method.startsWith("Page.")),
    ["Page.startScreencast", "Page.captureScreenshot", "Page.stopScreencast"],
  );
  const cast = calls.find((call) => call.method === "Page.startScreencast");
  // One pixel: nothing reads these frames, they exist only to make Chrome composite the tab.
  assert.equal(cast.params.maxWidth, 1);
  assert.equal(cast.params.maxHeight, 1);
  // Same realm on both sides: the worker runs in its own vm context, and an object from it
  // never deep-equals a literal built out here.
  assert.deepEqual(cast.params, worker.FRAME_FORCING_SCREENCAST);
});

test("a capture that fails is not left with a screencast running", async () => {
  const { calls, worker } = captureHarness({
    tab: { active: false, windowId: 7 },
    window: { state: "normal" },
    capture: () => {
      throw new Error("Session is not attached to the target");
    },
  });
  await assert.rejects(
    () => worker.captureScreenshotWithFrames(1, { format: "png" }),
    /not attached/,
  );
  assert.equal(
    methodsOf(calls).includes("Page.stopScreencast"),
    true,
    "the cast must be stopped even when the capture fails",
  );
});

// -- the bytes of an upload, in pieces --------------------------------------
//
// A file crosses the bridge in pieces because Chrome carries at most 1 MiB in
// one message from a host. These hold the part that decides whether the page
// gets the user's file or a corrupted imitation of it: pieces reassemble in
// order whatever order they arrive in, a missing piece is reported rather than
// papered over, and nothing unbounded is ever held here.

const base64Of = (text) => Buffer.from(text, "utf8").toString("base64");

test("pieces reassemble in order, whatever order they arrive in", async () => {
  const w2 = loadWorker();
  const uploadSession = w2.makeSession();
  const whole = base64Of("the whole file, in three parts");
  const pieces = [whole.slice(0, 10), whole.slice(10, 22), whole.slice(22)];
  // Deliberately out of order: the sequence number decides, not arrival.
  for (const seq of [2, 0, 1]) {
    await w2.handleUploadChunk(uploadSession, {
      upload_id: "u-1",
      seq,
      total: 3,
      data: pieces[seq],
    });
  }
  assert.equal(w2.assembleUpload(uploadSession, "u-1"), whole);
});

test("a missing piece assembles to nothing rather than a hole", async () => {
  const w2 = loadWorker();
  const uploadSession = w2.makeSession();
  await w2.handleUploadChunk(uploadSession, {
    upload_id: "u-2",
    seq: 0,
    total: 2,
    data: base64Of("first"),
  });
  assert.equal(w2.assembleUpload(uploadSession, "u-2"), null);
  assert.equal(w2.assembleUpload(uploadSession, "never-sent"), null);
});

test("an upload's pieces must agree on how many there are", async () => {
  const w2 = loadWorker();
  const uploadSession = w2.makeSession();
  await w2.handleUploadChunk(uploadSession, {
    upload_id: "u-3",
    seq: 0,
    total: 2,
    data: "AA",
  });
  await assert.rejects(
    () =>
      w2.handleUploadChunk(uploadSession, {
        upload_id: "u-3",
        seq: 1,
        total: 5,
        data: "BB",
      }),
    /disagree/,
  );
});

test("an out-of-range or unnamed piece is refused", async () => {
  const w2 = loadWorker();
  const uploadSession = w2.makeSession();
  await assert.rejects(
    () =>
      w2.handleUploadChunk(uploadSession, {
        upload_id: "",
        seq: 0,
        total: 1,
        data: "AA",
      }),
    /upload_id/,
  );
  await assert.rejects(
    () =>
      w2.handleUploadChunk(uploadSession, {
        upload_id: "u-4",
        seq: 3,
        total: 2,
        data: "AA",
      }),
    /out of range/,
  );
  await assert.rejects(
    () =>
      w2.handleUploadChunk(uploadSession, {
        upload_id: "u-4",
        seq: 0,
        total: w2.MAX_UPLOAD_CHUNKS + 1,
        data: "AA",
      }),
    /too many pieces/,
  );
});

test("the worker holds only so many uploads at once", async () => {
  const w2 = loadWorker();
  const uploadSession = w2.makeSession();
  for (let i = 0; i < w2.MAX_UPLOADS_IN_FLIGHT; i += 1) {
    await w2.handleUploadChunk(uploadSession, {
      upload_id: `u-${i}`,
      seq: 0,
      total: 1,
      data: "AA",
    });
  }
  await assert.rejects(
    () =>
      w2.handleUploadChunk(uploadSession, {
        upload_id: "one-too-many",
        seq: 0,
        total: 1,
        data: "AA",
      }),
    /in flight/,
  );
});

test("ending the session drops every buffered piece", async () => {
  const w2 = loadWorker();
  const uploadSession = w2.makeSession();
  await w2.handleUploadChunk(uploadSession, {
    upload_id: "u-5",
    seq: 0,
    total: 1,
    data: base64Of("bytes of a file the next session must never see"),
  });
  assert.notEqual(w2.assembleUpload(uploadSession, "u-5"), null);
  w2.clearUploads(uploadSession);
  assert.equal(w2.assembleUpload(uploadSession, "u-5"), null);
});

// That teardown actually calls clearUploads() was asserted here by slicing the text of
// detachAll and looking for the call. test_browser_extension_session.mjs now drives both ways
// an attachment can end and checks the buffer is empty afterwards, which is the same guarantee
// established by observation rather than by reading the source -- and it covers the browser
// detaching for us, which the text search never did.

// -- finding the file input behind the control a person clicks ---------------
//
// The input a page shows is almost never the one it uses: the real <input type=file> is hidden
// and a button, label, or menu item stands in front of it. resolveFileInputFrom runs IN the page
// (its source is inlined into the upload call), so these tests build the shapes the web actually
// uses out of plain objects and hold the search to them -- including the one case it must refuse
// rather than guess.

// A DOM small enough to read and real enough to resolve against: parentElement chains,
// querySelector(All) scoped to a subtree, closest by tag, and a label's `control`.
function el(tag, props = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    children,
    parentElement: null,
    ...props,
  };
  const descendants = () => {
    const out = [];
    const walk = (n) => {
      for (const child of n.children || []) {
        out.push(child);
        walk(child);
      }
    };
    walk(node);
    return out;
  };
  const isFile = (n) =>
    n.tagName === "INPUT" && (n.type || "").toLowerCase() === "file";
  node.querySelector = (selector) =>
    selector === 'input[type="file"]'
      ? descendants().find(isFile) || null
      : null;
  node.querySelectorAll = (selector) =>
    selector === 'input[type="file"]' ? descendants().filter(isFile) : [];
  node.closest = (tagName) => {
    let scope = node;
    while (scope) {
      if (scope.tagName === tagName.toUpperCase()) {
        return scope;
      }
      scope = scope.parentElement;
    }
    return null;
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}

const fileInput = (props = {}) => el("input", { type: "file", ...props });

test("a ref naming the file input itself resolves to it", () => {
  const input = fileInput();
  assert.equal(w.resolveFileInputFrom(input).input, input);
});

test("a label resolves to the input it controls, by property or by htmlFor", () => {
  const input = fileInput();
  assert.equal(
    w.resolveFileInputFrom(el("label", { control: input })).input,
    input,
  );

  // The other half of the same pattern: a label with `for` and the input elsewhere.
  const byId = fileInput({ id: "pick" });
  const label = el("label", {
    htmlFor: "pick",
    ownerDocument: { getElementById: (id) => (id === "pick" ? byId : null) },
  });
  assert.equal(w.resolveFileInputFrom(label).input, byId);
});

test("a button wrapping a hidden input resolves to the input", () => {
  const input = fileInput({ hidden: true });
  const button = el("button", {}, [el("span", {}, []), input]);
  assert.equal(w.resolveFileInputFrom(button).input, input);
});

test("a menu item beside a hidden input resolves through their container", () => {
  // The social preview form, in miniature: the input is a sibling of the menu, not inside it.
  const input = fileInput({ id: "repo-image-file-input" });
  const item = el("span", {}, []);
  el("form", {}, [input, el("details", {}, [el("menu", {}, [item])])]);
  assert.equal(w.resolveFileInputFrom(item).input, input);
});

test("several file inputs in scope is refused, never guessed", () => {
  const first = fileInput({ id: "a" });
  const second = fileInput({ id: "b" });
  const item = el("span", {}, []);
  el("form", {}, [first, second, el("div", {}, [item])]);
  const found = w.resolveFileInputFrom(item);
  assert.equal(found.input, undefined);
  assert.match(found.error, /several file inputs/);
});

test("a control that opens nothing says so, and nothing says no element", () => {
  const lonely = el("button", {}, []);
  el("div", {}, [lonely]);
  assert.match(w.resolveFileInputFrom(lonely).error, /does not open one/);
  assert.match(w.resolveFileInputFrom(null).error, /no element/);
});

test("the page runs this very function, not a copy of it", () => {
  // handleUpload inlines the resolver's source into the declaration it sends. If someone
  // re-implements the search inside the page function, these tests stop covering what ships.
  assert.match(workerSource, /String\(resolveFileInputFrom\)/);
  assert.match(workerSource, /const found = resolveFileInputFrom\(this\);/);
});

// -- naming a file input the page hides --------------------------------------

test("hidden file inputs are collected, named, and flagged", async () => {
  const nodes = [
    { backendNodeId: 11, role: "button", name: "Upload an image" },
  ];
  const attrs = {
    7: ["type", "file", "id", "repo-image-file-input", "multiple", ""],
    9: ["type", "file", "aria-label", "Attach receipts", "accept", "image/*"],
  };
  const worker = loadWorker({
    "debugger.sendCommand": async (_target, method, params) => {
      if (method === "DOM.getDocument") {
        return { root: { nodeId: 1 } };
      }
      if (method === "DOM.querySelectorAll") {
        assert.equal(params.selector, 'input[type="file"]');
        return { nodeIds: [7, 9] };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: params.nodeId,
            nodeName: "INPUT",
            attributes: attrs[params.nodeId],
          },
        };
      }
      return {};
    },
  });
  const collected = await worker.collectFileInputs(1, nodes);
  assert.equal(collected.truncated, false);
  assert.equal(collected.nodes.length, 2);
  const [first, second] = collected.nodes;
  // Named by what the page gives: id when there is nothing better, aria-label when there is.
  assert.equal(first.name, "repo-image-file-input");
  assert.equal(first.role, "filechooser");
  assert.equal(first.hidden_input, true);
  assert.equal(first.multiple, true);
  assert.equal(second.name, "Attach receipts");
  assert.equal(second.accepts, "image/*");
  assert.equal(second.multiple, false);
});

test("an input the accessibility pass already named is not named twice", async () => {
  const worker = loadWorker({
    "debugger.sendCommand": async (_target, method) => {
      if (method === "DOM.getDocument") {
        return { root: { nodeId: 1 } };
      }
      if (method === "DOM.querySelectorAll") {
        return { nodeIds: [42] };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: 42,
            nodeName: "INPUT",
            attributes: ["type", "file"],
          },
        };
      }
      return {};
    },
  });
  // 42 is already in the capture: the page shows this one, and the pass that saw it knows its
  // label and its box. A second entry would be the same control under two refs.
  const collected = await worker.collectFileInputs(1, [
    { backendNodeId: 42, role: "button", name: "Choose file" },
  ]);
  assert.deepEqual(crossRealm(collected.nodes), []);
});

test("a page full of file inputs is capped, and says it was", async () => {
  const many = Array.from(
    { length: w.MAX_FILE_INPUT_NODES + 5 },
    (_, i) => i + 1,
  );
  const worker = loadWorker({
    "debugger.sendCommand": async (_target, method, params) => {
      if (method === "DOM.getDocument") {
        return { root: { nodeId: 1 } };
      }
      if (method === "DOM.querySelectorAll") {
        return { nodeIds: many };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: params.nodeId,
            nodeName: "INPUT",
            attributes: ["type", "file"],
          },
        };
      }
      return {};
    },
  });
  const collected = await worker.collectFileInputs(1, []);
  assert.equal(collected.nodes.length, w.MAX_FILE_INPUT_NODES);
  assert.equal(collected.truncated, true);
});

test("a page that exposes no document fails the scan instead of reporting none", async () => {
  const worker = loadWorker({
    "debugger.sendCommand": async () => ({}),
  });
  await assert.rejects(
    () => worker.collectFileInputs(1, []),
    /no document node/,
  );
});
