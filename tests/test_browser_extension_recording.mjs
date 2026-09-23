// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Recording a tab to a .webm, and what happens when the session doing it ends.
//
// The video never comes back through a tool reply -- the bridge is one command,
// one reply, with hard caps on the reply -- so browser_record_stop returns a
// path. The risk that matters is not a missing file but a MISLEADING one: a
// session that dies mid-recording must leave no encoder running and must not
// hand back a truncated file as though it were the recording that was asked
// for.
//
// The encoder itself lives in an offscreen document (MediaRecorder needs a DOM
// the service worker does not have), which cannot run here. What is exercised
// is everything the worker owns: the refusals, the state, the timeline, and the
// messages it sends the recorder.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWorker, makeFakePort, settle } from "./extension_harness.mjs";

const EXPORTED = [
  "handleRecordStart",
  "handleRecordStop",
  "handleSelectTab",
  "handleNewTab",
  "handleWindow",
  "releaseAttachedState",
  "noteCommandForRecording",
];
const LIVE = "only: () => [...sessions][0]";

// Stand in for the offscreen document: record what the worker asked it to do
// and answer as the real recorder would.
function bootWorker({ stopAnswer } = {}) {
  const toRecorder = [];
  const cdp = [];
  const downloads = [];
  const worker = loadWorker(
    EXPORTED,
    {
      "runtime.connectNative": () => makeFakePort(),
      "runtime.getContexts": () =>
        Promise.resolve([{ contextType: "OFFSCREEN_DOCUMENT" }]),
      "runtime.sendMessage": (message) => {
        toRecorder.push(message);
        if (message.type === "record.stop") {
          return Promise.resolve(
            stopAnswer ?? {
              ok: true,
              url: "data:video/webm;base64,AAAA",
              bytes: 4096,
            },
          );
        }
        return Promise.resolve({ ok: true });
      },
      "debugger.attach": () => Promise.resolve(),
      "debugger.sendCommand": (_target, method) => {
        cdp.push(method);
        return Promise.resolve({});
      },
      "downloads.download": (options) => {
        downloads.push(options);
        return Promise.resolve(downloads.length);
      },
      "downloads.search": ({ id }) =>
        Promise.resolve([
          {
            id,
            state: "complete",
            filename: "C:/saved/" + downloads[id - 1].filename,
          },
        ]),
    },
    LIVE,
  );
  return { worker, toRecorder, cdp, downloads };
}

const sentTo = (toRecorder, type) => toRecorder.filter((m) => m.type === type);

test("starting a recording attaches, opens an encoder, and turns on screencast", async () => {
  const { worker, toRecorder, cdp } = bootWorker();
  const session = worker.only();

  const started = await worker.handleRecordStart(session, 7, {
    filename: "runs/login.webm",
  });

  assert.equal(started.ok, true);
  assert.equal(started.filename, "runs/login.webm");
  assert.ok(session.recording, "the session holds the recording");
  assert.equal(session.recording.tabId, 7);
  assert.equal(sentTo(toRecorder, "record.start").length, 1);
  assert.ok(
    cdp.includes("Page.startScreencast"),
    "frames have to be turned on or nothing is captured",
  );
  // Every message to the recorder names the session it is for: one offscreen
  // document serves them all, so there is no "current" recording to imply.
  assert.equal(
    sentTo(toRecorder, "record.start")[0].session,
    session.recording.id,
  );
});

test("a second start for the same session is refused, not silently restarted", async () => {
  // Restarting would discard the first recording with no way to tell it had
  // happened, which loses work rather than reporting a conflict.
  const { worker, toRecorder } = bootWorker();
  const session = worker.only();
  await worker.handleRecordStart(session, 7, {});
  const first = session.recording.id;

  await assert.rejects(
    () => worker.handleRecordStart(session, 7, {}),
    /already recording/i,
  );
  assert.equal(session.recording.id, first, "the first recording is untouched");
  assert.equal(sentTo(toRecorder, "record.start").length, 1);
});

test("a filename that escapes the downloads folder is refused", async () => {
  const { worker } = bootWorker();
  const session = worker.only();
  for (const bad of [
    "../escape.webm",
    "/abs/path.webm",
    "C:/abs/path.webm",
    "runs/../../escape.webm",
  ]) {
    await assert.rejects(
      () => worker.handleRecordStart(session, 7, { filename: bad }),
      /relative name/i,
      `must refuse ${bad}`,
    );
    assert.equal(session.recording, null, "and start nothing");
  }
  await assert.rejects(
    () => worker.handleRecordStart(session, 7, { filename: "runs/clip.mp4" }),
    /\.webm/i,
  );
});

test("stopping returns a path and a timeline, never the bytes", async () => {
  const { worker, downloads, cdp } = bootWorker();
  const session = worker.only();
  await worker.handleRecordStart(session, 7, { filename: "runs/login.webm" });

  // Two commands run while recording.
  worker.noteCommandForRecording(session, "b-1", "navigate");
  session.domEpoch += 1;
  worker.noteCommandForRecording(session, "b-2", "click");

  const stopped = await worker.handleRecordStop(session);

  assert.equal(stopped.ok, true);
  assert.match(stopped.path, /login\.webm$/);
  assert.equal(stopped.bytes, 4096);
  assert.equal(stopped.commands, 2);
  assert.match(stopped.timeline_path, /login\.timeline\.json$/);
  assert.equal(session.recording, null, "the session is no longer recording");
  assert.ok(cdp.includes("Page.stopScreencast"));

  // The reply carries a path, not a video: the bridge caps a reply far below
  // the size of any real recording.
  assert.equal(Object.hasOwn(stopped, "data"), false);
  assert.equal(Object.hasOwn(stopped, "bytes_base64"), false);

  // The timeline is written beside the video, and says what ran when.
  const timeline = downloads.find((d) => /timeline\.json$/.test(d.filename));
  assert.ok(timeline, "a timeline file is saved");
  const written = JSON.parse(
    Buffer.from(timeline.url.split(",")[1], "base64").toString("utf8"),
  );
  assert.equal(written.commands.length, 2);
  assert.equal(written.commands[0].cmd, "navigate");
  assert.equal(written.commands[0].id, "b-1");
  assert.equal(typeof written.commands[0].offset_ms, "number");
  assert.equal(
    written.commands[1].dom_epoch,
    written.commands[0].dom_epoch + 1,
    "the DOM generation at each command is what makes a frame readable",
  );
});

test("stopping when nothing is recording is an error, not an empty file", async () => {
  const { worker, downloads } = bootWorker();
  await assert.rejects(
    () => worker.handleRecordStop(worker.only()),
    /not recording/i,
  );
  assert.deepEqual(downloads, [], "and nothing is written");
});

test("RED DRILL: a session ending mid-recording leaves no encoder and no file", async () => {
  // This is the failure the whole design is arranged around. When a session
  // dies -- the bridge drops, the user closes the tab, DevTools detaches us --
  // the frames stop arriving and the bytes already encoded cover only part of
  // what was asked for. Writing them out would hand back a file that looks
  // complete and is not. The encoder must be released and the partial bytes
  // dropped.
  const { worker, toRecorder, downloads } = bootWorker();
  const session = worker.only();
  await worker.handleRecordStart(session, 7, { filename: "runs/doomed.webm" });
  const id = session.recording.id;

  worker.releaseAttachedState(session);
  await settle();

  assert.equal(session.recording, null, "the session stops claiming to record");

  const discarded = sentTo(toRecorder, "record.discard");
  assert.equal(discarded.length, 1, "the encoder is told to let go");
  assert.equal(discarded[0].session, id, "of that session's recording");

  assert.equal(
    sentTo(toRecorder, "record.stop").length,
    0,
    "it is discarded, not finalized",
  );
  assert.deepEqual(
    downloads,
    [],
    "and no partial file is written, let alone reported as the recording",
  );
});

test("moving to another tab while recording is refused, not silently ended", async () => {
  // A recording follows one tab. Ending it because the operator changed tabs
  // would lose the video to an action they could have done in the other order,
  // and there is no channel to tell them it happened -- so it is refused.
  const { worker, downloads } = bootWorker();
  const session = worker.only();
  await worker.handleRecordStart(session, 7, {});
  const id = session.recording.id;

  await assert.rejects(
    () => worker.handleSelectTab(session, { index: 0 }),
    /refused while this session is recording/i,
  );
  await assert.rejects(
    () => worker.handleNewTab(session, {}),
    /refused while this session is recording/i,
  );
  await assert.rejects(
    () => worker.handleWindow(session, { action: "new" }),
    /refused while this session is recording/i,
  );

  assert.equal(session.recording.id, id, "the recording is untouched");
  assert.deepEqual(downloads, [], "and nothing was written");
});

test("a release with nothing recording asks the encoder for nothing", async () => {
  const { worker, toRecorder } = bootWorker();
  worker.releaseAttachedState(worker.only());
  await settle();
  assert.equal(sentTo(toRecorder, "record.discard").length, 0);
});

test("the timeline cannot grow without bound", async () => {
  // It is held in memory for the life of the recording, so a runaway loop must
  // not be able to grow it until the worker dies.
  const { worker } = bootWorker();
  const session = worker.only();
  await worker.handleRecordStart(session, 7, {});
  for (let i = 0; i < 6000; i += 1) {
    worker.noteCommandForRecording(session, "b-" + i, "click");
  }
  assert.ok(session.recording.timeline.length < 6000, "the timeline is capped");
});
