// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// Every place this project states its own version has to state the SAME version.
//
// WHY THIS EXISTS
// Both package-lock.json files sat at 1.3.1 while the project shipped 1.4.0,
// 1.5.0, 1.5.1, 1.5.2, 1.5.3 and 1.5.4. Five releases went out carrying a
// lockfile that named a version from before any of them, and nothing noticed,
// because nothing had ever compared the places a version is written. npm does
// not check it either: `npm ci` validates dependencies against the lock, not the
// root version, so the drift is silent by construction.
//
// A version is not decoration. The extension's manifest version is what Chrome
// shows the user and what the installer compares to decide an upgrade, and the
// header constant is what the server reports for the extension it expects. Those
// disagreeing is the kind of fault that reads as "the update did not apply".
//
// The release checklist is a person remembering six files. This is the same
// checklist, run by the gate.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readJson = (relative) => JSON.parse(read(relative));

// The version the whole project is at: CMake is the build's own source of truth,
// so it is the one every other site is compared against rather than a constant
// repeated here (which would just become a seventh place to forget).
function projectVersion() {
  const match = read("CMakeLists.txt").match(
    /project\([^)]*?VERSION\s+(\d+\.\d+\.\d+)/s,
  );
  assert.ok(match, "CMakeLists.txt does not state a project VERSION");
  return match[1];
}

test("every file that states the version states the same one", () => {
  const version = projectVersion();

  const sites = [
    ["package.json", readJson("package.json").version],
    ["vscode/package.json", readJson("vscode/package.json").version],
    [
      "browser/extension/manifest.json",
      readJson("browser/extension/manifest.json").version,
    ],
    // What npm writes, and what it reinstalls from. Both fields, because npm
    // keeps the root version in two places and updates them together.
    ["package-lock.json (version)", readJson("package-lock.json").version],
    [
      'package-lock.json (packages[""])',
      readJson("package-lock.json").packages[""].version,
    ],
    [
      "vscode/package-lock.json (version)",
      readJson("vscode/package-lock.json").version,
    ],
    [
      'vscode/package-lock.json (packages[""])',
      readJson("vscode/package-lock.json").packages[""].version,
    ],
  ];

  for (const [where, found] of sites) {
    assert.equal(
      found,
      version,
      `${where} says ${found}, but CMakeLists.txt says ${version}`,
    );
  }

  // The extension version the SERVER expects, which is compared against the
  // manifest the browser actually loaded.
  const header = read(
    "include/chrome_control_mcp/browser_extension_installer.h",
  );
  const constant = header.match(
    /kBrowserExtensionVersion\[\]\s*=\s*"(\d+\.\d+\.\d+)"/,
  );
  assert.ok(
    constant,
    "browser_extension_installer.h states no extension version",
  );
  assert.equal(
    constant[1],
    version,
    `browser_extension_installer.h says ${constant[1]}, but CMakeLists.txt says ${version}`,
  );
});

test("the version being shipped is written down for the people upgrading to it", () => {
  const version = projectVersion();

  // A release that changed something and said nothing about it is the failure
  // this catches: the changelog entry and the release note are how an upgrade is
  // explained, and both are easy to leave behind in the bump.
  assert.ok(
    read("CHANGELOG.md").includes(`## [${version}]`),
    `CHANGELOG.md has no "## [${version}]" section`,
  );
  assert.ok(
    fs.existsSync(path.join(root, "docs", "releases", `v${version}.md`)),
    `docs/releases/v${version}.md does not exist`,
  );
});
