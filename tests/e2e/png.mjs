// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Just enough PNG to read a browser screenshot back: 8-bit RGB or RGBA, non-interlaced -- what
// Chrome's Page.captureScreenshot produces. Anything else is refused, never approximated.

import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Not a PNG image.");
  }
  let offset = 8;
  let header = null;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (offset + 8 + length > buffer.length) {
      throw new Error(
        `Truncated PNG: ${type} chunk claims ${length} bytes with ${buffer.length - offset - 8} left.`,
      );
    }
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (
    !header ||
    header.bitDepth !== 8 ||
    (header.colorType !== 2 && header.colorType !== 6) ||
    header.interlace !== 0
  ) {
    throw new Error(`Unsupported PNG layout: ${JSON.stringify(header)}`);
  }
  const { width, height } = header;
  if (width <= 0 || height <= 0) {
    throw new Error(`PNG has no pixels: ${width}x${height}.`);
  }
  const channels = header.colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  // One filter byte and one row of samples per row, exactly. A short stream is a truncated
  // capture, and unfiltering it would read zeroes off the end as image data.
  if (raw.length !== (stride + 1) * height) {
    throw new Error(
      `Truncated PNG pixels: ${raw.length} bytes for a ${width}x${height} image ` +
        `(expected ${(stride + 1) * height}).`,
    );
  }
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c =
        y > 0 && x >= channels ? pixels[out - stride + x - channels] : 0;
      let value = raw[line + x];
      if (filter === 1) {
        value += a;
      } else if (filter === 2) {
        value += b;
      } else if (filter === 3) {
        value += (a + b) >> 1;
      } else if (filter === 4) {
        value += paeth(a, b, c);
      } else if (filter !== 0) {
        throw new Error(`Invalid PNG filter ${filter} on row ${y}.`);
      }
      pixels[out + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// The bounding box, in image pixels, of every pixel of each colour. A target that is not in the
// image has no entry. `tolerance` absorbs colour-management rounding, nothing more: the targets'
// colours are far apart.
export function colourBoxes(image, targets, tolerance = 8) {
  const boxes = new Map();
  const { width, height, channels, pixels } = image;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      for (const { id, rgb } of targets) {
        if (
          Math.abs(pixels[i] - rgb[0]) <= tolerance &&
          Math.abs(pixels[i + 1] - rgb[1]) <= tolerance &&
          Math.abs(pixels[i + 2] - rgb[2]) <= tolerance
        ) {
          const box = boxes.get(id);
          if (box) {
            box.left = Math.min(box.left, x);
            box.right = Math.max(box.right, x);
            box.top = Math.min(box.top, y);
            box.bottom = Math.max(box.bottom, y);
            box.pixels += 1;
          } else {
            boxes.set(id, { left: x, right: x, top: y, bottom: y, pixels: 1 });
          }
          break;
        }
      }
    }
  }
  return boxes;
}
