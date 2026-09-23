// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The recorder host itself.
//
// tests/test_browser_extension_recording.mjs covers the service worker half and
// stubs this document out, so until now browser/extension/offscreen.js was the one
// shipped file that no test loaded. It shipped with a call that does not exist: it
// built an OffscreenCanvas and asked it for captureStream(), which is defined on
// HTMLCanvasElement only. Every recording failed on its first real start with
// "canvas.captureStream is not a function", and nothing caught it because nothing
// ran the file.
//
// The harness therefore models the platform fact rather than a convenient stub:
// OffscreenCanvas EXISTS here and has no captureStream, exactly as in Chrome. A
// recorder that reaches for one fails these tests the way it failed in the browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "..", "browser", "extension", "offscreen.js"),
  "utf8",
);

function makeTrack() {
  return {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
}

// Everything the document is given, plus a record of what it reached for.
function load() {
  const seen = {
    createdElements: [],
    offscreenCanvases: 0,
    recorders: [],
    tracks: [],
    canvases: [],
  };

  class OffscreenCanvas {
    constructor(width, height) {
      seen.offscreenCanvases += 1;
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { drawImage() {} };
    }
    // Deliberately no captureStream: this is what Chrome ships.
  }

  class MediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
      this.ondataavailable = null;
      this.onstop = null;
      seen.recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      if (this.onstop) {
        this.onstop();
      }
    }
    // What a real recorder does between start and stop.
    emit(size) {
      if (this.ondataavailable) {
        this.ondataavailable({ data: { size } });
      }
    }
  }

  const document = {
    createElement(tag) {
      seen.createdElements.push(tag);
      if (tag !== "canvas") {
        return {};
      }
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        captureStream: () => {
          const track = makeTrack();
          seen.tracks.push(track);
          return { getTracks: () => [track] };
        },
      };
      seen.canvases.push(canvas);
      return canvas;
    },
  };

  let listener = null;
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    document,
    OffscreenCanvas,
    MediaRecorder,
    Blob: class {
      constructor(chunks) {
        this.size = chunks.reduce((total, c) => total + (c.size || 0), 0);
      }
    },
    FileReader: class {
      readAsDataURL() {
        this.result = "data:video/webm;base64,AAAA";
        if (this.onload) {
          this.onload();
        }
      }
    },
    createImageBitmap: async () => ({ close() {} }),
    fetch: async () => ({ blob: async () => ({}) }),
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: "offscreen.js" });
  assert.ok(listener, "offscreen.js registered no message listener");

  // Deliver one message the way chrome.runtime.sendMessage does, and resolve
  // with whatever the document answers, synchronously or not.
  //
  // The answer is round-tripped through JSON because it was built inside the vm
  // realm: its prototype is that realm Object, so a strict deep-equal against a
  // literal written out here fails on identity alone. Chrome serializes these
  // replies across the message channel anyway, so this matches what the worker
  // actually receives.
  const send = (message) =>
    new Promise((resolve) => {
      listener(
        { target: "chrome_control_mcp.offscreen", ...message },
        {},
        (value) => resolve(JSON.parse(JSON.stringify(value))),
      );
    });

  return { send, seen, listener };
}

test("a recording starts, and records from a canvas that can be captured", async () => {
  const { send, seen } = load();
  const answer = await send({ type: "record.start", session: "s1" });
  assert.deepEqual(answer, { ok: true });
  // The regression this file exists for: an OffscreenCanvas has no
  // captureStream, so reaching for one is the bug, not a style preference.
  assert.equal(seen.offscreenCanvases, 0);
  assert.deepEqual(seen.createdElements, ["canvas"]);
});

test("the canvas takes the size it was asked for", async () => {
  const { send, seen } = load();
  await send({ type: "record.start", session: "s1", width: 640, height: 480 });
  assert.equal(seen.canvases[0].width, 640);
  assert.equal(seen.canvases[0].height, 480);
  assert.equal(seen.recorders[0].state, "recording");
});

test("a start without a size still gets a usable canvas", async () => {
  const { send, seen } = load();
  await send({ type: "record.start", session: "s1" });
  assert.ok(seen.canvases[0].width > 0);
  assert.ok(seen.canvases[0].height > 0);
});

test("one host serves several sessions, each with its own recorder", async () => {
  const { send, seen } = load();
  assert.deepEqual(await send({ type: "record.start", session: "a" }), {
    ok: true,
  });
  assert.deepEqual(await send({ type: "record.start", session: "b" }), {
    ok: true,
  });
  assert.equal(seen.recorders.length, 2);
  assert.notEqual(seen.recorders[0], seen.recorders[1]);
});

test("a second start for the same session is refused, not silently restarted", async () => {
  const { send } = load();
  await send({ type: "record.start", session: "a" });
  assert.deepEqual(await send({ type: "record.start", session: "a" }), {
    ok: false,
    error: "already recording",
  });
});

test("a frame for a session that is not recording is refused", async () => {
  const { send } = load();
  assert.deepEqual(
    await send({ type: "record.frame", session: "ghost", data: "" }),
    { ok: false, error: "not recording" },
  );
});

test("frames are counted per session", async () => {
  const { send } = load();
  await send({ type: "record.start", session: "a" });
  assert.deepEqual(
    await send({ type: "record.frame", session: "a", data: "x" }),
    { ok: true, frames: 1 },
  );
  assert.deepEqual(
    await send({ type: "record.frame", session: "a", data: "x" }),
    { ok: true, frames: 2 },
  );
});

test("a recording that captured nothing is an error, not a zero-byte video", async () => {
  const { send } = load();
  await send({ type: "record.start", session: "a" });
  assert.deepEqual(await send({ type: "record.stop", session: "a" }), {
    ok: false,
    error: "The recording captured no frames.",
  });
});

test("stopping returns the bytes and releases the capture", async () => {
  const { send, seen } = load();
  await send({ type: "record.start", session: "a" });
  seen.recorders[0].emit(1024);
  const answer = await send({ type: "record.stop", session: "a" });
  assert.equal(answer.ok, true);
  assert.equal(answer.bytes, 1024);
  assert.ok(answer.url.startsWith("data:video/webm"));
  assert.ok(
    seen.tracks.every((t) => t.stopped),
    "a track was left running",
  );
});

test("discarding drops the bytes and releases the capture", async () => {
  const { send, seen } = load();
  await send({ type: "record.start", session: "a" });
  seen.recorders[0].emit(2048);
  assert.deepEqual(await send({ type: "record.discard", session: "a" }), {
    ok: true,
    discarded: true,
  });
  assert.ok(
    seen.tracks.every((t) => t.stopped),
    "a track was left running",
  );
  // The session is gone, so a stop afterwards finds nothing.
  assert.deepEqual(await send({ type: "record.stop", session: "a" }), {
    ok: false,
    error: "not recording",
  });
});

test("discarding a session that is not recording is not an error", async () => {
  const { send } = load();
  assert.deepEqual(await send({ type: "record.discard", session: "ghost" }), {
    ok: true,
    discarded: false,
  });
});

test("one session stopping leaves another session recording", async () => {
  const { send, seen } = load();
  await send({ type: "record.start", session: "a" });
  await send({ type: "record.start", session: "b" });
  seen.recorders[0].emit(512);
  assert.equal((await send({ type: "record.stop", session: "a" })).ok, true);
  assert.deepEqual(
    await send({ type: "record.frame", session: "b", data: "x" }),
    { ok: true, frames: 1 },
  );
});

test("a message addressed elsewhere is ignored", async () => {
  const { listener } = load();
  let answered = false;
  const kept = listener(
    { target: "somebody.else", type: "record.start" },
    {},
    () => {
      answered = true;
    },
  );
  assert.equal(kept, false);
  assert.equal(answered, false);
});

test("an unknown message type is refused rather than ignored", async () => {
  const { send } = load();
  assert.deepEqual(await send({ type: "record.rewind", session: "a" }), {
    ok: false,
    error: "unknown offscreen message",
  });
});
