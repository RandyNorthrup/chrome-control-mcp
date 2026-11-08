// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Large uploads (docs/plans/large-uploads.md), in a live browser: files far past the 16 MiB bound
// that held before 1.11.0, staged in the page piece by piece. A page of its own takes them every
// way a page can -- a file input by ref, an input a script created and clicked, a drop zone, and
// showOpenFilePicker -- and hashes what it received, 8 MiB at a time, so each check reads the
// page's own account of the bytes against the file on disk. Then: a page that reloads mid-delivery
// assigns nothing and the next upload works; the operator's cap refuses a file before any of it is
// sent; and the worker is left holding nothing.
//
// Run through isolated_run.mjs: node tests/e2e/isolated_run.mjs --chrome=<CfT>
//   --executable=<server> tests/e2e/large_upload_e2e.mjs

import assert from "node:assert/strict";
import { createHash, randomFillSync } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  devtoolsEndpoint,
  evaluateIn,
  extensionWorker,
  targets,
} from "./devtools.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";

const MIB = 1024 * 1024;
const SLICE = 8 * MIB;
const LARGE_MIB = 300;
const MEDIUM_MIB = 40;
const CAP_MIB = 64;
const UPLOAD_TIMEOUT_MS = 600000;
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// The pages: each way in reports name, size, type and the digest of its slices' digests. A drop
// zone takes files only when no file input is in scope -- the tool gives an input the files when
// there is one -- so the drop zone and the picker have a page of their own.
const SCRIPT = `
async function digest(file, progress) {
  const parts = [];
  const total = Math.ceil(file.size / ${SLICE});
  for (let at = 0; at < file.size; at += ${SLICE}) {
    const slice = await file.slice(at, at + ${SLICE}).arrayBuffer();
    parts.push(new Uint8Array(await crypto.subtle.digest("SHA-256", slice)));
    progress(parts.length + "/" + total);
  }
  const joined = new Uint8Array(parts.length * 32);
  parts.forEach((part, i) => joined.set(part, i * 32));
  const whole = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return [...whole].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function report(id, label, file) {
  // How far the hash has got, so a check that times out says whether it stalled or was slow.
  const progress = (done) => {
    document.getElementById(id).textContent = label + ": working " + done;
  };
  progress("0");
  document.getElementById(id).textContent =
    label + ": " + file.name + ":" + file.size + ":" + file.type + ":" + (await digest(file, progress));
}
for (const [id, wire] of Object.entries({
  video: (el) => el.addEventListener("change", (e) => void report("video-status", "video", e.target.files[0])),
  attach: (el) => el.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => {
      const file = input.files[0];
      input.value = "";
      void report("attached", "attached", file);
    });
    input.click();
  }),
  dropzone: (el) => {
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      void report("dropped", "dropped", e.dataTransfer.files[0]);
    });
  },
  pick: (el) => el.addEventListener("click", async () => {
    const [handle] = await window.showOpenFilePicker();
    await report("picked", "picked", await handle.getFile());
  }),
})) {
  const el = document.getElementById(id);
  if (el) wire(el);
}`;
const page = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Large upload</title></head><body>
${body}
<script>${SCRIPT}</script></body></html>`;
const PAGES = {
  "/large": page(`<input id="video" type="file" aria-label="Video file">
<p id="video-status">video: none</p>
<button id="attach" type="button">Attach a file</button>
<p id="attached">attached: none</p>`),
  "/drop":
    page(`<div id="dropzone" role="button" tabindex="0" aria-label="Drop files here"
  style="width:300px;height:120px;border:2px dashed #888;margin:12px 0">Drop files here</div>
<p id="dropped">dropped: none</p>
<button id="pick" type="button">Open with picker</button>
<p id="picked">picked: none</p>`),
};

// A file of @p mebibytes random bytes, and its digest as the page computes it.
function makeFile(dir, name, mebibytes) {
  const file = path.join(dir, name);
  const fd = openSync(file, "w");
  const slices = [];
  const buffer = Buffer.alloc(SLICE);
  for (let left = mebibytes * MIB; left > 0; left -= SLICE) {
    const slice = buffer.subarray(0, Math.min(SLICE, left));
    randomFillSync(slice);
    writeSync(fd, slice);
    slices.push(createHash("sha256").update(slice).digest());
  }
  closeSync(fd);
  return {
    path: file,
    name,
    size: mebibytes * MIB,
    digest: createHash("sha256").update(Buffer.concat(slices)).digest("hex"),
  };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const executable = path.resolve(
    process.argv[2] ||
      path.join(
        scriptDir,
        "..",
        "..",
        "build",
        process.platform === "win32"
          ? path.join("Release", "chrome_control_mcp.exe")
          : "chrome_control_mcp",
      ),
  );
  assert.ok(existsSync(executable), `MCP executable not found: ${executable}`);
  const checks = [];
  const measured = {};
  const check = (condition, label, detail = "") => {
    checks.push({ check: label, status: condition ? "passed" : "failed" });
    process.stderr.write(
      `${condition ? "PASS" : "FAIL"} ${label}${condition || !detail ? "" : ` -- ${detail}`}\n`,
    );
  };
  const site = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      PAGES[new URL(request.url, "http://x").pathname] || PAGES["/large"],
    );
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccmcp-large-upload-"));
  const server = new McpClient(executable);
  // A second server for the same browser, with the operator's cap set low.
  const capped = new McpClient(executable, {
    ...process.env,
    CHROME_CONTROL_MCP_UPLOAD_MAX_MB: String(CAP_MIB),
  });
  let failure = null;
  try {
    const large = makeFile(dir, "long-video.mp4", LARGE_MIB);
    const medium = makeFile(dir, "short-video.mp4", MEDIUM_MIB);
    for (const client of [server, capped]) {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "large-upload", version: "1" },
      });
    }
    const endpoint = await devtoolsEndpoint();
    const opened = await server.json("browser_new_tab", {
      url: `${origin}/large`,
      agent: "uploader",
    });
    const tabId = opened.tab_id;
    await server.tool("browser_wait_for", {
      tab_id: tabId,
      text: "video: none",
    });
    // One status line, out of browser_read's JSON reply.
    const status = async (id) =>
      ((
        await server.json("browser_read", { tab_id: tabId, format: "text" })
      ).content.match(new RegExp(`${id}:[^\\n]*`)) || [""])[0].trim();
    const settled = async (id) => {
      for (let i = 0; i < 240; i += 1) {
        const line = await status(id);
        if (line && !line.endsWith(": none") && !/: working( |$)/.test(line)) {
          return line;
        }
        await sleep(500);
      }
      return status(id);
    };
    const expect = (label, file, type = "video/mp4") =>
      `${label}: ${file.name}:${file.size}:${type}:${file.digest}`;
    const refs = async () =>
      (await server.tool("browser_snapshot", { tab_id: tabId })).text;

    // A file input by ref: the 300 MiB file.
    let snapshot = await refs();
    const started = Date.now();
    const byRef = await server.tool(
      "browser_upload",
      {
        tab_id: tabId,
        ref: refFor(snapshot, "Video file"),
        paths: [large.path],
      },
      UPLOAD_TIMEOUT_MS,
    );
    measured.large_upload_seconds = (Date.now() - started) / 1000;
    measured.large_upload_mib_per_second = Number(
      (LARGE_MIB / measured.large_upload_seconds).toFixed(1),
    );
    const video = await settled("video");
    check(
      !byRef.isError && video === expect("video", large),
      `a ${LARGE_MIB} MiB file reaches a file input by ref, byte for byte`,
      JSON.stringify({ reply: byRef.text.slice(0, 300), video }),
    );

    // An input a script created and clicked, caught and filled.
    const click = async (name) =>
      server.tool("browser_click", {
        tab_id: tabId,
        ref: refFor(await refs(), name),
      });
    const attach = await click("Attach a file");
    const filled = await server.tool(
      "browser_upload",
      { tab_id: tabId, paths: [medium.path] },
      UPLOAD_TIMEOUT_MS,
    );
    const attached = await settled("attached");
    check(
      /file_chooser/.test(attach.text) &&
        !filled.isError &&
        attached === expect("attached", medium),
      `a ${MEDIUM_MIB} MiB file fills the input picker the page opened`,
      JSON.stringify({
        attach: attach.text.slice(0, 200),
        filled: filled.text.slice(0, 200),
        attached,
      }),
    );

    // A drop zone by ref, on a page with no file input in scope.
    await server.json("browser_navigate", {
      tab_id: tabId,
      url: `${origin}/drop`,
    });
    await server.tool("browser_wait_for", {
      tab_id: tabId,
      text: "dropped: none",
    });
    snapshot = await refs();
    const dropped = await server.tool(
      "browser_upload",
      {
        tab_id: tabId,
        ref: refFor(snapshot, "Drop files here"),
        paths: [medium.path],
      },
      UPLOAD_TIMEOUT_MS,
    );
    const drop = await settled("dropped");
    check(
      !dropped.isError &&
        /"delivered_by":\s*"drop"/.test(dropped.text) &&
        drop === expect("dropped", medium),
      `a ${MEDIUM_MIB} MiB file drops onto a drop zone by ref`,
      JSON.stringify({ reply: dropped.text.slice(0, 200), drop }),
    );

    // showOpenFilePicker, answered with a handle.
    const pick = await click("Open with picker");
    const answered = await server.tool(
      "browser_upload",
      { tab_id: tabId, paths: [medium.path] },
      UPLOAD_TIMEOUT_MS,
    );
    const picked = await settled("picked");
    check(
      /file_chooser/.test(pick.text) &&
        !answered.isError &&
        picked === expect("picked", medium),
      `a showOpenFilePicker answer gives the same ${MEDIUM_MIB} MiB`,
      JSON.stringify({
        pick: pick.text.slice(0, 200),
        answered: answered.text.slice(0, 200),
        picked,
      }),
    );

    // The page reloads while the large file is arriving: nothing is assigned, the call says why,
    // and the next upload to the tab works.
    await server.json("browser_navigate", {
      tab_id: tabId,
      url: `${origin}/large`,
    });
    await server.tool("browser_wait_for", {
      tab_id: tabId,
      text: "video: none",
    });
    snapshot = await refs();
    const target = (await targets(endpoint)).find(
      (t) => t.type === "page" && t.url.startsWith(`${origin}/large`),
    );
    const interrupted = server.tool(
      "browser_upload",
      {
        tab_id: tabId,
        ref: refFor(snapshot, "Video file"),
        paths: [large.path],
      },
      UPLOAD_TIMEOUT_MS,
    );
    await sleep(1500);
    await evaluateIn(
      target.webSocketDebuggerUrl,
      "location.reload(); true",
    ).catch(() => {});
    const cut = await interrupted;
    await server.tool("browser_wait_for", {
      tab_id: tabId,
      text: "video: none",
    });
    const again = await server.tool(
      "browser_upload",
      {
        tab_id: tabId,
        ref: refFor(await refs(), "Video file"),
        paths: [medium.path],
      },
      UPLOAD_TIMEOUT_MS,
    );
    const after = await settled("video");
    check(
      cut.isError &&
        /nothing was assigned/.test(cut.text) &&
        !again.isError &&
        after === expect("video", medium),
      "a page that reloads mid-delivery is given nothing and says why; the next upload works",
      JSON.stringify({
        cut: cut.text.slice(0, 300),
        again: again.text.slice(0, 200),
        after,
      }),
    );

    // The operator's cap, on the second server: refused before anything is sent.
    const cappedTab = (
      await capped.json("browser_new_tab", {
        url: `${origin}/large`,
        agent: "capped",
      })
    ).tab_id;
    await capped.tool("browser_wait_for", {
      tab_id: cappedTab,
      text: "video: none",
    });
    const cappedRefs = (
      await capped.tool("browser_snapshot", { tab_id: cappedTab })
    ).text;
    const refusedAt = Date.now();
    const refused = await capped.tool("browser_upload", {
      tab_id: cappedTab,
      ref: refFor(cappedRefs, "Video file"),
      paths: [large.path],
    });
    measured.cap_refusal_ms = Date.now() - refusedAt;
    check(
      refused.isError &&
        refused.text.includes(`at most ${CAP_MIB * MIB}`) &&
        refused.text.includes("CHROME_CONTROL_MCP_UPLOAD_MAX_MB"),
      "a file over the operator's cap is refused before any of it is sent",
      refused.text.slice(0, 300),
    );
    await capped.json("browser_release", { tab_id: cappedTab });

    // Every upload is over: the worker holds none of them.
    const worker = await extensionWorker(endpoint);
    const held = await evaluateIn(
      worker.webSocketDebuggerUrl,
      "[...sessions].reduce((n, s) => n + s.uploadChunks.size, 0)",
    );
    check(held === 0, "the worker is left holding no upload", String(held));
    await server.json("browser_release", { tab_id: tabId });
  } catch (error) {
    failure = error;
  } finally {
    await server.close();
    await capped.close();
    site.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = checks.filter((entry) => entry.status !== "passed");
  const report = {
    ok: failure === null && failed.length === 0 && checks.length === 7,
    checks,
    measured,
    error: failure ? String(failure.stack || failure) : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

await main();
