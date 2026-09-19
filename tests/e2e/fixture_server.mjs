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
    #deep-target { margin-top: 40rem; }
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
      </div>
      <div class="grid">
        <button id="normal-button" type="button">Fixture click button</button>
        <button id="js-button" type="button">Fixture JS button</button>
        <button id="coordinate-button" type="button">Fixture coordinate button</button>
        <button id="prompt-button" type="button">Open fixture prompt</button>
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
        <button id="deep-target" type="button">Fixture deep target</button>
      </div>
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
    let dragging = false;
    document.getElementById('drag-source').addEventListener('mousedown', () => { dragging = true; });
    document.addEventListener('mouseup', (event) => {
      if (dragging && event.target === document.getElementById('drag-target')) {
        document.getElementById('drag-output').textContent = 'dragged';
      }
      dragging = false;
    });
    setTimeout(() => { document.getElementById('delayed-output').textContent = 'Delayed fixture ready'; }, 350);
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

function geometryPage() {
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
    @keyframes tick { to { transform: rotate(360deg); } }
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
    const measure = () => {
      const vv = window.visualViewport;
      document.getElementById('metrics').textContent = 'metrics' +
        ' dpr=' + window.devicePixelRatio + ' iw=' + window.innerWidth + ' ih=' + window.innerHeight +
        ' cw=' + document.documentElement.clientWidth +
        ' vvs=' + vv.scale + ' vvl=' + vv.offsetLeft + ' vvt=' + vv.offsetTop +
        ' vvw=' + vv.width + ' vvh=' + vv.height +
        ' sx=' + window.scrollX + ' sy=' + window.scrollY +
        ' dw=' + document.documentElement.scrollWidth + ' dh=' + document.documentElement.scrollHeight +
        ' dwx=' + document.documentElement.getBoundingClientRect().width +
        ' dhx=' + document.documentElement.getBoundingClientRect().height + ' end';
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
      send(200, "text/html; charset=utf-8", geometryPage());
      return;
    }
    if (url.pathname === "/page2") {
      send(200, "text/html; charset=utf-8", pageTwo());
      return;
    }
    if (url.pathname === "/api/delay") {
      setTimeout(
        () => send(200, "text/plain; charset=utf-8", "Network fixture ready"),
        300,
      );
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
