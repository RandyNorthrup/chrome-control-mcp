// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Every pointer tool at the display scales, window sizes, browser zoom levels, and trackpad pinch
// a user can have, each in a dedicated browser (isolated_chrome.mjs) so the user's own Chrome is
// never touched. Nothing here trusts the arithmetic under test: a coordinate is proven by where
// its click LANDED on the geometry fixture, and a screenshot by the pixels of its solid-colour
// targets, measured against the page's own getBoundingClientRect.
//
// Usage: node tests/e2e/display_matrix_e2e.mjs --chrome=<Chrome for Testing binary>
//          [--executable=<chrome_control_mcp>] [--parallel=3] [--only=<config name>]
// Chrome for Testing is required: branded Chrome ignores --load-extension.
//
// Display scale is Chrome's --force-device-scale-factor, the display's device scale factor that a
// Windows 125% or 150% setting, a Retina panel, or a Linux fractional scale supplies. Browser zoom
// is the profile's default zoom level, as Settings > Page zoom sets it. A pinch is a synthesized
// pinch gesture through the input pipeline. An OS screen magnifier (macOS Zoom, Windows
// Magnifier) is not here because it cannot reach the tool: it magnifies the composited screen,
// and every coordinate the tool handles is a page coordinate -- captured by the DevTools protocol
// from the page's own compositor and dispatched to it the same way -- never an OS screen pixel.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForExtensionAttached } from "./extension_attach.mjs";
import { GEOMETRY_TARGETS, startFixtureServer } from "./fixture_server.mjs";
import { prepareIsolatedChrome } from "./isolated_chrome.mjs";
import { McpClient, refFor } from "./mcp_client.mjs";
import { colourBoxes, decodePng } from "./png.mjs";

// Real displays, as (device scale factor, browser window in DIPs): 100% desktops, Windows 125%
// to 300%, a Retina MacBook and a 5K iMac at 2x, and phone-sized windows at 2x and 3x.
const DISPLAYS = [
  { scale: 1, window: [800, 600] },
  { scale: 1, window: [1366, 768] },
  { scale: 1, window: [1920, 1080] },
  { scale: 1, window: [3840, 2160] },
  { scale: 1.25, window: [1024, 768] },
  { scale: 1.25, window: [1536, 864] },
  { scale: 1.25, window: [2048, 1152] },
  { scale: 1.5, window: [1280, 720] },
  { scale: 1.5, window: [1707, 960] },
  { scale: 1.5, window: [2560, 1440] },
  { scale: 1.75, window: [1097, 617] },
  { scale: 1.75, window: [2194, 1234] },
  { scale: 2, window: [390, 844] },
  { scale: 2, window: [1440, 900] },
  { scale: 2, window: [1920, 1080] },
  { scale: 2, window: [2560, 1440] },
  { scale: 2.5, window: [1536, 864] },
  { scale: 3, window: [390, 844] },
  { scale: 3, window: [1280, 720] },
];

// Chrome's own zoom steps (components/zoom/page_zoom_constants.cc).
const ZOOMS = [
  25, 33, 50, 67, 75, 80, 90, 110, 125, 150, 175, 200, 250, 300, 400, 500,
];
const PINCHES = [1.5, 2, 3];

// The fixture needs room: nine 24px targets placed by fractions of the viewport stay apart only
// in a CSS viewport at least this big.
const MIN_CSS_WIDTH = 260;
const MIN_CSS_HEIGHT = 200;
// The window's height that is browser UI rather than page, in DIPs (measured: a 700 DIP window
// shows a 557.6 DIP viewport). Used only to keep a zoom that would crowd the fixture out of the
// plan; the page's own measurements are what every check compares against.
const BROWSER_UI_HEIGHT = 143;

// Each display at 100% zoom, and again at the next zoom step that leaves the fixture room, so
// every step is covered across the scales.
function plan() {
  const configs = [];
  let next = 0;
  let pinch = 0;
  for (const display of DISPLAYS) {
    const [width, height] = display.window;
    const fits = (zoom) =>
      (width * 100) / zoom >= MIN_CSS_WIDTH &&
      ((height - BROWSER_UI_HEIGHT) * 100) / zoom >= MIN_CSS_HEIGHT;
    const zooms = [100];
    for (let tries = 0; tries < ZOOMS.length; tries += 1) {
      const zoom = ZOOMS[next % ZOOMS.length];
      next += 1;
      if (fits(zoom)) {
        zooms.push(zoom);
        break;
      }
    }
    for (const zoom of zooms) {
      configs.push({
        name: `${display.scale}x-${width}x${height}-zoom${zoom}`,
        scaleFactor: display.scale,
        windowSize: display.window,
        zoomPercent: zoom,
        pinch: PINCHES[pinch % PINCHES.length],
      });
      pinch += 1;
    }
  }
  return configs;
}

function pageState(text) {
  const content = JSON.parse(text).content;
  const out =
    content.match(/^(none|hit:\S+|miss@\S+|over:\S+|drop:\S+)$/m)?.[1] ?? null;
  const metrics = Object.fromEntries(
    [
      ...(content.match(/metrics (.*?) end/)?.[1] ?? "").matchAll(
        /(\w+)=(\S+)/g,
      ),
    ].map(([, key, value]) => [key, Number(value)]),
  );
  const rects = new Map(
    [
      ...(content.match(/rects (.*?) end/)?.[1] ?? "").matchAll(/(\w+)=(\S+)/g),
    ].map(([, id, value]) => {
      const [left, top, width, height] = value.split(",").map(Number);
      return [id, { left, top, width, height }];
    }),
  );
  return { out, metrics, rects };
}

const hitId = (out) =>
  out && out.startsWith("hit:") ? out.slice(4).split("@")[0] : null;
const centreOf = (box) => ({
  x: Math.round((box.left + box.right) / 2),
  y: Math.round((box.top + box.bottom) / 2),
});

// The DevTools endpoint of the dedicated browser, used for the one thing no tool does and a user
// does with their hands: pinch the trackpad.
async function devtoolsPage(devtools, urlPart) {
  const list = await (
    await fetch(`http://127.0.0.1:${devtools.port}/json/list`)
  ).json();
  const target = list.find(
    (entry) => entry.type === "page" && entry.url.includes(urlPart),
  );
  assert.ok(target, `No page at ${urlPart}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools socket failed"));
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`DevTools ${method} timed out`));
        }
      }, 15000);
    });
  return { send, close: () => socket.close() };
}

async function runConfig(config, { chrome, executable, fixture }) {
  const checks = [];
  const measured = {};
  const check = (label, ok, detail = "") => {
    checks.push({
      check: label,
      ok: Boolean(ok),
      detail: ok ? undefined : detail,
    });
  };
  let browser = null;
  let client = null;
  let pinchPage = null;
  try {
    browser = await prepareIsolatedChrome({ chrome, executable, ...config });
    client = new McpClient(executable, browser.env);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chrome-control-mcp-display-matrix", version: "1" },
    });
    const devtools = await browser.launch();
    await waitForExtensionAttached((name, args) => client.tool(name, args));
    const front = (await client.json("browser_tabs")).tabs.find(
      (tab) => tab.active,
    );

    const state = async () =>
      pageState((await client.tool("browser_read", { format: "text" })).text);
    const screenshot = async (fullPage = false) => {
      const outcome = await client.tool("browser_screenshot", {
        full_page: fullPage,
      });
      assert.ok(!outcome.isError, `screenshot failed: ${outcome.text}`);
      const image = outcome.result.content.find(
        (block) => block.type === "image",
      );
      const png = decodePng(Buffer.from(image.data, "base64"));
      return {
        png,
        boxes: colourBoxes(png, GEOMETRY_TARGETS),
        text: outcome.text,
      };
    };
    const clickAt = async (point) => {
      const outcome = await client.tool("browser_click_at", point);
      return outcome.isError
        ? { error: outcome.text }
        : { out: (await state()).out };
    };

    await client.json("browser_new_tab", { url: `${fixture.origin}/geometry` });
    let page = await state();
    const m = page.metrics;
    const dpr = m.dpr;
    Object.assign(measured, {
      dpr,
      css_viewport: [m.vvw, m.vvh],
      layout_width: m.iw,
    });
    const expectedDpr = (config.scaleFactor * config.zoomPercent) / 100;
    check(
      "the display scale and browser zoom are what the page sees",
      Math.abs(dpr - expectedDpr) < 0.002,
      `devicePixelRatio ${dpr}, expected ${expectedDpr}`,
    );

    // -- the viewport screenshot is the page, in device pixels ---------------------------------
    const inView = (rect, left, top, width, height) =>
      rect.left >= left &&
      rect.top >= top &&
      rect.left + rect.width <= left + width &&
      rect.top + rect.height <= top + height;
    const visible = GEOMETRY_TARGETS.map((t) => t.id).filter((id) =>
      inView(page.rects.get(id), 0, 0, m.vvw, m.vvh),
    );
    measured.visible_targets = visible;
    check(
      "every target but the one below the fold is on screen",
      visible.length === GEOMETRY_TARGETS.length - 1 &&
        !visible.includes("below"),
      `visible: ${visible.join(",")}`,
    );
    let shot = await screenshot();
    measured.screenshot = [shot.png.width, shot.png.height];
    check(
      "the screenshot is the viewport in device pixels",
      Math.abs(shot.png.width - m.vvw * dpr) <= 1 &&
        Math.abs(shot.png.height - m.vvh * dpr) <= 1,
      `${shot.png.width}x${shot.png.height} for a ${m.vvw}x${m.vvh} CSS viewport at ${dpr}`,
    );
    // Where a CSS rect must be in an image of the page taken with the given transform.
    const expectBox = (id, image, transform, label) => {
      const rect = page.rects.get(id);
      const box = image.boxes.get(id);
      // A rotated square's corners antialias, and the 6px target's fractional edges are
      // resampled: their solid-colour boxes shrink by up to two pixels a side. Under a pinch the
      // compositor also snaps the magnified layer to whole device pixels (measured 1.75 for the
      // 6px target, 1.5 for the others). Everything else is drawn to within rounding.
      const slack =
        (id === "turned" || id === "tiny" ? 2.5 : 1.5) +
        (transform.pinched ? 0.5 : 0);
      const want = {
        left: (rect.left - transform.x) * transform.scale,
        top: (rect.top - transform.y) * transform.scale,
        right: (rect.left + rect.width - transform.x) * transform.scale,
        bottom: (rect.top + rect.height - transform.y) * transform.scale,
      };
      check(
        `${label}: target ${id} is drawn where the page laid it out`,
        box &&
          Math.abs(box.left - want.left) <= slack &&
          Math.abs(box.top - want.top) <= slack &&
          Math.abs(box.right + 1 - want.right) <= slack &&
          Math.abs(box.bottom + 1 - want.bottom) <= slack,
        `drawn ${JSON.stringify(box)}, laid out ${JSON.stringify(want)}`,
      );
    };
    const viewportTransform = { x: 0, y: 0, scale: dpr };
    for (const id of visible) {
      expectBox(id, shot, viewportTransform, "viewport screenshot");
    }

    // -- a pixel read off the screenshot is where the click lands -------------------------------
    for (const id of visible) {
      const box = shot.boxes.get(id);
      if (!box) {
        continue;
      }
      const landed = await clickAt(centreOf(box));
      check(
        `click_at on target ${id}'s pixels hits it`,
        hitId(landed.out) === id,
        landed.error || landed.out,
      );
    }

    // -- a ref's geometry, and where browser_box says it is in the screenshot ---------------------
    let snapshot = (await client.tool("browser_snapshot")).text;
    const refs = new Map(
      GEOMETRY_TARGETS.map(({ id }) => [
        id,
        refFor(snapshot, `Geometry target ${id}`),
      ]),
    );
    for (const id of visible) {
      const box = await client.json("browser_box", { ref: refs.get(id) });
      const rect = page.rects.get(id);
      const drawn = shot.boxes.get(id);
      const centre = drawn && centreOf(drawn);
      check(
        `box reports target ${id}'s CSS rect`,
        Math.abs(box.x - rect.left) <= 1 &&
          Math.abs(box.y - rect.top) <= 1 &&
          Math.abs(box.width - rect.width) <= 1 &&
          Math.abs(box.height - rect.height) <= 1,
        `box ${JSON.stringify(box)}, page ${JSON.stringify(rect)}`,
      );
      check(
        `box's screenshot_center for target ${id} is on its pixels`,
        centre &&
          box.screenshot_center &&
          Math.abs(box.screenshot_center.x - centre.x) <= 1.5 &&
          Math.abs(box.screenshot_center.y - centre.y) <= 1.5,
        `screenshot_center ${JSON.stringify(box.screenshot_center)}, pixels centred at ${JSON.stringify(centre)}`,
      );
      check(
        `box says target ${id} is in the viewport`,
        box.in_viewport === true,
      );
    }

    // -- hover and drag -------------------------------------------------------------------------
    await client.json("browser_hover", { ref: refs.get("mid") });
    page = await state();
    check("hover reaches the target", page.out === "over:mid", page.out);
    await client.json("browser_drag", {
      ref: refs.get("tl"),
      to_ref: refs.get("br"),
    });
    page = await state();
    check(
      "a drag by refs drops on the target",
      page.out === "drop:tl>br",
      page.out,
    );
    shot = await screenshot();
    const from = centreOf(shot.boxes.get("tr"));
    const to = centreOf(shot.boxes.get("bl"));
    const dragged = await client.tool("browser_drag", {
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
    });
    page = await state();
    check(
      "a drag between two points read off the screenshot drops on the target",
      !dragged.isError && page.out === "drop:tr>bl",
      dragged.isError ? dragged.text : page.out,
    );

    // -- click by ref, the target the page must scroll to last ---------------------------------
    const byRef = GEOMETRY_TARGETS.map((target) => target.id).filter(
      (id) => id !== "below",
    );
    for (const id of [...byRef, "below"]) {
      const clicked = await client.tool("browser_click", { ref: refs.get(id) });
      page = await state();
      check(
        `click by ref hits target ${id}`,
        !clicked.isError && hitId(page.out) === id,
        clicked.isError ? clicked.text : page.out,
      );
    }

    // -- after that scroll, the screenshot and the click follow it -------------------------------
    page = await state();
    measured.scrolled_to = page.metrics.sy;
    check(
      "reaching the target below the fold scrolled the page",
      page.metrics.sy > 0,
    );
    shot = await screenshot();
    expectBox("below", shot, viewportTransform, "scrolled screenshot");
    const below = shot.boxes.get("below");
    if (below) {
      const landed = await clickAt(centreOf(below));
      check(
        "click_at on the scrolled screenshot hits the target",
        hitId(landed.out) === "below",
        landed.error || landed.out,
      );
    }

    // -- the full-page screenshot is the document in device pixels --------------------------------
    const scrolledTo = page.metrics.sy;
    const full = await screenshot(true);
    page = await state();
    check(
      "a full-page screenshot leaves the page where it was",
      page.metrics.sy === scrolledTo,
      `scrollY ${scrolledTo} before, ${page.metrics.sy} after`,
    );
    measured.full_page = [full.png.width, full.png.height];
    const clipped = /clipped/i.test(full.text);
    // The whole document, from its exact size (scrollWidth/Height round it to whole CSS pixels)
    // to less than one DIP -- the display's scale in device pixels -- past its end: Chrome clips
    // in whole DIPs.
    const holdsDocument = (image, metrics) =>
      [
        [image.width, metrics.dwx],
        [image.height, metrics.dhx],
      ].every(
        ([pixels, css]) =>
          pixels >= css * dpr - 1 &&
          pixels <= css * dpr + config.scaleFactor + 1,
      );
    check(
      "the full-page screenshot is the whole document in device pixels",
      clipped || holdsDocument(full.png, page.metrics),
      `${full.png.width}x${full.png.height} for a ${page.metrics.dwx}x${page.metrics.dhx} document at ${dpr}`,
    );
    if (!clipped) {
      expectBox(
        "below",
        full,
        { x: -page.metrics.sx, y: -page.metrics.sy, scale: dpr },
        "full-page screenshot",
      );
    }

    // -- a wheel scroll replies once the page is at rest, with how far it moved ------------------
    const scrollFrom = page.metrics.sy;
    const down = await client.json("browser_scroll", {
      direction: "down",
      amount: 200,
    });
    page = await state();
    measured.scroll_down = {
      reply: down.scrolled,
      page_moved: page.metrics.sy - scrollFrom,
    };
    check(
      "a scroll's reply is how far the page moved, and the page is already there",
      down.settled === true &&
        down.scrolled.y > 0 &&
        Math.abs(page.metrics.sy - scrollFrom - down.scrolled.y) <= 1,
      JSON.stringify(measured.scroll_down),
    );
    const upFrom = page.metrics.sy;
    const up = await client.json("browser_scroll", {
      direction: "up",
      amount: 100000,
    });
    page = await state();
    check(
      "scrolling past the top stops there, and says how far it went",
      up.settled === true &&
        page.metrics.sy === 0 &&
        Math.abs(up.scrolled.y + upFrom) <= 1,
      JSON.stringify({ reply: up, from: upFrom, now: page.metrics.sy }),
    );
    const still = await client.json("browser_scroll", {
      direction: "up",
      amount: 100,
    });
    check(
      "a scroll at the top says it moved nothing",
      still.settled === true && still.scrolled.y === 0,
      JSON.stringify(still),
    );

    // -- a trackpad pinch --------------------------------------------------------------------------
    const before = await screenshot();
    page = await state();
    pinchPage = await devtoolsPage(devtools, "/geometry");
    await pinchPage.send("Input.synthesizePinchGesture", {
      x: page.metrics.vvw / 2,
      y: page.metrics.vvh / 2,
      scaleFactor: config.pinch,
      gestureSourceType: "mouse",
    });
    page = await state();
    const pm = page.metrics;
    measured.pinch = { scale: pm.vvs, offset: [pm.vvl, pm.vvt] };
    check(
      `the pinch took: the page is at ${config.pinch}x`,
      Math.abs(pm.vvs - config.pinch) < 0.01,
      `visualViewport.scale ${pm.vvs}`,
    );
    const midBefore = before.boxes.get("mid");
    check(
      "the centre target is in the screenshot before the pinch",
      midBefore,
      JSON.stringify({
        metrics: page.metrics,
        image: [before.png.width, before.png.height],
        rect: page.rects.get("mid"),
      }),
    );
    const stale = midBefore
      ? await clickAt(centreOf(midBefore))
      : { error: "no target" };
    check(
      "click_at refuses a screenshot taken before the pinch",
      Boolean(stale.error) && /moved/.test(stale.error),
      stale.error || `it clicked: ${stale.out}`,
    );
    const pinched = await screenshot();
    measured.pinched_screenshot = [pinched.png.width, pinched.png.height];
    check(
      "the pinched screenshot is still the screen's size",
      pinched.png.width === before.png.width &&
        pinched.png.height === before.png.height,
      `${pinched.png.width}x${pinched.png.height} after, ${before.png.width}x${before.png.height} before`,
    );
    const pinchTransform = {
      x: pm.vvl,
      y: pm.vvt,
      scale: pm.vvs * dpr,
      pinched: true,
    };
    const inPinch = GEOMETRY_TARGETS.map((t) => t.id).filter((id) =>
      inView(page.rects.get(id), pm.vvl, pm.vvt, pm.vvw, pm.vvh),
    );
    const outOfPinch = GEOMETRY_TARGETS.map((t) => t.id).filter(
      (id) => id !== "below" && !inPinch.includes(id),
    );
    measured.pinch.visible_targets = inPinch;
    check(
      "the pinch magnified the centre target into view",
      inPinch.includes("mid"),
      inPinch.join(","),
    );
    for (const id of inPinch) {
      expectBox(id, pinched, pinchTransform, "pinched screenshot");
    }
    for (const id of inPinch) {
      const box = pinched.boxes.get(id);
      if (!box) {
        continue;
      }
      const landed = await clickAt(centreOf(box));
      check(
        `click_at on target ${id}'s pixels hits it under the pinch`,
        hitId(landed.out) === id,
        landed.error || landed.out,
      );
      const reported = await client.json("browser_box", { ref: refs.get(id) });
      const centre = centreOf(box);
      check(
        `box's screenshot_center for target ${id} is on its pixels under the pinch`,
        reported.screenshot_center &&
          Math.abs(reported.screenshot_center.x - centre.x) <= 2.5 &&
          Math.abs(reported.screenshot_center.y - centre.y) <= 2.5,
        `screenshot_center ${JSON.stringify(reported.screenshot_center)}, pixels centred at ${JSON.stringify(centre)}`,
      );
      check(
        `box says target ${id} is in view under the pinch`,
        reported.in_viewport === true,
        JSON.stringify(reported),
      );
    }
    for (const id of outOfPinch) {
      const reported = await client.json("browser_box", { ref: refs.get(id) });
      check(
        `box says target ${id} is out of view under the pinch`,
        reported.in_viewport === false,
        JSON.stringify(reported),
      );
    }
    const refused = await client.tool("browser_screenshot", {
      full_page: true,
    });
    page = await state();
    check(
      "a full-page screenshot of the pinched page is refused, and the pinch is left alone",
      refused.isError &&
        /pinch-zoomed/.test(refused.text) &&
        page.metrics.vvs === pm.vvs &&
        page.metrics.vvl === pm.vvl &&
        page.metrics.vvt === pm.vvt &&
        page.metrics.sy === pm.sy,
      JSON.stringify({ reply: refused.text, before: pm, after: page.metrics }),
    );
    snapshot = (await client.tool("browser_snapshot")).text;
    // Whether the browser's own hit test finds the target on top anywhere in its box -- the same
    // nine points the tool tries.
    const reachable = async (id) =>
      (
        await pinchPage.send("Runtime.evaluate", {
          expression: `(() => {
            const e = document.getElementById(${JSON.stringify(id)});
            const r = e.getBoundingClientRect();
            return [0.25, 0.5, 0.75].some((u) => [0.25, 0.5, 0.75].some((v) =>
              document.elementFromPoint(r.left + u * r.width, r.top + v * r.height) === e));
          })()`,
          returnByValue: true,
        })
      ).result.value;
    for (const id of [...inPinch, ...outOfPinch]) {
      const clicked = await client.tool("browser_click", {
        ref: refFor(snapshot, `Geometry target ${id}`),
      });
      page = await state();
      // A pinched page's scrollbars sit over its edges at a fixed DIP width -- at 25% zoom that
      // is wider than a 24px target flush with the edge -- and a click there reaches the
      // scrollbar, not the target. The tool must then refuse and say so, and only then: the
      // browser's own hit test has to agree that no point of the target is on top.
      const honestRefusal =
        clicked.isError &&
        /scrollbar is over it/.test(clicked.text) &&
        !(await reachable(id));
      check(
        `click by ref hits target ${id} under the pinch, or is refused because nothing of it is on top`,
        honestRefusal || (!clicked.isError && hitId(page.out) === id),
        clicked.isError ? clicked.text : page.out,
      );
      if (honestRefusal) {
        (measured.pinch.refused ??= []).push(id);
      }
    }

    const listing = await client.json("browser_tabs");
    check(
      "the browser's own tab stayed in front throughout",
      listing.tabs.find((tab) => tab.active)?.id === front.id,
    );
  } catch (error) {
    check(
      "the run completed",
      false,
      `${error.stack || error}\n--- browser stderr ---\n${(browser?.stderr() || "").slice(-2000)}`,
    );
  } finally {
    pinchPage?.close();
    await client?.close();
    await browser?.close();
  }
  return {
    config,
    ok: checks.every((entry) => entry.ok),
    measured,
    checks,
  };
}

async function main() {
  const option = (name) =>
    process.argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  const chrome = option("chrome");
  assert.ok(
    chrome && existsSync(chrome),
    "--chrome=<Chrome for Testing binary> is required",
  );
  assert.equal(
    typeof WebSocket,
    "function",
    "This suite needs Node 22 or newer (a global WebSocket) to pinch the page.",
  );
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const executable = path.resolve(
    option("executable") ||
      path.join(scriptDir, "..", "..", "build", "chrome_control_mcp"),
  );
  assert.ok(existsSync(executable), `MCP executable not found: ${executable}`);
  const parallel = Math.max(1, Number(option("parallel") || 3));
  const only = option("only");
  const configs = plan().filter((config) => !only || config.name === only);
  assert.ok(configs.length > 0, `No configuration named ${only}`);

  const fixture = await startFixtureServer();
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < configs.length) {
      const config = configs[cursor];
      cursor += 1;
      const result = await runConfig(config, { chrome, executable, fixture });
      const failed = result.checks.filter((entry) => !entry.ok);
      process.stderr.write(
        `${result.ok ? "PASS" : "FAIL"} ${config.name} pinch ${config.pinch}: ` +
          `${result.checks.length - failed.length}/${result.checks.length}\n`,
      );
      for (const entry of failed) {
        process.stderr.write(`    FAIL ${entry.check}: ${entry.detail}\n`);
      }
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  await fixture.close();

  results.sort((a, b) => configs.indexOf(a.config) - configs.indexOf(b.config));
  const checkCount = results.reduce(
    (sum, result) => sum + result.checks.length,
    0,
  );
  const passed = results.reduce(
    (sum, result) => sum + result.checks.filter((entry) => entry.ok).length,
    0,
  );
  const report = {
    ok: results.every((result) => result.ok),
    chrome,
    configurations: results.length,
    configurations_passed: results.filter((result) => result.ok).length,
    checks: checkCount,
    checks_passed: passed,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

await main();
