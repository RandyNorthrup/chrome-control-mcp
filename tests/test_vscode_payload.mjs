// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The two rules that decide whether a platform build can become a VSIX, tested
// against a real directory tree. Both exist because of a defect that reached a
// release, so each is tested from the failing side as well as the passing one:
// a guard that cannot be observed failing is not a guard.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertPayloadHasNoLinks,
  PayloadError,
  prunePayload,
  TARGETS,
  validatePayload,
} from "../vscode/scripts/payload.mjs";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-payload-"));
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/**
 * A directory link, however this platform makes one. Windows refuses a file
 * symlink to an unprivileged process but allows a junction, and a junction is
 * the shape that matters here: every link that broke packaging pointed at a
 * directory.
 */
function linkDirectory(target, linkPath) {
  fs.symlinkSync(
    target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/** The macOS framework layout, which is the only payload that carries links. */
function frameworkPayload() {
  const root = scratch();
  const framework = path.join(root, "Frameworks", "QtCore.framework");
  write(path.join(framework, "Versions", "A", "QtCore"), "mach-o");
  write(
    path.join(framework, "Versions", "A", "Resources", "Info.plist"),
    "<plist/>",
  );
  write(
    path.join(framework, "Versions", "A", "Headers", "qobject.h"),
    "#pragma once",
  );
  write(
    path.join(framework, "Versions", "A", "QtCore.prl"),
    "QMAKE_PRL_TARGET = QtCore",
  );
  linkDirectory(
    path.join(framework, "Versions", "A"),
    path.join(framework, "Versions", "Current"),
  );
  linkDirectory(
    path.join(framework, "Versions", "Current", "Resources"),
    path.join(framework, "Resources"),
  );
  write(path.join(root, "chrome_control_mcp"), "mach-o");
  write(path.join(root, "extension", "manifest.json"), '{"version":"1.4.0"}');
  return root;
}

test("every published target names the executable that platform ships", () => {
  assert.equal(TARGETS.get("win32-x64").executable, "chrome_control_mcp.exe");
  for (const target of ["linux-x64", "darwin-arm64", "darwin-x64"]) {
    assert.equal(TARGETS.get(target).executable, "chrome_control_mcp");
  }
  // A target the release workflow does not build must not package by accident
  // against another platform's payload.
  assert.equal(TARGETS.has("win32-arm64"), false);
});

test("a payload without the server is refused", () => {
  const root = scratch();
  write(path.join(root, "extension", "manifest.json"), "{}");
  assert.throws(
    () => validatePayload(root, "chrome_control_mcp"),
    (error) =>
      error instanceof PayloadError &&
      error.message.includes("chrome_control_mcp"),
  );
});

test("a payload without the Chrome extension folder is refused", () => {
  // A VSIX without it installs a server that can never attach to a browser,
  // which is not a failure the user would see until they tried to use it.
  const root = scratch();
  write(path.join(root, "chrome_control_mcp"), "mach-o");
  assert.throws(
    () => validatePayload(root, "chrome_control_mcp"),
    (error) =>
      error instanceof PayloadError &&
      error.message.includes("extension/manifest.json"),
  );
});

test("pruning removes every link, and leaves what dyld opens", () => {
  const root = frameworkPayload();
  const framework = path.join(root, "Frameworks", "QtCore.framework");

  const removed = prunePayload(root);

  assert.equal(removed.links, 2);
  assert.equal(removed.headers, 1);
  assert.equal(removed.metadata, 1);
  assert.equal(fs.existsSync(path.join(framework, "Resources")), false);
  assert.equal(
    fs.existsSync(path.join(framework, "Versions", "Current")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(framework, "Versions", "A", "Headers")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(framework, "Versions", "A", "QtCore.prl")),
    false,
  );

  // The versioned path is the one Qt's install_name names, so it is the one
  // thing in the framework that must survive.
  assert.equal(
    fs.readFileSync(path.join(framework, "Versions", "A", "QtCore"), "utf8"),
    "mach-o",
  );
  assert.equal(
    fs.readFileSync(
      path.join(framework, "Versions", "A", "Resources", "Info.plist"),
      "utf8",
    ),
    "<plist/>",
  );
  // Pruning must not reach outside the framework.
  assert.equal(fs.existsSync(path.join(root, "chrome_control_mcp")), true);
  assert.equal(
    fs.existsSync(path.join(root, "extension", "manifest.json")),
    true,
  );
});

test("a pruned payload passes the link check", () => {
  const root = frameworkPayload();
  prunePayload(root);
  assert.doesNotThrow(() => assertPayloadHasNoLinks(root));
});

test("RED DRILL: a surviving link fails the check, and names itself", () => {
  // The guard exists because vsce reports this as EISDIR from its secret scan,
  // or as "not a file" from the packer, neither of which says what is wrong.
  // If this check ever stops firing, that confusion comes back.
  const root = frameworkPayload();
  assert.throws(
    () => assertPayloadHasNoLinks(root),
    (error) =>
      error instanceof PayloadError &&
      error.message.includes("still a link") &&
      error.message.includes("Resources"),
  );
});

test("RED DRILL: a link added below the top level is still caught", () => {
  // The walk has to recurse. A link three directories down breaks the package
  // exactly as one at the root does.
  const root = frameworkPayload();
  prunePayload(root);
  const buried = path.join(
    root,
    "Frameworks",
    "QtCore.framework",
    "Versions",
    "A",
  );
  linkDirectory(buried, path.join(buried, "Self"));
  assert.throws(
    () => assertPayloadHasNoLinks(root),
    (error) => error instanceof PayloadError && error.message.includes("Self"),
  );
});

test("pruning a payload that has nothing to strip changes nothing", () => {
  const root = scratch();
  write(path.join(root, "chrome_control_mcp.exe"), "pe");
  write(path.join(root, "Qt6Core.dll"), "pe");
  write(path.join(root, "extension", "manifest.json"), "{}");

  const removed = prunePayload(root);

  assert.deepEqual(removed, { links: 0, headers: 0, metadata: 0 });
  assert.equal(fs.existsSync(path.join(root, "Qt6Core.dll")), true);
  assert.doesNotThrow(() => assertPayloadHasNoLinks(root));
});
