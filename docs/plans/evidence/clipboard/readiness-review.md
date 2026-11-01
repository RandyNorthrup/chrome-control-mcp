# Readiness review: per-agent clipboards

Reviewed 2026-10-31 against [the plan](../../per-agent-clipboard.md), `docs/QUALITY.md`,
`docs/MULTI_SESSION.md`, `docs/SECURITY.md`, and the current source of
`browser/extension/background.js`, `src/browser_contract.cpp` and `src/browser_control.cpp`. This
is a review of the requirements, not evidence that any code works.

## Source facts the requirements rest on

- Every agent key press goes through `dispatchKey` (`handlePressKey` is its only caller for chords),
  so one interception point covers the keystroke path.
- Agent tabs run with `Emulation.setFocusEmulationEnabled`, so a page in a background agent tab
  believes it is focused, and Chrome lets a focused document write the system clipboard. The
  expected consequence -- a page's copy button clicked by an agent writes the user's clipboard
  today -- is not yet observed; the live suite's red drill (stand-in disabled, sentinel
  overwritten) is what must show it, and REQ-CLIP-SYSTEM's page-API half rests on that.
- The file-picker stand-in (`filePickerShimScript`, `PICKER_BINDING`) already installs a page-world
  replacement in every document of a held tab and reports through `Runtime.bindingCalled`; the
  clipboard stand-in follows it.
- Chrome accepts at most 1 MiB in one message from a native host (`kMaxHostToBrowserBytes`), so
  text and HTML a tool call writes must be bounded below that; files already travel in chunks.
- The read-only profile is an explicit allow-list (`mcpToolIsReadOnly`), so a new mutating tool is
  excluded without a change there.

## Findings and resolutions

| #   | Finding                                                                                                                                                                        | Resolution                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Failure behaviour was missing for an empty clipboard, nothing selected, and nothing focused.                                                                                   | Added to AC-CLIP-KEYS and AC-CLIP-TOOL: copy with nothing selected leaves the clipboard unchanged; paste from an empty clipboard inserts nothing and says so; paste into nothing focused is refused naming why. |
| 2   | No bound was stated for what a tool call may write, and the transport imposes one.                                                                                             | AC-CLIP-TOOL: text and HTML together are refused past 512 KiB, leaving room in a 1 MiB frame; files keep the upload bounds.                                                                                     |
| 3   | The activation window did not say whether the agent's own clipboard commands open it. A page's paste handler that calls `navigator.clipboard.read` would be refused mid-paste. | The design now includes `browser_clipboard` copy, cut and paste in the window.                                                                                                                                  |
| 4   | "Never touches the system clipboard" could be read as covering shell commands an agent runs itself.                                                                            | Stated as a non-goal; the MCP instructions steer agents to the tool.                                                                                                                                            |
| 5   | Rich HTML paste could become an injection path if this code inserted HTML.                                                                                                     | Design: HTML is only handed to the page's own paste handler; the fallback inserts text only.                                                                                                                    |
| 6   | Cross-site frames cannot be reached by page script.                                                                                                                            | Stated as a limit: paste falls back to trusted text insertion, which does reach a focused field inside one; copy and rich paste are not available there.                                                        |
| 7   | Real-site coverage cannot be deterministic in CI.                                                                                                                              | AC-CLIP-SITES is a recorded manual live run with its reason; every other criterion has an automated behaviour check and a red drill.                                                                            |
| 8   | Requirement/acceptance/task coverage.                                                                                                                                          | Every requirement has acceptance; every criterion has an owning task; tasks depend only on tasks that come before them. No conflicting requirements found.                                                      |

## Terminology

"Agent" means a session (one MCP server) plus the agent name a tab was opened or selected with,
exactly as for tab groups. "Stand-in" means the page-world replacement functions. "Activation
window" means an agent's input command on a tab and the 2 s after it (`OPENER_GRACE_MS`).

Verdict: ready to implement.

## Addendum, after implementation began

The first readiness receipt went stale for two reasons, both reviewed here.

- **Task scope grew** by enabling paths the plan had not named:
  - `src/browser_bridge.cpp` and its header, for checking a file-carrying call's arguments before
    its files are sent. Without it, a rejected `browser_clipboard write` would strand its chunks
    exactly as a rejected upload already did.
  - `tests/browser_model.mjs`, the browser model moved out of the tabs suite so both suites share
    it; the tabs suite changed only to import it.
  - `tests/e2e/full_browser_e2e.mjs`, which must name the new tool as covered elsewhere.
  - `PLAN.md`.
    No requirement or acceptance criterion changed meaning. AC-CLIP-SERVERS gained a sharper live
    check: the second server's agent shares a name with one on the first, so a store keyed by name
    alone would be caught.
- **The rules file changed.** `docs/QUALITY.md` is also the per-release status page. Its 1.8.1 and
  1.8.2 updates touched evidence rows only, not the gates themselves.

Verdict unchanged: the requirements are clear, covered, and consistent.

## Addendum, after the 1.9.0 CI run

The second readiness receipt went stale because the rules file changed again. `docs/QUALITY.md`'s
status table now counts 204 JavaScript tests where it counted 199: `test_release_versions` gained
five tests for the release pages. No gate, threshold or rule changed. The same run found the live
suite selecting with Control+A, which on macOS moves the caret instead of selecting; that is a
defect in the check, not in a requirement or criterion, and AC-CLIP-KEYS reads the same.

Verdict unchanged: the requirements are clear, covered, and consistent.

## Addendum, after the version-exchange work

The third readiness receipt went stale because the rules file changed: `docs/QUALITY.md`'s status
table now counts 24/23 ctest suites and 210 JavaScript tests, and lists the extension-version live
suite among the live gates. No gate, threshold or rule changed. The version work
([extension-version.md](../../extension-version.md)) also changed files this plan's evidence is
bound to -- `background.js`, `browser_control.cpp`, `mcp_dispatch.cpp`, the browser model, the
live harness, the README and the changelog -- without changing anything a clipboard requirement or
criterion says; every behaviour receipt is re-run against the result rather than carried over.

Verdict unchanged: the requirements are clear, covered, and consistent.
