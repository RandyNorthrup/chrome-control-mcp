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
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 5000);
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
    if (url.pathname === "/page2") {
      send(200, "text/html; charset=utf-8", pageTwo());
      return;
    }
    if (url.pathname === "/api/delay") {
      setTimeout(() => send(200, "text/plain; charset=utf-8", "Network fixture ready"), 300);
      return;
    }
    if (url.pathname === "/download.txt") {
      send(200, "text/plain; charset=utf-8", "chrome-control-mcp-e2e-download\n", {
        "content-disposition": "attachment; filename=fixture-download.txt",
      });
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
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
