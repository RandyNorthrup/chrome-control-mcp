// Diagnostic: why does a wheel over a nested overflow scroller move nothing on some platforms?
// Pure CDP against Chrome for Testing -- no MCP server, no extension, no build. Run it where the
// live suite fails and it says which of "the wheel missed the region" and "the region would not
// take a wheel" is happening.
//
// Usage: node tools/scroll_probe.mjs <chrome binary> [extra chrome flag]...
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFixtureServer } from "../tests/e2e/fixture_server.mjs";

const CHROME = process.argv[2];
const EXTRA = process.argv.slice(3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const fixture = await startFixtureServer();
const profile = mkdtempSync(path.join(os.tmpdir(), "scrollprobe-"));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-search-engine-choice-screen", "--window-size=1280,800",
  "--headless=new", "--remote-debugging-port=0", ...EXTRA, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (c) => { stderr += c; });

let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i++) {
  await sleep(250);
  try {
    const text = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8");
    const [port, browserPath] = text.split(/\r?\n/);
    if (port && browserPath) wsUrl = `ws://127.0.0.1:${port}${browserPath}`;
  } catch {}
}
if (!wsUrl) throw new Error(`chrome did not start: ${stderr}`);

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
const cdp = new Cdp(ws);
const { targetId } = await cdp.send("Target.createTarget", { url: fixture.origin });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
for (const domain of ["Page", "Runtime", "DOM"]) {
  await cdp.send(`${domain}.enable`, {}, sessionId);
}
await sleep(1500);

const evaluate = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return r.result.value;
};
const doc = await cdp.send("DOM.getDocument", { depth: -1 }, sessionId);
const found = await cdp.send("DOM.querySelector",
  { nodeId: doc.root.nodeId, selector: "#scroll-region" }, sessionId);

const centreOf = (q) => ({ x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 });
const boxCentre = async () => {
  const m = await cdp.send("DOM.getBoxModel", { nodeId: found.nodeId }, sessionId);
  return centreOf(m.model.content);
};
const hitAt = (pt) => evaluate(
  `(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); ` +
  `return e ? e.tagName + (e.id ? '#' + e.id : '') : null; })()`);
const rewind = async () => {
  await evaluate("window.scrollTo({ top: 0, behavior: 'instant' }); " +
    "document.getElementById('scroll-region').scrollTop = 0; 'ok'");
  await sleep(300);
};
const readState = () => evaluate(
  "(() => { const e = document.getElementById('scroll-region'); return {" +
  " region: e.scrollTop, room: e.scrollHeight - e.clientHeight," +
  " page: document.scrollingElement.scrollTop," +
  " pageRoom: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight }; })()");

console.log("platform      ", process.platform, os.release());
console.log("chrome        ", (await cdp.send("Browser.getVersion", {})).product);
console.log("environment   ", JSON.stringify(await evaluate(
  "({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight]," +
  " vv: [visualViewport.width, visualViewport.height, visualViewport.scale]," +
  " ua: navigator.userAgent.slice(0, 60) })")));
await rewind();
console.log("region        ", JSON.stringify(await readState()));
console.log("");

console.log("-- does the box read race the scroll-into-view? --");
for (let i = 0; i < 5; i++) {
  await rewind();
  await cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId: found.nodeId }, sessionId);
  const immediate = await boxCentre();
  const hitNow = await hitAt(immediate);
  await sleep(800);
  const settled = await boxCentre();
  const hitLater = await hitAt(immediate);
  const state = await readState();
  console.log(`run ${i}: immediate y=${immediate.y.toFixed(1)} (hits ${hitNow})` +
    `  settled y=${settled.y.toFixed(1)} (old point now hits ${hitLater})` +
    `  drift=${(settled.y - immediate.y).toFixed(1)}  page=${state.page}/${state.pageRoom}`);
}

console.log("");
console.log("-- what actually moves the region, 5 runs each --");
const atRegion = async (fresh) => {
  await rewind();
  await cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId: found.nodeId }, sessionId);
  let pt = await boxCentre();
  if (fresh) { await sleep(400); pt = await boxCentre(); }
  return pt;
};
const variants = {
  "wheel at the shipping point": async () => {
    const pt = await atRegion(false);
    await cdp.send("Input.dispatchMouseEvent",
      { type: "mouseWheel", x: pt.x, y: pt.y, deltaX: 0, deltaY: 180 }, sessionId);
  },
  "wheel at a re-read point": async () => {
    const pt = await atRegion(true);
    await cdp.send("Input.dispatchMouseEvent",
      { type: "mouseWheel", x: pt.x, y: pt.y, deltaX: 0, deltaY: 180 }, sessionId);
  },
  "mouseMoved first, then wheel": async () => {
    const pt = await atRegion(true);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }, sessionId);
    await cdp.send("Input.dispatchMouseEvent",
      { type: "mouseWheel", x: pt.x, y: pt.y, deltaX: 0, deltaY: 180 }, sessionId);
  },
  "four wheels of 45": async () => {
    const pt = await atRegion(true);
    for (let i = 0; i < 4; i++) {
      await cdp.send("Input.dispatchMouseEvent",
        { type: "mouseWheel", x: pt.x, y: pt.y, deltaX: 0, deltaY: 45 }, sessionId);
      await sleep(30);
    }
  },
  "synthesizeScrollGesture": async () => {
    const pt = await atRegion(true);
    await cdp.send("Input.synthesizeScrollGesture",
      { x: pt.x, y: pt.y, xDistance: 0, yDistance: -180, gestureSourceType: "mouse", speed: 8000 },
      sessionId);
  },
};
for (const [name, run] of Object.entries(variants)) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    try { await run(); } catch (e) { out.push("ERR:" + e.message.slice(0, 50)); continue; }
    await sleep(800);
    const s = await readState();
    out.push(`region=${s.region} page=${s.page}`);
  }
  console.log(name.padEnd(30), out.join(" | "));
}

ws.close();
chrome.kill();
await fixture.close?.();
process.exit(0);
