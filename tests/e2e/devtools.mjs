// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The dedicated browser's own DevTools, for what a live suite must look at that no tool offers and
// no agent may do: the extension's service worker itself. isolated_run.mjs passes the browser's
// profile as CHROME_USER_DATA_DIR, where Chrome writes the port it listens on.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function devtoolsEndpoint(timeoutMs = 15000) {
  const profile = process.env.CHROME_USER_DATA_DIR;
  assert.ok(
    profile,
    "CHROME_USER_DATA_DIR is not set; run through isolated_run.mjs",
  );
  const file = path.join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!existsSync(file) && Date.now() - started < timeoutMs) {
    await sleep(250);
  }
  assert.ok(existsSync(file), "the browser wrote no DevToolsActivePort");
  const [port] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  return { port: Number(port) };
}

// Every target the browser lists: pages, and the extension's service worker.
export async function targets(endpoint) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`);
  return response.json();
}

// The ID the dedicated browser gave this extension (isolated_run.mjs derives it from the key the
// loaded manifest names: the unpacked build's, or the store build's under --store-key). Chrome
// lists its own component extensions' workers beside it.
export const EXTENSION_ID =
  process.env.CHROME_CONTROL_MCP_E2E_EXTENSION_ID ||
  "iojehhmnaigcejfcpmilpclmeljhlkaa";

// The extension's service worker target, or null while it is not running (a reload is under way).
export async function extensionWorker(endpoint) {
  const list = await targets(endpoint);
  return (
    list.find(
      (entry) =>
        entry.type === "service_worker" &&
        entry.url === `chrome-extension://${EXTENSION_ID}/background.js`,
    ) || null
  );
}

// Evaluate @p expression (awaited, returned by value) in the target at @p webSocketDebuggerUrl,
// over a socket opened for this one call.
export async function evaluateIn(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools socket failed"));
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("DevTools evaluate timed out")),
        15000,
      );
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) {
          clearTimeout(timer);
          resolve(message);
        }
      };
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (reply.error) {
      throw new Error(reply.error.message);
    }
    if (reply.result.exceptionDetails) {
      throw new Error(
        reply.result.exceptionDetails.exception?.description ||
          reply.result.exceptionDetails.text,
      );
    }
    return reply.result.result.value;
  } finally {
    socket.close();
  }
}
