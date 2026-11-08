// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// A browser_upload's file staged in the page (docs/plans/large-uploads.md). The app sends each
// piece as an uploadStage command naming the tab; the worker hands it straight to an object made
// in the realm of what the file is for and keeps only a count, so a file is never whole in the
// worker. The final upload passes that object by its DevTools handle, and every way an upload can
// end lets go of what the page gathered.
//
// The page is a stand-in that answers the DevTools calls the worker makes. The functions the worker
// sends to the page run here for real, on Node's own Blob, so what they build is checked byte for
// byte.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PROTOCOL, attachedBrowser, command } from "./browser_model.mjs";
import { loadWorker, settle } from "./extension_harness.mjs";

const EXPORTED = [
  "holdTab",
  "stageAppendFn",
  "MAX_STAGED_UPLOAD_BYTES",
  "MAX_STAGE_PIECE_BASE64",
];

// A page that holds staged objects, runs the functions the worker sends it, and records what the
// final assignment was given. `gone` makes it behave as a page that navigated away.
function stagingPage() {
  const page = { stages: new Map(), assigned: [], released: [], gone: false };
  let made = 0;
  page.cdp = (_tabId, method, params) => {
    if (method === "DOM.resolveNode") {
      return { object: { objectId: "node-" + params.backendNodeId } };
    }
    if (method === "Runtime.evaluate" && params.expression === "window") {
      return { result: { objectId: "window" } };
    }
    if (method === "Runtime.releaseObjectGroup") {
      page.released.push(params.objectGroup);
      return {};
    }
    if (method !== "Runtime.callFunctionOn") {
      return undefined;
    }
    const declaration = params.functionDeclaration;
    // Whether the input is already on screen, before it is brought into view: it is not.
    if (declaration.startsWith("function whollyInViewFn")) {
      return { result: { value: false } };
    }
    if (declaration.includes("pendingBytes: 0")) {
      made += 1;
      const objectId = "stage-" + made;
      page.stages.set(objectId, {
        blob: new Blob([]),
        pending: [],
        pendingBytes: 0,
        bytes: 0,
        group: params.objectGroup,
        anchor: params.objectId,
      });
      return { result: { objectId } };
    }
    if (declaration.startsWith("function stageAppendFn")) {
      if (page.gone) {
        return Promise.reject(
          new Error("Cannot find context with specified id"),
        );
      }
      const fn = new Function(`return (${declaration})`)();
      const value = fn.apply(
        page.stages.get(params.objectId),
        params.arguments.map((a) => a.value),
      );
      return { result: { value } };
    }
    // The assignment: say what it was given, and answer as a page that took the file would.
    page.assigned.push(params);
    return {
      result: {
        value: {
          ok: true,
          files: [{ name: "clip.mp4", size: 0, type: "video/mp4" }],
          delivered_by: "input",
        },
      },
    };
  };
  return page;
}

async function browserWithTab() {
  const page = stagingPage();
  const b = await attachedBrowser("100", {
    exported: EXPORTED,
    live: "sessions",
    cdp: (...args) => page.cdp(...args),
  });
  const tab = b.addTab({ active: false });
  b.worker.holdTab(b.session, b.copy(tab), "opened");
  await settle();
  return { b, page, tabId: tab.id, state: b.session.tabs.get(tab.id) };
}

// A file cut into pieces of @p piece bytes, each as base64.
function pieces(bytes, piece) {
  const out = [];
  for (let at = 0; at < bytes.length; at += piece) {
    out.push(Buffer.from(bytes.subarray(at, at + piece)).toString("base64"));
  }
  return out.length ? out : [""];
}

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (i * 2654435761) % 251;
  }
  return bytes;
}

async function stage(b, tabId, id, data, seq, total, size, extra = {}) {
  return command(b.port, "uploadStage", {
    tab_id: tabId,
    upload_id: id,
    seq,
    total,
    size,
    data,
    ...extra,
  });
}

test("the page folds what it gathers into a Blob, and it comes back byte for byte", async () => {
  const w = loadWorker(EXPORTED);
  const file = randomBytes(5000);
  const target = { blob: new Blob([]), pending: [], pendingBytes: 0, bytes: 0 };
  // Rebuilt from its source, as the page receives it: the worker sends the text, not the function.
  const stageAppend = new Function(`return (${String(w.stageAppendFn)})`)();
  for (const piece of pieces(file, 700)) {
    stageAppend.call(target, piece, 1500);
  }
  // Folded at least once along the way, with the rest still gathering.
  assert.ok(target.blob.size >= 1500);
  assert.equal(target.bytes, file.length);
  const whole = new Blob([target.blob, ...target.pending]);
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), file);
});

test("a file's pieces go straight into the page, and the worker keeps only a count", async () => {
  const { b, page, tabId, state } = await browserWithTab();
  state.fileChooser = { kind: "input", backendNodeId: 7, multiple: false };
  const file = randomBytes(3000);
  const parts = pieces(file, 1024);
  for (let seq = 0; seq < parts.length; seq += 1) {
    const reply = await stage(
      b,
      tabId,
      "u-1-0",
      parts[seq],
      seq,
      parts.length,
      file.length,
    );
    assert.equal(reply.type, "result", JSON.stringify(reply));
    assert.equal(reply.payload.received, seq + 1);
  }
  // Made in the realm of the picker's input, under a group of its own.
  const [staged] = [...page.stages.values()];
  assert.equal(staged.anchor, "node-7");
  assert.match(staged.group, /^ccmcp-upload-\d+$/);
  // The worker holds no byte of it.
  const entry = b.session.uploadChunks.get("u-1-0");
  assert.equal(entry.staged, true);
  assert.equal(entry.next, parts.length);
  assert.equal(entry.bytes, file.length);
  assert.equal(entry.pieces, undefined);
  assert.equal(
    JSON.stringify(entry).includes(parts[0].slice(0, 16)),
    false,
    "no piece is kept in the worker",
  );
  const whole = new Blob([staged.blob, ...staged.pending]);
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), file);
});

test("the upload assigns the staged file by its handle, and lets go of it", async () => {
  const { b, page, tabId, state } = await browserWithTab();
  state.fileChooser = { kind: "input", backendNodeId: 7, multiple: false };
  const file = randomBytes(2000);
  const parts = pieces(file, 1500);
  for (let seq = 0; seq < parts.length; seq += 1) {
    await stage(b, tabId, "u-2-0", parts[seq], seq, parts.length, file.length);
  }
  const reply = await command(b.port, "upload", {
    tab_id: tabId,
    files: [
      {
        upload_id: "u-2-0",
        name: "clip.mp4",
        mime: "video/mp4",
        size: file.length,
      },
    ],
  });
  assert.equal(reply.type, "result", JSON.stringify(reply));
  const [assignment] = page.assigned;
  assert.equal(assignment.objectId, "node-7");
  const [delivered, handle] = assignment.arguments;
  assert.deepEqual(JSON.parse(JSON.stringify(delivered.value)), [
    { stage: 0, name: "clip.mp4", mime: "video/mp4", size: file.length },
  ]);
  assert.equal(handle.objectId, [...page.stages.keys()][0]);
  // No byte rode along by value, and the page was told to drop what it gathered.
  assert.equal(JSON.stringify(delivered).includes("data"), false);
  assert.equal(b.session.uploadChunks.size, 0);
  await settle();
  assert.ok(page.released.includes([...page.stages.values()][0].group));
});

test("a picker the page opened takes staged files through its window", async () => {
  const { b, page, tabId, state } = await browserWithTab();
  state.fileChooser = { kind: "picker", multiple: false };
  const file = randomBytes(900);
  await stage(b, tabId, "u-3-0", pieces(file, 4096)[0], 0, 1, file.length);
  assert.equal([...page.stages.values()][0].anchor, "window");
  await command(b.port, "upload", {
    tab_id: tabId,
    files: [{ upload_id: "u-3-0", name: "a.bin", mime: "", size: file.length }],
  });
  const [answer] = page.assigned;
  assert.equal(answer.objectId, "window");
  assert.equal(answer.arguments.length, 3);
  assert.equal(answer.arguments[2].objectId, [...page.stages.keys()][0]);
  assert.equal(answer.arguments[0].value[0].stage, 0);
});

test("pieces out of order, oversized, not base64, or past the file's size are refused", async () => {
  const { b, page, tabId, state } = await browserWithTab();
  state.fileChooser = { kind: "input", backendNodeId: 7, multiple: true };
  const piece = Buffer.from("abcdef").toString("base64");
  const error = async (args) => {
    const reply = await stage(b, tabId, ...args);
    assert.equal(reply.type, "error", JSON.stringify(reply));
    return reply.error;
  };
  // Starting anywhere but the first piece.
  assert.match(await error(["u-a", piece, 1, 2, 12]), /out of order/);
  // A gap after the first: the upload ends, and what the page gathered goes.
  await stage(b, tabId, "u-b", piece, 0, 3, 18);
  assert.match(await error(["u-b", piece, 2, 3, 18]), /out of order/);
  assert.equal(b.session.uploadChunks.has("u-b"), false);
  await settle();
  assert.ok(page.released.includes([...page.stages.values()][0].group));
  // Larger than one bridge message.
  const huge = "A".repeat(b.worker.MAX_STAGE_PIECE_BASE64 + 4);
  assert.match(
    await error(["u-c", huge, 0, 1, 1]),
    /larger than one bridge message/,
  );
  // Not base64.
  assert.match(await error(["u-d", "not base64!", 0, 1, 8]), /not base64/);
  // More than the file's size.
  assert.match(
    await error(["u-e", piece, 0, 1, 2]),
    /more than the file's size/,
  );
  // Past what this extension delivers for one file, whatever it is told.
  assert.match(
    await error(["u-f", piece, 0, 1, b.worker.MAX_STAGED_UPLOAD_BYTES + 1]),
    /larger than this extension delivers/,
  );
  // And the upload that names a file whose pieces did not all arrive assigns nothing.
  await stage(b, tabId, "u-g", piece, 0, 2, 12);
  const reply = await command(b.port, "upload", {
    tab_id: tabId,
    files: [{ upload_id: "u-g", name: "half.bin", mime: "", size: 12 }],
  });
  assert.equal(reply.type, "error");
  assert.match(reply.error, /did not arrive whole/);
  assert.equal(page.assigned.length, 0);
});

test("a piece for a tab the session does not hold is refused", async () => {
  const { b } = await browserWithTab();
  const stranger = b.addTab({ active: false });
  const reply = await stage(b, stranger.id, "u-x", "", 0, 1, 0, {
    backendNodeId: 3,
  });
  assert.equal(reply.type, "error");
  assert.equal(b.session.uploadChunks.size, 0);
});

test("the page changing mid-delivery ends the upload with its reason", async () => {
  const { b, page, tabId } = await browserWithTab();
  const piece = Buffer.from("012345").toString("base64");
  await stage(b, tabId, "u-n", piece, 0, 2, 12, { backendNodeId: 9 });
  page.gone = true;
  const reply = await stage(b, tabId, "u-n", piece, 1, 2, 12, {
    backendNodeId: 9,
  });
  assert.equal(reply.type, "error");
  assert.match(reply.error, /page changed while the file was being delivered/);
  assert.equal(b.session.uploadChunks.has("u-n"), false);
});

test("a staged file goes with its tab's attachment, and a worker-held one stays", async () => {
  const { b, tabId } = await browserWithTab();
  await stage(b, tabId, "u-p", "", 0, 2, 3, { backendNodeId: 4 });
  b.session.uploadChunks.set("held", { total: 1, pieces: new Map(), bytes: 0 });
  b.fire("debugger.onDetach", { tabId }, "target_closed");
  await settle();
  assert.equal(b.session.uploadChunks.has("u-p"), false);
  assert.equal(b.session.uploadChunks.has("held"), true);
});

test("an armed dialog answer survives an upload's pieces", async () => {
  const { b, tabId, state } = await browserWithTab();
  const armed = await command(b.port, "dialog", {
    tab_id: tabId,
    action: "accept",
  });
  assert.equal(armed.type, "result", JSON.stringify(armed));
  const policy = state.pendingDialogPolicy;
  assert.ok(policy, "the dialog answer is armed");
  await stage(b, tabId, "u-d", "", 0, 1, 0, { backendNodeId: 5 });
  assert.equal(
    state.pendingDialogPolicy,
    policy,
    "still armed for the click it was meant for",
  );
});

test("an older app's pieces still gather in the worker, as before", async () => {
  const { b } = await browserWithTab();
  const reply = await command(b.port, "uploadChunk", {
    upload_id: "legacy",
    seq: 0,
    total: 1,
    data: Buffer.from("hello").toString("base64"),
  });
  assert.equal(reply.type, "result", JSON.stringify(reply));
  assert.equal(b.session.uploadChunks.get("legacy").pieces.size, 1);
  assert.equal(PROTOCOL, 2);
});
