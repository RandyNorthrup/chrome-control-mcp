# Actions that say what they changed, forms in one call, and unchanged snapshots

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them. The research behind
it is [docs/research/browser-mcp-speed-and-token-efficiency.md](../research/browser-mcp-speed-and-token-efficiency.md),
items R3, R10 and R11.

## Why

After an action an agent cannot tell whether anything happened without looking, and the look it
reaches for is a whole snapshot -- the most expensive call there is. On Mind2Web, 52.9% of the steps
within a page change nothing. An agent also spends one call and one model turn per field on a form,
and a second snapshot to learn that a page it is polling has not moved. The owner chose, on
2026-11-08, the full set the research recommended, with the tool catalog's byte budget raised to
pay for it.

## Design

**`changes` on every action reply.** Around each command that delivers input or loads a document
(`CHANGE_COMMANDS`: click, click_at, js_click, type, press_key, select, set_value, fill_form,
hover, drag, upload, scroll, navigate, back, forward, reload), the extension reads the tab before
and after: its URL and title, the tab's counts of console errors and dialogs (new per-tab counters),
the document generation, and a page-side change counter. The counter (`domChangesFn`) is a
MutationObserver registered with the other new-document scripts and evaluated into the current
document at attach; it counts added and removed nodes, text and attribute changes, skipping `style`
and the extension's own overlay, numbers focused elements, and keeps no records. `summarizeChanges`
turns the two readings into `changes`: `dom` is always there ("none", "some", "many" from 5% of the
page's elements and at least 20, or "new document"), the rest only when they happened. Nothing waits.

**`snapshot: true` on those tools.** The extension polls the counter from its own clock (a page's
timers run once a second behind the user's tab) until the page has made no change for 100 ms, or for
1.5 s, captures a snapshot, and returns it with the document generation it was taken in. The bridge
installs its refs through the same code `browser_snapshot` uses (`installSnapshot`), shows the
action's JSON and then the snapshot, and refuses to bind refs when the capture's generation is not
the reply's. A failed capture is `snapshot_error`; the action stands.

**`if_changed: true` on `browser_snapshot`.** The bridge keeps, per tab, a SHA-256 of the last
outline as shown with the options it was shown under, and a snapshot number. An equal outline is
answered in one line; a changed one comes back whole with `*` before each ref the previous snapshot
did not carry. The first snapshot of a document has no baseline and is shown whole and unmarked.

**`browser_fill_form`.** `fields: [{ref, value}]`, at most 50, values strings (so every client's
schema handling accepts them), all on one tab. The contract resolves each ref to its node and keeps
the ref beside it; the bridge's stale-ref check covers every field. The extension fills each in
order with `fillFieldFn`: a select by visible option text or value, a checkbox or radio by a real
click to the state asked, a text field through the prototype's value setter with `input` and
`change` (so React's controlled inputs see it), contenteditable by its text. It stops at the first
field that cannot take its value, naming its position and ref and how many were filled before it.

**The catalog and the instructions.** One generic property adds `snapshot` to every action tool's
schema; `if_changed` and the new tool add the rest. The budget rises from 43,500 to 46,000 bytes
(45,624 for 55 tools). The server's instructions tell agents that actions report what changed and
that `snapshot: true` returns the page; `browser_hover` no longer tells them to snapshot.

## Non-goals and limits

- A general batch tool stays unbuilt: a batch wrapping `browser_click` would let an agent act
  through a tool the user never allowed, which is why the research keeps it behind a flag.
- `changes` reports what had happened by reply time; a page's later response is not in it. The
  counter runs in the page's world, so a page can make its own count wrong.
- A form across tabs, or a file field, is not filled by `browser_fill_form`: one tab, and files go
  through `browser_upload`.

## Compatibility

- Every reply keeps what it carried and gains `changes`; every new argument is optional. A
  `snapshot`, `if_changed` or `fields` key on a tool that does not take it is refused as before.
- The read-only profile is unchanged at 15 tools; `browser_fill_form` is not in it.
- Two agents sharing a server share a tab's snapshot numbering, as they share its refs.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-ACT",
    "title": "Actions that say what they changed, forms in one call, and unchanged snapshots",
    "scope_revision": 2,
    "brief": null,
    "brief_reason": "Scoped change in an existing product; README.md, docs/TOOLS.md, the research report docs/research/browser-mcp-speed-and-token-efficiency.md and the owner's decision of 2026-11-08 (the full set, budget raised) carry the context",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "2341ef05e7b3"
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
        "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
        "ubuntu-laptop-gcc": "15.2.0",
        "ubuntu-laptop-clang": "21.1.8",
        "ubuntu-laptop-qt": "6.10.2",
        "ubuntu-laptop-cmake": "4.2.3",
        "ubuntu-laptop-cppcheck": "2.19.0",
        "ubuntu-laptop-node": "v24.20.0",
        "ubuntu-laptop-python": "3.14.4",
        "ubuntu-laptop-semgrep": "1.174.0"
      }
    }
  },
  "requirements": [
    {
      "id": "REQ-ACT-CHANGES",
      "statement": "Every action's reply says what it changed -- dom, and url, title, dialog, console errors and focus when they happened -- without adding a wait",
      "priority": "critical",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-LIVE"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-ACT-SNAPSHOT",
      "statement": "An action asked for a snapshot returns the settled page in the same reply, with refs that work at once and are never bound to a replaced document",
      "priority": "critical",
      "acceptance": [
        "AC-ACT-SNAPSHOT"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-ACT-UNCHANGED",
      "statement": "browser_snapshot with if_changed answers in one line for an unchanged page and marks new refs on a changed one",
      "priority": "normal",
      "acceptance": [
        "AC-ACT-UNCHANGED"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-ACT-FORM",
      "statement": "browser_fill_form fills text fields, selects, checkboxes and radios in one call and stops at the first field that cannot take its value, naming it",
      "priority": "critical",
      "acceptance": [
        "AC-ACT-FORM"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-ACT-COMPAT",
      "statement": "Every earlier suite, every MCP client, the read-only profile and the catalog's budget keep working, and the release says what shipped",
      "priority": "critical",
      "acceptance": [
        "AC-ACT-COMPAT",
        "AC-ACT-RELEASE"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-ACT-CHANGES",
      "requirement": "REQ-ACT-CHANGES",
      "given": "Readings of a tab before and after an action: unchanged; with a new url, title, dialog, console errors, focus and a few DOM changes; with a replaced document; with no counter",
      "when": "the extension summarizes them, and the dispatcher runs an action or a read",
      "then": "dom is none, some or many (5% of the page and at least 20) or new document, url, title, dialog, console_errors and focus appear only when they happened, a replaced document says nothing of focus, a page with no counter says nothing of dom, an action's reply carries changes and a read's does not",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-ACT-LIVE",
      "requirement": "REQ-ACT-CHANGES",
      "given": "Chrome for Testing on the laptop with the actions fixture; Windows and macOS run the same suite in the release's live job",
      "when": "the action-changes suite clicks buttons that do nothing, add a few nodes, add hundreds, open an alert, log an error, move focus and navigate, and the latency suite runs",
      "then": "each reply reports dom none, some, many, the dialog's type and message, one console error, the focused textbox's name, and new document with the new url and title; every latency check stays under 500 ms",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-ACT-SNAPSHOT",
      "requirement": "REQ-ACT-SNAPSHOT",
      "given": "An action sent with snapshot true, its capture taken in the reply's document generation or in an earlier one; every tool's schema",
      "when": "the reply arrives",
      "then": "the reply is the action's JSON then the snapshot, whose refs are installed for the tab and work for the next action with no browser_snapshot between; a capture from a replaced document installs nothing and says why; snapshot is offered on exactly the sixteen action tools, as a boolean",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-ACT-UNCHANGED",
      "requirement": "REQ-ACT-UNCHANGED",
      "given": "Snapshots of one tab with if_changed: the first, an equal one, one with a new button, one without if_changed, and one after a navigation",
      "when": "the bridge answers each",
      "then": "the first is whole and unmarked, the equal one is one line naming the snapshot it repeats and its element count with the refs still installed, the changed one is whole with only the new ref marked *, a snapshot without if_changed is never marked, and the first after a navigation is whole and unmarked",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-ACT-FORM",
      "requirement": "REQ-ACT-FORM",
      "given": "Fields for a text input, a select, a checkbox, a radio and a textarea; malformed field lists; a disabled field mid-form; an option the select lacks; a number field given text; a field on a stale tab",
      "when": "browser_fill_form runs",
      "then": "all fill in one call through the page's own events (a text field through its prototype setter, past a framework's value property), the page's status confirming each value; a malformed list, a ref used twice, refs on two tabs or a value too long are refused before sending; the disabled field stops the form naming field 2 and that one field before it was filled; a missing option and a refused number are named; a stale field ref is refused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-ACT-COMPAT",
      "requirement": "REQ-ACT-COMPAT",
      "given": "The 1.15.0 tree on Windows and on the Ubuntu laptop",
      "when": "ctest, the JavaScript suites, the smoke test, the static analysis and every live suite run",
      "then": "all pass: the catalog within 46,000 bytes with 55 tools, the read-only profile's 15, every earlier live suite (latency, display matrix, full browser exercising browser_fill_form, interference, multi-agent, clipboard, versions, profiles, large upload) unchanged, and clang-tidy, cppcheck and Semgrep clean",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-ACT-RELEASE",
      "requirement": "REQ-ACT-COMPAT",
      "given": "The version files, the changelog, the README and the release page",
      "when": "the release-versions suite reads them",
      "then": "every one says 1.15.0, the changelog and README's What's new start with it, and its release page exists",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    }
  ],
  "tasks": [
    {
      "id": "TASK-ACT-EXTENSION",
      "purpose": "The extension: the page's change counter, the per-tab error and dialog counts, changes on every action reply, the settled snapshot, browser_fill_form's handler, and their unit tests",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-FORM"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-ACT-CTEST",
        "EV-ACT-UNIT-JS",
        "EV-ACT-LINUX",
        "EV-ACT-LIVE-CHANGES",
        "EV-ACT-RED-DOM",
        "EV-ACT-RED-MANY",
        "EV-ACT-RED-FOCUS",
        "EV-ACT-RED-ATTACHED",
        "EV-ACT-RED-SELECT",
        "EV-ACT-RED-STOP",
        "EV-ACT-RED-SETTER",
        "EV-ACT-RED-NOT-SHOWN",
        "EV-ACT-RED-EPOCH"
      ]
    },
    {
      "id": "TASK-ACT-SERVER",
      "purpose": "The server: the snapshot argument and browser_fill_form in the contract and catalog, the action-snapshot reply and if_changed in the bridge, the stale check on form fields, the instructions, and their tests",
      "acceptance": [
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "action": "modify"
        },
        {
          "path": "src/browser_contract.cpp",
          "action": "modify"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "action": "modify"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-ACT-CTEST",
        "EV-ACT-LINUX",
        "EV-ACT-LIVE-CHANGES",
        "EV-ACT-RED-NOT-SHOWN",
        "EV-ACT-RED-EPOCH",
        "EV-ACT-RED-NEVER-SAME",
        "EV-ACT-RED-UNMARKED",
        "EV-ACT-RED-STALE-FIELD",
        "EV-ACT-RED-OFFERED",
        "EV-ACT-RED-CROSS-TAB",
        "EV-ACT-RED-STOP"
      ]
    },
    {
      "id": "TASK-ACT-LIVE",
      "purpose": "The live suites: the action-changes suite and its fixture page, browser_fill_form in the full-browser suite, and the suite in live.yml",
      "acceptance": [
        "AC-ACT-LIVE",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM",
        "AC-ACT-COMPAT"
      ],
      "depends_on": [
        "TASK-ACT-EXTENSION",
        "TASK-ACT-SERVER"
      ],
      "changes": [
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "action": "create"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "action": "modify"
        },
        {
          "path": ".github/workflows/live.yml",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-ACT-LIVE-CHANGES",
        "EV-ACT-LIVE-LATENCY",
        "EV-ACT-LIVE-FULL",
        "EV-ACT-LIVE-REGRESSION",
        "EV-ACT-RED-LIVE",
        "EV-ACT-RED-NOT-SHOWN",
        "EV-ACT-RED-NEVER-SAME",
        "EV-ACT-RED-STOP",
        "EV-ACT-RED-CATALOG",
        "EV-ACT-GATES",
        "EV-ACT-SMOKE"
      ]
    },
    {
      "id": "TASK-ACT-RELEASE",
      "purpose": "The version 1.15.0 in every file that carries it, and the documentation of what shipped: tools, architecture, README, changelog, plan and the release page",
      "acceptance": [
        "AC-ACT-RELEASE",
        "AC-ACT-COMPAT"
      ],
      "depends_on": [
        "TASK-ACT-EXTENSION",
        "TASK-ACT-SERVER",
        "TASK-ACT-LIVE"
      ],
      "changes": [
        {
          "path": "CMakeLists.txt",
          "action": "modify"
        },
        {
          "path": "browser/extension/manifest.json",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "action": "modify"
        },
        {
          "path": "package.json",
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
        },
        {
          "path": "docs/TOOLS.md",
          "action": "modify"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "action": "modify"
        },
        {
          "path": "README.md",
          "action": "modify"
        },
        {
          "path": "CHANGELOG.md",
          "action": "modify"
        },
        {
          "path": "PLAN.md",
          "action": "modify"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "action": "create"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-ACT-CTEST",
        "EV-ACT-UNIT-JS",
        "EV-ACT-RED-RELEASE",
        "EV-ACT-RED-CATALOG",
        "EV-ACT-GATES",
        "EV-ACT-SMOKE",
        "EV-ACT-LIVE-REGRESSION"
      ]
    }
  ],
  "evidence": [
    {
      "id": "EV-ACT-READINESS",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-LIVE",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM",
        "AC-ACT-COMPAT",
        "AC-ACT-RELEASE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the surveyed source and the research report: ten findings (no wait by default, the counter skipping the extension, a page lying to its counter, a replaced document's snapshot, settling off the page's timers, a baseline the agent still has, form fields inside the ref rules, string values for every client, React's controlled inputs, the catalog budget), each resolved or accepted in the design; every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/act/readiness-review.md",
        "sha256": "3c3ce59ed4a86a50606b9efd6226b0ee74f4efdc676f28e54e38a1aeee355e46"
      },
      "red": null,
      "reason": "Scope revision 2: scripts/mcp_smoke.mjs, which pins the tool count, joins TASK-ACT-SERVER; the smoke run found it at 54",
      "scope_sha256": "148e21505889d4399eb93832ddfba29f6b87a17ecbff2454ae724a8b1fed0c18",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        }
      ]
    },
    {
      "id": "EV-ACT-READINESS-2",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-LIVE",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM",
        "AC-ACT-COMPAT",
        "AC-ACT-RELEASE"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Requirements reviewed against the surveyed source and the research report: ten findings (no wait by default, the counter skipping the extension, a page lying to its counter, a replaced document's snapshot, settling off the page's timers, a baseline the agent still has, form fields inside the ref rules, string values for every client, React's controlled inputs, the catalog budget), each resolved or accepted in the design; scope revision 2 adds the smoke script, which pins the tool count; every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/act/readiness-review.md",
        "sha256": "3c3ce59ed4a86a50606b9efd6226b0ee74f4efdc676f28e54e38a1aeee355e46"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        }
      ]
    },
    {
      "id": "EV-ACT-CTEST",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM",
        "AC-ACT-COMPAT",
        "AC-ACT-RELEASE"
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
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.15.0 tree: all 28 suites pass, among them test_browser_bridge (an action's snapshot shown after its JSON with its refs installed and the next action by ref going out; a capture from a replaced document installing nothing and saying why; if_changed's first, equal, grown, plain and post-navigation snapshots; a stale form field refused), test_browser_contract (snapshot offered on exactly the sixteen action tools as a boolean and refused elsewhere; if_changed accepted; a form's fields resolved in order on one tab, and every malformed list refused naming the field), test_browser_mcp_server (55 tools, the catalog within 46,000 bytes, the read-only profile's 15) and every JavaScript suite",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-ctest.txt",
        "sha256": "3880e78439288394d550a10ff14e7879503b69394d2d4407d831b5d607268962"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-GATES",
      "acceptance": [
        "AC-ACT-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "lint"
      ],
      "method": "ESLint and PSScriptAnalyzer clean over the tree, the new live suite included; Prettier flags no file that is committed (the seven it lists are the untracked research notes in reports/ and research_notes/, which are not part of this change)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-gates.txt",
        "sha256": "bd1ade4e225422c5f29dab0c8724309af50004a1c22d8f7986340b48b184a780"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-LINUX",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM",
        "AC-ACT-COMPAT",
        "AC-ACT-RELEASE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_act.sh",
        "static"
      ],
      "method": "The Ubuntu 26.04.1 laptop (GCC 15.2.0, Qt 6.10.2, Clang 21.1.8): the 1.15.0 build with no warnings, ctest 27/27, clang-tidy 21.1.8 and exhaustive cppcheck 2.19.0 clean (clang-tidy's first run found the form bounds multiplied in int and widened; they are built as qsizetype now), Semgrep 1.174.0 with no findings",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/linux-summary.txt",
        "sha256": "07399b5c70256cf7926516ffc92c64fa582f05de9f0e79f410ec41d7acb08a02"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-LIVE-CHANGES",
      "acceptance": [
        "AC-ACT-LIVE",
        "AC-ACT-SNAPSHOT",
        "AC-ACT-UNCHANGED",
        "AC-ACT-FORM"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_changes_e2e.mjs"
      ],
      "method": "Chrome for Testing 153 on the laptop, the actions fixture: dom none, some and many for a no-op, a few nodes and four hundred; the alert's type and message; one console error; textbox \"Name\" taking focus; new document with the address and title of the page a link opened; back with snapshot: true returning the page with refs that a click used at once; an unchanged page in one line and a changed one with only the new button's ref marked; a text field, select, checkbox, radio and textarea filled in one call as the page's own status confirms; a disabled field stopping the form at field 2 after one; an option the select lacks named; 14/14",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/live-action-changes.json",
        "sha256": "2e7c05986a1ffc414c9e432d884640b49b306deff6ed32157232cc913e085ecf"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-LIVE-FULL",
      "acceptance": [
        "AC-ACT-FORM",
        "AC-ACT-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/full_browser_e2e.mjs"
      ],
      "method": "The full-browser suite in Chrome for Testing 153 on the laptop: 50 tools exercised, browser_fill_form among them (a select and a checkbox filled in one call, its reply carrying changes), 208 cases",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/live-full-browser.json",
        "sha256": "af6960ba1e623ef98d1e8e24362e68b15995e33a434521e82430290af9d8e418"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-LIVE-LATENCY",
      "acceptance": [
        "AC-ACT-LIVE",
        "AC-ACT-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_latency_e2e.mjs"
      ],
      "method": "Chrome for Testing 153 on the laptop, the agent's tab behind the browser's own, every action now reading the page before and after itself: click, hover and three kinds of scroll, three times each, every one under 500 ms (worst: click 41 ms, hover 62, scrolls 99, 98 and 65); 6/6",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/live-action-latency.json",
        "sha256": "68ef22b1d43b889f4748878d5701a660cff9560aeb63d1172f5c312ea76546b4"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-LIVE-REGRESSION",
      "acceptance": [
        "AC-ACT-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_act.sh",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.15.0 build: action latency, the display matrix (35 configurations, 3,475 checks), full browser, user interference, multi-agent, per-agent clipboard, large upload, extension version (current, Chrome Web Store key, older, and the released 1.11.1 extension), two profiles and the profiles upgrade (the closed-history rule: earlier plans are not re-stamped)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/linux-summary.txt",
        "sha256": "07399b5c70256cf7926516ffc92c64fa582f05de9f0e79f410ec41d7acb08a02"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-ATTACHED",
      "acceptance": [
        "AC-ACT-CHANGES"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (changes-not-attached): the dispatcher never adds changes to an action's reply. Planted, the suite failed in an action's reply says what it changed; a command that is not an action says nothing; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "the dispatcher never adds changes to an action's reply",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an action's reply says what it changed; a command that is not an action says nothing",
        "observed_diagnostic": "an action's reply says what it changed; a command that is not an action says nothing",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "dca1fe90e8951d383ae5c54a5e6feaa1e8656aea7046dee7e53b3d0115d98241"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "317b60e57ff52c6cb3d05b4a53629b930e09998828f53fcad2e2e0c53b5b780d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-CATALOG",
      "acceptance": [
        "AC-ACT-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_mcp_server$"
      ],
      "method": "Drill (catalog-over-budget): the catalog grows past its byte budget. Planted, the suite failed in catalogStaysWithinItsBudgetAndStable; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "the catalog grows past its byte budget",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "catalogStaysWithinItsBudgetAndStable",
        "observed_diagnostic": "catalogStaysWithinItsBudgetAndStable",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "704be86f41e1e2a7cbedd7d8c22615abad3fb6f48ab6a96966078895ce0d2446"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-CROSS-TAB",
      "acceptance": [
        "AC-ACT-FORM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_contract$"
      ],
      "method": "Drill (fill-cross-tab): refs on two tabs are not named as a cross-tab form. Planted, the suite failed in buildCommand_fillFormRefusesMalformedFields; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "refs on two tabs are not named as a cross-tab form",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_fillFormRefusesMalformedFields",
        "observed_diagnostic": "buildCommand_fillFormRefusesMalformedFields",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "d2176a741cb391de7a843c9522a7ffd0f7e3c3b31bf78373e7f78ae7f6c42ec5"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-DOM",
      "acceptance": [
        "AC-ACT-CHANGES"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (summary-dom-ignored): every action says dom: none. Planted, the suite failed in an action's reply names each change it caused, and only those; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "every action says dom: none",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an action's reply names each change it caused, and only those",
        "observed_diagnostic": "an action's reply names each change it caused, and only those",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "8a22fcb25fd3c947d443fba65035872a023de81426c903620fcebd21a9968757"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "317b60e57ff52c6cb3d05b4a53629b930e09998828f53fcad2e2e0c53b5b780d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-EPOCH",
      "acceptance": [
        "AC-ACT-SNAPSHOT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (action-snapshot-epoch): a snapshot from a replaced document binds refs. Planted, the suite failed in actionSnapshot_ofAReplacedPageIsNotBound; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "a snapshot from a replaced document binds refs",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "actionSnapshot_ofAReplacedPageIsNotBound",
        "observed_diagnostic": "actionSnapshot_ofAReplacedPageIsNotBound",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "4a1279340c802dc523a211514b08091e80c1dcda2391b8e98399dddda3e6a20d"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-FOCUS",
      "acceptance": [
        "AC-ACT-CHANGES"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (focus-ignored): a focus change is never reported. Planted, the suite failed in an action's reply names each change it caused, and only those; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "a focus change is never reported",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an action's reply names each change it caused, and only those",
        "observed_diagnostic": "an action's reply names each change it caused, and only those",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a451dab726015e8547cb850300e00f77d31f5b549b28180d596ae3753368a726"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "317b60e57ff52c6cb3d05b4a53629b930e09998828f53fcad2e2e0c53b5b780d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-LIVE",
      "acceptance": [
        "AC-ACT-LIVE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_changes_e2e.mjs"
      ],
      "method": "Drill (changes-not-attached): in real Chrome, no action's reply carries changes. Planted, the suite failed in a click that changes nothing says dom: none, and nothing else; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/live-red-drills.txt",
        "sha256": "38e1a992f194e990c4d2b8465e1643b66eda1fa77146fe7e7bb40f10fc53e84f"
      },
      "red": {
        "mutation": "in real Chrome, no action's reply carries changes",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a click that changes nothing says dom: none, and nothing else",
        "observed_diagnostic": "a click that changes nothing says dom: none, and nothing else",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "dca1fe90e8951d383ae5c54a5e6feaa1e8656aea7046dee7e53b3d0115d98241"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-MANY",
      "acceptance": [
        "AC-ACT-CHANGES"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (many-threshold): many needs half the page. Planted, the suite failed in many is a share of the page, and never fewer than twenty changes; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "many needs half the page",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "many is a share of the page, and never fewer than twenty changes",
        "observed_diagnostic": "many is a share of the page, and never fewer than twenty changes",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "d265b11763881effc700128770d37d7ec894420f1b2a0a7c02c033690cedcdad"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "317b60e57ff52c6cb3d05b4a53629b930e09998828f53fcad2e2e0c53b5b780d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-NEVER-SAME",
      "acceptance": [
        "AC-ACT-UNCHANGED"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (if-changed-never): an unchanged page is shown whole. Planted, the suite failed in ifChanged_saysUnchangedAndMarksOnlyNewRefs; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "an unchanged page is shown whole",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "ifChanged_saysUnchangedAndMarksOnlyNewRefs",
        "observed_diagnostic": "ifChanged_saysUnchangedAndMarksOnlyNewRefs",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "76f5e6c0a5ebe93629a9617c0ea6eecaf9776be3fa63512b3b5441b4cce16415"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-NOT-SHOWN",
      "acceptance": [
        "AC-ACT-SNAPSHOT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (action-snapshot-not-shown): an action's snapshot is passed on as JSON, its refs never installed. Planted, the suite failed in actionSnapshot_isShownAndItsRefsWork; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "an action's snapshot is passed on as JSON, its refs never installed",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "actionSnapshot_isShownAndItsRefsWork",
        "observed_diagnostic": "actionSnapshot_isShownAndItsRefsWork",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "d587bea18814864b6d34c2e9c7d35aef9c8ba796a2e46c373674c73dbf7c42a4"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-OFFERED",
      "acceptance": [
        "AC-ACT-SNAPSHOT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_contract$"
      ],
      "method": "Drill (action-snapshot-offered): browser_fill_form is not offered snapshot. Planted, the suite failed in buildCommand_actionSnapshotOnEveryActionTool; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "browser_fill_form is not offered snapshot",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_actionSnapshotOnEveryActionTool",
        "observed_diagnostic": "buildCommand_actionSnapshotOnEveryActionTool",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "19ad2640f519bdf269f2b541f3ed513343c258dfa42deb567594c3b2dc0344f0"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-RELEASE",
      "acceptance": [
        "AC-ACT-RELEASE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_release_versions.mjs"
      ],
      "method": "Drill (release-version): the extension's manifest is left at 1.14.0. Planted, the suite failed in every file that states the version states the same one; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "the extension's manifest is left at 1.14.0",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "every file that states the version states the same one",
        "observed_diagnostic": "every file that states the version states the same one",
        "before": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
          }
        ],
        "after": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-SELECT",
      "acceptance": [
        "AC-ACT-FORM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (fill-select-text): a select is matched by value only, not by its visible text. Planted, the suite failed in a select takes the option's visible text, or its value, and refuses one it lacks; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "a select is matched by value only, not by its visible text",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a select takes the option's visible text, or its value, and refuses one it lacks",
        "observed_diagnostic": "a select takes the option's visible text, or its value, and refuses one it lacks",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "ab72c5d38245e15b81d0af630c8230d59eceb88deed48831128f23d5f0b64dd6"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-SETTER",
      "acceptance": [
        "AC-ACT-FORM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (fill-plain-setter): a text field is set by plain assignment, which a framework's own value property swallows. Planted, the suite failed in a text field is set past a framework's own value property, as React's controlled inputs need; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "a text field is set by plain assignment, which a framework's own value property swallows",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a text field is set past a framework's own value property, as React's controlled inputs need",
        "observed_diagnostic": "a text field is set past a framework's own value property, as React's controlled inputs need",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "16dcd243b5e2f41268a482614c7d7d7d3f7744e80af5ea377ab1b97099d2b75d"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-STALE-FIELD",
      "acceptance": [
        "AC-ACT-FORM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (fill-stale-field): a form field's ref on a stale tab goes out. Planted, the suite failed in fillForm_refusesAStaleFieldRef; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "a form field's ref on a stale tab goes out",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "fillForm_refusesAStaleFieldRef",
        "observed_diagnostic": "fillForm_refusesAStaleFieldRef",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "edd0c64f6053b607899198216145ce85c6e84fc31a1faa6d546380ae78508de9"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-STOP",
      "acceptance": [
        "AC-ACT-FORM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (fill-no-stop): a field the page refuses is passed over. Planted, the suite failed in a form stops at the first field that cannot be filled, and says which and how far it got; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/js-red-drills.txt",
        "sha256": "629d7b3052fe38dacc01a9f9904a39a6a4dfac6ab19209f60bcdf9e5386e1f42"
      },
      "red": {
        "mutation": "a field the page refuses is passed over",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a form stops at the first field that cannot be filled, and says which and how far it got",
        "observed_diagnostic": "a form stops at the first field that cannot be filled, and says which and how far it got",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "c4a76194936e995010b63a360986dcb0d1ffb24f40320dd93789355adfe0de6f"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-RED-UNMARKED",
      "acceptance": [
        "AC-ACT-UNCHANGED"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (if-changed-unmarked): new refs are not marked. Planted, the suite failed in ifChanged_saysUnchangedAndMarksOnlyNewRefs; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-unit-red-drills.txt",
        "sha256": "6b866c53c5b322c2b56ffd0213e7fc0dd2b7ad02d2d5fbfc666b7aca585fb51c"
      },
      "red": {
        "mutation": "new refs are not marked",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "ifChanged_saysUnchangedAndMarksOnlyNewRefs",
        "observed_diagnostic": "ifChanged_saysUnchangedAndMarksOnlyNewRefs",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "f483c2bc96d05565276c04d8dc5cecbb27da1cf2e97e1ac3e07aef3fe55836bb"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "0d3a23e50c9b67d49c5cb4281082e739180e108d515ed924d229e4d2eda9b2bb",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        }
      ]
    },
    {
      "id": "EV-ACT-SMOKE",
      "acceptance": [
        "AC-ACT-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test, run in both profiles: 55 tools in full and 15 read-only",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-smoke.txt",
        "sha256": "d0f6d44908921fb77546ec1a86f20cba81ffc3a6db41b0936fdd8331780a0ac3"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    },
    {
      "id": "EV-ACT-UNIT-JS",
      "acceptance": [
        "AC-ACT-CHANGES",
        "AC-ACT-FORM",
        "AC-ACT-RELEASE",
        "AC-ACT-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 14 JavaScript suites, 289 tests: changes summarized (dom none, some, many from 5% of the page and at least 20, new document; url, title, dialog, console errors and focus only when they happened; nothing of dom with no counter), the dispatcher adding changes to an action's reply and not to a read's, the focused element described and bounded, and browser_fill_form's fields: a select by text or value and a missing or disabled option refused, a checkbox or radio clicked to the state asked and a refusal reported, a text field set through the prototype's setter past a framework's own value property, a number field given text refused, read-only, disabled and contenteditable handled, and the form stopping at its first refused field naming it; every earlier suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/act/windows-test-js.txt",
        "sha256": "b1ebfda7e2126954b705eb0fcca4abe9b3530db098411bd9104e889444a2aa03"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "ubuntu-laptop-clang": "21.1.8",
          "ubuntu-laptop-cmake": "4.2.3",
          "ubuntu-laptop-cppcheck": "2.19.0",
          "ubuntu-laptop-gcc": "15.2.0",
          "ubuntu-laptop-node": "v24.20.0",
          "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
          "ubuntu-laptop-python": "3.14.4",
          "ubuntu-laptop-qt": "6.10.2",
          "ubuntu-laptop-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
        },
        {
          "path": "PLAN.md",
          "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
        },
        {
          "path": "README.md",
          "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
        },
        {
          "path": "docs/releases/v1.15.0.md",
          "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
        },
        {
          "path": "package-lock.json",
          "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
        },
        {
          "path": "package.json",
          "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
        },
        {
          "path": "tests/e2e/action_changes_e2e.mjs",
          "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
        },
        {
          "path": "vscode/package.json",
          "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
        }
      ]
    }
  ],
  "checkpoint": {
    "scope_sha256": "2857bb948482b99a851a0d20f08e17ea682bf87e342e04402a18a418af01b644",
    "inputs": [
      {
        "path": ".github/workflows/live.yml",
        "sha256": "d5817f39f3b305e2ce22bf529c2e81768570903f81b37053612dffa89d5e4b72"
      },
      {
        "path": "CHANGELOG.md",
        "sha256": "f641af16acb9bca5dc6d771b2d9f1a4abfeee4bedb921e9c40f744eafd687a8e"
      },
      {
        "path": "CMakeLists.txt",
        "sha256": "47ad64afd8fcfe601b901e14004152b25fda7bd047a1b2239a9dd2e6e800d8c8"
      },
      {
        "path": "PLAN.md",
        "sha256": "11fc12791a41d8b90750bcb80c6826bf6bd91704f8c4d4e918f9638de441b8ec"
      },
      {
        "path": "README.md",
        "sha256": "a1f3266f4b39a76adf0c092ffe6280e9222eb33b175ca8f0fb15781b2ddbc504"
      },
      {
        "path": "browser/extension/background.js",
        "sha256": "7cd60a3e90d36aed680b2805bcbd5135fba3288aca4efa72a55757cc18988e33"
      },
      {
        "path": "browser/extension/manifest.json",
        "sha256": "01fe890c24b2b4c9d8d1af903dc1baefcfc46167d70ef1e5ec2976e1e97c8e94"
      },
      {
        "path": "docs/ARCHITECTURE.md",
        "sha256": "bb3929e4d008f24aac9e51ee2f43aaf822582521609db49da8259e005b9b23cb"
      },
      {
        "path": "docs/QUALITY.md",
        "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
      },
      {
        "path": "docs/TOOLS.md",
        "sha256": "99a3074054ce3af76aa847fd2c5998329a2d33d665b1d2d6d20f79df8d14e949"
      },
      {
        "path": "docs/releases/v1.15.0.md",
        "sha256": "1d04204a2688b4072ff3eefbf091387d30d236dc27249b3f460d98f43100aae1"
      },
      {
        "path": "include/chrome_control_mcp/browser_bridge.h",
        "sha256": "1bdd4a22f8df4f1318812d1556bca5189c11235bc01dfe2161381e46ebe13372"
      },
      {
        "path": "include/chrome_control_mcp/browser_contract.h",
        "sha256": "f297d499efc627422e436c9429c4aa80d96777aa940c451a06e3afe83c752f19"
      },
      {
        "path": "include/chrome_control_mcp/browser_extension_installer.h",
        "sha256": "30a4a49526a420434f88f60a1f5da9843f0465a4db320c1791581ef7148b0870"
      },
      {
        "path": "package-lock.json",
        "sha256": "f2a66a1558eab30a4c255eb25485fe64efedc4fc06003afa7a2fea985862f9ba"
      },
      {
        "path": "package.json",
        "sha256": "7430a00050c194cb9ee7dcaf928a6774e12517621c993d9b3003bf6f87b6bec1"
      },
      {
        "path": "scripts/mcp_smoke.mjs",
        "sha256": "ee36417fb22cbabd866f0ce6d7057d237d2dec7442feb1a39f4ffcb89ff9923d"
      },
      {
        "path": "src/browser_bridge.cpp",
        "sha256": "69af82b253b1e01e3542f1dd4a51a6523573319576f20011ec0cf4ce9417cf91"
      },
      {
        "path": "src/browser_contract.cpp",
        "sha256": "8fd8d7a87be195f003fb2f14c19980d0bda3bf025082146cd57bd2521b927401"
      },
      {
        "path": "src/mcp_dispatch.cpp",
        "sha256": "14a4afebb8366b1b33235fad4d2285b4e0b6fd90001d691ac1ceb0d88c873e8c"
      },
      {
        "path": "tests/e2e/action_changes_e2e.mjs",
        "sha256": "ecf4c5e67e4309c73e8c631ac6b8bbcb8d436f351dba0f6ec4e1a9104091443a"
      },
      {
        "path": "tests/e2e/fixture_server.mjs",
        "sha256": "583e985ea1b849c99b4cd25ba9bffcdc4d5eadf5a23bc8e73cfb37dd50f1fc24"
      },
      {
        "path": "tests/e2e/full_browser_e2e.mjs",
        "sha256": "c1e863c9e1eeb45df402cf31c836ab7f52bd5670baeee85c15606a75202b8193"
      },
      {
        "path": "tests/test_browser_bridge.cpp",
        "sha256": "54d03fb76811a2d1726e071cab83f28b6218ecc039595658756947226bc5fd89"
      },
      {
        "path": "tests/test_browser_contract.cpp",
        "sha256": "21efc9d54e9e74126fce3c168b7b9f87f8a765897e12d6116b62f1144cb177c0"
      },
      {
        "path": "tests/test_browser_extension_pure.mjs",
        "sha256": "bea44f1812bbf8b369deabf151a99bba03375a973248a59cf8b4a2856eba016c"
      },
      {
        "path": "tests/test_browser_extension_tabs.mjs",
        "sha256": "0feff516f7ad34991b3a9e565e856d58c1ae25b7135e352814cc95c36f69b631"
      },
      {
        "path": "tests/test_browser_mcp_server.cpp",
        "sha256": "d3c935e5617530fa324082b2f94115f281f95f0af6a1c469f5947a43525d1990"
      },
      {
        "path": "vscode/package-lock.json",
        "sha256": "b8953d9194df93954eaf325325a8046a5ffdd4d1e4e6e90655343c79f1b11551"
      },
      {
        "path": "vscode/package.json",
        "sha256": "6caaaf55dbb9300fb71511795a03096d2af22917300b9ab717ca0817b3f59269"
      }
    ],
    "environment": {
      "platform": "windows",
      "tools": {
        "chrome-for-testing": "153.0.8010.52",
        "cmake": "4.4.5",
        "node": "v24.20.0",
        "python": "3.14.10",
        "ubuntu-laptop-clang": "21.1.8",
        "ubuntu-laptop-cmake": "4.2.3",
        "ubuntu-laptop-cppcheck": "2.19.0",
        "ubuntu-laptop-gcc": "15.2.0",
        "ubuntu-laptop-node": "v24.20.0",
        "ubuntu-laptop-os": "Ubuntu 26.04.1 LTS",
        "ubuntu-laptop-python": "3.14.4",
        "ubuntu-laptop-qt": "6.10.2",
        "ubuntu-laptop-semgrep": "1.174.0"
      }
    },
    "verified_tasks": [
      "TASK-ACT-EXTENSION",
      "TASK-ACT-SERVER",
      "TASK-ACT-LIVE",
      "TASK-ACT-RELEASE"
    ],
    "pending_operations": [],
    "next_action": "Closed. Commit and push; once CI passes, tag v1.15.0: the release runs every live suite on Windows, macOS and Linux before it publishes the GitHub release, the VS Code packages and the Chrome Web Store submission.",
    "source_revision": "eb72f9f"
  }
}
```
