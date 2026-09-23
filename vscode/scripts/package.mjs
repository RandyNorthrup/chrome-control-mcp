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

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Every target the release workflow builds an archive for. A target absent
// here cannot be packaged by accident with a payload for another platform.
const TARGETS = new Map([
  ["win32-x64", { executable: "chrome_control_mcp.exe" }],
  ["linux-x64", { executable: "chrome_control_mcp" }],
  ["darwin-arm64", { executable: "chrome_control_mcp" }],
  ["darwin-x64", { executable: "chrome_control_mcp" }],
]);

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
if (!fs.existsSync(path.join(payloadRoot, executable))) {
  fail(`${payloadRoot} does not contain ${executable}`);
}
// The server needs its extension folder beside it: that folder is what the
// user loads into Chrome, and a VSIX without it installs a server that cannot
// be attached to a browser.
if (!fs.existsSync(path.join(payloadRoot, "extension", "manifest.json"))) {
  fail(`${payloadRoot} does not contain extension/manifest.json`);
}

// Stage the payload flat under bin/. The Qt runtime and the TLS backend have to
// sit beside the executable, so the tree is copied whole rather than
// cherry-picked.
const binary = path.join(extensionRoot, "bin");
fs.rmSync(binary, { recursive: true, force: true });
// dereference: a macOS payload carries Qt frameworks, which are directories of
// symlinks (QtCore.framework/QtCore -> Versions/Current/QtCore). Packaging
// those as links makes vsce's secret scanner fail outright, and a VSIX is a zip
// whose link handling is not worth depending on. Copying the real files costs a
// few megabytes and leaves the paths dyld actually resolves -- the versioned
// ones named by the install_name -- as ordinary files.
fs.cpSync(payloadRoot, binary, { recursive: true, dereference: true });
// Qt frameworks ship their headers, and a framework's Headers directory is
// hundreds of text files that nothing at runtime reads. They are dead weight in
// a VSIX and they are what the marketplace secret scanner spends its time on,
// so drop them along with the other build-time leftovers.
function prune(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "Headers" || entry.name.endsWith(".dSYM")) {
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      prune(full);
    } else if (entry.name.endsWith(".prl") || entry.name.endsWith(".la")) {
      fs.rmSync(full, { force: true });
    }
  }
}
prune(binary);

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
run(
  "npx",
  ["vsce", "package", "--target", target, "--out", out, "--no-dependencies"],
  extensionRoot,
);
console.log(`VSIX: ${out}`);
