// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The recorder host.
//
// MediaRecorder needs a DOM and the service worker has none, so encoding runs
// here. Chrome allows exactly ONE offscreen document per extension, which means
// this single page serves every assistant session the worker holds -- so it
// keeps a map of recorders keyed by session, and every message names the
// session it is for. There is no "current" recording: a value that meant "the
// one being recorded" would be wrong the moment a second session started one.
//
// Frames arrive as base64 JPEG from CDP Page.startScreencast rather than from
// chrome.tabCapture, which cannot be used here: tabCapture requires the
// activeTab grant, and that comes only from a user invoking the extension on
// that tab. An agent-driven start has no such invocation. Screencast needs no
// gesture and no permission this extension does not already hold, at the cost
// of video only -- no audio -- and whatever frame pacing CDP delivers.

const recorders = new Map();

// A recording that produced no frame at all has nothing to encode. Reporting a
// zero-byte file as a video would be worse than failing.
function finish(entry, resolve) {
  const blob = new Blob(entry.chunks, { type: "video/webm" });
  if (blob.size === 0) {
    resolve({ ok: false, error: "The recording captured no frames." });
    return;
  }
  const reader = new FileReader();
  // A blob: URL created here would be revoked when this document is torn down,
  // which can happen before the download finishes. A data: URL carries the
  // bytes, so the download owns them.
  reader.onload = () =>
    resolve({ ok: true, url: String(reader.result), bytes: blob.size });
  reader.onerror = () =>
    resolve({ ok: false, error: "The recording could not be read back." });
  reader.readAsDataURL(blob);
}

function startRecording(message) {
  if (recorders.has(message.session)) {
    return { ok: false, error: "already recording" };
  }
  // A DOM canvas, not an OffscreenCanvas: captureStream() is defined on
  // HTMLCanvasElement and does not exist on OffscreenCanvas, so an
  // OffscreenCanvas here fails with "canvas.captureStream is not a function"
  // the first time a recording starts. Having a DOM is the whole reason this
  // document exists -- the service worker has none -- so use it.
  const canvas = document.createElement("canvas");
  canvas.width = message.width || 1280;
  canvas.height = message.height || 800;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(message.fps || 10);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const entry = { canvas, context, stream, recorder, chunks: [], frames: 0 };
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      entry.chunks.push(event.data);
    }
  };
  recorders.set(message.session, entry);
  recorder.start(1000);
  return { ok: true };
}

async function drawFrame(message) {
  const entry = recorders.get(message.session);
  if (!entry) {
    return { ok: false, error: "not recording" };
  }
  const bitmap = await createImageBitmap(
    await (await fetch("data:image/jpeg;base64," + message.data)).blob(),
  );
  // The page can change size mid-recording. Resizing the canvas would restart
  // the encoder's stream, so the frame is fitted into the canvas it started
  // with instead -- the video keeps one resolution throughout.
  entry.context.drawImage(
    bitmap,
    0,
    0,
    entry.canvas.width,
    entry.canvas.height,
  );
  bitmap.close();
  entry.frames += 1;
  return { ok: true, frames: entry.frames };
}

function stopRecording(message) {
  const entry = recorders.get(message.session);
  if (!entry) {
    return Promise.resolve({ ok: false, error: "not recording" });
  }
  recorders.delete(message.session);
  return new Promise((resolve) => {
    entry.recorder.onstop = () => {
      for (const track of entry.stream.getTracks()) {
        track.stop();
      }
      finish(entry, resolve);
    };
    // A recorder that never started cannot be stopped; treat it as an empty
    // recording rather than leaving the caller waiting on an event that will
    // not arrive.
    if (entry.recorder.state === "inactive") {
      entry.recorder.onstop();
      return;
    }
    entry.recorder.stop();
  });
}

// Discard without producing a file. This is what a session dying mid-recording
// gets: the encoder is released and the partial bytes are dropped, because a
// truncated file reported as a finished video is worse than no file.
function discardRecording(message) {
  const entry = recorders.get(message.session);
  if (!entry) {
    return { ok: true, discarded: false };
  }
  recorders.delete(message.session);
  try {
    if (entry.recorder.state !== "inactive") {
      entry.recorder.stop();
    }
  } catch (_e) {
    // Already stopped; the tracks below are what actually matter.
  }
  for (const track of entry.stream.getTracks()) {
    track.stop();
  }
  entry.chunks.length = 0;
  return { ok: true, discarded: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "chrome_control_mcp.offscreen") {
    return false;
  }
  const answer = (value) => sendResponse(value);
  try {
    switch (message.type) {
      case "record.start":
        answer(startRecording(message));
        return false;
      case "record.frame":
        drawFrame(message).then(answer, (e) =>
          answer({ ok: false, error: String((e && e.message) || e) }),
        );
        return true;
      case "record.stop":
        stopRecording(message).then(answer, (e) =>
          answer({ ok: false, error: String((e && e.message) || e) }),
        );
        return true;
      case "record.discard":
        answer(discardRecording(message));
        return false;
      default:
        answer({ ok: false, error: "unknown offscreen message" });
        return false;
    }
  } catch (e) {
    answer({ ok: false, error: String((e && e.message) || e) });
    return false;
  }
});
