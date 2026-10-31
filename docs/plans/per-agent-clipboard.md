# Per-agent clipboards

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them.

## Why

Agents in one browser shared the one clipboard the operating system has, and so did the user. An
agent's Ctrl+V pasted whatever was last copied anywhere on the machine -- possibly the user's own
copy, or another agent's -- and an agent's copy replaced the user's. Agents that staged post text
with a shell command (`Set-Clipboard`, `pbcopy`) raced each other. Worse, a page's own "Copy"
button clicked by an agent could write the user's clipboard: agent tabs run under focus emulation,
so a background page believes it is focused and Chrome lets it write.

Chrome has no clipboard per tab, per profile or per extension. Isolation therefore has to be
provided by Chrome Control MCP itself, without ever reaching the system clipboard, and it has to
work on any site: this is a public tool, and social sites, mail, editors and forms all paste
differently.

## Design

**One clipboard per agent, held by the extension.** Keyed like the agent's tab group: the session
(one MCP server) and the agent name given to `browser_new_tab`, or the session's shared group when
none was given. Kept in the service worker's memory only -- never in `chrome.storage`, never on
disk -- bounded in size, and cleared when the agent lets go of its last tab, when its server exits
or its session is stood down, and when the user pauses the bridge. A ten-minute idle stand-down
keeps it, as it keeps the agent's tabs.

**Keystrokes.** Every agent key press already goes through one dispatcher. Copy, cut and paste
chords for the platform (Ctrl or Cmd with C, X, V; Ctrl+Insert, Shift+Delete and Shift+Insert off
macOS; paste-as-plain-text variants) are answered there and never sent to Chrome as keys, which is
what would have read or written the system clipboard.

- _Copy_ gives the page what a real copy gives it: a `copy` event with a fresh `DataTransfer`. A
  page that fills it (many do: "Read more at...", rich formats) is believed; otherwise the
  selection is taken -- an input's or textarea's selected value, or the document selection as
  text and HTML. _Cut_ is copy, then the selection deleted with a trusted Backspace when the page
  did not handle it.
- _Paste_ gives the focused element, as a real paste does, a `paste` event carrying the agent's
  clipboard as `text/plain`, `text/html` and `File` objects; if the page did not take it, a
  `beforeinput` of type `insertFromPaste` with the same data (some editors handle paste only
  there); and if the page took neither, the text is inserted with CDP's trusted `Input.insertText`,
  which reaches any focused field, including one inside a cross-site frame. HTML is only ever
  handed to the page's own paste handler, which sanitizes it as it would a real paste; it is never
  inserted by this code.

**The page's clipboard API in agent tabs.** A stand-in installed in every document of a held tab
(the same mechanism as the file-picker stand-in) replaces `navigator.clipboard`'s methods and
`document.execCommand('copy'|'cut')`, on the prototypes so a bound reference cannot bypass them.
They reach the extension through a CDP binding. A write or read is honoured only while one of the
agent's input commands on that tab (including its own `browser_clipboard` copy, cut and paste) is
running and for 2 s after -- the window in which a real user's click would give the page activation
-- and only against that tab's agent's clipboard; outside it the page is refused as a page with no
permission is. When the tab is handed back, the browser's
own functions are put back in the live document, and new documents never get the stand-in.

**`browser_clipboard`.** One tool, tab-scoped like the rest: `write` text, HTML and/or files (by
path, read and bounded by the server exactly like `browser_upload`, so paths never reach the
browser), `read`, `clear`, and `copy`, `cut` and `paste` (with an optional `ref` to act on). The
agent whose clipboard is used is the agent that holds the tab.

## Non-goals and limits

- A shell command an agent runs outside the browser can still use the system clipboard; the MCP
  `instructions` steer agents to `browser_clipboard` instead.
- Inside a cross-site frame, copy and rich paste are not available (the page script cannot reach
  it); paste falls back to inserting the text.
- A page that deliberately bypasses the stand-in (for example through a freshly created frame
  before the stand-in reaches it) is outside the threat model; ordinary pages are not.
- On Linux, selecting text still sets the X11/Wayland primary selection, which Chrome does for
  every selection; middle-click paste outside the browser can see it.
- Survives neither a browser restart nor the extension's service worker being restarted.

## Reuse

The upload pipeline (path rules, `CHROME_CONTROL_MCP_UPLOAD_ROOTS`, chunking, manifest) carries
clipboard files; the file-picker stand-in's install, binding and arming pattern carries the page
stand-in; `OPENER_COMMANDS` and its 2 s grace define the activation window; `releaseTabs`,
`standDown` and `releaseTabState` are where clearing hooks in; the table-driven contract adds the
tool.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-CLIPBOARD",
    "title": "Per-agent isolated clipboards",
    "scope_revision": 1,
    "brief": null,
    "brief_reason": "Scoped feature in an existing product; README.md and docs/MULTI_SESSION.md carry the product context and the 1.8 multi-agent decisions it extends",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "f0646273ed53"
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
      "id": "REQ-CLIP-ISOLATION",
      "statement": "Each agent has a clipboard of its own that no other agent, session or page of another agent can read or write",
      "priority": "critical",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-SERVERS"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CLIP-SYSTEM",
      "statement": "No agent action -- key press, tool call, or page clipboard call in an agent-held tab -- reads or writes the operating system clipboard",
      "priority": "critical",
      "acceptance": [
        "AC-CLIP-SYSTEM"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CLIP-KEYS",
      "statement": "An agent's copy, cut and paste chords act on its own clipboard and reach the page as a real copy, cut or paste would",
      "priority": "critical",
      "acceptance": [
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CLIP-PAGE",
      "statement": "A page's clipboard API in an agent-held tab uses that agent's clipboard during the agent's own input commands, is refused outside them, and is the browser's own again once the tab is handed back",
      "priority": "normal",
      "acceptance": [
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CLIP-TOOL",
      "statement": "browser_clipboard writes, reads, clears, copies, cuts and pastes the calling agent's clipboard, for any MCP client, with paths kept on the server",
      "priority": "normal",
      "acceptance": [
        "AC-CLIP-TOOL"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CLIP-LIFETIME",
      "statement": "A clipboard lives only in memory, is bounded, and is cleared when its agent lets go, its session ends, or the user pauses the bridge",
      "priority": "critical",
      "acceptance": [
        "AC-CLIP-LIFETIME"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CLIP-SITES",
      "statement": "Copy and paste work on the editors real sites are built with, not only on this project's fixtures",
      "priority": "normal",
      "acceptance": [
        "AC-CLIP-SITES"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-CLIP-AGENTS",
      "requirement": "REQ-CLIP-ISOLATION",
      "given": "Two agents on one server, alpha and beta, each with its own tab, and alpha's clipboard holding text",
      "when": "beta pastes into a field and reads its clipboard",
      "then": "beta's field and read never contain alpha's text, and alpha's paste still yields alpha's text",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-SERVERS",
      "requirement": "REQ-CLIP-ISOLATION",
      "given": "An agent on a second server in the same browser",
      "when": "it reads its clipboard and pastes",
      "then": "it gets nothing of the first server's agents",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-SYSTEM",
      "requirement": "REQ-CLIP-SYSTEM",
      "given": "A sentinel string placed on the browser's system clipboard by the test, outside any agent",
      "when": "agents copy, cut and paste by key and by tool, and click page buttons that copy with execCommand and navigator.clipboard",
      "then": "the system clipboard still holds the sentinel afterwards, and no agent paste ever produces it",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-KEYS",
      "requirement": "REQ-CLIP-KEYS",
      "given": "An agent's tab with text selected in a textarea",
      "when": "the agent presses the platform's copy, cut and paste chords",
      "then": "copy stores the selection, cut stores and removes it, paste inserts it, and none of the chords is dispatched to Chrome as a key event; a copy with nothing selected leaves the clipboard as it was, and a paste from an empty clipboard inserts nothing and says so",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-PASTE",
      "requirement": "REQ-CLIP-KEYS",
      "given": "Editors that take paste from the paste event, from beforeinput insertFromPaste, or not at all",
      "when": "the agent pastes text, HTML and an image file",
      "then": "the paste-event editor receives text/plain, text/html and the File, the beforeinput editor receives the data transfer, and a plain contenteditable receives the text",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-PAGEAPI",
      "requirement": "REQ-CLIP-PAGE",
      "given": "A page with copy buttons using execCommand and navigator.clipboard.writeText, a paste button using readText, and a timer that reads the clipboard by itself",
      "when": "the agent clicks the buttons and the timer fires outside any agent command",
      "then": "the buttons write and read the agent's clipboard, and the timer's read is refused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-RESTORE",
      "requirement": "REQ-CLIP-PAGE",
      "given": "An agent-held tab whose page has the stand-in",
      "when": "the agent releases it with keep_open",
      "then": "the page's navigator.clipboard and execCommand are the browser's own functions again",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-TOOL",
      "requirement": "REQ-CLIP-TOOL",
      "given": "browser_clipboard calls with valid and invalid argument combinations",
      "when": "they are translated into commands",
      "then": "valid calls reach the extension without any path, invalid ones are refused naming the problem (an unknown action, write with nothing to write, text or HTML past 512 KiB together -- Chrome takes at most 1 MiB in one message from the server -- or an argument the action does not take), the tool is absent from the read-only profile, and the full profile lists 53 tools",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-LIFETIME",
      "requirement": "REQ-CLIP-LIFETIME",
      "given": "An agent with a filled clipboard",
      "when": "it releases its last tab, its session is stood down, or the bridge is paused",
      "then": "its clipboard is empty afterwards, while another agent's that still holds tabs is untouched; oversized writes are refused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CLIP-SITES",
      "requirement": "REQ-CLIP-SITES",
      "given": "Public demos of the editor frameworks real sites use (ProseMirror, Lexical, Slate, Quill, CKEditor, TinyMCE, CodeMirror and plain form fields)",
      "when": "an agent pastes text and copies it back",
      "then": "each editor shows the pasted text and the copy returns it",
      "checks": [
        "manual"
      ],
      "manual_reason": "Third-party sites change without notice and cannot be a deterministic CI gate; a live run against them is recorded instead"
    }
  ],
  "tasks": [
    {
      "id": "TASK-CLIP-EXTENSION",
      "purpose": "Clipboard store, chord interception, copy/cut/paste in the page, the page stand-in and its gating, and clearing, in the service worker",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-SERVERS",
        "AC-CLIP-SYSTEM",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE",
        "AC-CLIP-LIFETIME",
        "AC-CLIP-SITES"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CLIP-UNIT-JS",
        "EV-CLIP-LIVE",
        "EV-CLIP-RED-LIVE",
        "EV-CLIP-RED-UNIT",
        "EV-CLIP-SITES"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CLIP-SERVER",
      "purpose": "The browser_clipboard contract, its file transfer through the upload pipeline, and the MCP instructions",
      "acceptance": [
        "AC-CLIP-TOOL",
        "AC-CLIP-SYSTEM"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "src/browser_contract.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_control.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "action": "modify"
        },
        {
          "path": "src/browser_uploads.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "action": "modify"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CLIP-CTEST",
        "EV-CLIP-RED-CONTRACT",
        "EV-CLIP-LIVE",
        "EV-CLIP-RED-LIVE"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CLIP-UNIT",
      "purpose": "Unit coverage of routing, isolation, gating, clearing and the contract",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-KEYS",
        "AC-CLIP-LIFETIME",
        "AC-CLIP-TOOL",
        "AC-CLIP-PAGEAPI"
      ],
      "depends_on": [
        "TASK-CLIP-EXTENSION",
        "TASK-CLIP-SERVER"
      ],
      "changes": [
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "action": "create"
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
        },
        {
          "path": "CMakeLists.txt",
          "action": "modify"
        },
        {
          "path": "package.json",
          "action": "modify"
        },
        {
          "path": "tests/browser_model.mjs",
          "action": "create"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CLIP-UNIT-JS",
        "EV-CLIP-CTEST",
        "EV-CLIP-RED-UNIT",
        "EV-CLIP-RED-CONTRACT"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CLIP-LIVE",
      "purpose": "A live suite in Chrome for Testing with a fixture page of editors, copy buttons and a system-clipboard sentinel, run in CI on three platforms",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-SERVERS",
        "AC-CLIP-SYSTEM",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE",
        "AC-CLIP-LIFETIME"
      ],
      "depends_on": [
        "TASK-CLIP-EXTENSION",
        "TASK-CLIP-SERVER"
      ],
      "changes": [
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "action": "create"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "action": "modify"
        },
        {
          "path": ".github/workflows/quality.yml",
          "action": "modify"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CLIP-LIVE",
        "EV-CLIP-RED-LIVE",
        "EV-CLIP-RED-UNIT"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CLIP-DOCS",
      "purpose": "Document the tool, the isolation, its limits and its security model; count 53 tools everywhere",
      "acceptance": [
        "AC-CLIP-TOOL"
      ],
      "depends_on": [
        "TASK-CLIP-LIVE",
        "TASK-CLIP-UNIT"
      ],
      "changes": [
        {
          "path": "README.md",
          "action": "modify"
        },
        {
          "path": "docs/TOOLS.md",
          "action": "modify"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "action": "modify"
        },
        {
          "path": "docs/SECURITY.md",
          "action": "modify"
        },
        {
          "path": "CHANGELOG.md",
          "action": "modify"
        },
        {
          "path": "vscode/README.md",
          "action": "modify"
        },
        {
          "path": "PLAN.md",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CLIP-CTEST",
        "EV-CLIP-RED-CONTRACT"
      ],
      "blocker": null,
      "superseded_by": null
    }
  ],
  "evidence": [
    {
      "id": "EV-CLIP-READINESS-1",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-SERVERS",
        "AC-CLIP-SYSTEM",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE",
        "AC-CLIP-TOOL",
        "AC-CLIP-LIFETIME",
        "AC-CLIP-SITES"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements review against the plan, docs/QUALITY.md, docs/MULTI_SESSION.md, docs/SECURITY.md and the current source of background.js, browser_contract.cpp and browser_control.cpp; eight findings, each resolved in the plan before this receipt",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/readiness-review.md",
        "sha256": "c032d3121ee969507f64a3d967b5ae96bb89485556182f6416cec05f8cc3d7a3"
      },
      "red": null,
      "reason": "Task scope grew by enabling paths and docs/QUALITY.md (the rules file) took the 1.8.1 and 1.8.2 status updates; re-reviewed as EV-CLIP-READINESS-2",
      "scope_sha256": "1de02c23e38caaa89128d13ba0c4e95ee4f9c7a8764e4e3c95cc07f0644c3d64",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "75c4afdfcfe2e5bf5da7cb3594235d318c35fe87c2c0cf643c3401d818bf54be"
        }
      ]
    },
    {
      "id": "EV-CLIP-READINESS-2",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-SERVERS",
        "AC-CLIP-SYSTEM",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE",
        "AC-CLIP-TOOL",
        "AC-CLIP-LIFETIME",
        "AC-CLIP-SITES"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Re-review after the first readiness receipt went stale: the added enabling paths (argument pre-check, shared browser model, full-suite catalog entry, PLAN.md) and the rules file's 1.8.x status edits were checked against every requirement; no requirement or criterion changed meaning; recorded as an addendum to the review",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/readiness-review.md",
        "sha256": "5ce4ff96060d56d4ee47d385f6492ad58854e10b80d45abe71aaba4f223b7eca"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "348b4c1ca3e44930f32e7c2d584dc60cce32e16480cf6135f7e3dfb707eda1d8",
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
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        }
      ]
    },
    {
      "id": "EV-CLIP-UNIT-JS",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-LIFETIME"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "All ten JavaScript suites, including test_browser_extension_clipboard.mjs (7 tests driving the worker through real command frames against the browser model): chords answered and never sent as keys, per-agent isolation, the page command window, typed fallback, clearing on release, bounds; 199/199",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/windows-test-js.txt",
        "sha256": "e43a99873f81a18fe49dd204ad4fbac88ed5212c2ae0027fd0fbca8c0176f964"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "3293a2c4d0ee7e882ade65d770982db1a5321ff6b1ad08c8fb97836f786ed391",
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
          "path": ".github/workflows/quality.yml",
          "sha256": "59aa71bf4ed8c54adfabc6fff0b1f536afe42a443b4553f146dcafbd75a80288"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "00fc5192155df05abdaeaa809865fca111cb4c61ad35bb606275631c1c2a4acf"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "76a0cef02e26b5f995c65ad5e4cebfa86a3ede3cdf44acc6bc47d731b8636212"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "1475edd3394ec8812d01fb0597faa0f7908849e794495d1939bad9cd687352cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "83cb3b7fc1b0c21e4d6eb5f936e468321333f4aefdf8f0db81c028a195f17036"
        },
        {
          "path": "package.json",
          "sha256": "8ab1f10d329402d9b5d2b6674c0e21895325544a444e55a6dd3cd4b4c1f151bb"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "52909e87eebd669137686fe6aeff6d5bec8e8fa3ea3a583a52738e9ccfd16682"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "84c0f30448bca4812069cd8556740685a029839285ce720cc9e674cbc612abb5"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "2f17435071c5cf107d2e6cc96e5807d579023fc55f2198bac478959f98deeacc"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "47b8fff79aa7e7273ca0e79489be3baa9f59c1022d5832067043390e4bf21e9e"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0a235624ead5a7b3ef7d954a951ea6cca8342fd5ad19a07fa9d256bda31ff220"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "ea06a289b005dd1c5b8a50166c662693509dd1ec2c0d3d5826875374a43390e6"
        },
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "sha256": "d41fc1fb4a2b5c544c60ae03c76685a71f700629a203cecf888e750bab0e0538"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "9ae6070790f616b8b0d4b19cb9dcbe3111c372e8f6925b588e6d5344423c9173"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "405326d275b9bc650ab4a7f668d1f6c05af6fdc64b03da9960288496199380b0"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "4499481b4a1e57816912fb35da4ff4ad6c5ce77949f72763749b29aad13ea33e"
        },
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "sha256": "c1a8c3a815fc1bf2be46b17d4f590a2af688e40fdb8468923de9326f41914aa0"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "98f456c97360274ae885912c5724ad3613b00ad5963d99d1ddf76621e74f0b0f"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5745494e2bc66e36ccc4becab306105a3b992af974fcc18297550a7a2877d185"
        }
      ]
    },
    {
      "id": "EV-CLIP-CTEST",
      "acceptance": [
        "AC-CLIP-TOOL"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release"
      ],
      "method": "MSVC Release build, all 23 ctest suites: test_browser_contract (per-action argument rules, paths kept on the server, the 512 KiB bound, 47 browser tools, tab_id on the tool) and test_browser_mcp_server (53 tools, instructions); the built server separately smoked at 53 full and 14 read-only tools (windows-smoke.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/windows-ctest.txt",
        "sha256": "7c8ca7102f8f35bb84916f5601bafa12a1e86e5018d94a5d0af5ea333c6975d7"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "348b4c1ca3e44930f32e7c2d584dc60cce32e16480cf6135f7e3dfb707eda1d8",
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
          "path": ".github/workflows/quality.yml",
          "sha256": "59aa71bf4ed8c54adfabc6fff0b1f536afe42a443b4553f146dcafbd75a80288"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "1b9e84fb83d5510ff5bf8bf8b2fc0bda252b4fd519f5fc59585ebfb9b9879d6c"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "00fc5192155df05abdaeaa809865fca111cb4c61ad35bb606275631c1c2a4acf"
        },
        {
          "path": "PLAN.md",
          "sha256": "fcc60710f2ed97ac73b05cff13bb0a0fe1edbdb517702c4c9a43e9f52cb1a085"
        },
        {
          "path": "README.md",
          "sha256": "aaa7ac0729ab891e383b452c7b97eeb67e3865f28c536710ceb5916aee4fc593"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "a1087e82b585d2d81d9b85de70168b2bb80b561368e05b8a45117a5f30fb541b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "a29333dbca6afb32cba5aa8a177cb71eab981b723e8d45213c1a268c4dc7ca1e"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f25691e830eb0a100560868e125be66074f4ba6041b716455d33479f7019361"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "76a0cef02e26b5f995c65ad5e4cebfa86a3ede3cdf44acc6bc47d731b8636212"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "1475edd3394ec8812d01fb0597faa0f7908849e794495d1939bad9cd687352cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "83cb3b7fc1b0c21e4d6eb5f936e468321333f4aefdf8f0db81c028a195f17036"
        },
        {
          "path": "package.json",
          "sha256": "8ab1f10d329402d9b5d2b6674c0e21895325544a444e55a6dd3cd4b4c1f151bb"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "52909e87eebd669137686fe6aeff6d5bec8e8fa3ea3a583a52738e9ccfd16682"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "84c0f30448bca4812069cd8556740685a029839285ce720cc9e674cbc612abb5"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "2f17435071c5cf107d2e6cc96e5807d579023fc55f2198bac478959f98deeacc"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "47b8fff79aa7e7273ca0e79489be3baa9f59c1022d5832067043390e4bf21e9e"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0a235624ead5a7b3ef7d954a951ea6cca8342fd5ad19a07fa9d256bda31ff220"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "ea06a289b005dd1c5b8a50166c662693509dd1ec2c0d3d5826875374a43390e6"
        },
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "sha256": "d41fc1fb4a2b5c544c60ae03c76685a71f700629a203cecf888e750bab0e0538"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "9ae6070790f616b8b0d4b19cb9dcbe3111c372e8f6925b588e6d5344423c9173"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "405326d275b9bc650ab4a7f668d1f6c05af6fdc64b03da9960288496199380b0"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "4499481b4a1e57816912fb35da4ff4ad6c5ce77949f72763749b29aad13ea33e"
        },
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "sha256": "c1a8c3a815fc1bf2be46b17d4f590a2af688e40fdb8468923de9326f41914aa0"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "98f456c97360274ae885912c5724ad3613b00ad5963d99d1ddf76621e74f0b0f"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5745494e2bc66e36ccc4becab306105a3b992af974fcc18297550a7a2877d185"
        },
        {
          "path": "vscode/README.md",
          "sha256": "7896d9724aaeb3a6b4b47a3db8ae27eb2902d273c0604e3b57d74d7e7f1d2d8a"
        }
      ]
    },
    {
      "id": "EV-CLIP-LIVE",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-SERVERS",
        "AC-CLIP-SYSTEM",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE",
        "AC-CLIP-LIFETIME"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/clipboard_e2e.mjs"
      ],
      "method": "Live suite in headless Chrome for Testing 153 with two servers and three agents and a sentinel on the browser's own clipboard; 24/24; the same suite passed 33 consecutive further runs (clipboard-loop*.txt). One earlier run in the final pass stopped on a browser_click transport error, recorded in VERIFICATION.md as unexplained",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/live-clipboard_e2e.json",
        "sha256": "297506522c3c892dd1f7d77f05d85338506c2fc1d37af79050fd539c8815a66d"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "3293a2c4d0ee7e882ade65d770982db1a5321ff6b1ad08c8fb97836f786ed391",
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
          "path": ".github/workflows/quality.yml",
          "sha256": "59aa71bf4ed8c54adfabc6fff0b1f536afe42a443b4553f146dcafbd75a80288"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "00fc5192155df05abdaeaa809865fca111cb4c61ad35bb606275631c1c2a4acf"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "76a0cef02e26b5f995c65ad5e4cebfa86a3ede3cdf44acc6bc47d731b8636212"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "1475edd3394ec8812d01fb0597faa0f7908849e794495d1939bad9cd687352cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "83cb3b7fc1b0c21e4d6eb5f936e468321333f4aefdf8f0db81c028a195f17036"
        },
        {
          "path": "package.json",
          "sha256": "8ab1f10d329402d9b5d2b6674c0e21895325544a444e55a6dd3cd4b4c1f151bb"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "52909e87eebd669137686fe6aeff6d5bec8e8fa3ea3a583a52738e9ccfd16682"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "84c0f30448bca4812069cd8556740685a029839285ce720cc9e674cbc612abb5"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "2f17435071c5cf107d2e6cc96e5807d579023fc55f2198bac478959f98deeacc"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "47b8fff79aa7e7273ca0e79489be3baa9f59c1022d5832067043390e4bf21e9e"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0a235624ead5a7b3ef7d954a951ea6cca8342fd5ad19a07fa9d256bda31ff220"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "ea06a289b005dd1c5b8a50166c662693509dd1ec2c0d3d5826875374a43390e6"
        },
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "sha256": "d41fc1fb4a2b5c544c60ae03c76685a71f700629a203cecf888e750bab0e0538"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "9ae6070790f616b8b0d4b19cb9dcbe3111c372e8f6925b588e6d5344423c9173"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "405326d275b9bc650ab4a7f668d1f6c05af6fdc64b03da9960288496199380b0"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "4499481b4a1e57816912fb35da4ff4ad6c5ce77949f72763749b29aad13ea33e"
        },
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "sha256": "c1a8c3a815fc1bf2be46b17d4f590a2af688e40fdb8468923de9326f41914aa0"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "98f456c97360274ae885912c5724ad3613b00ad5963d99d1ddf76621e74f0b0f"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5745494e2bc66e36ccc4becab306105a3b992af974fcc18297550a7a2877d185"
        }
      ]
    },
    {
      "id": "EV-CLIP-RED-LIVE",
      "acceptance": [
        "AC-CLIP-SERVERS",
        "AC-CLIP-SYSTEM",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-RESTORE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "bash",
        "wsl_clip_drills.sh"
      ],
      "method": "Six mutations, each staged into the extension the dedicated browser loads, the live clipboard suite run against it, then the mirror re-synced: no stand-in for new documents, no stand-in at all, chords sent as keys, no command window, one clipboard per name across servers, no restore on handback; each failed its checks; the restored tree passed. Fingerprints are of the no-stand-in-at-all mutation",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/live-red-drills.txt",
        "sha256": "c01cb9d7e3052c526f984c87ecfc914ee72eaa2ed46b7a4db2a45b0d08c55114"
      },
      "red": {
        "mutation": "clipboardStandInScript() returns \"void 0\": no page stand-in is installed",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the user's clipboard still holds the sentinel",
        "observed_diagnostic": "FAIL after all of it, the user's clipboard still holds the sentinel -- exec-copied-text",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a6b77c39d30907ae965bb482e8c0ed2234af7d5a2b20dd3e4bdb6b2ed542b839"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "3293a2c4d0ee7e882ade65d770982db1a5321ff6b1ad08c8fb97836f786ed391",
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
          "path": ".github/workflows/quality.yml",
          "sha256": "59aa71bf4ed8c54adfabc6fff0b1f536afe42a443b4553f146dcafbd75a80288"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "00fc5192155df05abdaeaa809865fca111cb4c61ad35bb606275631c1c2a4acf"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "76a0cef02e26b5f995c65ad5e4cebfa86a3ede3cdf44acc6bc47d731b8636212"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "1475edd3394ec8812d01fb0597faa0f7908849e794495d1939bad9cd687352cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "83cb3b7fc1b0c21e4d6eb5f936e468321333f4aefdf8f0db81c028a195f17036"
        },
        {
          "path": "package.json",
          "sha256": "8ab1f10d329402d9b5d2b6674c0e21895325544a444e55a6dd3cd4b4c1f151bb"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "52909e87eebd669137686fe6aeff6d5bec8e8fa3ea3a583a52738e9ccfd16682"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "84c0f30448bca4812069cd8556740685a029839285ce720cc9e674cbc612abb5"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "2f17435071c5cf107d2e6cc96e5807d579023fc55f2198bac478959f98deeacc"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "47b8fff79aa7e7273ca0e79489be3baa9f59c1022d5832067043390e4bf21e9e"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0a235624ead5a7b3ef7d954a951ea6cca8342fd5ad19a07fa9d256bda31ff220"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "ea06a289b005dd1c5b8a50166c662693509dd1ec2c0d3d5826875374a43390e6"
        },
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "sha256": "d41fc1fb4a2b5c544c60ae03c76685a71f700629a203cecf888e750bab0e0538"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "9ae6070790f616b8b0d4b19cb9dcbe3111c372e8f6925b588e6d5344423c9173"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "405326d275b9bc650ab4a7f668d1f6c05af6fdc64b03da9960288496199380b0"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "4499481b4a1e57816912fb35da4ff4ad6c5ce77949f72763749b29aad13ea33e"
        },
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "sha256": "c1a8c3a815fc1bf2be46b17d4f590a2af688e40fdb8468923de9326f41914aa0"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "98f456c97360274ae885912c5724ad3613b00ad5963d99d1ddf76621e74f0b0f"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5745494e2bc66e36ccc4becab306105a3b992af974fcc18297550a7a2877d185"
        }
      ]
    },
    {
      "id": "EV-CLIP-RED-UNIT",
      "acceptance": [
        "AC-CLIP-AGENTS",
        "AC-CLIP-KEYS",
        "AC-CLIP-PASTE",
        "AC-CLIP-PAGEAPI",
        "AC-CLIP-LIFETIME"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "drill.mjs",
        "browser/extension/background.js",
        "tests/test_browser_extension_clipboard.mjs"
      ],
      "method": "Five unit drills on the final tree (chord interception, per-agent keying, the command window, clearing on release, Shift+Enter between typed lines), each failing its named test and restored byte for byte with a green rerun. Fingerprints are of the per-agent keying mutation",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/unit-red-drills.txt",
        "sha256": "a0c449af7add86a5dc66eb9a62006bd80a208d63861fa630d557e773abcfafe0"
      },
      "red": {
        "mutation": "every agent's clipboard stored under the empty key",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "each agent pastes its own clipboard, never another agent's",
        "observed_diagnostic": "each agent pastes its own clipboard, never another agent's",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "d8b0627252c90f88f999cda2f1e92f6a08896feb5a40cf354cd1f5caf454f022"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "3293a2c4d0ee7e882ade65d770982db1a5321ff6b1ad08c8fb97836f786ed391",
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
          "path": ".github/workflows/quality.yml",
          "sha256": "59aa71bf4ed8c54adfabc6fff0b1f536afe42a443b4553f146dcafbd75a80288"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "00fc5192155df05abdaeaa809865fca111cb4c61ad35bb606275631c1c2a4acf"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "76a0cef02e26b5f995c65ad5e4cebfa86a3ede3cdf44acc6bc47d731b8636212"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "1475edd3394ec8812d01fb0597faa0f7908849e794495d1939bad9cd687352cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "83cb3b7fc1b0c21e4d6eb5f936e468321333f4aefdf8f0db81c028a195f17036"
        },
        {
          "path": "package.json",
          "sha256": "8ab1f10d329402d9b5d2b6674c0e21895325544a444e55a6dd3cd4b4c1f151bb"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "52909e87eebd669137686fe6aeff6d5bec8e8fa3ea3a583a52738e9ccfd16682"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "84c0f30448bca4812069cd8556740685a029839285ce720cc9e674cbc612abb5"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "2f17435071c5cf107d2e6cc96e5807d579023fc55f2198bac478959f98deeacc"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "47b8fff79aa7e7273ca0e79489be3baa9f59c1022d5832067043390e4bf21e9e"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0a235624ead5a7b3ef7d954a951ea6cca8342fd5ad19a07fa9d256bda31ff220"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "ea06a289b005dd1c5b8a50166c662693509dd1ec2c0d3d5826875374a43390e6"
        },
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "sha256": "d41fc1fb4a2b5c544c60ae03c76685a71f700629a203cecf888e750bab0e0538"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "9ae6070790f616b8b0d4b19cb9dcbe3111c372e8f6925b588e6d5344423c9173"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "405326d275b9bc650ab4a7f668d1f6c05af6fdc64b03da9960288496199380b0"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "4499481b4a1e57816912fb35da4ff4ad6c5ce77949f72763749b29aad13ea33e"
        },
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "sha256": "c1a8c3a815fc1bf2be46b17d4f590a2af688e40fdb8468923de9326f41914aa0"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "98f456c97360274ae885912c5724ad3613b00ad5963d99d1ddf76621e74f0b0f"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5745494e2bc66e36ccc4becab306105a3b992af974fcc18297550a7a2877d185"
        }
      ]
    },
    {
      "id": "EV-CLIP-RED-CONTRACT",
      "acceptance": [
        "AC-CLIP-TOOL"
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
      "method": "applyToolExtras' browser_clipboard branch removed, test_browser_contract rebuilt and run: both clipboard contract tests failed; the file was restored byte for byte and the suite passed",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/contract-red-drill.txt",
        "sha256": "d11eb9706eba150923df2086c484b2df311b244471ed5fe14c1301f2dd393f98"
      },
      "red": {
        "mutation": "browser_clipboard's per-action argument checks removed from applyToolExtras",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_clipboardTakesOnlyWhatEachActionUses",
        "observed_diagnostic": "FAIL!  : BrowserContractTests::buildCommand_clipboardTakesOnlyWhatEachActionUses() '!unknown.ok' returned FALSE.",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "0acbb20d6bbd1979d3ff229300dae850aafb0310f1572d3ba49e288958fdaa94"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "348b4c1ca3e44930f32e7c2d584dc60cce32e16480cf6135f7e3dfb707eda1d8",
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
          "path": ".github/workflows/quality.yml",
          "sha256": "59aa71bf4ed8c54adfabc6fff0b1f536afe42a443b4553f146dcafbd75a80288"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "1b9e84fb83d5510ff5bf8bf8b2fc0bda252b4fd519f5fc59585ebfb9b9879d6c"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "00fc5192155df05abdaeaa809865fca111cb4c61ad35bb606275631c1c2a4acf"
        },
        {
          "path": "PLAN.md",
          "sha256": "fcc60710f2ed97ac73b05cff13bb0a0fe1edbdb517702c4c9a43e9f52cb1a085"
        },
        {
          "path": "README.md",
          "sha256": "aaa7ac0729ab891e383b452c7b97eeb67e3865f28c536710ceb5916aee4fc593"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "a1087e82b585d2d81d9b85de70168b2bb80b561368e05b8a45117a5f30fb541b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "a29333dbca6afb32cba5aa8a177cb71eab981b723e8d45213c1a268c4dc7ca1e"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f25691e830eb0a100560868e125be66074f4ba6041b716455d33479f7019361"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "76a0cef02e26b5f995c65ad5e4cebfa86a3ede3cdf44acc6bc47d731b8636212"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "1475edd3394ec8812d01fb0597faa0f7908849e794495d1939bad9cd687352cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_uploads.h",
          "sha256": "83cb3b7fc1b0c21e4d6eb5f936e468321333f4aefdf8f0db81c028a195f17036"
        },
        {
          "path": "package.json",
          "sha256": "8ab1f10d329402d9b5d2b6674c0e21895325544a444e55a6dd3cd4b4c1f151bb"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "52909e87eebd669137686fe6aeff6d5bec8e8fa3ea3a583a52738e9ccfd16682"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "84c0f30448bca4812069cd8556740685a029839285ce720cc9e674cbc612abb5"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "d91a9237faa7f064a68532ce88407a1296867d0a5b8513d1e330e62688cbe6a3"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "2f17435071c5cf107d2e6cc96e5807d579023fc55f2198bac478959f98deeacc"
        },
        {
          "path": "src/browser_uploads.cpp",
          "sha256": "47b8fff79aa7e7273ca0e79489be3baa9f59c1022d5832067043390e4bf21e9e"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0a235624ead5a7b3ef7d954a951ea6cca8342fd5ad19a07fa9d256bda31ff220"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "ea06a289b005dd1c5b8a50166c662693509dd1ec2c0d3d5826875374a43390e6"
        },
        {
          "path": "tests/e2e/clipboard_e2e.mjs",
          "sha256": "d41fc1fb4a2b5c544c60ae03c76685a71f700629a203cecf888e750bab0e0538"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "9ae6070790f616b8b0d4b19cb9dcbe3111c372e8f6925b588e6d5344423c9173"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "405326d275b9bc650ab4a7f668d1f6c05af6fdc64b03da9960288496199380b0"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "4499481b4a1e57816912fb35da4ff4ad6c5ce77949f72763749b29aad13ea33e"
        },
        {
          "path": "tests/test_browser_extension_clipboard.mjs",
          "sha256": "c1a8c3a815fc1bf2be46b17d4f590a2af688e40fdb8468923de9326f41914aa0"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "98f456c97360274ae885912c5724ad3613b00ad5963d99d1ddf76621e74f0b0f"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5745494e2bc66e36ccc4becab306105a3b992af974fcc18297550a7a2877d185"
        },
        {
          "path": "vscode/README.md",
          "sha256": "7896d9724aaeb3a6b4b47a3db8ae27eb2902d273c0604e3b57d74d7e7f1d2d8a"
        }
      ]
    },
    {
      "id": "EV-CLIP-SITES",
      "acceptance": [
        "AC-CLIP-SITES"
      ],
      "kind": "manual",
      "status": "pass",
      "command": [],
      "method": "Live run against public demos of ProseMirror, Lexical, Slate, Quill, Draft.js, CKEditor 5, CodeMirror 6 and a plain form field: paste by Control+V from the agent's clipboard, the marker read back from the page or field, then copied back with Control+C; all eight passed. TinyMCE could not be reached by ref and is recorded as not tried",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/clipboard/real-sites-summary.md",
        "sha256": "76ecdcc9d33b0ef841a039ef7e8522b77b4a71a9500020c06fbc6d5985e04c65"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ccc5dcd85195f59d9cdf854ed58b27d9eefb44a2e94cda19debb6fe448cb01ec",
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
          "path": "browser/extension/background.js",
          "sha256": "92f5c4b1d9494fee8fd48d69666d1af66b2398f57845af7d59d8ea82d3618201"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "6728b27a6fa4ab29cfe99ddfd808699b8a6ec1ff6ced9a3e112b1bf60d1cb18e"
        }
      ]
    }
  ],
  "checkpoint": null
}
```
