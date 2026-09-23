// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Builds one platform-specific VSIX: stage a platform's install tree into
// bin/, compile the extension, and hand both to vsce with a --target.
//
// The marketplace serves the VSIX matching the user's platform, so each one
// carries exactly one binary and the extension never has to choose between
// several or download one after the fact.
//
// Usage:
//   node scripts/package.mjs --target win32-x64 --payload ../build/Release
//   node scripts/package.mjs --target linux-x64 --payload ./payload/linux-x64

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPayloadHasNoLinks,
  PayloadError,
  prunePayload,
  TARGETS,
  validatePayload,
} from "./payload.mjs";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const target = argument("--target");
if (!target || !TARGETS.has(target)) {
  fail(`--target must be one of ${[...TARGETS.keys()].join(", ")}`);
}
const payload = argument("--payload");
if (!payload) {
  fail("--payload must name the directory holding that platform's build");
}

const payloadRoot = path.resolve(payload);
const { executable } = TARGETS.get(target);
const binary = path.join(extensionRoot, "bin");

try {
  validatePayload(payloadRoot, executable);

  // Stage the payload flat under bin/. The Qt runtime and the TLS backend have
  // to sit beside the executable, so the tree is copied whole rather than
  // cherry-picked, then stripped of what a VSIX cannot or should not carry.
  fs.rmSync(binary, { recursive: true, force: true });
  fs.cpSync(payloadRoot, binary, { recursive: true });
  const removed = prunePayload(binary);
  assertPayloadHasNoLinks(binary);
  console.log(
    `payload: removed ${removed.links} links, ${removed.headers} header ` +
      `directories, ${removed.metadata} static-link files`,
  );
} catch (error) {
  if (error instanceof PayloadError) {
    fail(error.message);
  }
  throw error;
}

// A VSIX is a zip and the executable bit does not survive it reliably; the
// extension re-applies it at runtime. Set it here too so a locally installed
// VSIX works even if that ever regresses.
if (process.platform !== "win32") {
  fs.chmodSync(path.join(binary, executable), 0o755);
}

const { version, name } = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
);
const outDirectory = path.resolve(extensionRoot, "..", "dist");
fs.mkdirSync(outDirectory, { recursive: true });
const out = path.join(outDirectory, `${name}-${version}-${target}.vsix`);

run("npx", ["tsc", "-p", "."], extensionRoot);
// vsce's secret and .env scan stays on. This package goes to the marketplace,
// and the only thing that scan ever caught here was a payload defect of ours:
// a link to a directory, which it reports as EISDIR while the packer that runs
// after it reports the same entry as "not a file".
run(
  "npx",
  ["vsce", "package", "--target", target, "--out", out, "--no-dependencies"],
  extensionRoot,
);
console.log(`VSIX: ${out}`);
