// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The Chrome Web Store package: the extension folder, zipped, with the manifest's `key` removed.
//
// The unpacked extension carries a manifest `key` so every unpacked install has the same ID
// (iojehhmnaigcejfcpmilpclmeljhlkaa). The store signs its build with a key of its own and refuses a
// package whose manifest names one, so the store package is the same files with `key` taken out.
// The store also refuses a description over 132 characters, and its listing needs the icons, so a
// manifest that breaks either rule is refused here, before an upload that would fail for it.
//
// Usage:
//   node scripts/store_package.mjs --version 1.13.0 --out chrome-control-mcp-1.13.0-store.zip
//   node scripts/store_package.mjs --version 1.13.0 --out pkg.zip --extension browser/extension
//
// --version is the release's version; the manifest must state the same one.
//
// The zip is written by this file, with no dependency: stored or deflated entries, a fixed
// timestamp so the same folder always gives the same bytes, and forward-slash paths.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const DESCRIPTION_MAX = 132;
export const ICON_SIZES = ["16", "32", "48", "128"];

// 1980-01-01 00:00, the earliest time a zip entry can state: a fixed time keeps the bytes of a
// package a function of its files alone.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const ZIP_VERSION = 20;
const UTF8_FLAG = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_SIZE = 22;

export class StorePackageError extends Error {}

// Every file under @p dir, as forward-slash paths relative to it, in a stable order.
export function listFiles(dir) {
  const found = [];
  const walk = (relative) => {
    const entries = fs.readdirSync(path.join(dir, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        found.push(child);
      } else {
        throw new StorePackageError(`${child} is neither a file nor a folder`);
      }
    }
  };
  walk("");
  return found.sort();
}

// The manifest the store receives: @p manifest without `key`, after checking the rules the store
// and its listing hold it to. @p files is the package's file list, for the icon check.
export function storeManifest(manifest, { version, files }) {
  const problems = [];
  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version is ${manifest.manifest_version}, not 3`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    problems.push("the manifest has no name");
  }
  if (manifest.version !== version) {
    problems.push(
      `the manifest's version is ${manifest.version}, not the release's ${version}`,
    );
  }
  const description = manifest.description;
  if (typeof description !== "string" || description.length === 0) {
    problems.push("the manifest has no description");
  } else if (description.length > DESCRIPTION_MAX) {
    problems.push(
      `the description is ${description.length} characters; the store allows ${DESCRIPTION_MAX}`,
    );
  }
  const icons = manifest.icons ?? {};
  for (const size of ICON_SIZES) {
    const icon = icons[size];
    if (typeof icon !== "string") {
      problems.push(`the manifest names no ${size}px icon`);
    } else if (!files.includes(icon)) {
      problems.push(`the ${size}px icon ${icon} is not in the folder`);
    }
  }
  if (problems.length > 0) {
    throw new StorePackageError(problems.join("; "));
  }
  const { key: _key, ...rest } = manifest;
  return rest;
}

// A zip archive of @p entries ([{name, data}]), each deflated unless that would not save space.
export function zipEntries(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(stored ? METHOD_STORED : METHOD_DEFLATED, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(stored ? METHOD_STORED : METHOD_DEFLATED, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += LOCAL_HEADER_SIZE + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_OF_CENTRAL_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The entries of a zip this file wrote (or any zip without data descriptors or zip64), read
// through its central directory and checked against each entry's CRC.
export function readZip(bytes) {
  const endAt = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) {
    throw new StorePackageError("not a zip: no end of central directory");
  }
  const count = bytes.readUInt16LE(endAt + 10);
  let at = bytes.readUInt32LE(endAt + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(at) !== CENTRAL_HEADER) {
      throw new StorePackageError(`central directory entry ${i} is malformed`);
    }
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localAt = bytes.readUInt32LE(at + 42);
    const name = bytes.toString(
      "utf8",
      at + CENTRAL_HEADER_SIZE,
      at + CENTRAL_HEADER_SIZE + nameLength,
    );
    const localName = bytes.readUInt16LE(localAt + 26);
    const localExtra = bytes.readUInt16LE(localAt + 28);
    const start = localAt + LOCAL_HEADER_SIZE + localName + localExtra;
    const body = bytes.subarray(start, start + compressed);
    const data =
      method === METHOD_STORED ? Buffer.from(body) : zlib.inflateRawSync(body);
    if (zlib.crc32(data) !== crc) {
      throw new StorePackageError(`${name}: CRC mismatch`);
    }
    entries.push({ name, data });
    at += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

// The store package of @p extensionDir for release @p version, as zip bytes, and its file list.
export function buildStorePackage({ extensionDir, version }) {
  const files = listFiles(extensionDir);
  if (!files.includes("manifest.json")) {
    throw new StorePackageError(`${extensionDir} has no manifest.json`);
  }
  let manifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"),
    );
  } catch (error) {
    throw new StorePackageError(
      `manifest.json does not parse: ${error.message}`,
    );
  }
  const forStore = storeManifest(manifest, { version, files });
  const entries = files.map((name) => ({
    name,
    data:
      name === "manifest.json"
        ? Buffer.from(`${JSON.stringify(forStore, null, 2)}\n`, "utf8")
        : fs.readFileSync(path.join(extensionDir, name)),
  }));
  return { bytes: zipEntries(entries), files, manifest: forStore };
}

function argument(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const version = argument("--version");
  const out = argument("--out");
  if (!version || !out) {
    throw new StorePackageError(
      "usage: store_package.mjs --version X.Y.Z --out FILE.zip",
    );
  }
  const extensionDir = path.resolve(
    argument("--extension") ?? path.join(root, "browser/extension"),
  );
  const { bytes, files } = buildStorePackage({
    extensionDir,
    version: version.replace(/^v/, ""),
  });
  fs.writeFileSync(out, bytes);
  console.log(
    `${out}: ${files.length} files, ${bytes.length} bytes, manifest without key`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    if (error instanceof StorePackageError) {
      console.error(`store package: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
