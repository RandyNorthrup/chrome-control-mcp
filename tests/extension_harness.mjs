// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Loading browser/extension/background.js under test.
//
// The worker is evaluated AS SHIPPED rather than split into a testable module: extracting
// its functions into their own file would mean changing the artifact that is staged and
// loaded, and then testing the copy instead of the thing that runs. It only touches chrome
// at top level to register listeners and to call connect(), so a recording stub satisfies it
// and every top-level function becomes reachable.
//
// This file holds the loading machinery only. What each suite pulls out of the worker, and
// what it asserts, stays in that suite.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
export const workerPath = join(
  here,
  "..",
  "browser",
  "extension",
  "background.js",
);
export const workerSource = readFileSync(workerPath, "utf8");

// Every chrome.* access resolves to this same callable proxy, so arbitrarily deep chains
// (chrome.debugger.onDetach.addListener(fn)) work without enumerating the API surface.
// It records nothing and returns itself.
// `overrides` maps a dotted path ("tabs.get", "runtime.connectNative") to a real
// implementation. Everything else still resolves to the proxy, so a test that needs Chrome to
// ANSWER something says only what it needs and inherits the rest.
export function makeChromeStub(overrides = {}, path = "") {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return undefined;
      } // must not look like a thenable
      if (typeof prop !== "string") {
        return makeChromeStub(overrides, path);
      }
      const reached = path ? `${path}.${prop}` : prop;
      if (Object.prototype.hasOwnProperty.call(overrides, reached)) {
        return overrides[reached];
      }
      return makeChromeStub(overrides, reached);
    },
    apply() {
      return makeChromeStub(overrides, path);
    },
    construct() {
      return makeChromeStub(overrides, path);
    },
  });
}

// A stand-in for the chrome.runtime.Port that connectNative returns: it records what the
// worker posted and lets a test deliver frames as the native host would. The worker is
// strictly request/reply on this channel, so a test drives it one frame at a time.
export function makeFakePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  const posted = [];
  let connected = true;
  return {
    // -- the chrome.runtime.Port surface the worker uses --
    onMessage: {
      addListener: (fn) => messageListeners.push(fn),
    },
    onDisconnect: {
      addListener: (fn) => disconnectListeners.push(fn),
    },
    postMessage(message) {
      if (!connected) {
        throw new Error("Attempting to use a disconnected port object");
      }
      posted.push(message);
    },
    disconnect() {
      connected = false;
    },

    // -- the test's side --
    posted,
    get connected() {
      return connected;
    },
    // Deliver one frame from the host. Returns after every listener has been invoked; the
    // worker's own handling may still be in flight, so callers that need the reply await
    // settle() below.
    emit(message) {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
    // The host went away, the way Chrome reports it.
    drop() {
      connected = false;
      for (const listener of disconnectListeners) {
        listener();
      }
    },
    // The last frame the worker posted, or undefined.
    lastPosted() {
      return posted[posted.length - 1];
    },
  };
}

// Let the worker's own promise chain run to completion. handleCommand is async and replies
// through port.postMessage, so a test that emits a command has to yield before asserting on
// what came back. A handful of turns covers the deepest chain the worker builds.
export async function settle(turns = 12) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Evaluate the worker and hand back the names in `exported`.
//
// `extra` is appended to the epilogue verbatim, so a suite can take a closure over a live
// `let` binding (`ready: () => bridgeReady`) instead of a snapshot of its value at load time.
export function loadWorker(exported, overrides = {}, extra = "") {
  const context = vm.createContext({
    chrome: makeChromeStub(overrides),
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    structuredClone,
  });
  const fields = exported.join(", ");
  const epilogue =
    `\n;globalThis.__chrome_control_mcp_exports = { ${fields}` +
    (extra ? `, ${extra}` : "") +
    ` };\n`;
  vm.runInContext(workerSource + epilogue, context, { filename: workerPath });
  const result = context.__chrome_control_mcp_exports;
  for (const name of exported) {
    if (result[name] === undefined) {
      throw new Error(
        `background.js no longer defines ${name}; the harness is stale`,
      );
    }
  }
  return result;
}
