// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// What a platform's build has to look like before it can become a VSIX, and the
// two rules that got there the hard way. Kept apart from the packaging command
// so both can be tested against a real directory tree instead of only through
// vsce.

import fs from "node:fs";
import path from "node:path";

// Every target the release workflow builds an archive for, and the executable
// each one carries. A target absent here cannot be packaged by accident with a
// payload built for another platform.
export const TARGETS = new Map([
  ["win32-x64", { executable: "chrome_control_mcp.exe" }],
  ["linux-x64", { executable: "chrome_control_mcp" }],
  ["darwin-arm64", { executable: "chrome_control_mcp" }],
  ["darwin-x64", { executable: "chrome_control_mcp" }],
]);

/** Raised for a payload this packaging step refuses to accept. */
export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadError";
  }
}

/**
 * The server needs its extension folder beside it -- that folder is what the
 * user loads into Chrome -- so a payload without one installs a server that can
 * never attach to a browser.
 */
export function validatePayload(root, executable) {
  if (!fs.existsSync(path.join(root, executable))) {
    throw new PayloadError(`${root} does not contain ${executable}`);
  }
  if (!fs.existsSync(path.join(root, "extension", "manifest.json"))) {
    throw new PayloadError(`${root} does not contain extension/manifest.json`);
  }
}

/**
 * Strip what must not reach a VSIX, and report what went.
 *
 * Links: a VSIX is a zip and neither half of vsce copes with one. Its secret
 * scanner reads every file it is given, so a link to a directory fails the
 * whole package with `EISDIR: illegal operation on a directory, read`, and if
 * that is silenced the packer then refuses the same entry with `not a file`. A
 * macOS Qt framework is built from links -- Versions/Current, Resources,
 * Headers, and the dylib stub beside them -- and all four are conveniences.
 * Qt's install_name names the versioned file directly, so removing them leaves
 * exactly what dyld opens, and costs less than resolving each into a duplicate.
 *
 * Headers and static-link metadata: build-time artifacts. Keeping Qt's headers
 * out takes a macOS payload from 1080 files to 26.
 */
export function prunePayload(directory) {
  const removed = { links: 0, headers: 0, metadata: 0 };
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.links += 1;
      } else if (entry.isDirectory()) {
        if (entry.name === "Headers" || entry.name.endsWith(".dSYM")) {
          fs.rmSync(full, { recursive: true, force: true });
          removed.headers += 1;
        } else {
          walk(full);
        }
      } else if (entry.name.endsWith(".prl") || entry.name.endsWith(".la")) {
        fs.rmSync(full, { force: true });
        removed.metadata += 1;
      }
    }
  };
  walk(directory);
  return removed;
}

/**
 * Refuse to hand vsce a tree that still holds a link.
 *
 * vsce's own messages name the file and not the reason -- one of them names no
 * reason at all -- so a link that survives the walk costs a build and a bisect
 * to find. This turns that into one sentence at the point of failure.
 */
export function assertPayloadHasNoLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new PayloadError(
        `${full} is still a link; a VSIX cannot carry one`,
      );
    }
    if (entry.isDirectory()) {
      assertPayloadHasNoLinks(full);
    }
  }
}
