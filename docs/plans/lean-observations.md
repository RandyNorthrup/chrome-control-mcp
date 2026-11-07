# browser_find and lean observations

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them.

## Why

Agents spend their tokens finding elements, not acting on them. Action replies are 50 to 300
bytes, but a ref comes only from `browser_snapshot`, which takes no parameters and always renders
the whole page -- estimated at 100 to 140 KB on a page that reaches its 2,000-record cap, past the
50,000 characters at which Claude Code stops inlining a reply and saves it to a file. Agents on X
and YouTube Studio called a `browser_find` tool that does not exist about 300 times in one session
(`{"query":"Send message button"}`, `{"text":"View replies (1)"}`); Playwright MCP shipped a
`browser_find(text)` in July 2026 and Anthropic's browser toolset defines a `find` that returns up
to 20 refs in the snapshot's own line format, so models arrive expecting one. The research behind
this plan -- competing servers measured, papers on observation pruning, the MCP and model token
rules, and an audit of this server's own costs -- is
[research/browser-mcp-speed-and-token-efficiency.md](../research/browser-mcp-speed-and-token-efficiency.md).
This plan is its first wave: the observation tools. Action consequences, screenshot scale, form
filling and the latency items follow in later releases.

## Design

**`browser_find`.** A read-only tool that takes the same capture as `browser_snapshot` and returns
only the lines that match, each in the snapshot's exact line format with the same ref, so
`browser_click` works on a result with no snapshot in between. It takes `text` (a literal,
case-insensitive search of names and values) or `query` (the same words, where a role word such as
"button", "link" or "field" becomes a role filter, and a query of a role word alone lists that
role's elements), or `regex` (at most 200 characters, case-insensitive, refused when it does not
compile); optionally `role` and `max_results` (1 to 20, default 10). Matches rank exact name, then prefix, whole word, substring
and word overlap, with interactive and on-screen elements first. Each result line is followed by
the landmark, dialog or form it sits in. With no match, the reply names the three closest names on
the page and points to `browser_snapshot`. Matching is code, not a model: the same query on the
same page always gives the same answer. The capture and its refs are installed exactly as a
snapshot's are -- the tab's refs are replaced by this capture's, carried by node -- so a find and a
snapshot are interchangeable for every later call.

**Snapshot controls.** `browser_snapshot` takes optional `ref` (the subtree under one element),
`depth` (levels below the root), `filter` (`all`, the default; `interactive`, which keeps elements
with refs plus landmarks and headings; or `viewport`, which keeps what is on screen and counts the
rest), and `max_chars`. Landmarks, dialogs, forms, tables and lists gain refs, so a region can be
scoped. When an outline exceeds `max_chars`, it is not cut at the tail: everything on screen and
every landmark and heading line stays, and the largest off-screen regions collapse to one line
each -- `- region "Comments" [ref=e900] (312 lines omitted: browser_snapshot ref=e900, or
browser_find)`. Without positions (an older extension) the top of the page stays instead of the
viewport. With no `max_chars` the outline is whole, as today, up to the existing record cap. The
options apply in one order -- slimming, then `ref`, `depth`, `filter`, and last `max_chars` -- and a
scoped or filtered outline's header says how many lines it shows of how many.

**Slimmer by default.** Two rules that remove only repetition apply to every snapshot and find: a
text line whose words already appear in its parent's name is dropped (a link "Send message" no
longer carries a second line "Send message" under it), and indentation follows the lines actually
shown rather than the page's raw nesting, which reached 40 spaces. Unnamed wrappers that hold a
single shown line fold into it. The line format itself -- `- role "name" [ref=eN] (flags)` -- is
unchanged.

**Positions.** The extension adds the viewport (scroll offset and size) to each capture and marks
main-document elements wholly outside it, which `filter: "viewport"`, find's ordering and elision
use. Elements in subframes have no main-document position and count as on screen.

**`browser_read` in pages.** The reply keeps its JSON shape -- every live suite and any script
that reads it parses `content` -- and gains `offset`, `total` and, when there is more,
`next_offset`. `max_chars` (default 30,000, at most 200,000) and `offset` page through a long page;
the saving is the cap, not the escaping, which costs little on prose. `ref` or `selector` reads one element; `mode: "main"` reads the page's
main content (the longest of `main`, `[role=main]` and `article`, else the body). `format: "html"`
is capped the same way.

**A smaller, stable catalog.** The `tab_id` description, repeated in 35 schemas (19% of the
catalog), becomes one short clause; the instructions already explain tab ownership. The longest
descriptions lose repetition. A test holds the catalog under a byte budget and the instructions
under 4,096 characters (Claude Code's cut-off), and the instructions tell agents to try
`browser_find` before a full snapshot. Order and bytes stay identical from run to run, for prompt
caching.

**A meter.** A live suite drives the built server against the fixture pages and three public pages
and records bytes, lines, estimated tokens (bytes / 4) and time for `tools/list` in both profiles,
`browser_snapshot` (whole and each filter), `browser_find`, `browser_read` and
`browser_screenshot`. It runs before and after this work, so every size claim in the release is
measured.

## Non-goals and limits

- No model is involved anywhere: find is code; paraphrases it cannot match are covered by word
  overlap, the closest-names reply and the snapshot one call away.
- No default cap on `browser_snapshot` yet: `max_chars` is opt-in until the meter shows an
  elided outline loses nothing agents need.
- The extension's 2,000-record walk is unchanged; elision works within what is captured.
- Cross-origin frames stay unsearched, as they are unsnapshotted; replies say so.
- Screenshots, action replies, form filling and latency are the next releases' work.

## Compatibility

- Tools are only added: the full profile goes from 53 to 54 tools, the read-only profile from 14
  to 15. A client with an explicit tool allow-list sees `browser_find` once it is added there.
- An extension older than 1.12.0 sends no positions: find, scoping, slimming and elision work,
  `filter: "viewport"` says to reload the extension, and `browser_read` pages within the 200,000
  characters such an extension returns. Such an extension would ignore read's `ref`, `selector`
  and `mode` and return the whole page, so the server refuses them with a note to reload it.
- Refs, their tab binding, the session's single command slot, held-tab refusals and profile
  routing are the snapshot's, unchanged; several agents and several profiles see nothing new.

## Reuse

- `renderSnapshot`, its carried refs and its escaping produce every line find and the controls
  print; find is a view over the same rendering, not a second renderer.
- `fillSnapshotResult` installs a find's refs exactly as a snapshot's.
- `handleRead` keeps its evaluate-in-page read and omitted-frame report; scoping reuses the ref
  resolution every element command uses.
- `viewportState` already reads the scroll offset and viewport size the capture now carries.
- The meter runs under `isolated_run.mjs` like every live suite.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-LEAN",
    "title": "browser_find and lean observations",
    "scope_revision": 4,
    "brief": null,
    "brief_reason": "Scoped change in an existing product; README.md and docs/TOOLS.md carry the product context, and the research report this plan cites records why",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "81556cecb9c4"
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
        "wsl2-arch-node": "v26.13.0",
        "wsl2-arch-cmake": "4.4.5",
        "wsl2-arch-python": "3.12.16",
        "wsl2-arch-semgrep": "1.174.0"
      }
    }
  },
  "requirements": [
    {
      "id": "REQ-LEAN-FIND",
      "statement": "browser_find locates elements by visible text, name, role or pattern and returns, in the snapshot's line format, refs that every element tool accepts with no snapshot in between",
      "priority": "critical",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-LEAN-SNAPSHOT",
      "statement": "browser_snapshot can be scoped to a ref, a depth, interactive elements or the viewport and capped by characters without a blind cut, and every outline drops repeated text and raw-nesting indentation while keeping its line format and refs",
      "priority": "critical",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-LEAN-READ",
      "statement": "browser_read is capped with offset continuation and scoped to an element or the main content on request, in its existing JSON reply",
      "priority": "normal",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-LEAN-CATALOG",
      "statement": "The tool catalog and instructions are smaller, byte-stable across runs, within a tested budget, and point agents to browser_find",
      "priority": "normal",
      "acceptance": [
        "AC-LEAN-CATALOG"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-LEAN-COMPAT",
      "statement": "Nothing that worked before regresses: an older extension, single- and multi-profile users, several agents, every MCP client and every existing suite",
      "priority": "critical",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-LEAN-FIND-MATCH",
      "requirement": "REQ-LEAN-FIND",
      "given": "The /find fixture page: a Messages dialog with a Send message button, a View replies (1) link, a Write your reply field, landmarks, and a long list whose Load more button is below the fold",
      "when": "browser_find runs with text \"Send message\", then with text \"View replies (1)\", then browser_click acts on the returned ref with no snapshot in between",
      "then": "each reply opens with the match count and lists the matching lines in the snapshot's exact format with the same refs a snapshot of the same page issues, the exact match first, each followed by its dialog or landmark; the click reaches the button; a ref from before a navigation is refused as a snapshot's is",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-FIND-QUERY",
      "requirement": "REQ-LEAN-FIND",
      "given": "The same page",
      "when": "browser_find runs with query \"Send message button\", with role \"link\" and text \"replies\", with regex \"^Load\", with max_results 2 over many matches, with text that matches nothing, with no text, query or regex, and with an invalid regex",
      "then": "the role word becomes a role filter and the button ranks first; role and regex select as asked; at most 2 lines show and the count says how many there were; no match names the three closest names and browser_snapshot; the last two are refused naming the accepted parameters or the pattern error; on-screen and interactive elements rank above equal off-screen ones",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-SNAP-SCOPE",
      "requirement": "REQ-LEAN-SNAPSHOT",
      "given": "The /find fixture page",
      "when": "browser_snapshot runs with ref naming the dialog, with depth 1, with filter interactive, with filter viewport, and with a ref that is no longer on the page",
      "then": "the dialog's subtree alone, the top level alone, only ref'd elements plus landmarks and headings, and only on-screen lines with a count of the rest are shown, every ref equal to the whole snapshot's; landmarks, dialogs, forms, tables and lists carry refs; the missing ref is refused with what to do",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-SNAP-SLIM",
      "requirement": "REQ-LEAN-SNAPSHOT",
      "given": "Captures with a link whose text child repeats its name, a chain of unnamed wrappers, and deep raw nesting; and the fixture and public pages",
      "when": "a whole snapshot is rendered",
      "then": "the repeated text line is gone, the wrappers fold into their one shown child, indentation is one step per shown ancestor, every other line and every ref are as before, and the meter records the bytes before and after on each page",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-SNAP-ELIDE",
      "requirement": "REQ-LEAN-SNAPSHOT",
      "given": "A page whose outline is far over a small max_chars",
      "when": "browser_snapshot runs with that max_chars",
      "then": "the outline fits, keeps every on-screen line and every landmark and heading line, replaces the largest off-screen regions with one stub line each naming its ref, the lines omitted and how to reach them, and ends with a line naming the remedies; nothing is cut mid-region",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-READ",
      "requirement": "REQ-LEAN-READ",
      "given": "The fixture page with a long article",
      "when": "browser_read runs with defaults, with max_chars and offset, with ref, with selector, with mode main, with format html, and with an offset past the end",
      "then": "the reply is the existing JSON with offset, total and next_offset; the default shows at most 30,000 characters and names the next offset; each page continues where the last stopped; ref and selector read only that element, main only the main content; html is capped the same way; the past-the-end offset is refused naming the total",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-CATALOG",
      "requirement": "REQ-LEAN-CATALOG",
      "given": "The built server in the full and read-only profiles",
      "when": "tools/list and initialize are read twice, in separate processes",
      "then": "both runs are byte-identical; the full catalog is within its budget and smaller than 1.11.1's 44,965 bytes, the tab_id description is one clause, the instructions are at most 4,096 characters and name browser_find; the profiles list 54 and 15 tools",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-LEAN-COMPAT",
      "requirement": "REQ-LEAN-COMPAT",
      "given": "The 1.12.0 build; an extension reporting 1.11.1; every suite that existed before this work",
      "when": "find, the snapshot controls and read run against the older extension, and every existing unit and live suite runs against the new build",
      "then": "against the older extension find, scoping, slimming and elision work, filter viewport and read's ref, selector and mode are refused saying to reload the extension, and read pages within what that extension returns; every existing suite passes",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    }
  ],
  "tasks": [
    {
      "id": "TASK-LEAN-METER",
      "purpose": "A live suite that records bytes, lines, estimated tokens and time for tools/list in both profiles and for snapshot, find, read and screenshot on the fixture and public pages, run on 1.11.1 before any change and on the new build after",
      "acceptance": [
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-CATALOG"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "action": "create"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-LEAN-METER-2",
        "EV-LEAN-RED-SLIM-2",
        "EV-LEAN-RED-CATALOG-2",
        "EV-LEAN-RED-LIVE-REPEATS-2"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-LEAN-SERVER",
      "purpose": "The rendering options (scope, depth, filters, slimming, container refs, elision), the find matcher and its reply, find's arguments and refs in the session, read's text reply and paging, the catalog and instructions, and their unit tests",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "action": "modify"
        },
        {
          "path": "src/browser_contract.cpp",
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
          "path": "src/mcp_dispatch.cpp",
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
        },
        {
          "path": "tests/test_browser_views.cpp",
          "action": "create"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "action": "modify"
        },
        {
          "path": "CMakeLists.txt",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-LEAN-CTEST-2",
        "EV-LEAN-LINUX-2",
        "EV-LEAN-SMOKE-2",
        "EV-LEAN-RED-FIND-ORDER-2",
        "EV-LEAN-RED-FIND-ROLE-2",
        "EV-LEAN-RED-OUTLINE-REF-2",
        "EV-LEAN-RED-SLIM-2",
        "EV-LEAN-RED-ELIDE-2",
        "EV-LEAN-RED-READ-OFFSET-2",
        "EV-LEAN-RED-CATALOG-2",
        "EV-LEAN-RED-COMPAT-2"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-LEAN-EXTENSION",
      "purpose": "The viewport and off-screen marks in each capture, and read's offset, cap, element and main-content scoping in the page",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-READ",
        "AC-LEAN-COMPAT"
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
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-LEAN-UNIT-JS-2",
        "EV-LEAN-RED-EXT-WINDOW-2",
        "EV-LEAN-RED-EXT-PAGE-2",
        "EV-LEAN-RED-EXT-OFFSCREEN-2",
        "EV-LEAN-RED-COMPAT-2"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-LEAN-LIVE",
      "purpose": "The /find fixture page and live cases for find, the snapshot controls and read",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "depends_on": [
        "TASK-LEAN-METER",
        "TASK-LEAN-SERVER",
        "TASK-LEAN-EXTENSION"
      ],
      "changes": [
        {
          "path": "tests/e2e/fixture_server.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-LEAN-LIVE-2",
        "EV-LEAN-LIVE-REGRESSION-2",
        "EV-LEAN-COMPAT-EXT-2",
        "EV-LEAN-METER-2",
        "EV-LEAN-RED-LIVE-REPEATS-2",
        "EV-LEAN-RED-FIND-ROLE-2",
        "EV-LEAN-RED-OUTLINE-REF-2",
        "EV-LEAN-RED-ELIDE-2",
        "EV-LEAN-RED-READ-OFFSET-2",
        "EV-LEAN-RED-CATALOG-2",
        "EV-LEAN-RED-COMPAT-2"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-LEAN-DOCS",
      "purpose": "Version 1.12.0, the tool reference, architecture, quality counts, README, changelog, release page, plan index and the research report",
      "acceptance": [
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "depends_on": [
        "TASK-LEAN-METER",
        "TASK-LEAN-SERVER",
        "TASK-LEAN-EXTENSION",
        "TASK-LEAN-LIVE"
      ],
      "changes": [
        {
          "path": "CMakeLists.txt",
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
          "path": "browser/extension/manifest.json",
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
          "path": "docs/TOOLS.md",
          "action": "modify"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "action": "modify"
        },
        {
          "path": "docs/QUALITY.md",
          "action": "modify"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "action": "create"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "action": "create"
        },
        {
          "path": "docs/SECURITY.md",
          "action": "modify"
        },
        {
          "path": "vscode/README.md",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-LEAN-SMOKE-2",
        "EV-LEAN-CTEST-2",
        "EV-LEAN-RED-CATALOG-2",
        "EV-LEAN-RED-COMPAT-2"
      ],
      "blocker": null,
      "superseded_by": null
    }
  ],
  "evidence": [
    {
      "id": "EV-LEAN-READINESS-1",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the plan, the rules file, the research report and the snapshot, find-adjacent, read, catalog and extension capture source: twelve findings, five of which (role-word-only queries, the regex bound, the options' order, elision without positions, an older extension ignoring read's scoping) amended the plan before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/lean/readiness-review.md",
        "sha256": "d407227e19a683fc5b4c4f56a2cd008dc5bd9e5cb2745ed62b5e094b453cc150"
      },
      "red": null,
      "reason": "Superseded by the addendum: browser_read keeps its JSON reply (scope revision 2)",
      "scope_sha256": "3349abcc0ad97d3968614bc2e075b87f597070d0997bd58597e2b0c3c94b577d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "14a7a68aae6f5943ceb9f81661b15db9161f429660cdb0028f7704793c4603f7"
        }
      ]
    },
    {
      "id": "EV-LEAN-READINESS-2",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review for scope revision 2 (browser_read keeps its JSON reply; recorded as an addendum to readiness-review.md) on top of the first review: requirements reviewed against the plan, the rules file, the research report and the snapshot, find-adjacent, read, catalog and extension capture source: twelve findings, five of which (role-word-only queries, the regex bound, the options' order, elision without positions, an older extension ignoring read's scoping) amended the plan before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/lean/readiness-review.md",
        "sha256": "bf07cb04c178ba88648452510e964b4fa85c6d3d45fb96fb6d5d1ea5186e269b"
      },
      "red": null,
      "reason": "Superseded by the addendum: the meter is its own task (scope revision 3)",
      "scope_sha256": "d049783b444fa138375a2774a1ba96078f06255fce42606cbe97c424ec1c7730",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "14a7a68aae6f5943ceb9f81661b15db9161f429660cdb0028f7704793c4603f7"
        }
      ]
    },
    {
      "id": "EV-LEAN-READINESS-3",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review for scope revision 3 (the meter is its own task, run on 1.11.1 first; browser_read keeps its JSON reply; both recorded as addenda to readiness-review.md) on top of the first review: requirements reviewed against the plan, the rules file, the research report and the snapshot, find-adjacent, read, catalog and extension capture source: twelve findings, five of which (role-word-only queries, the regex bound, the options' order, elision without positions, an older extension ignoring read's scoping) amended the plan before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/lean/readiness-review.md",
        "sha256": "e9144221ad328e1c81ce2f296963cfab89746f418170adfa59b9b6612b3abad9"
      },
      "red": null,
      "reason": "Superseded by the addendum: the paths the work touched (scope revision 4)",
      "scope_sha256": "537a570c93915f8207c479a602137bdb7921959158bc6752e7c5a9cb29996120",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "14a7a68aae6f5943ceb9f81661b15db9161f429660cdb0028f7704793c4603f7"
        }
      ]
    },
    {
      "id": "EV-LEAN-READINESS-4",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review for scope revision 4 (the change lists brought to every path touched, and the two live findings recorded; the meter as its own task and browser_read keeping its JSON reply before that; all recorded as addenda to readiness-review.md) on top of the first review: requirements reviewed against the plan, the rules file, the research report and the snapshot, find-adjacent, read, catalog and extension capture source: twelve findings, five of which (role-word-only queries, the regex bound, the options' order, elision without positions, an older extension ignoring read's scoping) amended the plan before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/lean/readiness-review.md",
        "sha256": "458fdfcf79acb503097ff6f7c7dc2420897d8fd9d4d269c706ccefa817a28d7c"
      },
      "red": null,
      "reason": "Superseded: the rules file's counts changed (revision 81556cecb9c4)",
      "scope_sha256": "7386fb1c57aaf0c7887c428f873b722a23584e7ce04b4322aa2fe786b7a0e953",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        }
      ]
    },
    {
      "id": "EV-LEAN-READINESS-5",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Re-review for scope revision 4 and rules revision 81556cecb9c4 (the rules file counting the new suite and the meter; the change lists brought to every path touched, and the two live findings recorded; the meter as its own task and browser_read keeping its JSON reply before that; all recorded as addenda to readiness-review.md) on top of the first review: requirements reviewed against the plan, the rules file, the research report and the snapshot, find-adjacent, read, catalog and extension capture source: twelve findings, five of which (role-word-only queries, the regex bound, the options' order, elision without positions, an older extension ignoring read's scoping) amended the plan before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/lean/readiness-review.md",
        "sha256": "eae09113ae8009b9d1b26331a9db214071851780257944ea1b3f46bc9832d259"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        }
      ]
    },
    {
      "id": "EV-LEAN-COMPAT-EXT",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--extension=ext1111/chrome-control-mcp-v1.11.1-linux-x64/extension",
        "tests/e2e/meter_e2e.mjs"
      ],
      "method": "The meter with the released 1.11.1 extension loaded: find, the slimmed snapshot (the same sizes as with the new extension), the interactive filter, the cap and read all answer, read paged by the server; filter viewport is refused saying to reload the extension (refused_for_older_extension)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/meter-extension-1.11.1.json",
        "sha256": "edd6b9ca7448352700f9d2cdf2c11c374b48add9fb4c4ae9e14ef354200c2e72"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-CTEST",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "--output-on-failure"
      ],
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.12.0 tree: all 27 suites pass, among them test_browser_views (slimming, the snapshot's options and elision, find's ranking, role words, patterns, context and closest names, read paging and its refusals, and find, options and read through the session) and test_browser_mcp_server (54 and 15 tools, the catalog within its 43,500-byte budget and byte-identical across listings, instructions under 4,096 characters naming browser_find)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/windows-ctest.txt",
        "sha256": "1c5edee695fb8d6cdaca82a66f324bad717188cfb595a1d9bcce27934db7babd"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-LINUX",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "bash",
        "/tmp/wsl_lean_evidence.sh",
        "docs/plans/evidence/lean/"
      ],
      "method": "WSL Arch (GCC 16.2.1, Qt 6.12.0): build with no warnings, ctest 26/26, clang-tidy 23.1.4 and exhaustive cppcheck 2.22.0 clean, Semgrep 0 findings; the summary also carries every live suite's result",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/linux-summary.txt",
        "sha256": "7cf56bb0e879768d385f6539bfafc1f509dfaccac866b90b2174259c50e78e99"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-LIVE-REGRESSION",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "bash",
        "/tmp/wsl_lean_evidence.sh",
        "docs/plans/evidence/lean/",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.12.0 build: display matrix, full browser, user interference 10/10, multi-agent 25/25, per-agent clipboard 24/24, large upload 7/7, extension version current 6/6, older 12/12 and the released 1.11.1 extension 12/12, two profiles 14/14, the profiles upgrade 4/4 (the closed-history rule: earlier plans are not re-stamped)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/linux-summary.txt",
        "sha256": "7cf56bb0e879768d385f6539bfafc1f509dfaccac866b90b2174259c50e78e99"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-LIVE",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/full_browser_e2e.mjs"
      ],
      "method": "Chrome for Testing 153, the full suite with the /find page: find by text (exact match first, its dialog named, a click on its ref with no snapshot between reaching the button), by a name with brackets, by a phrase whose role word filters, by pattern below the fold (marked off-screen), with no match (closest names), refusals for no text and a broken pattern; a region by ref with the page's refs, the interactive and viewport filters, a 1,500-character cap that collapses regions and keeps the footer; reads in two pages that add up to the total, by selector, main content and ref, refusals past the end and for a selector that matches nothing; a find ref refused after a navigation; 49 tools, 202 cases",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/live-full-browser.json",
        "sha256": "b2f40c83980c2a5b14aad5017a9a98be5238bb2d0648e085880b6fe1f6e68e9e"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-METER",
      "acceptance": [
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-CATALOG"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/meter_e2e.mjs"
      ],
      "method": "The meter on the 1.12.0 build against meter-baseline.json (the same suite on the 1.11.1 build): catalog 42,951 bytes for 54 tools from 44,965 for 53, byte-identical across processes; whole snapshots Wikipedia 113,134 to about 38 KB, Hacker News 70,800 to about 18 KB, GitHub 137,582 to about 48 KB; find about 1.3 KB on Wikipedia",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/meter-after.json",
        "sha256": "1ebf05656e443616efe9de501d6d3d38ed57c929992afb95ff3280385ff858e8"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-SMOKE",
      "acceptance": [
        "AC-LEAN-CATALOG"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test in both profiles: 54 tools in full and 15 read-only, pinned",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/windows-smoke.txt",
        "sha256": "57f9db5af1866f24b1910c925e1656231f6c3a12b120b3ae122741efc5da2918"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-UNIT-JS",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-READ",
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 13 JavaScript suites, 231 tests: the extension's off-screen marks (main document only, a pinch's rect), read's scope and window, and the page read function rebuilt from its own source and run on a fake document; every earlier extension test unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/windows-test-js.txt",
        "sha256": "0719e2836e819e337c1084bb867da095d131f40bd006b81a9e3a0ee080829485"
      },
      "red": null,
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-CATALOG",
      "acceptance": [
        "AC-LEAN-CATALOG"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_contract"
      ],
      "method": "Drill (catalog-tab-id): the tab_id description is the long one again, in every tab-scoped schema. Planted, the suite failed in catalog_tabIdOnExactlyTheTabScopedTools; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "the tab_id description is the long one again, in every tab-scoped schema",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "catalog_tabIdOnExactlyTheTabScopedTools",
        "observed_diagnostic": "catalog_tabIdOnExactlyTheTabScopedTools",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "09c0c27d28767ff09f2bb23df0287d7824f6d9796b62a038dea4c29540402ffd"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-COMPAT",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (compat-scoped-read): a scoped read an older extension answered with the whole page is passed on. Planted, the suite failed in read_refusesAScopedReadAnOlderExtensionIgnored; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "a scoped read an older extension answered with the whole page is passed on",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "read_refusesAScopedReadAnOlderExtensionIgnored",
        "observed_diagnostic": "read_refusesAScopedReadAnOlderExtensionIgnored",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "30e68fc9d8424df54c9e50319b102864384d0868f18b730b9d06fbba67e14ae9"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-ELIDE",
      "acceptance": [
        "AC-LEAN-SNAP-ELIDE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (elide-collapse): the cap collapses no region and cuts the outline at the tail. Planted, the suite failed in outline_elidesRegionsNotTheTail; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "the cap collapses no region and cuts the outline at the tail",
        "baseline_exit": 0,
        "mutated_exit": 2,
        "restored_exit": 0,
        "expected_diagnostic": "outline_elidesRegionsNotTheTail",
        "observed_diagnostic": "outline_elidesRegionsNotTheTail",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "b99be6927a89290a09fe4028a022f02ae98bee024ba822c8b6bea0e5bda96b6b"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-EXT-OFFSCREEN",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "--test-reporter=tap",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (offscreen-below): elements below the viewport are not marked off-screen. Planted, the suite failed in only main-document records wholly outside the visible rect are marked off-screen; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/extension-red-drills.txt",
        "sha256": "993bc0ea7acb46bcba6c8519895b5106623bdc4f9aa3d94b6ae3f21a6bc3da5f"
      },
      "red": {
        "mutation": "elements below the viewport are not marked off-screen",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "only main-document records wholly outside the visible rect are marked off-screen",
        "observed_diagnostic": "only main-document records wholly outside the visible rect are marked off-screen",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "c4f61444394f41abe9056c2383842492c71b7dff5ec8fe5083e6c079777b8159"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-EXT-PAGE",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "--test-reporter=tap",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (page-read-slice): the page read returns the first window whatever the offset. Planted, the suite failed in the page read returns the window asked for and the whole text's length; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/extension-red-drills.txt",
        "sha256": "993bc0ea7acb46bcba6c8519895b5106623bdc4f9aa3d94b6ae3f21a6bc3da5f"
      },
      "red": {
        "mutation": "the page read returns the first window whatever the offset",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the page read returns the window asked for and the whole text's length",
        "observed_diagnostic": "the page read returns the window asked for and the whole text's length",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a50a670dc5749f5bd832a9f02028628c18cfa66980674c9e63e0998376d5eac3"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-EXT-WINDOW",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "--test-reporter=tap",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (read-window): the extension reads from the start whatever the offset. Planted, the suite failed in a read's scope and window come from its arguments, bounded; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/extension-red-drills.txt",
        "sha256": "993bc0ea7acb46bcba6c8519895b5106623bdc4f9aa3d94b6ae3f21a6bc3da5f"
      },
      "red": {
        "mutation": "the extension reads from the start whatever the offset",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a read's scope and window come from its arguments, bounded",
        "observed_diagnostic": "a read's scope and window come from its arguments, bounded",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2af6fccc15e444400b81dd779356be2bcb8ffbfba8a257084bddd3b600e6cca6"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-FIND-ORDER",
      "acceptance": [
        "AC-LEAN-FIND-MATCH"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (find-order): find lists its matches worst first. Planted, the suite failed in find_exactMatchFirstWithItsContainers; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "find lists its matches worst first",
        "baseline_exit": 0,
        "mutated_exit": 2,
        "restored_exit": 0,
        "expected_diagnostic": "find_exactMatchFirstWithItsContainers",
        "observed_diagnostic": "find_exactMatchFirstWithItsContainers",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c8600690ae9fa55f9ce606cffe83987c9f088dac2b7b34f32b682b9708341024"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-FIND-ROLE",
      "acceptance": [
        "AC-LEAN-FIND-QUERY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (find-role-words): a phrase's role words are read as plain words. Planted, the suite failed in find_queryRoleWordFiltersByRole; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "a phrase's role words are read as plain words",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "find_queryRoleWordFiltersByRole",
        "observed_diagnostic": "find_queryRoleWordFiltersByRole",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "335c83ff3539978ebc65b83a5905db468bb2d250fc578e02bcb1eda310161494"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-OUTLINE-REF",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (outline-ref): a snapshot by ref shows the whole page. Planted, the suite failed in outline_refShowsOneSubtreeWithTheSameRefs; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "a snapshot by ref shows the whole page",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "outline_refShowsOneSubtreeWithTheSameRefs",
        "observed_diagnostic": "outline_refShowsOneSubtreeWithTheSameRefs",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "e60b079e19d27f85c3d6813fced674bf7e01ea106021dbf3af5e7e474bda4787"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-READ-OFFSET",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (read-offset): an older extension's reply is paged from its start whatever the offset. Planted, the suite failed in read_pagesAnOlderExtensionsWholeReply; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "an older extension's reply is paged from its start whatever the offset",
        "baseline_exit": 0,
        "mutated_exit": 2,
        "restored_exit": 0,
        "expected_diagnostic": "read_pagesAnOlderExtensionsWholeReply",
        "observed_diagnostic": "read_pagesAnOlderExtensionsWholeReply",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "74f4be448b64b398857b2f335c3505fc9b97e191cb8eec961c148ad9ffd60826"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-SLIM",
      "acceptance": [
        "AC-LEAN-SNAP-SLIM"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (slim-repeats): text that repeats its parent's name is kept. Planted, the suite failed in slim_dropsTextThatRepeatsItsParent; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "4844184e8f71f5db441acd79b01fcd122b04d6a8c9e89c5b48783d9edc13aacf"
      },
      "red": {
        "mutation": "text that repeats its parent's name is kept",
        "baseline_exit": 0,
        "mutated_exit": 4,
        "restored_exit": 0,
        "expected_diagnostic": "slim_dropsTextThatRepeatsItsParent",
        "observed_diagnostic": "slim_dropsTextThatRepeatsItsParent",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8c98cb0dc07908bddc0710994fdd75de69086056668db52ebf300242f32043e3"
          }
        ]
      },
      "reason": "Superseded: tests/e2e/full_browser_e2e.mjs changed after this was recorded -- its baseline now waits out the harness's Developer-mode tab, which one run in eight took for the user's tab -- so every check ran again for the fresh set",
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "54a27bc5e43ef2ff6383010a99dbc0daa0443c6356199de9a5b7bd4c2391d795"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-COMPAT-EXT-2",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--extension=ext1111/chrome-control-mcp-v1.11.1-linux-x64/extension",
        "tests/e2e/meter_e2e.mjs"
      ],
      "method": "The meter with the released 1.11.1 extension loaded: find, the slimmed snapshot (the same sizes as with the new extension), the interactive filter, the cap and read all answer, read paged by the server; filter viewport is refused saying to reload the extension (refused_for_older_extension)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/meter-extension-1.11.1.json",
        "sha256": "50cdb2363542681affc0cfc9f773276a6b464d038592bd962af114be3357d958"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-CTEST-2",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
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
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.12.0 tree: all 27 suites pass, among them test_browser_views (slimming, the snapshot's options and elision, find's ranking, role words, patterns, context and closest names, read paging and its refusals, and find, options and read through the session) and test_browser_mcp_server (54 and 15 tools, the catalog within its 43,500-byte budget and byte-identical across listings, instructions under 4,096 characters naming browser_find)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/windows-ctest.txt",
        "sha256": "c6690a55ef4fd61aa5b7be8672266c54523f72a882fad150456e7f73b9227eb7"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-LINUX-2",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ",
        "AC-LEAN-CATALOG",
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "bash",
        "/tmp/wsl_lean_evidence.sh",
        "docs/plans/evidence/lean/"
      ],
      "method": "WSL Arch (GCC 16.2.1, Qt 6.12.0): build with no warnings, ctest 26/26, clang-tidy 23.1.4 and exhaustive cppcheck 2.22.0 clean, Semgrep 0 findings; the summary also carries every live suite's result",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/linux-summary.txt",
        "sha256": "7cf56bb0e879768d385f6539bfafc1f509dfaccac866b90b2174259c50e78e99"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-LIVE-2",
      "acceptance": [
        "AC-LEAN-FIND-MATCH",
        "AC-LEAN-FIND-QUERY",
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-SNAP-ELIDE",
        "AC-LEAN-READ"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/full_browser_e2e.mjs"
      ],
      "method": "Chrome for Testing 153, the full suite with the /find page: find by text (exact match first, its dialog named, a click on its ref with no snapshot between reaching the button), by a name with brackets, by a phrase whose role word filters, by pattern below the fold (marked off-screen), with no match (closest names), refusals for no text and a broken pattern; a region by ref with the page's refs, the interactive and viewport filters, a 1,500-character cap that collapses regions and keeps the footer; reads in two pages that add up to the total, by selector, main content and ref, refusals past the end and for a selector that matches nothing; a find ref refused after a navigation; 49 tools, 202 cases",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/live-full-browser.json",
        "sha256": "a43c61ad5e678fc3b28aa2052efa5b513eccc0509cee317d1435a1590d2f82a3"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-LIVE-REGRESSION-2",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "bash",
        "/tmp/wsl_lean_evidence.sh",
        "docs/plans/evidence/lean/",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.12.0 build: display matrix, full browser, user interference 10/10, multi-agent 25/25, per-agent clipboard 24/24, large upload 7/7, extension version current 6/6, older 12/12 and the released 1.11.1 extension 12/12, two profiles 14/14, the profiles upgrade 4/4 (the closed-history rule: earlier plans are not re-stamped)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/linux-summary.txt",
        "sha256": "7cf56bb0e879768d385f6539bfafc1f509dfaccac866b90b2174259c50e78e99"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-METER-2",
      "acceptance": [
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-CATALOG"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/meter_e2e.mjs"
      ],
      "method": "The meter on the 1.12.0 build against meter-baseline.json (the same suite on the 1.11.1 build): catalog 42,951 bytes for 54 tools from 44,965 for 53, byte-identical across processes; whole snapshots Wikipedia 113,134 to about 38 KB, Hacker News 70,800 to about 18 KB, GitHub 137,582 to about 48 KB; find about 1.3 KB on Wikipedia",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/meter-after.json",
        "sha256": "4e6e22055b8aa5ff10bcf1836677b66e062fd29ea63e6aca19fa4f891fd96c9a"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-CATALOG-2",
      "acceptance": [
        "AC-LEAN-CATALOG"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_contract"
      ],
      "method": "Drill (catalog-tab-id): the tab_id description is the long one again, in every tab-scoped schema. Planted, the suite failed in catalog_tabIdOnExactlyTheTabScopedTools; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "the tab_id description is the long one again, in every tab-scoped schema",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "catalog_tabIdOnExactlyTheTabScopedTools",
        "observed_diagnostic": "catalog_tabIdOnExactlyTheTabScopedTools",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "09c0c27d28767ff09f2bb23df0287d7824f6d9796b62a038dea4c29540402ffd"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-COMPAT-2",
      "acceptance": [
        "AC-LEAN-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (compat-scoped-read): a scoped read an older extension answered with the whole page is passed on. Planted, the suite failed in read_refusesAScopedReadAnOlderExtensionIgnored; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "a scoped read an older extension answered with the whole page is passed on",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "read_refusesAScopedReadAnOlderExtensionIgnored",
        "observed_diagnostic": "read_refusesAScopedReadAnOlderExtensionIgnored",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "30e68fc9d8424df54c9e50319b102864384d0868f18b730b9d06fbba67e14ae9"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-ELIDE-2",
      "acceptance": [
        "AC-LEAN-SNAP-ELIDE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (elide-collapse): the cap collapses no region and cuts the outline at the tail. Planted, the suite failed in outline_elidesRegionsNotTheTail; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "the cap collapses no region and cuts the outline at the tail",
        "baseline_exit": 0,
        "mutated_exit": 2,
        "restored_exit": 0,
        "expected_diagnostic": "outline_elidesRegionsNotTheTail",
        "observed_diagnostic": "outline_elidesRegionsNotTheTail",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "b99be6927a89290a09fe4028a022f02ae98bee024ba822c8b6bea0e5bda96b6b"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-EXT-OFFSCREEN-2",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "--test-reporter=tap",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (offscreen-below): elements below the viewport are not marked off-screen. Planted, the suite failed in only main-document records wholly outside the visible rect are marked off-screen; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/extension-red-drills.txt",
        "sha256": "993bc0ea7acb46bcba6c8519895b5106623bdc4f9aa3d94b6ae3f21a6bc3da5f"
      },
      "red": {
        "mutation": "elements below the viewport are not marked off-screen",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "only main-document records wholly outside the visible rect are marked off-screen",
        "observed_diagnostic": "only main-document records wholly outside the visible rect are marked off-screen",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "c4f61444394f41abe9056c2383842492c71b7dff5ec8fe5083e6c079777b8159"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-EXT-PAGE-2",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "--test-reporter=tap",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (page-read-slice): the page read returns the first window whatever the offset. Planted, the suite failed in the page read returns the window asked for and the whole text's length; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/extension-red-drills.txt",
        "sha256": "993bc0ea7acb46bcba6c8519895b5106623bdc4f9aa3d94b6ae3f21a6bc3da5f"
      },
      "red": {
        "mutation": "the page read returns the first window whatever the offset",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the page read returns the window asked for and the whole text's length",
        "observed_diagnostic": "the page read returns the window asked for and the whole text's length",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a50a670dc5749f5bd832a9f02028628c18cfa66980674c9e63e0998376d5eac3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-EXT-WINDOW-2",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "--test-reporter=tap",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (read-window): the extension reads from the start whatever the offset. Planted, the suite failed in a read's scope and window come from its arguments, bounded; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/extension-red-drills.txt",
        "sha256": "993bc0ea7acb46bcba6c8519895b5106623bdc4f9aa3d94b6ae3f21a6bc3da5f"
      },
      "red": {
        "mutation": "the extension reads from the start whatever the offset",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a read's scope and window come from its arguments, bounded",
        "observed_diagnostic": "a read's scope and window come from its arguments, bounded",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2af6fccc15e444400b81dd779356be2bcb8ffbfba8a257084bddd3b600e6cca6"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-FIND-ORDER-2",
      "acceptance": [
        "AC-LEAN-FIND-MATCH"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (find-order): find lists its matches worst first. Planted, the suite failed in find_exactMatchFirstWithItsContainers; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "find lists its matches worst first",
        "baseline_exit": 0,
        "mutated_exit": 2,
        "restored_exit": 0,
        "expected_diagnostic": "find_exactMatchFirstWithItsContainers",
        "observed_diagnostic": "find_exactMatchFirstWithItsContainers",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c8600690ae9fa55f9ce606cffe83987c9f088dac2b7b34f32b682b9708341024"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-FIND-ROLE-2",
      "acceptance": [
        "AC-LEAN-FIND-QUERY"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (find-role-words): a phrase's role words are read as plain words. Planted, the suite failed in find_queryRoleWordFiltersByRole; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "a phrase's role words are read as plain words",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "find_queryRoleWordFiltersByRole",
        "observed_diagnostic": "find_queryRoleWordFiltersByRole",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "335c83ff3539978ebc65b83a5905db468bb2d250fc578e02bcb1eda310161494"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-OUTLINE-REF-2",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (outline-ref): a snapshot by ref shows the whole page. Planted, the suite failed in outline_refShowsOneSubtreeWithTheSameRefs; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "a snapshot by ref shows the whole page",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "outline_refShowsOneSubtreeWithTheSameRefs",
        "observed_diagnostic": "outline_refShowsOneSubtreeWithTheSameRefs",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "e60b079e19d27f85c3d6813fced674bf7e01ea106021dbf3af5e7e474bda4787"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-READ-OFFSET-2",
      "acceptance": [
        "AC-LEAN-READ"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (read-offset): an older extension's reply is paged from its start whatever the offset. Planted, the suite failed in read_pagesAnOlderExtensionsWholeReply; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "an older extension's reply is paged from its start whatever the offset",
        "baseline_exit": 0,
        "mutated_exit": 2,
        "restored_exit": 0,
        "expected_diagnostic": "read_pagesAnOlderExtensionsWholeReply",
        "observed_diagnostic": "read_pagesAnOlderExtensionsWholeReply",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "74f4be448b64b398857b2f335c3505fc9b97e191cb8eec961c148ad9ffd60826"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-SLIM-2",
      "acceptance": [
        "AC-LEAN-SNAP-SLIM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_views"
      ],
      "method": "Drill (slim-repeats): text that repeats its parent's name is kept. Planted, the suite failed in slim_dropsTextThatRepeatsItsParent; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/unit-red-drills.txt",
        "sha256": "24cdc3fbdffe4d742d1c7977526a2f4ae72ecc744513986d91ab1ce9013c59e9"
      },
      "red": {
        "mutation": "text that repeats its parent's name is kept",
        "baseline_exit": 0,
        "mutated_exit": 4,
        "restored_exit": 0,
        "expected_diagnostic": "slim_dropsTextThatRepeatsItsParent",
        "observed_diagnostic": "slim_dropsTextThatRepeatsItsParent",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8c98cb0dc07908bddc0710994fdd75de69086056668db52ebf300242f32043e3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    },
    {
      "id": "EV-LEAN-SMOKE-2",
      "acceptance": [
        "AC-LEAN-CATALOG"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test in both profiles: 54 tools in full and 15 read-only, pinned",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/windows-smoke.txt",
        "sha256": "57f9db5af1866f24b1910c925e1656231f6c3a12b120b3ae122741efc5da2918"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-UNIT-JS-2",
      "acceptance": [
        "AC-LEAN-SNAP-SCOPE",
        "AC-LEAN-READ",
        "AC-LEAN-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 13 JavaScript suites, 231 tests: the extension's off-screen marks (main document only, a pinch's rect), read's scope and window, and the page read function rebuilt from its own source and run on a fake document; every earlier extension test unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/windows-test-js.txt",
        "sha256": "c44b37e93315106b6448ccdb2827a12e685ff312c4ed777e15a8370329241ad1"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "7434f3425e58313198e4f3a6d157bc823ad2c22e1a8f6269cf94bf33daa9c398",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CHANGELOG.md",
          "sha256": "156d06f2a71d18ca2b62da85c6a865c8226cbfbf321f4fdbf21e0895cc5e5918"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "PLAN.md",
          "sha256": "6cad0883627d6bb7b714dab469d851a5db04fee9647c2b2b21b71a606ce6f8a6"
        },
        {
          "path": "README.md",
          "sha256": "d248063f1c53c2d812bc73df55e536fe4f923fd51b76ee7ab5ffd0d792841ce7"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "68cd1d1d2138e2518945f58463f44b7c5ea952f48159d10e816541f7ce042d9a"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "a808bf4d5eb46c5e300a5fa1939c3312465214cd42baef06be7915336afa0eac"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "311220dc0ec2de02ac4ff807b43c65f6749a4fc8e15a443838c20b36de32249b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "e676fd415016a06cefaea8477b9c21e1f32aa2599ef7de6d58d3f990195192e1"
        },
        {
          "path": "docs/releases/v1.12.0.md",
          "sha256": "9d42a5fd6398b735725a5c9246654c640973ed827fc2e2965b9a4ad9d4b0d9c6"
        },
        {
          "path": "docs/research/browser-mcp-speed-and-token-efficiency.md",
          "sha256": "703fd36e0e109be847056c52550ce477d5f033a271fd282d71dce46cf6ceeb9c"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "07683f377c3d5ad3aed1bfe36476d8f99f7f8ee248296ae80e88889e490aeaf3"
        },
        {
          "path": "package-lock.json",
          "sha256": "a1fc1a53703c7194e759a1db4852feb433bb4c2292a3954cdd6ffe9a0fedfb22"
        },
        {
          "path": "package.json",
          "sha256": "346d538de855cb7f7e3f6d8d4dbfb65e9f5b524644e989a7e91301649338f82c"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        },
        {
          "path": "vscode/README.md",
          "sha256": "9e2c1df03e0a0c62c22188aac735c70c32d8875fa157864833f488581cc57839"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "349d3e0488076a4f345b8844ae57f4741f52053d7cb7248b3440a259698024ce"
        },
        {
          "path": "vscode/package.json",
          "sha256": "e26010fae84dc493195b22ac8e744b38028524b1f8c51ddaea1192e33369ed5d"
        }
      ]
    },
    {
      "id": "EV-LEAN-RED-LIVE-REPEATS-2",
      "acceptance": [
        "AC-LEAN-SNAP-SLIM",
        "AC-LEAN-FIND-MATCH"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/full_browser_e2e.mjs"
      ],
      "method": "Drill (repetition-kept): text that repeats its parent's name is kept, against real Chrome. Planted, the suite failed in the exact match comes first; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/lean/live-red-drills.txt",
        "sha256": "416cef0bfe1bb6520504a9b7810369f90212885fb614158b4bc9ea0d1e5bd1d8"
      },
      "red": {
        "mutation": "text that repeats its parent's name is kept, against real Chrome",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the exact match comes first",
        "observed_diagnostic": "the exact match comes first",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "8c98cb0dc07908bddc0710994fdd75de69086056668db52ebf300242f32043e3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "8862aaa38caf533f7d6b8d6e9cd0acb7d4ccd8122fed381cebe9085578831a90",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "5062fcc74406ece3ed66729a08b0f2f0bd802b70caad6c468320c71a2f7c32b3"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "fd8ca33216c31a5e20b47d358d817ecc43499b2b0dd12f3677b9830d6b6d22aa"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "08fb6fc1ee5f49d49319d95c2bacfed063736d844369f677e1f43278d51bac31"
        },
        {
          "path": "include/chrome_control_mcp/browser_contract.h",
          "sha256": "a0bb87032ed68b11a0d116abfa9a3efc9a7434d64b884580619e7c870643e002"
        },
        {
          "path": "scripts/mcp_smoke.mjs",
          "sha256": "0cc86d851931fb4bd40eeb4cc3fdbf59eb515954d0e98d68b0c7cdccdc398158"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "60b27fb407e2c171f04a4a492a8e83c7e71eeb1d1be0d4b47ef1837c95e1e1cf"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "1bc261eb0544cb64486f832baac89b69bdbc88afaaedf93848c459427ebde4cb"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "1e02b18007a539c8679f4a70200b6f276d2738ce28a1611d909f82f59a944ef4"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "3b692ed6db4e44fff98e3dbb8b859ff12d5802b02904707e8fa4e4800aee5822"
        },
        {
          "path": "tests/e2e/fixture_server.mjs",
          "sha256": "6151b9cdd6b67161415d50f8d14331acd671a4a79e7f24bdbbc06c400a654434"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "7dfa8c99ad65fd730eb6d45d35b2b4572e82c39e8a77df91086d0dde999d5749"
        },
        {
          "path": "tests/e2e/meter_e2e.mjs",
          "sha256": "3c6ec7d789f81780b5a04a482f25c7e8ce7c07789b6ed5efe20e8fbf8b79aa07"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "391b53ad5c25dcfc7c390ea89b24f25e602a7e44fa15fef210386673c5693dd1"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "cb985f0c1c1a96c6bfb3d504a891eb0b1b5ebcb9640f5c5af2ad225c93fe3a43"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "8363e31ce593848ca2fca4226f18ac8acd30bd1959795a68b7f387c28f36e710"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "5f4a57621112a0438605c66a6ec1a72b4c910a4dddf471c10eafda046b23b175"
        },
        {
          "path": "tests/test_browser_views.cpp",
          "sha256": "dc0400ac1b66628ea0fff70a8e44bbaca03746bd6385b802184ff0ee7fd1708a"
        }
      ]
    }
  ],
  "checkpoint": null
}
```
