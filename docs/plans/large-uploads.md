# Large uploads

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them.

## Why

`browser_upload` read a whole file into the server, sent it over the bridge as base64 pieces, and
had the extension's service worker hold every piece until the page was given one `File` built from
a single DevTools call. Each of those steps keeps the whole file in memory, so the tool was bounded
at 16 MiB a file. The user's social-media agent uploads a channel's videos: long ones are 270 to
390 MB and some Shorts 17 to 43 MB. None could go, and since 1.8.0 an agent's click catches the
page's file dialog, so the old workaround of filling the native picker by hand cannot run during an
agent's work either (report, 2026-11-01).

## Design

**Pieces go straight into the page.** For `browser_upload`, the server reads each file 384 KiB at a
time as it sends it, never whole. Each piece travels as an `uploadStage` command naming the tab, and
the element when a ref named one, so the extension can put it where the file will be used. On the
first piece the extension creates a staging object in the realm of the element the file is for: the
input or drop zone a ref names, the input of the picker the page opened, or the window that called
`showOpenFilePicker`. The object is created by calling a function on that element over DevTools, so
it lives in that frame's own JavaScript realm and is reachable only through the extension's
DevTools handle -- no page script holds a reference to it. Each piece is decoded in the page and
appended; every 8 MiB the pieces are folded into a `Blob`, which Chrome stores outside the page's
heap and spills to disk when large. The worker keeps only a count. The final `upload` command builds
the `File` from that `Blob` and assigns it exactly as before. Measured with raw DevTools on Chrome
for Testing 153: 400 MiB staged at 25 MB/s, the page's file byte-identical (SHA-256).

**The cap is the operator's.** Default 2 GiB a file, set with `CHROME_CONTROL_MCP_UPLOAD_MAX_MB`
(whole MiB, 1 to 8192). A value that is not one of those fails closed to the old 16 MiB, and a file
refused under it says the variable was not understood. A file over the cap is refused before any
piece is sent, naming its size, the cap and the variable. The extension refuses more than 8 GiB of
staged pieces for one file whatever it is told, and pieces out of order or larger than one bridge
message.

**A delivery that cannot finish assigns nothing.** If the page navigates, the tab is released or
closed, the debugger detaches or the session ends while pieces are arriving, the staged object is
gone or is released, the call fails saying why, and nothing reaches the input.

**Older pieces stay as they were.** An extension older than 1.11.0 does not know `uploadStage`; the
server sees its version in the handshake and sends such an extension pieces the old way, bounded at
16 MiB, with a refusal above that saying to reload the extension. `browser_clipboard` keeps files
in the worker, as a clipboard must hold them until a paste, and keeps the 16 MiB bound.

**The relay's exit check (found on the way).** The first live run lost a 300 MiB upload at piece
388 of 800: the relay ended itself. Its watcher, on Linux and macOS, asks whether Chrome's end of
stdin is readable and then how many bytes wait; the pump thread can drain them in between, which
reads as a closed pipe. Measured on a busy pipe, one look in 2,000 misread, four looks a second --
the cause of the rare "relay closed the connection" failures since 1.9.0. The watcher now ends the
relay only after three closed looks in a row; a closed pipe stays closed and a busy one does not.

**CI in tiers (decided by the user, 2026-11-01).** The live browser suites were ten to twenty
minutes a platform on every push, most of it the display matrix, and prove what a release ships.
They move to a reusable workflow the release runs and waits for before publishing; every push keeps
the fast gates, and a push of documents alone builds nothing.

## Non-goals and limits

- Folder uploads stay unsupported.
- Delivery runs at the pace of `chrome.debugger`, which moves about 7 MB/s of base64 whatever the
  size of the call (measured: 53 ms for 512 KiB, 600 ms for 4 MiB, 2.7 ms empty) -- 2 to 6 MB/s of
  file end to end, so a 390 MB video takes one to three minutes. A faster channel into the page is
  separate work. The call holds this server's single command slot meanwhile, as every call does.
- A clipboard still holds at most 16 MiB of files.
- No path reaches the extension or the page; only the name, type and bytes do, as before.

## Reuse

- `readUploadFiles` keeps its checks (absolute, real file, `CHROME_CONTROL_MCP_UPLOAD_ROOTS`, at
  most 8 files) for the clipboard; the streaming path reuses them without reading the files.
- The final `upload` command, the input resolver, the drop path and the picker answer are the
  existing ones, given a staged `Blob` instead of base64.
- `buildExtensionCommand` already translates a ref to its tab and element; the server previews it to
  address the pieces.
- The handshake's extension version (1.9.0) decides which path an extension gets.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-UPLOADS",
    "title": "Large uploads, and CI in tiers",
    "scope_revision": 2,
    "brief": null,
    "brief_reason": "Scoped change in an existing product; README.md, docs/TOOLS.md and docs/SECURITY.md carry the product context, and the report that prompted it is recorded in this plan's Why",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "76dc7784bfe5"
      }
    ],
    "inputs": [],
    "environment": {
      "platform": "windows",
      "tools": {
        "node": "v24.20.0",
        "cmake": "4.4.5",
        "python": "3.14.10",
        "chrome-for-testing": "153.0.8010.52",
        "wsl2-arch-node": "v26.9.0",
        "wsl2-arch-cmake": "4.4.3",
        "wsl2-arch-python": "3.12.16",
        "wsl2-arch-semgrep": "1.174.0"
      }
    }
  },
  "requirements": [
    {
      "id": "REQ-UPL-LARGE",
      "statement": "browser_upload delivers files up to the operator's cap to every target it reached before -- an input or drop zone by ref, a caught input picker, a caught showOpenFilePicker -- byte for byte, without the server or the extension's worker holding a whole file",
      "priority": "critical",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-UPL-LIMIT",
      "statement": "The cap is 2 GiB by default and set with CHROME_CONTROL_MCP_UPLOAD_MAX_MB; a malformed value fails closed to 16 MiB and says so; a file over the cap is refused before anything is sent",
      "priority": "critical",
      "acceptance": [
        "AC-UPL-LIMIT"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-UPL-FAIL",
      "statement": "A delivery that cannot finish assigns nothing, says why, and leaves nothing staged; the extension refuses pieces out of order, oversized, beyond its own ceiling, or for a tab its session does not hold",
      "priority": "critical",
      "acceptance": [
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-UPL-COMPAT",
      "statement": "An extension older than 1.11.0 keeps the 16 MiB path with a reason to reload above it; browser_clipboard files keep theirs; every existing upload, clipboard and live suite passes unchanged",
      "priority": "critical",
      "acceptance": [
        "AC-UPL-COMPAT"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CI-TIERS",
      "statement": "Every push runs the fast gates (formatting, lint, secret scan, dependency audit, static analysis, builds and unit tests on three platforms, sanitizers) and no live browser suite; a push of documents alone builds nothing; a release runs the live suites on three platforms and publishes only once they pass",
      "priority": "normal",
      "acceptance": [
        "AC-CI-PUSH",
        "AC-CI-RELEASE"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-UPL-LARGE-INPUT",
      "requirement": "REQ-UPL-LARGE",
      "given": "A file of random bytes far over the old bound (300 MiB live) and a page with a file input and a drop zone",
      "when": "browser_upload assigns it by ref to the input, and fills an input picker the page opened",
      "then": "the page's File has the file's name, type and size and the same SHA-256 over every 8 MiB slice as the file on disk, its change handler ran, and the reply reports the delivery as before; a smaller file reaches a drop zone by ref the same way",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-UPL-LARGE-PICKER",
      "requirement": "REQ-UPL-LARGE",
      "given": "A page that called showOpenFilePicker during an agent's click",
      "when": "browser_upload answers it with a file over the old bound",
      "then": "the handle's getFile() gives the same bytes, size, name and type",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-UPL-MEMORY",
      "requirement": "REQ-UPL-LARGE",
      "given": "A file being sent with uploadStage",
      "when": "each piece is read and passed on",
      "then": "the server reads 384 KiB at a time and never the whole file, each stage frame carries one piece and names the tab and, for a ref, the element, and the extension's worker holds no piece after passing it to the page",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-UPL-LIMIT",
      "requirement": "REQ-UPL-LIMIT",
      "given": "CHROME_CONTROL_MCP_UPLOAD_MAX_MB unset, 512, and each of 0, 9000, abc, 1.5",
      "when": "a file is checked against the cap",
      "then": "the cap is 2 GiB, 512 MiB, and 16 MiB respectively, the last with a refusal naming the malformed variable; a file over the cap is refused before any piece is sent, naming its size, the cap and the variable",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-UPL-ABORT",
      "requirement": "REQ-UPL-FAIL",
      "given": "A delivery in progress",
      "when": "the page navigates, the tab detaches or is let go, or the session ends",
      "then": "the call fails saying the page changed or the tab is gone, nothing is assigned, the staged object is released and the worker holds nothing of it; the next upload to that tab works",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-UPL-BOUNDS",
      "requirement": "REQ-UPL-FAIL",
      "given": "The extension receiving stage pieces",
      "when": "a piece arrives out of order, larger than one bridge message, past 8 GiB for its file, as a ninth upload in flight, or for a tab the session does not hold, or the final command names a file whose pieces did not all arrive",
      "then": "each is refused with its reason and nothing is assigned",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-UPL-COMPAT",
      "requirement": "REQ-UPL-COMPAT",
      "given": "An extension reporting a version older than 1.11.0, or none; a browser_clipboard write with files; and every existing suite",
      "when": "browser_upload or browser_clipboard sends files and the suites run",
      "then": "the old extension gets uploadChunk pieces bounded at 16 MiB and a file above that is refused saying to reload the extension; clipboard files go the old way and keep 16 MiB; every existing unit, contract and live suite passes",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CI-PUSH",
      "requirement": "REQ-CI-TIERS",
      "given": "A push of code, and a push that changes only Markdown and docs/",
      "when": "the Quality workflow runs on each",
      "then": "the code push runs lint, PowerShell and native analysis, builds and ctest on three platforms and both sanitizers, with no live browser job; the documents-only push runs only the lint job and its release-document checks, every other job skipped",
      "checks": [
        "manual"
      ],
      "manual_reason": "Workflow behaviour is executed by GitHub Actions on its hosted Windows, Linux and macOS runners and by the release workflow on a real tag; no local command reproduces those runs or their dependency graph, so it is observed on the runs themselves and recorded with gh run view"
    },
    {
      "id": "AC-CI-RELEASE",
      "requirement": "REQ-CI-TIERS",
      "given": "A version tag",
      "when": "the release workflow runs",
      "then": "the live browser suites run on Windows, Linux and macOS beside the archives, and the GitHub release and Marketplace packages publish only after both pass",
      "checks": [
        "manual"
      ],
      "manual_reason": "Workflow behaviour is executed by GitHub Actions on its hosted Windows, Linux and macOS runners and by the release workflow on a real tag; no local command reproduces those runs or their dependency graph, so it is observed on the runs themselves and recorded with gh run view"
    }
  ],
  "tasks": [
    {
      "id": "TASK-UPL-SERVER",
      "purpose": "The cap and its variable, checking files without reading them, reading 384 KiB pieces, previewing the target, sending uploadStage pieces, and the old path for an older extension",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-MEMORY",
        "AC-UPL-LIMIT",
        "AC-UPL-COMPAT"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "action": "modify"
        },
        {
          "path": "src/browser_uploads.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "action": "modify"
        },
        {
          "path": "src/browser_control.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_contract.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-UPL-CTEST",
        "EV-UPL-LINUX",
        "EV-UPL-LIVE",
        "EV-UPL-LIVE-REGRESSION",
        "EV-UPL-RED-PIECES",
        "EV-UPL-RED-CAP",
        "EV-UPL-RED-ADDRESS",
        "EV-UPL-RED-COMPAT",
        "EV-UPL-RED-RELAY-EXIT",
        "EV-UPL-RED-FOLD-LIVE"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-UPL-EXTENSION",
      "purpose": "uploadStage: staging in the target's realm, bounds, the final upload and picker answer from a staged Blob, and release on completion, failure, detach and session end",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS",
        "AC-UPL-COMPAT"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        },
        {
          "path": "browser/extension/manifest.json",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "action": "create"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "action": "modify"
        },
        {
          "path": "CMakeLists.txt",
          "action": "modify"
        },
        {
          "path": "package.json",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-UPL-UNIT-JS",
        "EV-UPL-CTEST",
        "EV-UPL-LIVE",
        "EV-UPL-LIVE-REGRESSION",
        "EV-UPL-RED-WORKER-HOLDS",
        "EV-UPL-RED-ORDER",
        "EV-UPL-RED-DETACH",
        "EV-UPL-RED-PICKER",
        "EV-UPL-RED-DIALOG",
        "EV-UPL-RED-FOLD-LIVE"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-UPL-LIVE",
      "purpose": "A live suite uploading a 300 MiB file by ref, 40 MiB ones through a caught picker, a drop zone and showOpenFilePicker, a page reloading mid-delivery, and the cap from the variable; run with every release",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-LIMIT",
        "AC-UPL-ABORT"
      ],
      "depends_on": [
        "TASK-UPL-SERVER",
        "TASK-UPL-EXTENSION"
      ],
      "changes": [
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "action": "create"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-UPL-LIVE",
        "EV-UPL-RED-FOLD-LIVE",
        "EV-UPL-RED-PICKER",
        "EV-UPL-RED-CAP",
        "EV-UPL-RED-DETACH"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-UPL-DOCS",
      "purpose": "Say what the cap is and how to set it, what an older extension and the clipboard keep, and that navigate takes http(s) only; number the release 1.11.0",
      "acceptance": [
        "AC-UPL-LIMIT",
        "AC-UPL-COMPAT"
      ],
      "depends_on": [
        "TASK-UPL-SERVER",
        "TASK-UPL-EXTENSION"
      ],
      "changes": [
        {
          "path": "README.md",
          "action": "modify"
        },
        {
          "path": "CHANGELOG.md",
          "action": "modify"
        },
        {
          "path": "docs/TOOLS.md",
          "action": "modify"
        },
        {
          "path": "docs/SECURITY.md",
          "action": "modify"
        },
        {
          "path": "docs/QUALITY.md",
          "action": "modify"
        },
        {
          "path": "PLAN.md",
          "action": "modify"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "action": "create"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "action": "modify"
        },
        {
          "path": "package-lock.json",
          "action": "modify"
        },
        {
          "path": "vscode/package.json",
          "action": "modify"
        },
        {
          "path": "vscode/package-lock.json",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-UPL-CTEST",
        "EV-UPL-RED-CAP",
        "EV-UPL-RED-COMPAT"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CI-TIERS",
      "purpose": "Split CI: the fast gates on every push, documents-only pushes building nothing, and the live browser suites moved to a reusable workflow the release runs and waits for before publishing",
      "acceptance": [
        "AC-CI-PUSH",
        "AC-CI-RELEASE"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": ".github/workflows/quality.yml",
          "action": "modify"
        },
        {
          "path": ".github/workflows/release.yml",
          "action": "modify"
        },
        {
          "path": ".github/workflows/live.yml",
          "action": "create"
        },
        {
          "path": "docs/RELEASES.md",
          "action": "modify"
        }
      ],
      "status": "implemented",
      "evidence": [],
      "blocker": null,
      "superseded_by": null
    }
  ],
  "evidence": [
    {
      "id": "EV-UPL-READINESS-1",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-LIMIT",
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS",
        "AC-UPL-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the plan, the rules file and the server and extension upload source, plus a measured raw-DevTools staging probe (40 and 400 MiB, byte-identical): twelve findings, five of which (handles released per command, realm, the single outstanding slot, dialog-arm scoping, staged uploads dying with their tab) shaped the design before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/uploads/readiness-review.md",
        "sha256": "b0b645f33b1025ba83f964aa52d03fea7f7b037ed3d9a8778d1cc83bbec22791"
      },
      "red": null,
      "reason": "Scope, rules and the review changed after the first live runs: the relay fix, CI in tiers, corrected rates",
      "scope_sha256": "6cfdcc00f8d215de1c92ec18136e9af18e812d11a73ef5808034164bd0a98bf9",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        }
      ]
    },
    {
      "id": "EV-UPL-READINESS-2",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-LIMIT",
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS",
        "AC-UPL-COMPAT",
        "AC-CI-PUSH",
        "AC-CI-RELEASE"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Re-review after the first live runs: the relay ending itself under steady traffic (root-caused with a measured probe and fixed in TASK-UPL-SERVER), the delivery rate measured through the extension and the documents corrected, CI in tiers added by the user as REQ-CI-TIERS with manual criteria and TASK-CI-TIERS, and the rules file updated for the tiers and counts; no requirement changed meaning; recorded as an addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/uploads/readiness-review.md",
        "sha256": "ff7cace8625d00b52fe274078036554f39144068748eed437956a1e382a5dbad"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "d0551208e90d1d89a7e0ff4a99546a3bdbdce9deaee3b7088588d1cf9bdf860c",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        }
      ]
    },
    {
      "id": "EV-UPL-CTEST",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-LIMIT",
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS",
        "AC-UPL-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "--output-on-failure"
      ],
      "method": "MSVC Release build, all 26 ctest suites: test_browser_uploads 12/12 (the cap from its variable and failing closed, files checked without being read and refused over the cap naming size, cap and variable, pieces read one at a time and rejoined byte for byte, a file changing under them refused), test_browser_bridge_relay 38/38 (through a real pipe and relay: uploadStage pieces in order, addressed to the tab and the ref's element, byte-exact, no path in any frame; the cap refusing before any piece; an extension older than 1.11.0 given uploadChunk and refused above 16 MiB with a reload note; clipboard files the old way; one closed look ending no relay), test_browser_extension_uploads (staging, the handle-passed assignment, the picker, bounds, the page changing, detach, the dialog arm), and every earlier suite unchanged; the built server smoked, 53 tools full and 14 read-only (windows-smoke.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/windows-ctest.txt",
        "sha256": "d5bc72cc446d6ce19ef3f4ae5df0d5821b782a691c95b7655fc045b79f1fc9cc"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "874c31c87927bb5b4a2f0b2461a31e804d5fc0e3c1e885b917134805ca63c82d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-UNIT-JS",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS",
        "AC-UPL-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "All 13 JavaScript files, 227/227: the page folding pieces into a Blob byte for byte, pieces going straight into the page with the worker keeping a count, the assignment passing the staged file by its handle and releasing it, a showOpenFilePicker answered through its window, pieces out of order, oversized, not base64, past the size or the 8 GiB ceiling refused, a tab not held refused, the page changing mid-delivery, a staged file going with its tab's attachment, an armed dialog answer surviving the pieces, an older app's pieces gathering as before; every earlier extension suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/windows-test-js.txt",
        "sha256": "b2f0611b2b0d94d751f3300ec69f7f00f4f5d540bb739ebf1bd02417e80ae03d"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "874c31c87927bb5b4a2f0b2461a31e804d5fc0e3c1e885b917134805ca63c82d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-LINUX",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-LIMIT",
        "AC-UPL-ABORT",
        "AC-UPL-BOUNDS",
        "AC-UPL-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "--output-on-failure"
      ],
      "method": "WSL2 Arch, a fresh sync with every source touched: GCC 16 Release build with no warnings and ctest 25/25 (the POSIX relay and socket carrying the pieces; linux-ctest.txt); clang 22 build, run-clang-tidy clean (clang-tidy.txt), exhaustive cppcheck clean (cppcheck.txt), Semgrep 1.174.0 0 findings (semgrep.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/linux-summary.txt",
        "sha256": "bd00afa05a752407fdb562a38b7e83d26332f906f098b994a68519d192b8c5f8"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "874c31c87927bb5b4a2f0b2461a31e804d5fc0e3c1e885b917134805ca63c82d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-LIVE",
      "acceptance": [
        "AC-UPL-LARGE-INPUT",
        "AC-UPL-LARGE-PICKER",
        "AC-UPL-MEMORY",
        "AC-UPL-LIMIT",
        "AC-UPL-ABORT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/large_upload_e2e.mjs"
      ],
      "method": "Chrome for Testing 153 on Linux, 7/7 (live-large-upload.log): a 300 MiB file of random bytes reached a file input by ref with the page's slice-wise SHA-256 equal to the file's (30.326 s, 9.9 MiB/s); 40 MiB files filled an input picker the page opened, dropped onto a drop zone by ref, and answered showOpenFilePicker, each hash equal; a page reloaded mid-delivery was given nothing, the call said nothing was assigned, and the next upload worked; a second server with CHROME_CONTROL_MCP_UPLOAD_MAX_MB=64 refused the 300 MiB file before sending (1 ms); the worker held no upload afterwards",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/live-large-upload.json",
        "sha256": "52eb96d4038bc022a789aa949adfd154bc6f1327fee7cf4c482c768fb49f9ff9"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "874c31c87927bb5b4a2f0b2461a31e804d5fc0e3c1e885b917134805ca63c82d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-LIVE-REGRESSION",
      "acceptance": [
        "AC-UPL-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/multi_agent_e2e.mjs"
      ],
      "method": "Every live suite that existed before this work, Chrome for Testing 153 on Linux, from the same build (live-*.json and .log): display matrix 35 configurations, full browser suite 177 cases (its uploads among them), user interference, multi-agent, clipboard (files on a clipboard the old way), extension version in three cases, Chrome profiles two-profile and update cases",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/linux-summary.txt",
        "sha256": "bd00afa05a752407fdb562a38b7e83d26332f906f098b994a68519d192b8c5f8"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "66951f677c1a943e3e81d90ec82cbbc662d4f0fe9980ef27fe8383347b72a548",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-PIECES",
      "acceptance": [
        "AC-UPL-MEMORY"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_uploads$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: the server reads the rest of the file in one piece. Mutated, rebuilt, test_browser_uploads failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/unit-red-drills.txt",
        "sha256": "bc84a807bcab92a65ed4437a1e90c929137bb3f780aa801e5de874ef904f3b7d"
      },
      "red": {
        "mutation": "the server reads the rest of the file in one piece",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "pieces_areReadOneAtATimeAndRejoinToTheFile",
        "observed_diagnostic": "pieces_areReadOneAtATimeAndRejoinToTheFile",
        "before": [
          {
            "path": "src/browser_uploads.cpp",
            "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
          }
        ],
        "after": [
          {
            "path": "src/browser_uploads.cpp",
            "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_uploads.cpp",
            "sha256": "04928da1c3d43b2a5a4b5f990e39fdc675deb057d6389c654c947a1aa89f0bf5"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0b298506f3f1bea9eecd71b877c4613a29c313ac8a94ee5f2f74cba881daea8f",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-CAP",
      "acceptance": [
        "AC-UPL-LIMIT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_uploads$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a malformed cap falls back to the 2 GiB default instead of 16 MiB. Mutated, rebuilt, test_browser_uploads failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/unit-red-drills.txt",
        "sha256": "bc84a807bcab92a65ed4437a1e90c929137bb3f780aa801e5de874ef904f3b7d"
      },
      "red": {
        "mutation": "a malformed cap falls back to the 2 GiB default instead of 16 MiB",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "cap_isTheOperatorsAndFailsClosed",
        "observed_diagnostic": "cap_isTheOperatorsAndFailsClosed",
        "before": [
          {
            "path": "src/browser_uploads.cpp",
            "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
          }
        ],
        "after": [
          {
            "path": "src/browser_uploads.cpp",
            "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_uploads.cpp",
            "sha256": "70074199cd39f663dd63b82f273f756e457fdc6a31863d05f13d2dcb3eb10477"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "874c31c87927bb5b4a2f0b2461a31e804d5fc0e3c1e885b917134805ca63c82d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-ADDRESS",
      "acceptance": [
        "AC-UPL-LARGE-INPUT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: pieces are not addressed to the element the ref names. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/unit-red-drills.txt",
        "sha256": "bc84a807bcab92a65ed4437a1e90c929137bb3f780aa801e5de874ef904f3b7d"
      },
      "red": {
        "mutation": "pieces are not addressed to the element the ref names",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "upload_goesInPiecesToThePageAndAnOlderExtensionKeepsItsBound",
        "observed_diagnostic": "upload_goesInPiecesToThePageAndAnOlderExtensionKeepsItsBound",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "6e0633fe9c2c9e8005eb2f33a1ed0794c9f64a5721edf6551b7cca70266c152a"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6ad87285a9442d5492ae5f3e334524797727775a3fd27c12f4f6b78bc5ca0388",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-COMPAT",
      "acceptance": [
        "AC-UPL-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: an extension older than 1.11.0 is sent uploadStage. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/unit-red-drills.txt",
        "sha256": "bc84a807bcab92a65ed4437a1e90c929137bb3f780aa801e5de874ef904f3b7d"
      },
      "red": {
        "mutation": "an extension older than 1.11.0 is sent uploadStage",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "upload_goesInPiecesToThePageAndAnOlderExtensionKeepsItsBound",
        "observed_diagnostic": "upload_goesInPiecesToThePageAndAnOlderExtensionKeepsItsBound",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "d1f08650a4ddafadec03d46d9037b17b2181920b3585e00a6ee83f67714597bc"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "66951f677c1a943e3e81d90ec82cbbc662d4f0fe9980ef27fe8383347b72a548",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-RELAY-EXIT",
      "acceptance": [
        "AC-UPL-LARGE-INPUT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: the relay ends on one closed look. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/unit-red-drills.txt",
        "sha256": "bc84a807bcab92a65ed4437a1e90c929137bb3f780aa801e5de874ef904f3b7d"
      },
      "red": {
        "mutation": "the relay ends on one closed look",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "browserPresence_oneClosedLookEndsNothing",
        "observed_diagnostic": "browserPresence_oneClosedLookEndsNothing",
        "before": [
          {
            "path": "include/chrome_control_mcp/browser_bridge_relay.h",
            "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
          }
        ],
        "after": [
          {
            "path": "include/chrome_control_mcp/browser_bridge_relay.h",
            "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
          }
        ],
        "mutated": [
          {
            "path": "include/chrome_control_mcp/browser_bridge_relay.h",
            "sha256": "bab0818afc8922cf922d4d7fa3bd05bf16c58369561179d10bcd5531656d7b66"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6ad87285a9442d5492ae5f3e334524797727775a3fd27c12f4f6b78bc5ca0388",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-FOLD-LIVE",
      "acceptance": [
        "AC-UPL-LARGE-INPUT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/large_upload_e2e.mjs"
      ],
      "method": "Drill in the WSL mirror: the page drops what it gathered when it folds. Mutated, rebuilt, the large-upload live suite failed as expected, restored byte for byte (mirror matched source), rebuilt and green (live-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/live-red-drills.txt",
        "sha256": "071b70be9af3b268952c19839f90db1174f6d46f411823c2a8a82c3a3f8f0328"
      },
      "red": {
        "mutation": "the page drops what it gathered when it folds",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "FAIL a 300 MiB file reaches a file input by ref, byte for byte",
        "observed_diagnostic": "FAIL a 300 MiB file reaches a file input by ref, byte for byte",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "5bdf7c5647b10671a9fd5a680d7569a40c2967d745d5024fe4cd3bdeebf89dbb"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6ad87285a9442d5492ae5f3e334524797727775a3fd27c12f4f6b78bc5ca0388",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-WORKER-HOLDS",
      "acceptance": [
        "AC-UPL-MEMORY"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_uploads.mjs"
      ],
      "method": "Drill on Windows: the worker keeps each piece it passes on. Mutated, the uploads suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/extension-red-drills.txt",
        "sha256": "b5c8d5d155b4ada83b94534a1af1e52e581668a03f87899b4b5792e8783805b1"
      },
      "red": {
        "mutation": "the worker keeps each piece it passes on",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a file's pieces go straight into the page, and the worker keeps only a count",
        "observed_diagnostic": "a file's pieces go straight into the page, and the worker keeps only a count",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "c36688fe5f9f8aad89beeae28640934543a0b263d651272defb3a9795682cd3c"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0b298506f3f1bea9eecd71b877c4613a29c313ac8a94ee5f2f74cba881daea8f",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-ORDER",
      "acceptance": [
        "AC-UPL-BOUNDS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_uploads.mjs"
      ],
      "method": "Drill on Windows: a piece out of order is taken. Mutated, the uploads suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/extension-red-drills.txt",
        "sha256": "b5c8d5d155b4ada83b94534a1af1e52e581668a03f87899b4b5792e8783805b1"
      },
      "red": {
        "mutation": "a piece out of order is taken",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "pieces out of order, oversized, not base64, or past the file's size are refused",
        "observed_diagnostic": "pieces out of order, oversized, not base64, or past the file's size are refused",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "e90bc5cac744527f47a87a850c7751ca5f12ab7a73522ec2f425ba8b3d6d66ed"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "23853d15a78020b62b096ad8bf02affe7ec31689d6a41be86735bf9f58810bff",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-DETACH",
      "acceptance": [
        "AC-UPL-ABORT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_uploads.mjs"
      ],
      "method": "Drill on Windows: a staged file outlives its tab's attachment. Mutated, the uploads suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/extension-red-drills.txt",
        "sha256": "b5c8d5d155b4ada83b94534a1af1e52e581668a03f87899b4b5792e8783805b1"
      },
      "red": {
        "mutation": "a staged file outlives its tab's attachment",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a staged file goes with its tab's attachment, and a worker-held one stays",
        "observed_diagnostic": "a staged file goes with its tab's attachment, and a worker-held one stays",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "10cf592213ff530f077052f57eb4ea456f4e0604585145d95e10bc148c82381f"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6ad87285a9442d5492ae5f3e334524797727775a3fd27c12f4f6b78bc5ca0388",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-PICKER",
      "acceptance": [
        "AC-UPL-LARGE-PICKER"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_uploads.mjs"
      ],
      "method": "Drill on Windows: a showOpenFilePicker's file is not staged in its window. Mutated, the uploads suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/extension-red-drills.txt",
        "sha256": "b5c8d5d155b4ada83b94534a1af1e52e581668a03f87899b4b5792e8783805b1"
      },
      "red": {
        "mutation": "a showOpenFilePicker's file is not staged in its window",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a picker the page opened takes staged files through its window",
        "observed_diagnostic": "a picker the page opened takes staged files through its window",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2e317ea19f635b04e25be0165e66fb2b77329d8679c6597f03da520c5be2f49c"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6ad87285a9442d5492ae5f3e334524797727775a3fd27c12f4f6b78bc5ca0388",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "3e9323c476c9961220f133fe94be6c5f7487b6924b61f95ce3bc571420cef6fe"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        }
      ]
    },
    {
      "id": "EV-UPL-RED-DIALOG",
      "acceptance": [
        "AC-UPL-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_uploads.mjs"
      ],
      "method": "Drill on Windows: an upload's pieces cancel an armed dialog answer. Mutated, the uploads suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/uploads/extension-red-drills.txt",
        "sha256": "b5c8d5d155b4ada83b94534a1af1e52e581668a03f87899b4b5792e8783805b1"
      },
      "red": {
        "mutation": "an upload's pieces cancel an armed dialog answer",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an armed dialog answer survives an upload's pieces",
        "observed_diagnostic": "an armed dialog answer survives an upload's pieces",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "450a1292cd2aca736f098e57b32273390c1b4270bb59740b3631d785de079a2d"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "66951f677c1a943e3e81d90ec82cbbc662d4f0fe9980ef27fe8383347b72a548",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "0cb14f8297995a4ebfb5e5b75ee2421e6bb1e3d44780191411b087525c0d493e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "35cfa3789dd5976b94010acd95b27bc5f885100e59060ffeb4e07b5113f35a58"
        },
        {
          "path": "PLAN.md",
          "sha256": "df8a5e03b14fb44d49cbd95b4e65962879b612ae92d240004e25183d55dd5ae4"
        },
        {
          "path": "README.md",
          "sha256": "900c0d161ec4330c34afbbeae92bb647c34df17cd4c016f566b888192e7294e6"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "04ebe967c7a886e4a453f3cb379b3ab1256ad0647e736d1611f52cd2660a80a8"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "b195cb058c389e5c27f4df3844d0f0e882ae3bd7247d34b9f0ab06cdd7bfc5ae"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "69975ce492e0f9ced9fb6e35ce38039fd39ef817fad87436f656e58de1d65efb"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "d4599c5191404b4baa2758f145723ad9a466666a5fa61133f11bd32efe2af478"
        },
        {
          "path": "docs/releases/v1.11.0.md",
          "sha256": "9e3419b1101df1ad5bdfc033eeaa87dde5894a8dac86fd137f67992081c5aa18"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "2a37ef896ca931dd09043b03a7abcf7053e282a9a3b4d5b30e2f18ff82023f5c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "dd32d3d9abdd825c63809d22966940599d8c81a934d61e73635fa3ce77a8ce8a"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7063695eb28db05832c2b3b4e645dafd911ed31573ff5135b3f79d6a346956b8"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "9756c2a865e60f098228c9ee12cc4eedfb813a7e4fdd4fffbc61bf33d948c2a8"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "a8e0622f03d2394ebf909e65da548ab48fc7c26201faa368ca7e32be6e5f1a8e"
        },
        {
          "path": "package-lock.json",
          "sha256": "ebf6ee75699e7970c1531cf5f2166e0eeba29a8e27f00dcd6dec8e7526cda331"
        },
        {
          "path": "package.json",
          "sha256": "fc076b0349be0a4508fdab95ca3b9ab3a6ce80b19cfa42d2ea7ff2fbc4424bb0"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "6c1f10bd7386d0bc277650c104bbaeef502b1e7c456bc3bb5263c9538c4bb52d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "66545c552d566c259de6bc6339d3fbf6d65604a878a4a68f7dc1d0f92b09461c"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d9e0f52e835f31942ab55f21cf8a2ab5a223e6df41c134dee3eb0c6b68a88968"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "541e8c4e9ff8103b610c1b002966eabdd1b297a804829dc9cdf20efa91832f9a"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "5316e585b326432736ff7d1dbf0369af756fc25d1189dd70df165fe57d4dc1d5"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "7f4b28ddc2c0a6af9db2f68a1fcb53d665cf0574ca0bb6a84e061b488d09aa70"
        },
        {
          "path": "tests/test_browser_extension_session.mjs",
          "sha256": "849d731cab86c83ba6c001925e8d11e982563f30a2e91e952f775c1397dad9ff"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "4fe4c64d0abf9f47f7f290381aebb6f1a346561bc1ec0de639170fbd8be62507"
        },
        {
          "path": "tests/test_browser_uploads.cpp",
          "sha256": "e8f1ef7fb9ae5f452e6c082ef126fc5da7b19cac3ff2627d277cfb7fd53624f6"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "44ca3f7b03dabe3f2f2b0fb99c9a88a10eec83c95bd115d5c6fbb6c932e090f5"
        },
        {
          "path": "vscode/package.json",
          "sha256": "694ddf00ac71d7a6013556059408c6b15f3c720bb91944340d9264fd3a5245c2"
        }
      ]
    },
    {
      "id": "EV-CI-RELEASE",
      "acceptance": [
        "AC-CI-RELEASE"
      ],
      "kind": "manual",
      "status": "pass",
      "command": [],
      "method": "Observed release run 41332519441 for the v1.11.0 tag (ci-release.json, from gh run view): the four archive jobs and live.yml's live browser suites on Linux, macOS and Windows ran side by side from 17:38; Publish GitHub release started at 18:00:16, three seconds after the last live job (Windows) completed at 18:00:13, and the Marketplace publish followed it (v1.11.0 published for all four targets). Each platform's large-upload suite passed 7/7 (ci-large-upload-*.json: Linux 11.5, macOS 8.8, Windows 5.9 MiB/s)",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/uploads/ci-release.json",
        "sha256": "8187ccc9a69bc955da9fc1c1e18e1307adf263cb6be90c3910d57242cf787431"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "d5c483e4c45658be5312a57086e2278be120c20162f4c4bcd20e502ef1752cb6",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "fb752bc95fb1205076e685eeec9fbfd32ad6dd4627bb6ae3cbe05e51854b7f84"
        },
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "d48fb5ff2efb3687a325265543558d27af25ec2056e87f6c7e95ee2515c12346"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "eddc667c69cdf5ae29537693065ecf1d40e9c2f100b5cb7d78bc91e0f4d5c1b3"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "fdf4f79a8ccc117d785627d668a8cd1fb0e00f354b5bd9ee63bd8b95f547d4fb"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "a3e2cd2c84d1c3fe765ba3355250f3aa2d9167d98a05a9cc1ac3f50d3d246d32"
        }
      ]
    }
  ],
  "checkpoint": null
}
```
