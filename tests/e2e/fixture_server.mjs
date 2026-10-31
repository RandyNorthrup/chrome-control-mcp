// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

import http from "node:http";

function htmlPage(title, body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0 auto; max-width: 70rem; padding: 1rem; line-height: 1.5; }
    main { display: grid; gap: 1rem; }
    section { border: 1px solid #7778; border-radius: .5rem; padding: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .75rem; }
    label { display: grid; gap: .25rem; font-weight: 600; }
    button, input, select { min-height: 2.75rem; font: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
      outline: .2rem solid #ff2d95; outline-offset: .15rem;
    }
    #hover-target, #drag-source, #drag-target { min-height: 4rem; padding: 1rem; border: .15rem solid #777; }
    #drag-source { background: #1769aa; color: white; }
    #drag-target { background: #207a3c; color: white; }
    #scroll-region { height: 9rem; overflow: auto; border: 1px solid #777; padding: .5rem; }
    /* Rows of different depth and height, so a wheel inside the region changes WHICH element sits
       under the action point -- a plain paragraph, then a span inside a row. Naming the scroller
       by how far it was from the point renamed it mid-scroll on exactly this shape. */
    .scroll-row { padding: 1.4rem 0; border-bottom: 1px dotted #aaa; }
    .scroll-filler { margin: 1.8rem 0; }
    #deep-target { margin-top: 40rem; }
    /* Controls the page wires up itself. To the accessibility tree these are "generic": no role
       and no focusability says they can be acted on, which is why they used to reach the model as
       scenery. cursor:pointer is INHERITED, so the child inside the card computes it too. */
    #pointer-card { cursor: pointer; border: .15rem solid #777; padding: 1rem; }
    #wired-click, #wired-hover { border: .15rem dashed #777; padding: 1rem; }
    output { display: block; min-height: 1.5rem; font-weight: 700; }
    @media (max-width: 35rem) { body { padding: .5rem; } section { padding: .75rem; } }
  </style>
</head>
<body>
  <header><h1>${title}</h1></header>
  <main>${body}</main>
  <script>${script}</script>
</body>
</html>`;
}

function fixtureHome() {
  return htmlPage(
    "Chrome Control MCP E2E Fixture",
    `
    <section aria-labelledby="navigation-heading">
      <h2 id="navigation-heading">Navigation</h2>
      <a id="page-two-link" data-e2e="page-two" href="/page2">Fixture Page Two</a>
    </section>
    <section aria-labelledby="controls-heading">
      <h2 id="controls-heading">Controls</h2>
      <div class="grid">
        <label>Fixture text input
          <input id="text-input" aria-label="Fixture text input" data-e2e="text-input" value="">
        </label>
        <label>Fixture select
          <select id="single-select" aria-label="Fixture select">
            <option value="alpha">Alpha</option><option value="beta">Beta</option><option value="gamma">Gamma</option>
          </select>
        </label>
        <label>Fixture multiple select
          <select id="multi-select" aria-label="Fixture multiple select" multiple>
            <option value="one">One</option><option value="two">Two</option><option value="three">Three</option>
          </select>
        </label>
        <label><input id="checkbox" type="checkbox" aria-label="Fixture checkbox"> Fixture checkbox</label>
        <label>Fixture range
          <input id="range" type="range" min="0" max="100" value="10" aria-label="Fixture range">
        </label>
        <label>Fixture file input
          <input id="file-input" type="file" aria-label="Fixture file input">
        </label>
        <!-- What the whole web does: the real input is hidden and a styled button stands in
             front of it, clicking the input on the user's behalf. The input has no box and no
             accessibility node, so it can only be reached if the snapshot names it or the
             upload resolves from the button to the input beside it. -->
        <span id="hidden-file-group">
          <button id="hidden-file-button" type="button" aria-label="Fixture hidden file picker">Choose a file</button>
          <input id="hidden-file-input" type="file" style="display:none" aria-label="Fixture hidden file input">
        </span>
      </div>
      <output id="file-output" aria-live="polite">No file</output>
      <output id="hidden-file-output" aria-live="polite">No hidden file</output>
      <div class="grid">
        <button id="normal-button" type="button">Fixture click button</button>
        <button id="js-button" type="button">Fixture JS button</button>
        <button id="coordinate-button" type="button">Fixture coordinate button</button>
        <button id="prompt-button" type="button">Open fixture prompt</button>
        <button id="diagnostics-button" type="button">Fixture diagnostics</button>
      </div>
      <output id="action-output" aria-live="polite">No action yet</output>
    </section>
    <section aria-labelledby="pointer-heading">
      <h2 id="pointer-heading">Pointer operations</h2>
      <button id="hover-target" type="button" aria-label="Fixture hover target">Hover target</button>
      <output id="hover-output" aria-live="polite">Not hovered</output>
      <div class="grid">
        <button id="drag-source" type="button" aria-label="Fixture drag source">Drag source</button>
        <button id="drag-target" type="button" aria-label="Fixture drag target">Drag target</button>
      </div>
      <output id="drag-output" aria-live="polite">Not dragged</output>
    </section>
    <section aria-labelledby="media-heading">
      <h2 id="media-heading">Media</h2>
      <audio id="fixture-audio" aria-label="Fixture audio" tabindex="0" controls preload="metadata" src="/tone.wav"></audio>
    </section>
    <section aria-labelledby="wait-heading">
      <h2 id="wait-heading">Wait and shadow DOM</h2>
      <output id="delayed-output" aria-live="polite">Waiting</output>
      <output id="network-output" aria-live="polite">Network pending</output>
      <div id="shadow-host" aria-label="Fixture shadow host"></div>
    </section>
    <section aria-labelledby="scroll-heading">
      <h2 id="scroll-heading">Scrolling</h2>
      <div id="scroll-region" role="region" tabindex="0" aria-label="Fixture scroll region">
        <p>Scroll region start</p>
        <div class="scroll-row"><span class="scroll-label">Nested row one</span></div>
        <p class="scroll-filler">Filler between the rows</p>
        <div class="scroll-row"><span class="scroll-label">Nested row two</span></div>
        <p class="scroll-filler">More filler between the rows</p>
        <div class="scroll-row"><span class="scroll-label">Nested row three</span></div>
        <button id="deep-target" type="button">Fixture deep target</button>
      </div>
    </section>
    <section aria-labelledby="wired-heading">
      <h2 id="wired-heading">Wired by the page</h2>
      <div id="wired-click" aria-label="Fixture wired click">Click handler, no role</div>
      <div id="wired-hover" aria-label="Fixture wired hover" onmouseenter="window.__fixtureWiredHover()">Hover handler, no role</div>
      <div id="pointer-card" aria-label="Fixture pointer card">
        Pointer card
        <span id="pointer-card-child" aria-label="Fixture pointer card child">inside the card</span>
      </div>
      <output id="wired-output">Wired idle</output>
    </section>`,
    `
    const actionOutput = document.getElementById('action-output');
    document.getElementById('normal-button').addEventListener('click', () => { actionOutput.textContent = 'normal-clicked'; });
    document.getElementById('js-button').addEventListener('click', () => { actionOutput.textContent = 'js-clicked'; });
    document.getElementById('coordinate-button').addEventListener('click', () => { actionOutput.textContent = 'coordinate-clicked'; });
    document.getElementById('prompt-button').addEventListener('click', () => {
      const value = prompt('Fixture prompt', 'default');
      actionOutput.textContent = value === null ? 'prompt-dismissed' : 'prompt:' + value;
    });
    document.getElementById('hover-target').addEventListener('mouseenter', () => {
      document.getElementById('hover-output').textContent = 'hovered';
    });
    // Wired the way a real page wires a div it drew itself. The click goes through
    // addEventListener -- measured against a real Chrome, DOMSnapshot's isClickable flags that
    // just as it flags an inline onclick -- and the hover through the inline attribute, which
    // isClickable does NOT flag and which nothing but an attribute scan can see.
    const wiredOutput = document.getElementById('wired-output');
    document.getElementById('wired-click').addEventListener('click', () => {
      wiredOutput.textContent = 'wired-clicked';
    });
    window.__fixtureWiredHover = () => { wiredOutput.textContent = 'wired-hovered'; };
    document.getElementById('pointer-card').addEventListener('click', () => {
      wiredOutput.textContent = 'card-clicked';
    });
    // The page reports the file the way a site would use it: through its own change event,
    // reading name, size, and -- the part that proves the bytes really arrived -- the contents.
    document.getElementById('file-input').addEventListener('change', async (event) => {
      const out = document.getElementById('file-output');
      const file = event.target.files[0];
      if (!file) { out.textContent = 'No file'; return; }
      const text = await file.text();
      out.textContent = 'file:' + file.name + ':' + file.size + ':' + text;
    });
    document.getElementById('hidden-file-button').addEventListener('click', () => {
      document.getElementById('hidden-file-input').click();
    });
    document.getElementById('hidden-file-input').addEventListener('change', async (event) => {
      const out = document.getElementById('hidden-file-output');
      const file = event.target.files[0];
      if (!file) { out.textContent = 'No hidden file'; return; }
      const text = await file.text();
      out.textContent = 'hidden:' + file.name + ':' + file.size + ':' + text;
    });
    let dragging = false;
    document.getElementById('drag-source').addEventListener('mousedown', () => { dragging = true; });
    document.addEventListener('mouseup', (event) => {
      if (dragging && event.target === document.getElementById('drag-target')) {
        document.getElementById('drag-output').textContent = 'dragged';
      }
      dragging = false;
    });
    setTimeout(() => { document.getElementById('delayed-output').textContent = 'Delayed fixture ready'; }, 350);
    document.getElementById('diagnostics-button').addEventListener('click', () => {
      // One click that produces every kind of thing browser_console reports: a plain log, an
      // error the page chose to print, a request that 404s, and an exception nobody catches.
      console.log('fixture console line');
      console.error('fixture console error');
      // The body has to be read, or the request never finishes loading and the page never goes
      // network-idle again -- which is correct of network_idle, and would be this fixture
      // leaving a request outstanding for the rest of the run.
      fetch('/api/missing').then((response) => response.text()).catch(() => {});
      // A POST that 302s to a GET: two hops, one requestId.
      fetch('/api/redirect', { method: 'POST' }).then((response) => response.text()).catch(() => {});
      setTimeout(() => { throw new TypeError('fixture uncaught failure'); }, 0);
    });
    fetch('/api/delay').then((response) => response.text()).then((text) => {
      document.getElementById('network-output').textContent = text;
    });
    const root = document.getElementById('shadow-host').attachShadow({mode: 'open'});
    root.innerHTML = '<button id="shadow-button" type="button">Fixture shadow button</button>';
    `,
  );
}

function pageTwo() {
  return htmlPage(
    "Fixture Page Two",
    `<section><h2>History target</h2><p id="page-two-marker">Fixture history marker</p><a href="/">Back to fixture home</a></section>`,
  );
}

// The three ways a page asks for a file that no ref can reach through an ordinary input: a button
// whose script creates an input on the fly and clicks it (the input is in no document), a drop
// zone with no input at all, and the File System Access picker. Each writes what it received into
// its own status line, so a check reads the page's own account rather than the tool's.
function uploadShapesPage() {
  return htmlPage(
    "Upload shapes",
    `<button id="attach" type="button">Attach a file</button>
<p id="attached">attached: none</p>
<div id="dropzone" role="button" tabindex="0" aria-label="Drop files here"
  style="width:300px;height:120px;border:2px dashed #888;margin:12px 0">Drop files here</div>
<p id="dropped">dropped: none</p>
<button id="pick" type="button">Open with picker</button>
<p id="picked">picked: none</p>`,
    `document.getElementById('attach').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.addEventListener('change', () => {
    document.getElementById('attached').textContent =
      'attached: ' + [...input.files].map((f) => f.name + ':' + f.size).join(',');
  });
  input.click();
});
const zone = document.getElementById('dropzone');
zone.addEventListener('dragover', (e) => e.preventDefault());
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  document.getElementById('dropped').textContent =
    'dropped: ' + [...e.dataTransfer.files].map((f) => f.name + ':' + f.size).join(',');
});
document.getElementById('pick').addEventListener('click', async () => {
  try {
    const [handle] = await window.showOpenFilePicker();
    const file = await handle.getFile();
    document.getElementById('picked').textContent =
      'picked: ' + handle.name + ':' + file.size + ':' + (await file.text());
  } catch (e) {
    document.getElementById('picked').textContent = 'picked: ' + e.name;
  }
});`,
  );
}

function protectedPage() {
  return htmlPage(
    "Authenticated Fixture",
    `<section><h2>Authentication</h2><p id="auth-marker">AUTH OK</p></section>`,
  );
}

// Geometry: solid-colour targets whose pixels the suite finds in a screenshot and whose clicks the
// page reports, so a coordinate is proven by where the click LANDED -- never by the arithmetic that
// produced it. The targets sit at the viewport's corners and centre, one is 6 CSS px at a
// fractional offset, one is below the fold, one is inside a CSS-zoomed box and one is rotated.
// The readout is what the page itself measures: devicePixelRatio, the layout viewport, and the
// visual viewport a pinch moves.
export const GEOMETRY_TARGETS = [
  { id: "tl", rgb: [255, 0, 0] },
  { id: "tr", rgb: [0, 160, 0] },
  { id: "bl", rgb: [0, 0, 255] },
  { id: "br", rgb: [255, 140, 0] },
  { id: "mid", rgb: [160, 0, 160] },
  { id: "tiny", rgb: [0, 170, 170] },
  { id: "below", rgb: [200, 200, 0] },
  { id: "zoomed", rgb: [120, 60, 0] },
  { id: "turned", rgb: [0, 90, 160] },
];

// A scrollbar that takes layout space, as Windows and Linux draw by default and macOS does when
// "show scroll bars" is set to always -- the CI runner's setting. It changes what the page measures
// and what a capture covers, so the geometry fixture can be asked for one.
const CLASSIC_SCROLLBAR_CSS = `
    html { scrollbar-gutter: stable; }
    ::-webkit-scrollbar { width: 15px; height: 15px; }
    ::-webkit-scrollbar-thumb { background: #888; }
    ::-webkit-scrollbar-track { background: #eee; }`;

function geometryPage(classicScrollbar) {
  const buttons = GEOMETRY_TARGETS.map(
    ({ id, rgb }) =>
      `<button class="t" id="${id}" aria-label="Geometry target ${id}" style="background:rgb(${rgb.join(",")})"></button>`,
  );
  const inZoom = buttons.find((b) => b.includes('id="zoomed"'));
  const outside = buttons.filter((b) => b !== inZoom).join("\n  ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Geometry fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { width: 100%; min-height: 300vh; position: relative; font: 12px/1.3 monospace; }
    .t { all: unset; position: absolute; display: block; width: 24px; height: 24px; }
    #tiny { width: 6px; height: 6px; }
    #turned { transform: rotate(30deg); }
    #zoombox { position: absolute; zoom: 1.5; width: 60px; height: 60px; }
    #zoomed { left: 10px; top: 10px; }
    #readout { position: absolute; left: 0; top: 220vh; pointer-events: none; }
    /* Frames keep coming while something animates, and a synthesized pinch advances one frame at
       a time: without this a still page leaves the gesture waiting for a frame that never comes. */
    #ticker { position: absolute; left: 0; top: 230vh; width: 4px; height: 4px; background: #eee;
      animation: tick 1s linear infinite; }
    @keyframes tick { to { transform: rotate(360deg); } }${classicScrollbar ? CLASSIC_SCROLLBAR_CSS : ""}
  </style>
</head>
<body>
  ${outside}
  <div id="zoombox">${inZoom}</div>
  <div id="ticker"></div>
  <div id="readout"><div id="out">none</div><div id="metrics"></div><div id="rects"></div><div id="scrolls"></div></div>
  <script>
    const out = document.getElementById('out');
    const place = () => {
      const w = document.documentElement.clientWidth, h = window.innerHeight;
      const at = (id, x, y) => { const e = document.getElementById(id); e.style.left = x + 'px'; e.style.top = y + 'px'; };
      at('tl', 4, 4); at('tr', w - 28, 4); at('bl', 4, h - 28); at('br', w - 28, h - 28);
      at('mid', Math.round(w / 2) - 12, Math.round(h / 2) - 12);
      at('tiny', Math.round(w * 0.3) + 0.5, Math.round(h * 0.3) + 0.5);
      at('below', Math.round(w / 3), Math.round(h * 1.6));
      at('turned', Math.round(w * 0.7), Math.round(h * 0.6));
      const box = document.getElementById('zoombox');
      // CSS zoom scales the box's own offsets too: 0.4 of the viewport lands at 0.6 of it.
      box.style.left = Math.round(w * 0.1) + 'px'; box.style.top = Math.round(h * 0.4) + 'px';
      measure();
    };
    // Every scroll the page sees, with the page's own clock: a scroll is animated, and in a
    // background tab the animation advances only as fast as that tab gets frames.
    const scrollLog = [];
    addEventListener('scroll', () => {
      if (scrollLog.length < 300) {
        scrollLog.push(Math.round(performance.now()) + ':' + Math.round(window.scrollY));
      }
    }, { capture: true });
    // How far the page's content reaches on one axis, from the root and body (whose own min-height
    // makes this page tall) down through every element.
    //
    // floorAtViewport is false for the WIDTH. A full-page capture is clipped by Chrome to its own
    // content area, and where the scrollbar is an overlay that area can be narrower than
    // documentElement.clientWidth: measured 1335 against a clientWidth of 1350, with the capture
    // staying 1335 even when the clip was raised to 1350, so the browser and not the extension
    // decides it. Flooring the expected width at the viewport therefore demanded an image Chrome
    // will not produce. Height keeps its floor: a short page must still capture the whole
    // viewport, and nothing clips that.
    const extent = (edge, viewport, scrolled, floorAtViewport = true) => Math.max(
      floorAtViewport ? document.documentElement[viewport] : 0,
      ...[document.documentElement, document.body, ...document.querySelectorAll('body *')]
        .map((e) => Math.round(e.getBoundingClientRect()[edge] + scrolled)),
    );
    const measure = () => {
      const vv = window.visualViewport;
      document.getElementById('metrics').textContent = 'metrics' +
        ' dpr=' + window.devicePixelRatio + ' iw=' + window.innerWidth + ' ih=' + window.innerHeight +
        ' cw=' + document.documentElement.clientWidth +
        ' ch=' + document.documentElement.clientHeight +
        ' vvs=' + vv.scale + ' vvl=' + vv.offsetLeft + ' vvt=' + vv.offsetTop +
        ' vvw=' + vv.width + ' vvh=' + vv.height +
        ' sx=' + window.scrollX + ' sy=' + window.scrollY +
        ' dw=' + document.documentElement.scrollWidth + ' dh=' + document.documentElement.scrollHeight +
        // How far the page's own content actually reaches, which is what a full-page capture must
        // cover: scrollWidth is inflated by the gutter a classic scrollbar reserves on some
        // machines and reflects real overflow on others, so it cannot stand in for it.
        ' ew=' + extent('right', 'clientWidth', window.scrollX, false) +
        ' eh=' + extent('bottom', 'clientHeight', window.scrollY) + ' end';
      document.getElementById('scrolls').textContent = 'scrolls ' + scrollLog.join(' ') + ' end';
      document.getElementById('rects').textContent = 'rects ' + [...document.querySelectorAll('.t')].map((e) => {
        const r = e.getBoundingClientRect();
        return e.id + '=' + [r.left, r.top, r.width, r.height].map((v) => v.toFixed(2)).join(',');
      }).join(' ') + ' end';
    };
    for (const e of document.querySelectorAll('.t')) {
      e.addEventListener('click', (ev) => { out.textContent = 'hit:' + e.id + '@' + ev.clientX + ',' + ev.clientY; });
      e.addEventListener('mouseenter', () => { out.textContent = 'over:' + e.id; });
    }
    // A press released over another element is a drop. Chrome then fires click on the two
    // elements' common ancestor, which is not a click anyone aimed.
    let pressed = null;
    let dropped = false;
    document.addEventListener('mousedown', (ev) => { pressed = ev.target.id || 'page'; dropped = false; });
    document.addEventListener('mouseup', (ev) => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (pressed && under && pressed !== (under.id || 'page')) {
        out.textContent = 'drop:' + pressed + '>' + (under.id || 'page');
        dropped = true;
      }
      pressed = null;
    });
    // A click that reaches no target says so, so it can never read as the previous target's hit.
    document.addEventListener('click', (ev) => {
      if (dropped) {
        dropped = false;
      } else if (!ev.target.classList || !ev.target.classList.contains('t')) {
        out.textContent = 'miss@' + ev.clientX + ',' + ev.clientY;
      }
    });
    // Placed once: a full-page screenshot lays the page out at the document's height for the
    // capture, and a re-placement on that resize would move the targets under the next check.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure);
    visualViewport.addEventListener('resize', measure);
    visualViewport.addEventListener('scroll', measure);
    place();
  </script>
</body>
</html>`;
}

function toneWav() {
  const sampleRate = 8000;
  const samples = 2000;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 5000,
    );
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

export async function startFixtureServer() {
  const audio = toneWav();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      });
      response.end(body);
    };

    if (url.pathname === "/") {
      send(200, "text/html; charset=utf-8", fixtureHome());
      return;
    }
    if (url.pathname === "/timers") {
      // The page times its own setTimeout delays: what a page can rely on while it is not the
      // tab in front, which is where every wait this tool makes has to work.
      send(
        200,
        "text/html; charset=utf-8",
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timers</title></head>
<body><div id="log">timers end</div><script>
  const delays = [];
  const render = () => { document.getElementById('log').textContent = 'timers ' + delays.join(' ') + ' end'; };
  for (const ms of [50, 100, 250, 1000]) {
    const start = performance.now();
    setTimeout(() => { delays.push('timer:' + ms + '=' + Math.round(performance.now() - start)); render(); }, ms);
  }
</script></body></html>`,
      );
      return;
    }
    if (url.pathname === "/geometry") {
      send(
        200,
        "text/html; charset=utf-8",
        geometryPage(url.searchParams.get("scrollbar") === "classic"),
      );
      return;
    }
    if (url.pathname === "/page2") {
      send(200, "text/html; charset=utf-8", pageTwo());
      return;
    }
    if (url.pathname === "/popup") {
      // A link that opens a new tab the way most sites do it: target=_blank, which implies
      // noopener -- so Chrome names no opener for the new tab to an extension.
      send(
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Popup source",
          `<a id="popup-link" href="/page2?from=popup" target="_blank">Open the popup</a>`,
        ),
      );
      return;
    }
    if (url.pathname === "/uploads") {
      send(200, "text/html; charset=utf-8", uploadShapesPage());
      return;
    }
    if (url.pathname === "/api/delay") {
      setTimeout(
        () => send(200, "text/plain; charset=utf-8", "Network fixture ready"),
        300,
      );
      return;
    }
    // A POST that redirects, which is what a real form submit does. browser_network logged only
    // the GET that followed, because the redirect re-fires requestWillBeSent under the same id.
    if (url.pathname === "/api/redirect") {
      response.writeHead(302, { location: "/api/landed" });
      response.end();
      return;
    }
    if (url.pathname === "/api/landed") {
      send(200, "text/plain; charset=utf-8", "landed");
      return;
    }
    if (url.pathname === "/download.txt") {
      send(
        200,
        "text/plain; charset=utf-8",
        "chrome-control-mcp-e2e-download\n",
        {
          "content-disposition": "attachment; filename=fixture-download.txt",
        },
      );
      return;
    }
    if (url.pathname === "/tone.wav") {
      send(200, "audio/wav", audio, { "content-length": String(audio.length) });
      return;
    }
    if (url.pathname === "/protected") {
      const expected = `Basic ${Buffer.from("e2e:pass").toString("base64")}`;
      if (request.headers.authorization !== expected) {
        send(401, "text/plain; charset=utf-8", "authentication required", {
          "www-authenticate": 'Basic realm="Chrome Control MCP E2E"',
        });
        return;
      }
      send(200, "text/html; charset=utf-8", protectedPage());
      return;
    }
    send(404, "text/plain; charset=utf-8", "not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
