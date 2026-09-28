// How often does the extension actually reach for a bridge that is not there?
//
// The unit tests assert the cadence with mocked timers. This measures it in a real browser, which
// is where the complaint came from: a machine with the extension installed and no editor running
// spawned native-host processes continuously. No native-messaging manifest is installed here, so
// every connectNative fails at once -- which is exactly the shape of "no server is running" from
// the extension's side, and each attempt logs one "host disconnected".
//
// Also checks the service worker loads clean, which matters because this release adds the
// `storage` permission: a manifest mistake there would break the extension for everyone.
//
// Usage: node backoff_probe.mjs <chrome binary> <unpacked extension dir> [seconds]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const chrome = process.argv[2];
const extension = process.argv[3];
const seconds = Number(process.argv[4] || 75);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(os.tmpdir(), "backoff-"));
const child = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--remote-debugging-port=0",
    "--headless=new",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  stderr += c;
});

let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i++) {
  await sleep(250);
  try {
    const text = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8");
    const [port, browserPath] = text.split(/\r?\n/);
    if (port && browserPath) {
      wsUrl = `ws://127.0.0.1:${port}${browserPath}`;
    }
  } catch {
    // not written yet
  }
}
if (!wsUrl) {
  console.error("chrome did not start:", stderr.slice(-800));
  process.exit(1);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve } = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve(m.result ?? {});
        return;
      }
      if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
const cdp = new Cdp(ws);
await cdp.send("Target.setDiscoverTargets", { discover: true });
await cdp.send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
});
await sleep(3000);

// The extension's service worker, whichever target it is.
const attached = cdp.events.filter(
  (e) => e.method === "Target.attachedToTarget",
);
const workers = attached.filter(
  (e) =>
    e.params.targetInfo.type === "service_worker" &&
    String(e.params.targetInfo.url).startsWith("chrome-extension://"),
);
if (workers.length === 0) {
  console.error(
    "no extension service worker attached; targets:",
    JSON.stringify(attached.map((e) => e.params.targetInfo.type)),
  );
  ws.close();
  child.kill();
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
}
// Every worker session, not just the first: Chrome retires an idle MV3 worker and starts a new
// target for the next event, and a probe bound to one session stops hearing anything.
const enabled = new Set();
async function enableAll() {
  for (const event of cdp.events.filter(
    (e) => e.method === "Target.attachedToTarget",
  )) {
    const info = event.params.targetInfo;
    if (
      info.type === "service_worker" &&
      String(info.url).startsWith("chrome-extension://") &&
      !enabled.has(event.params.sessionId)
    ) {
      enabled.add(event.params.sessionId);
      await cdp.send("Runtime.enable", {}, event.params.sessionId);
    }
  }
}
await enableAll();

const started = Date.now();
// Re-enable as workers come and go, so a retired worker does not take the measurement with it.
for (let tick = 0; tick < seconds; tick++) {
  await sleep(1000);
  await enableAll();
}

const lines = cdp.events
  .filter((e) => e.method === "Runtime.consoleAPICalled")
  .map((e) =>
    (e.params.args || []).map((a) => String(a.value ?? "")).join(" "),
  );
// Both shapes of a failed attempt: a port that opened and dropped, and a connectNative that
// threw outright (which is what happens with no native-messaging manifest at all).
const disconnects = lines.filter((l) =>
  /host disconnected|connectNative threw/i.test(l),
);
const errors = cdp.events
  .filter((e) => e.method === "Runtime.exceptionThrown")
  .map((e) => e.params.exceptionDetails?.text ?? "");

console.log(
  JSON.stringify(
    {
      watched_seconds: Math.round((Date.now() - started) / 1000),
      connect_attempts: disconnects.length,
      attempts_per_minute: Number(
        ((disconnects.length * 60000) / (Date.now() - started)).toFixed(1),
      ),
      worker_exceptions: errors.slice(0, 5),
      worker_sessions_seen: enabled.size,
      sample: lines.filter((l) => /ChromeControlMCP/.test(l)).slice(0, 4),
      // A flat 2 s retry plus one attempt per tab event is what this replaced.
      old_behaviour_would_be_at_least: Math.floor((seconds * 1000) / 2000),
    },
    null,
    2,
  ),
);

ws.close();
child.kill();
rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
