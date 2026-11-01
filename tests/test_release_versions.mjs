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

import {
  changelogAnchor,
  changelogReleases,
  downloadsSection,
  pageForTag,
  parseNotes,
  REPOSITORY,
  ReleaseNotesError,
} from "../scripts/release_notes.mjs";

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

// What a person reading the releases sees. Every release page was once titled "Chrome Control MCP
// v1.x.y" and nothing more, so two dozen of them said nothing about which did what, two changelog
// dates were the day the entry was written rather than the day it shipped, and nothing compared the
// four places a release is described. These tests are that comparison.

const headlineOf = (version) =>
  parseNotes(read(`docs/releases/v${version}.md`), `v${version}.md`).headline;

// The rows of the first Markdown table after `heading`, as arrays of trimmed cells.
function tableAfter(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `no "${heading}"`);
  const rows = [];
  for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
    if (line.startsWith("|")) {
      rows.push(
        line
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim()),
      );
    } else if (rows.length > 0) {
      break;
    }
  }
  return rows.slice(2); // past the header and its rule
}

test("every release has a dated changelog entry and notes with a headline", () => {
  const releases = changelogReleases(read("CHANGELOG.md"));
  const notes = fs
    .readdirSync(path.join(root, "docs", "releases"))
    .filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name))
    .map((name) => name.slice(1, -3));
  assert.deepEqual(
    [...notes].sort(),
    releases.map((release) => release.version).sort(),
    "docs/releases/ and CHANGELOG.md must describe the same releases",
  );
  for (const { version } of releases) {
    assert.doesNotThrow(() => headlineOf(version), `v${version}.md`);
  }
  // Newest first, and never a release dated before the one it follows.
  for (let i = 1; i < releases.length; i += 1) {
    assert.ok(
      releases[i - 1].date >= releases[i].date,
      `${releases[i - 1].version} is dated before ${releases[i].version}`,
    );
  }
});

test("the changelog opens with every release, its date and its headline", () => {
  const text = read("CHANGELOG.md");
  const releases = changelogReleases(text);
  const rows = tableAfter(text, "# Changelog");
  assert.deepEqual(
    rows,
    releases.map(({ version, date }) => [
      `[${version}](#${changelogAnchor(version, date)})`,
      date,
      headlineOf(version),
    ]),
    "CHANGELOG.md's index must list every section, newest first, with the notes' headline",
  );
  for (const { version } of releases) {
    assert.ok(
      text.includes(`\n[${version}]: ${REPOSITORY}/releases/tag/v${version}\n`),
      `the [${version}] heading links to no release page`,
    );
  }
});

test("the README's What's new starts with the version being shipped", () => {
  const releases = changelogReleases(read("CHANGELOG.md"));
  const rows = tableAfter(read("README.md"), "## What's new");
  assert.ok(rows.length >= 1, "What's new lists no release");
  assert.equal(
    rows[0][0],
    `[${projectVersion()}](${REPOSITORY}/releases/tag/v${projectVersion()})`,
    "What's new must lead with the version being shipped",
  );
  rows.forEach(([, date, summary], i) => {
    const { version, date: shipped } = releases[i];
    assert.equal(
      rows[i][0],
      `[${version}](${REPOSITORY}/releases/tag/v${version})`,
    );
    assert.equal(date, shipped, `What's new dates ${version} ${date}`);
    assert.ok(
      summary.startsWith(`**${headlineOf(version)}.**`),
      `What's new must open ${version}'s row with its headline`,
    );
  });
});

test("every release page builds, and says when and what", () => {
  for (const { version, date } of changelogReleases(read("CHANGELOG.md"))) {
    const page = pageForTag(root, `v${version}`, { date });
    assert.equal(page.title, `v${version}: ${headlineOf(version)}`);
    assert.ok(page.body.startsWith(`Released ${date} · `), page.body);
    assert.ok(!page.body.includes(`# ${headlineOf(version)}`));
    // Served from /releases/tag/, where a relative link leads nowhere.
    const relative = page.body.match(/\]\((?![a-z]+:|#)[^)]+\)/gi);
    assert.equal(relative, null, `v${version} links relatively: ${relative}`);
  }
  const version = projectVersion();
  assert.throws(
    () => pageForTag(root, `v${version}`, { date: "2000-01-01" }),
    ReleaseNotesError,
    "a release tagged on a day its changelog does not give is refused",
  );
});

test("a release page names every file, and refuses one it cannot", () => {
  const version = projectVersion();
  const tag = `v${version}`;
  const assets = [
    `chrome-control-mcp-${tag}-windows-x64.zip`,
    `chrome-control-mcp-${tag}-linux-x64.tar.gz`,
    `chrome-control-mcp-${tag}-macos-arm64.tar.gz`,
    `chrome-control-mcp-${tag}-macos-x64.tar.gz`,
    `chrome-control-mcp-${version}-win32-x64.vsix`,
    `chrome-control-mcp-${version}-linux-x64.vsix`,
    `chrome-control-mcp-${version}-darwin-arm64.vsix`,
    `chrome-control-mcp-${version}-darwin-x64.vsix`,
    "SHA256SUMS.txt",
  ];
  const section = downloadsSection(tag, assets);
  for (const name of assets) {
    assert.ok(
      section.includes(
        `[${name}](${REPOSITORY}/releases/download/${tag}/${name})`,
      ),
      `Downloads does not link ${name}`,
    );
  }
  assert.throws(
    () => downloadsSection(tag, [...assets, "chrome-control-mcp-extra.zip"]),
    ReleaseNotesError,
  );
  assert.throws(
    () => downloadsSection(tag, assets.slice(1)),
    ReleaseNotesError,
  );
  assert.throws(
    () => parseNotes("Chrome Control MCP 9.9.9 has no headline.\n"),
    ReleaseNotesError,
  );
});
