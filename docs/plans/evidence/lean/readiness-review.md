# Readiness review: browser_find and lean observations

Reviewed 2026-11-07 against [the plan](../../lean-observations.md), the rules file
[docs/QUALITY.md](../../../QUALITY.md) (revision `afe12ab3a6b6`), the research report the plan
cites, and the current source: `renderSnapshot`, `buildNodeLine`, the node filters and command specs
in `src/browser_contract.cpp`; `fillSnapshotResult`, `beginCommand` and the ref index in
`src/browser_bridge.cpp`; the read-only allow-list and instructions in `src/mcp_dispatch.cpp`;
`captureSnapshot`, `axNodeToCapture`, `walkAxTree`, `viewportState`, `handleRead` and the command
table in `browser/extension/background.js`; the smoke test's pinned tool counts.

## What the source establishes

- A snapshot capture is a flat list of records in document order, each with `role` (lower-cased
  Chrome role, text as `statictext`), `name`, raw `depth`, `interactable`, bounds and state. The
  renderer drops invisible, zero-size and unnamed structural nodes and gives refs to interactable
  or value-bearing nodes, carried by `backendNodeId`. A find and the snapshot controls can
  therefore be views over the same rendering, with refs identical by construction.
- The extension hands `snapshot` no arguments (`args: false`) and `read` only reads `format`, so new
  arguments reach an older extension harmlessly -- except that read would silently answer a
  scoped request with the whole page. Finding 5 below.
- `DOMSnapshot` layout bounds are document coordinates of each frame's own document; only the main
  document's can be compared with the viewport. `viewportState` already reads scroll offset and
  viewport size in one evaluate.
- Refs are installed per tab by `fillSnapshotResult`, replacing that tab's previous refs, after the
  session-epoch and tab checks. A find routed through the same path inherits the stale-ref,
  held-tab and profile-routing behaviour with no new state beyond the find's own arguments.
- The read-only profile is an explicit allow-list; a new read-only tool must be added to it, and
  the smoke test pins 53 and 14 tools.

## Findings

1. **A query of a role word alone** ("button") would strip to nothing. Resolved in the plan: it
   lists that role's elements.
2. **Regex is a new input surface.** Bounded in the plan: at most 200 characters, case-insensitive,
   refused when it does not compile. Names are already capped at 120 characters and a capture at
   2,000 records, so a match pass is bounded.
3. **The options' order was unstated.** `ref` with `filter: "viewport"` and a `max_chars` could be
   read several ways. Resolved: slimming, then `ref`, `depth`, `filter`, `max_chars`; the header
   says how many lines show of how many.
4. **Elision without positions** (an older extension, or subframe content) had no rule. Resolved:
   the top of the page stands in for the viewport.
5. **An older extension ignores read's scoping.** `ref`, `selector` and `mode` sent to a 1.11
   extension would return the whole page as if it were the element asked for. Resolved: the server
   refuses them for an extension older than 1.12.0 with a note to reload it, using the version the
   handshake already reports; AC-LEAN-COMPAT checks it.
6. **Container refs change existing outlines.** Landmarks, dialogs, forms, tables and lists gaining
   refs raises `elements:` counts and moves new-ref numbering on every page. Accepted: the line
   format is unchanged, carried refs keep their names, and the golden outputs in the unit tests and
   any live assertion of counts are updated with the change, each checked against the intended
   rule rather than re-recorded blind.
7. **Slimming changes default output.** It removes only repeated text, folded wrappers and
   indentation, so no element or ref disappears; AC-LEAN-SNAP-SLIM requires every other line and
   every ref to be as before, which the unit tests compare line by line.
8. **The default read cap drops from 200,000 to 30,000 characters.** An agent reading a long page
   needs more calls. Accepted with `offset` continuation named in the header and `max_chars` up to
   200,000; Claude Code already diverts anything over 50,000 characters to a file, so the old
   reach was not inline anyway.
9. **Find replaces the tab's refs, like a snapshot.** An agent holding refs from a snapshot keeps
   them when the nodes are still present (carried by node); refs to nodes now gone answer
   "Unknown element ref" exactly as after a second snapshot. No new semantics.
10. **Rules-file counts.** docs/QUALITY.md records tool and suite counts and is this plan's rules
    file; editing it at the end stales this review, which then needs an addendum and a fresh
    receipt. Planned for the docs task.
11. **Coverage.** Every requirement has criteria, every criterion behaviour and red checks and an
    owning task; the live task depends on server and extension, docs on all three. No criterion
    relies on a model or on a public site's content for pass or fail -- the meter's public-page
    numbers are measurements, not gates.
12. **Compatibility proof.** AC-LEAN-COMPAT re-runs every suite that existed before this work
    against the new build (the closed-history rule: earlier plans are not re-stamped).

No finding is left open. The plan was amended for 1 to 5 before this receipt.

## Addendum, 2026-11-07: browser_read keeps its JSON reply

Before any code, a scan of the suites found `browser_read`'s JSON parsed by six live suites
(clipboard, display matrix, full browser, large upload, multi-agent, profiles), and any operator
script may do the same. Replacing it with plain text would change a reply shape every client has
seen since 1.0 for a saving the research measures as small on prose. Amended: the reply keeps its
JSON shape and gains `offset`, `total` and `next_offset`; the 30,000-character default cap,
paging and scoping carry the saving. REQ-LEAN-READ and AC-LEAN-READ were reworded to match; no
other requirement changed. Scope revision 2.

## Addendum, 2026-11-07: the meter records the baseline first

The meter was part of the live task, which depends on the server and extension work; run there it
could only measure the new build, and every "before" number would be the research's estimate. It
is now its own task (TASK-LEAN-METER) with no dependencies, run on the 1.11.1 build before any
change and again after. The live and documentation tasks depend on it. No requirement or criterion
changed. Scope revision 3.

## Addendum, 2026-11-07: the paths the work touched

Before any behaviour evidence, the task change lists were brought to what the work actually
touched. The server task gained `tests/test_browser_views.cpp` (a suite of its own for the views
over one capture, registered in `CMakeLists.txt`), `tests/test_browser_bridge_relay.cpp` (its
golden outline loses the raw-depth indentation, as the slimming rule intends) and
`src/browser_mcp_tools.cpp` (the installer's and updater's descriptions, part of the catalog
trim); `tests/test_browser_bridge.cpp` left it, the session cases having gone into the new suite.
The documentation task gained `docs/SECURITY.md` and `vscode/README.md`, which state the
read-only profile's tool count. The live work also found two things the plan had not foreseen,
both fixed in the server task with unit cases of their own: Chrome splits text into inline runs
(`inlinetextbox`), which the repetition rule now drops under their text node however long it is;
and the shared fixture template wraps everything in one `<main>`, so the find page is a document of
its own. No requirement or criterion changed. Scope revision 4.

## Addendum, 2026-11-07: the rules file's counts

docs/QUALITY.md, this plan's rules file, now counts 27 ctest suites on Windows and 26 elsewhere
(the new `test_browser_views`) and names the meter beside the live suites; its revision moved from
`afe12ab3a6b6` to `81556cecb9c4`. No rule changed meaning; the plan's criteria are unaffected.
