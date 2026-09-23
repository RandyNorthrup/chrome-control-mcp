// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Draws the marketplace icon: the project's own signature, a browser window
// wearing the pink AI CONTROL frame, in the palette the social preview already
// uses. Committed as a script rather than a binary someone has to recreate by
// hand, so the icon can be regenerated or adjusted without a design tool.
//
// Usage: node scripts/make_icon.mjs [--size 128] [--out icon.png]

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPERSAMPLE = 4;
const SLATE = [0x11, 0x13, 0x1b];
const SLATE_EDGE = [0x1e, 0x22, 0x30];
const CHROME = [0xe9, 0xec, 0xf3];
const MUTED = [0x7a, 0x84, 0x97];
const PINK = [0xec, 0x48, 0x99];
const VIOLET = [0xa7, 0x8b, 0xfa];

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    size: Number(get("--size", "128")),
    out: get("--out", "icon.png"),
  };
}

/** Coverage in [0,1] of a point inside a rounded rectangle. */
function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(right - radius, x));
  const cy = Math.max(top + radius, Math.min(bottom - radius, y));
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) {
    return x >= left && x <= right && y >= top && y <= bottom ? 1 : 0;
  }
  return Math.hypot(dx, dy) <= radius ? 1 : 0;
}

function circle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) <= radius ? 1 : 0;
}

/** Paint `color` over `pixel` with coverage `alpha`, tracking opacity. */
function over(pixel, color, alpha) {
  if (alpha <= 0) {
    return;
  }
  for (let i = 0; i < 3; i += 1) {
    pixel[i] = pixel[i] * (1 - alpha) + color[i] * alpha;
  }
  pixel[3] = pixel[3] * (1 - alpha) + alpha;
}

/**
 * One sample of the icon at unit coordinates, both in [0,1]. Everything is
 * expressed as a fraction of the icon so the drawing is resolution independent.
 */
function sample(u, v) {
  const pixel = [0, 0, 0, 0];

  // Card: a rounded square, slightly lighter at its edge so it reads as a
  // surface rather than a hole at small sizes.
  const card = roundedRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22);
  if (card === 0) {
    return pixel;
  }
  const edge = roundedRect(u, v, 0.05, 0.05, 0.95, 0.95, 0.19);
  over(pixel, edge ? SLATE : SLATE_EDGE, 1);

  // A violet glow behind the window, echoing the social preview's blurred
  // accent, so the icon is not flat black behind the frame.
  const glow = Math.max(0, 1 - Math.hypot(u - 0.72, v - 0.26) / 0.45);
  over(pixel, VIOLET, glow * glow * 0.22);

  // Browser window.
  const winL = 0.165;
  const winR = 0.835;
  const winT = 0.2;
  const winB = 0.8;
  const outer = roundedRect(u, v, winL, winT, winR, winB, 0.075);
  const inner = roundedRect(
    u,
    v,
    winL + 0.035,
    winT + 0.035,
    winR - 0.035,
    winB - 0.035,
    0.05,
  );
  over(pixel, CHROME, outer - inner);

  // Title bar rule and its three dots.
  const bar = winT + 0.145;
  if (u > winL + 0.035 && u < winR - 0.035 && Math.abs(v - bar) < 0.011) {
    over(pixel, MUTED, 0.75);
  }
  for (let i = 0; i < 3; i += 1) {
    over(
      pixel,
      MUTED,
      circle(u, v, winL + 0.085 + i * 0.062, winT + 0.082, 0.02),
    );
  }

  // The AI CONTROL frame: the pink border this project draws around a tab it is
  // driving. It is the whole identity of the thing, so it is the loudest mark.
  const frameOuter = roundedRect(
    u,
    v,
    winL + 0.075,
    bar + 0.055,
    winR - 0.075,
    winB - 0.075,
    0.035,
  );
  const frameInner = roundedRect(
    u,
    v,
    winL + 0.115,
    bar + 0.095,
    winR - 0.115,
    winB - 0.115,
    0.02,
  );
  over(pixel, PINK, frameOuter - frameInner);

  // The agent cursor inside the frame.
  over(pixel, PINK, circle(u, v, 0.58, 0.63, 0.045));
  over(pixel, CHROME, circle(u, v, 0.58, 0.63, 0.018));

  return pixel;
}

function render(size) {
  const dimension = size * SUPERSAMPLE;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (x * SUPERSAMPLE + sx + 0.5) / dimension;
          const v = (y * SUPERSAMPLE + sy + 0.5) / dimension;
          const pixel = sample(u, v);
          // Weight colour by its own coverage so a transparent sample does not
          // drag the corner pixels toward black.
          r += pixel[0] * pixel[3];
          g += pixel[1] * pixel[3];
          b += pixel[2] * pixel[3];
          a += pixel[3];
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
      }
      rgba[offset + 3] = Math.round((a / samples) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // Scanlines carry filter byte 0: the image is tiny and deflate handles it.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const { size, out } = parseArgs(process.argv.slice(2));
const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  out,
);
writeFileSync(target, encodePng(render(size), size));
console.log(`Wrote ${target} (${size}x${size})`);
