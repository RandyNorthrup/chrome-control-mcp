# Readiness review: actions that say what they changed, forms in one call, and unchanged snapshots

Reviewed 2026-11-08 against [the plan](../../action-changes.md), the rules file
[docs/QUALITY.md](../../../QUALITY.md) (revision `2341ef05e7b3`), the research report's items R3,
R10 and R11, and the current source: the extension's `handleCommand`, `dispatchCommand`,
`reportSideEffects`, `enableSessionDomains` and its new-document scripts, `recordConsole`, the dialog
handler, `captureSnapshot`, `handleSetValue` and `handleSelect`; the contract's argument specs,
`allowedArgKeys`, `buildExtensionCommand`, `applyToolExtras`, `applyDragExtra`, `bindRefTab` and the
catalog builders; the bridge's `beginCommand`, `fillResult`, `fillSnapshotResult`, `staleRefError`,
`applyCommandEffect` and `reconcileDomEpoch`; and the catalog budget test.

The review was made while the work was under way, from a survey of those paths before the first
change; every criterion is proved by checks and red drills on the finished tree, not by this review.

## What the source establishes

- Replies already carry `opened_tabs`, `file_chooser` and `page_clipboard` from `reportSideEffects`;
  nothing reports what an action did to the page itself. No mutation counter exists, and nothing
  counts console errors or dialogs per tab (the console is a ring; the last dialog is written only
  after its answer lands, which can be after the reply).
- The bridge allows one outstanding command and installs refs only on a snapshot's reply, keyed to
  the reply's tab and document generation. An action that returns a snapshot must route it through
  that same installation, or refs would be issued by two code paths.
- The contract has no array-of-objects argument; `applyDragExtra` is the one precedent for resolving
  a ref inside another argument, and `staleRefError` hard-codes `ref` and `to_ref`.
- The catalog is 43,464 bytes against a 43,500 budget.

## Findings

1. **The default path must not wait.** A settle on every action would slow every agent for the few
   who want the page. Resolved: `changes` costs two reads; only `snapshot: true` waits.
2. **The counter must not count the extension.** The frame, badge and cursor are page DOM, and the
   cursor moves on every pointer action. Resolved: nodes under the extension's ids are skipped, and
   so are `style` attributes, which an animation rewrites every frame.
3. **A page can lie to an in-page counter.** It runs in the page's world. Accepted and documented:
   the cost of a lying page is an inaccurate hint about its own changes; nothing it says reaches a
   decision the extension makes.
4. **A snapshot from a replaced document must not bind refs.** A navigation can land between the
   capture and the reply. Resolved: the capture carries its document generation, and the bridge
   installs only when it equals the reply's.
5. **Settling cannot use the page's timers.** A tab behind the user's runs its timers once a second.
   Resolved: the extension polls the counter from its own clock.
6. **"Unchanged" needs a baseline the agent still has.** An agent whose earlier snapshot was dropped
   from its context has nothing to compare with. Resolved: `if_changed` is opt-in, compares only
   under the same options, leaves volatile url and title out, and the first snapshot of a document is
   whole and unmarked.
7. **A form's fields must stay inside the safety rules refs already have.** Resolved: every field's
   ref is resolved and tab-bound like a primary ref, the stale check covers every field, the fields
   are bounded in count and size so one command fits one native message, and the tool stays out of
   the read-only profile.
8. **Values must suit every client's schema handling.** A `string | boolean` union is refused or
   mangled by some clients. Resolved: every value is a string, `"true"`/`"false"` for a checkbox.
9. **React's controlled inputs ignore a plain value assignment.** Resolved: text fields are set
   through the prototype's setter, with a unit test of a framework-owned value property.
10. **The catalog budget.** The full set costs about 2.2 KB; the owner chose it on 2026-11-08.
    Resolved: one generic property for `snapshot`, descriptions trimmed, budget 46,000 with the reason
    recorded beside the test.

## Coverage

| Criterion        | Task(s)                 | Behaviour proof                                     | Red drill                                                         |
| ---------------- | ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| AC-ACT-CHANGES   | EXTENSION               | pure suite's summary cases; tabs suite's dispatcher | dom ignored; many threshold; focus ignored; not attached          |
| AC-ACT-LIVE      | LIVE                    | action-changes suite; latency suite                 | live: changes not attached                                        |
| AC-ACT-SNAPSHOT  | EXTENSION, SERVER, LIVE | bridge's action-snapshot cases; contract; live      | not shown; epoch not compared; not offered                        |
| AC-ACT-UNCHANGED | SERVER, LIVE            | bridge's if_changed case; live                      | never unchanged; nothing marked                                   |
| AC-ACT-FORM      | EXTENSION, SERVER, LIVE | pure suite's field cases; contract; bridge; live    | select by text off; no stop; plain setter; cross-tab; stale field |
| AC-ACT-COMPAT    | LIVE, RELEASE           | ctest, test:js, static analysis, every suite        | catalog over its budget                                           |
| AC-ACT-RELEASE   | RELEASE                 | release-versions suite                              | manifest left at 1.14.0                                           |

The closed ledgers are not re-recorded; AC-ACT-COMPAT re-runs their suites as this work's regression
proof. `docs/VERIFICATION.md` is not a change path. Live proof runs on the Ubuntu laptop locally;
Windows and macOS run every live suite in the release's live job, which gates publishing.
