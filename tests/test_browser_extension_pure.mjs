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
  "boundedMs",
  "boundedCount",
  "CLICK_SAMPLES",
  "shotMatchesRender",
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
];

function loadWorker(overrides = {}) {
  return loadWorkerFrom(EXPORTED, overrides);
}

const w = loadWorker();

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
  assert.equal(w.shotMatchesRender(shot, now), true);
  assert.equal(w.shotMatchesRender(shot, { ...now, scale: 1.5 }), false);
  assert.equal(w.shotMatchesRender(shot, { ...now, offsetX: 133 }), false);
  assert.equal(w.shotMatchesRender(shot, { ...now, offsetY: 76 }), false);
  assert.equal(w.shotMatchesRender(shot, { ...now, dpr: 2.2 }), false);
  assert.equal(w.shotMatchesRender(shot, { ...now, ok: false }), false);
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
  const whole = base64Of("the whole file, in three parts");
  const pieces = [whole.slice(0, 10), whole.slice(10, 22), whole.slice(22)];
  // Deliberately out of order: the sequence number decides, not arrival.
  for (const seq of [2, 0, 1]) {
    await w2.handleUploadChunk({
      upload_id: "u-1",
      seq,
      total: 3,
      data: pieces[seq],
    });
  }
  assert.equal(w2.assembleUpload("u-1"), whole);
});

test("a missing piece assembles to nothing rather than a hole", async () => {
  const w2 = loadWorker();
  await w2.handleUploadChunk({
    upload_id: "u-2",
    seq: 0,
    total: 2,
    data: base64Of("first"),
  });
  assert.equal(w2.assembleUpload("u-2"), null);
  assert.equal(w2.assembleUpload("never-sent"), null);
});

test("an upload's pieces must agree on how many there are", async () => {
  const w2 = loadWorker();
  await w2.handleUploadChunk({
    upload_id: "u-3",
    seq: 0,
    total: 2,
    data: "AA",
  });
  await assert.rejects(
    () =>
      w2.handleUploadChunk({ upload_id: "u-3", seq: 1, total: 5, data: "BB" }),
    /disagree/,
  );
});

test("an out-of-range or unnamed piece is refused", async () => {
  const w2 = loadWorker();
  await assert.rejects(
    () => w2.handleUploadChunk({ upload_id: "", seq: 0, total: 1, data: "AA" }),
    /upload_id/,
  );
  await assert.rejects(
    () =>
      w2.handleUploadChunk({ upload_id: "u-4", seq: 3, total: 2, data: "AA" }),
    /out of range/,
  );
  await assert.rejects(
    () =>
      w2.handleUploadChunk({
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
  for (let i = 0; i < w2.MAX_UPLOADS_IN_FLIGHT; i += 1) {
    await w2.handleUploadChunk({
      upload_id: `u-${i}`,
      seq: 0,
      total: 1,
      data: "AA",
    });
  }
  await assert.rejects(
    () =>
      w2.handleUploadChunk({
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
  await w2.handleUploadChunk({
    upload_id: "u-5",
    seq: 0,
    total: 1,
    data: base64Of("bytes of a file the next session must never see"),
  });
  assert.notEqual(w2.assembleUpload("u-5"), null);
  w2.clearUploads();
  assert.equal(w2.assembleUpload("u-5"), null);
});

test("detaching clears uploads, so a file cannot outlive its session", () => {
  // The guarantee above is only real if teardown actually calls it.
  assert.match(workerSource, /clearUploads\(\);/);
  const detachAll = workerSource.slice(
    workerSource.indexOf("async function detachAll("),
    workerSource.indexOf("async function detachAll(") + 2000,
  );
  assert.match(detachAll, /clearUploads\(\)/);
});

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
