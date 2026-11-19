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

// S.A.K. Utility's native host: the extension's second, optional one. Unless a suite says
// otherwise it is not installed -- the browser of a Chrome Control MCP user without S.A.K. -- and
// a port for it is answered the way Chrome answers one for any host it cannot find: it
// disconnects at once, with this as chrome.runtime.lastError.
export const SAK_HOST_NAME = "com.sak.browsercontrol";
export const HOST_NOT_FOUND = "Specified native messaging host not found.";

// A port for a host Chrome cannot find. @p overrides is the chrome stub's override map, where
// chrome.runtime.lastError is set for as long as the disconnect is being delivered.
export function makeMissingHostPort(overrides) {
  const port = makeFakePort();
  setTimeout(() => {
    const had = Object.prototype.hasOwnProperty.call(
      overrides,
      "runtime.lastError",
    );
    const before = overrides["runtime.lastError"];
    overrides["runtime.lastError"] = { message: HOST_NOT_FOUND };
    try {
      port.drop();
    } finally {
      if (had) {
        overrides["runtime.lastError"] = before;
      } else {
        delete overrides["runtime.lastError"];
      }
    }
  }, 0);
  return port;
}

// Route chrome.runtime.connectNative by host name: Chrome Control MCP's host to whatever the
// suite gave (or the recording stub), S.A.K.'s to @p sakHost, or to a host that is not there.
// Done in place, so a suite that changes its override map later is still heard.
function routeHosts(overrides, sakHost) {
  const own = overrides["runtime.connectNative"];
  overrides["runtime.connectNative"] = (name, ...rest) => {
    if (name === SAK_HOST_NAME) {
      return sakHost ? sakHost(name, ...rest) : makeMissingHostPort(overrides);
    }
    return own
      ? own(name, ...rest)
      : makeChromeStub(overrides, "runtime.connectNative");
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

// The administrator's policy that lets the extension reach S.A.K.'s host, as chrome.storage.managed
// reports it (managed_schema.json).
export const SAK_HOST_POLICY = "sakHostEnabled";

// chrome.storage.managed holding @p policy, unless the suite's override map already answers it.
function managedPolicy(overrides, policy) {
  if (!Object.prototype.hasOwnProperty.call(overrides, "storage.managed.get")) {
    overrides["storage.managed.get"] = () => Promise.resolve({ ...policy });
  }
}

// Evaluate the worker and hand back the names in `exported`.
//
// `extra` is appended to the epilogue verbatim, so a suite can take a closure over a live
// `let` binding (`ready: () => bridgeReady`) instead of a snapshot of its value at load time.
// `sakHost`, when given, answers connectNative for S.A.K.'s host (see SAK_HOST_NAME); without it
// that host is not installed. `sakPolicy` says whether an administrator turned S.A.K.'s host on
// (SAK_HOST_POLICY): by default it is on exactly when the host is installed, as S.A.K. sets both
// together; a suite's own "storage.managed.get" override wins over it. `console`, when given, is
// the worker's console, so a suite can say what it logged; without it the worker logs nowhere.
export function loadWorker(
  exported,
  overrides = {},
  extra = "",
  { sakHost, sakPolicy = Boolean(sakHost), console: sink } = {},
) {
  routeHosts(overrides, sakHost);
  managedPolicy(overrides, sakPolicy ? { [SAK_HOST_POLICY]: true } : {});
  const context = vm.createContext({
    chrome: makeChromeStub(overrides),
    console: sink || {
      log() {},
      warn() {},
      error() {},
      debug() {},
      info() {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    structuredClone,
    // Present in a real service worker; the worker uses them to build the
    // data: urls it hands to chrome.downloads.
    btoa,
    atob,
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
