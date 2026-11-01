// Copyright (c) 2026 Randy Northrup. All rights reserved.
// SPDX-License-Identifier: MIT

// The title and body of one GitHub release, built from docs/releases/<tag>.md and CHANGELOG.md.
//
// Every release page used to be titled "Chrome Control MCP v1.x.y" and nothing else, so a list of
// two dozen of them said nothing about which one fixed what, a rebuild that changed one comment
// looked exactly like the release that added uploads, and no page said when it shipped or which of
// its nine files a person needed. Every page now says the same things in the same places:
//
//   title      v1.9.0: A clipboard for every agent    (the notes file's "# " line)
//   first line Released 2026-10-31, links to every release and to the code changes
//   body       the notes file, below its headline
//   Downloads  which file is which: the server for any MCP client, the VS Code package, checksums
//
// Usage:
//   node scripts/release_notes.mjs v1.9.0 --date 2026-10-31 --check
//   node scripts/release_notes.mjs v1.9.0 --date 2026-10-31 --assets release-assets \
//     --title-out title.txt --notes-out notes.md
//   node scripts/release_notes.mjs v1.0.0 --date 2026-08-20 --asset-names names.txt ...
//
// --date is the day the release is cut. It must be the day CHANGELOG.md gives, so a changelog
// written days before the tag cannot ship saying the wrong day (1.5.5 and 1.7.0 both did).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "https://github.com/RandyNorthrup/chrome-control-mcp";
const HEADLINE_MAX = 72;

// Platform rows, in the order a person scans for theirs. Archive and VS Code package suffixes are
// the release workflow's own names (docs/RELEASES.md).
const PLATFORMS = [
  { label: "Windows x64", archive: "windows-x64.zip", vsix: "win32-x64" },
  { label: "Linux x64", archive: "linux-x64.tar.gz", vsix: "linux-x64" },
  {
    label: "macOS, Apple silicon",
    archive: "macos-arm64.tar.gz",
    vsix: "darwin-arm64",
  },
  { label: "macOS, Intel", archive: "macos-x64.tar.gz", vsix: "darwin-x64" },
];
const CHECKSUMS = "SHA256SUMS.txt";

export class ReleaseNotesError extends Error {}

function fail(message) {
  throw new ReleaseNotesError(message);
}

// A notes file opens with "# <headline>" and a blank line. The headline is plain text -- it becomes
// the release title, which GitHub shows without rendering Markdown -- and it says what the release
// is, not that it is one.
export function parseNotes(text, where = "notes") {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const match = /^# (.+)$/.exec(lines[0] ?? "");
  if (!match) {
    fail(`${where} must open with "# <headline>", the release's title`);
  }
  const headline = match[1].trim();
  if (headline.length > HEADLINE_MAX) {
    fail(`${where}: the headline is longer than ${HEADLINE_MAX} characters`);
  }
  if (/[`*[\]]|\.$/.test(headline)) {
    fail(`${where}: the headline is plain text with no closing full stop`);
  }
  if (lines[1] !== "") {
    fail(`${where}: a blank line must follow the headline`);
  }
  const body = lines.slice(2).join("\n").trim();
  if (body === "") {
    fail(`${where} says nothing below its headline`);
  }
  return { headline, body };
}

// Each "## [x.y.z] - YYYY-MM-DD" section of CHANGELOG.md, newest first, as written.
export function changelogReleases(text) {
  const releases = [];
  for (const match of text.matchAll(
    /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm,
  )) {
    releases.push({ version: match[1], date: match[2] });
  }
  return releases;
}

export function releaseTitle(version, headline) {
  return `v${version}: ${headline}`;
}

// Where a changelog section's heading lands, by GitHub's anchor rule: lower case, punctuation other
// than hyphens dropped, each space a hyphen. "[1.9.0] - 2026-10-31" renders as "1.9.0 - 2026-10-31".
export function changelogAnchor(version, date) {
  return `${version} - ${date}`
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
}

// A release page is served from /releases/tag/<tag>, where a link relative to docs/releases/ leads
// nowhere. A link to another release's notes opens that release's page; any other file opens in the
// repository.
export function absoluteLinks(markdown) {
  return markdown.replace(
    /\]\((?![a-z]+:|#)([^)\s]+)\)/gi,
    (_match, target) => {
      const resolved = path.posix.normalize(
        path.posix.join("docs/releases", target),
      );
      const release = /^docs\/releases\/(v\d+\.\d+\.\d+)\.md$/.exec(resolved);
      return release
        ? `](${REPOSITORY}/releases/tag/${release[1]})`
        : `](${REPOSITORY}/blob/main/${resolved})`;
    },
  );
}

function assetUrl(tag, name) {
  return `${REPOSITORY}/releases/download/${tag}/${name}`;
}

// The Downloads section, from the files the release actually carries. A file this does not know is
// refused rather than left out: a page that lists eight of nine files is how the ninth gets lost.
export function downloadsSection(tag, assetNames) {
  const version = tag.replace(/^v/, "");
  const names = new Set(assetNames);
  const known = new Set([CHECKSUMS]);
  const rows = [];
  for (const platform of PLATFORMS) {
    const archive = `chrome-control-mcp-${tag}-${platform.archive}`;
    const vsix = `chrome-control-mcp-${version}-${platform.vsix}.vsix`;
    known.add(archive);
    known.add(vsix);
    if (!names.has(archive)) {
      fail(`${tag} has no ${archive}`);
    }
    rows.push({ platform, archive, vsix: names.has(vsix) ? vsix : null });
  }
  const unknown = assetNames.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    fail(`${tag} carries files the release page cannot name: ${unknown}`);
  }
  if (!names.has(CHECKSUMS)) {
    fail(`${tag} has no ${CHECKSUMS}`);
  }
  const withVsix = rows.some((row) => row.vsix);
  const link = (name) => `[${name}](${assetUrl(tag, name)})`;
  const table = withVsix
    ? [
        "| Platform | MCP server, for any client | VS Code package |",
        "| --- | --- | --- |",
        ...rows.map(
          (row) =>
            `| ${row.platform.label} | ${link(row.archive)} | ${row.vsix ? link(row.vsix) : "--"} |`,
        ),
      ]
    : [
        "| Platform | MCP server, for any client |",
        "| --- | --- |",
        ...rows.map(
          (row) => `| ${row.platform.label} | ${link(row.archive)} |`,
        ),
      ];
  const lead = withVsix
    ? "The server is one program for every MCP client: take the archive for your platform and run " +
      "`--install` from it. A VS Code package holds the same server for VS Code's own MCP support; " +
      "the VS Code Marketplace installs it for you."
    : "The server is one program for every MCP client: take the archive for your platform and run " +
      "`--install` from it.";
  return [
    "## Downloads",
    "",
    lead,
    "",
    ...table,
    "",
    `Check a download against ${link(CHECKSUMS)}. To update a server you already installed, see ` +
      `[Updating](${REPOSITORY}/blob/main/docs/RELEASES.md#updating).`,
  ].join("\n");
}

// The whole page for one release. `previous` is the release before it, or null for the first.
export function releasePage({
  version,
  date,
  previous,
  notes,
  assetNames = null,
}) {
  const { headline, body } = parseNotes(notes, `docs/releases/v${version}.md`);
  const tag = `v${version}`;
  const links = [
    `[Every release](${REPOSITORY}/blob/main/CHANGELOG.md)`,
    ...(previous
      ? [
          `[Code changes since ${previous}](${REPOSITORY}/compare/v${previous}...${tag})`,
        ]
      : []),
  ];
  const parts = [
    `Released ${date} · ${links.join(" · ")}`,
    absoluteLinks(body),
  ];
  if (assetNames) {
    parts.push(downloadsSection(tag, assetNames));
  }
  return {
    title: releaseTitle(version, headline),
    body: `${parts.join("\n\n")}\n`,
  };
}

// Everything one tag's page is made from, read from the repository at `root` and checked.
export function pageForTag(root, tag, { date, assetNames = null } = {}) {
  const version = tag.replace(/^v/, "");
  const releases = changelogReleases(
    fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
  );
  const index = releases.findIndex((release) => release.version === version);
  if (index < 0) {
    fail(`CHANGELOG.md has no "## [${version}] - <date>" section`);
  }
  const entry = releases[index];
  if (date && entry.date !== date) {
    fail(
      `CHANGELOG.md dates ${version} ${entry.date}, but it is being released ${date}: ` +
        "correct the date before tagging",
    );
  }
  const notesPath = path.join(root, "docs", "releases", `${tag}.md`);
  if (!fs.existsSync(notesPath)) {
    fail(`docs/releases/${tag}.md does not exist`);
  }
  return releasePage({
    version,
    date: entry.date,
    previous: releases[index + 1]?.version ?? null,
    notes: fs.readFileSync(notesPath, "utf8"),
    assetNames,
  });
}

function argument(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tag = process.argv[2];
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
    fail("the first argument is the tag, such as v1.9.0");
  }
  const date = argument("--date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    fail("--date YYYY-MM-DD, the day this release is cut, is required");
  }
  let assetNames = null;
  if (argument("--assets")) {
    assetNames = fs.readdirSync(argument("--assets"));
  } else if (argument("--asset-names")) {
    assetNames = fs
      .readFileSync(argument("--asset-names"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
  }
  const page = pageForTag(root, tag, { date, assetNames });
  if (process.argv.includes("--check")) {
    console.log(page.title);
    return;
  }
  fs.writeFileSync(argument("--title-out") ?? "title.txt", `${page.title}\n`);
  fs.writeFileSync(argument("--notes-out") ?? "notes.md", page.body);
  console.log(page.title);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    if (error instanceof ReleaseNotesError) {
      console.error(`release notes: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
