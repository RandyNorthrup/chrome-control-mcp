// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Waiting for the browser-control extension to attach to a freshly started MCP server.
//
// The extension reaches a server only after the server publishes its rendezvous record, and how
// soon depends on the extension's service worker. While the worker is alive it retries every
// 2 s; Chrome retires an idle MV3 worker after about 30 s, and from then on only the standing
// reconnect alarm (every 30 s -- RECONNECT_ALARM in browser/extension/background.js) brings the
// bridge up, "within a minute of the server publishing its record". A fixed sleep either wastes
// that minute or races it: on macOS three consecutive attaches took 1.8 s, 6.6 s and 9.1 s, and a
// 3 s sleep failed two of them before the first browser call.
//
// So a live suite polls a read-only tool until the extension answers, up to that documented
// minute. Any error other than "not attached" is a real failure and is reported as it is rather
// than waited out.

// The extension reconnects every 2 s while its service worker is alive, and otherwise on a 30 s
// alarm -- and Chrome coalesces a background worker's timers, so a browser that started before
// its server can take the better part of a minute to find it. Measured: 6-10 s on a foreground
// Chrome, longer on several dedicated browsers starting at once.
//
// 90 s covered three alarm periods, which was enough until the matrix began running two browsers
// at a time on a hosted Windows runner: two configurations there failed with "did not attach
// within 90 s" and both passed on a re-run, which is a budget sitting right on the edge rather
// than a broken bridge. A deadline that is occasionally too short does not find bugs, it
// manufactures them -- and every second of it is spent only when the attach is actually slow, so
// a generous one costs nothing on a fast machine.
const ATTACH_DEADLINE_MS = 180_000;
const POLL_MS = 250;
const NOT_ATTACHED = "extension is not attached";

// `callTool(name, args)` resolves to {isError, text}. Resolves to the milliseconds the attach
// took; rejects when the deadline passes or a browser call fails for another reason.
export async function waitForExtensionAttached(
  callTool,
  deadlineMs = ATTACH_DEADLINE_MS,
) {
  const started = Date.now();
  for (;;) {
    const { isError, text } = await callTool("browser_tabs", {});
    if (!isError) {
      return Date.now() - started;
    }
    if (!String(text).includes(NOT_ATTACHED)) {
      throw new Error(`Waiting for the extension to attach: ${text}`);
    }
    if (Date.now() - started >= deadlineMs) {
      throw new Error(
        `The browser-control extension did not attach within ` +
          `${deadlineMs / 1000} s; is it loaded in chrome://extensions?`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
