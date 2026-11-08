# Readiness review: faster actions, and screenshots shaped for the model

Reviewed 2026-11-07 against [the plan](../../speed-and-screenshots.md), the rules file
[docs/QUALITY.md](../../../QUALITY.md) (revision `2341ef05e7b3`), the research report's items R4,
R7, R8 and R9, and the current source: the extension's command table and `dispatchCommand`,
`captureScreenshotWithFrames`, `resolveActionQuad` and `settleScroll`, `handleScreenshot`,
`screenshotPoint`, `handleBox`, `handleRecordStart` and the offscreen recorder; the relay's reply
loops (`browser_bridge_relay.cpp`, `browser_bridge_relay_posix.cpp`); the contract's argument
specs and catalog (`browser_contract.cpp`); the bridge's screenshot reply (`browser_bridge.cpp`);
and the dispatcher's read-only policy (`mcp_dispatch.cpp`).

The review was made while the work was under way: the measurements that motivated it were taken
first, on the 1.13.0 build, and the design was settled from them. Every criterion below is proved
by checks and red drills run on the finished tree, not by this review.

## What the source and the measurements establish

- On the Ubuntu laptop, in the agent's tab behind the browser's own, 1.13.0 took 2,036 to 3,092 ms
  for a scroll by ref, one to two seconds for a page scroll, up to 1,057 ms for a click or hover,
  and 26 ms for `browser_tabs`. An instrumented copy of the extension showed the time inside
  `Input.dispatchMouseEvent` acknowledgements and the `scrollend` wait, each about a second: the
  cadence at which Chrome draws a background tab. A one-pixel screencast already kept a tab drawing
  for off-screen screenshots, and with one running the same actions took 12 to 85 ms.
- Replies came back at 26, 51, 76 and 101 ms: the relay loop slept 25 ms between looks at the
  reader's flag.
- Every action called `DOM.scrollIntoViewIfNeeded` and then `settleScroll`, whose page-timed pause
  was most of a click on a visible element.
- `handleScreenshot` returned the device-pixel capture; `screenshotPoint` and `handleBox` converted
  with `dpr × pinch scale`. The bridge forwarded `data` and a size summary and nothing else, so the
  extension's `clipped` fields never reached the agent.
- The off-screen screenshot path started and stopped its own screencast. On a tab being recorded,
  that replaced the recording's screencast parameters and its stop ended the recording's frames.
- The recorder's canvas was always 1280x800 and every frame was drawn stretched to it.

## Findings

1. **Overlapping actions on one tab must share one cast.** Two casts on one target replace each
   other, and the first to finish would stop the second's. Resolved: a per-tab entry counts users,
   starts once, stops when the count reaches zero, and a start waits for a stop still in flight.
2. **A recorded tab must not be given a forcing cast.** Resolved: `withFrames` leaves a tab a
   recording films alone, which also fixes the screenshot-during-recording fault above.
3. **A refused cast must not fail the action.** Resolved: the action runs at the old pace.
4. **"In view" has to mean wholly visible to the user.** A box inside the viewport can still be
   clipped by a scrolling ancestor or a shadow host. Resolved: the in-view test walks every clipping
   ancestor, including across shadow roots, and only the top window counts; a pinch-zoomed page
   always scrolls.
5. **The view's factor must be the one coordinates use.** If the image were resized by one factor
   and click_at converted by another, every click would miss by the difference. Resolved: one
   function, `viewFactor`, feeds the resize, `screenshotPoint` (through the shot binding) and
   `screenshot_center`.
6. **Integer coordinates lose precision once the view is smaller than CSS pixels.** A 3840-pixel
   viewport at 25% zoom has a view factor of 0.41: one view pixel spans about five CSS pixels, and a
   6-pixel target can fall between two integers. Resolved: the coordinate arguments become numbers,
   checked to lie within 0 to 16,384, and `screenshot_center` keeps a tenth of a pixel.
7. **A presentation must not reach the model, and must not be writable to a path a page chooses.**
   Resolved: the bridge decides from what it sent (not what came back), writes under a name it
   chooses beside `browser_print`'s PDFs, and replies with the path; the read-only profile refuses
   it by its argument, since `browser_screenshot` is a read-only tool otherwise.
8. **A zoom must not move the page.** `resolveActionQuad` scrolls; a screenshot is a read-only tool.
   Resolved: a zoom by ref reads the box where it stands and refuses an element off screen.
9. **The live suites must not write into a real Downloads folder.** Resolved:
   `CHROME_CONTROL_MCP_OUTPUT_DIR` names the folder, and every isolated run sets it inside its own
   temporary root.
10. **Speed needs a guard of its own.** No suite measured latency, so a regression to frame-bound
    actions would pass everything. Resolved: the latency suite, in `live.yml`, with a bound between
    the two measured regimes, checked on the actions whose broken form is furthest from it.
11. **Compatibility.** New arguments are optional; numbers accept every integer a client sent
    before; the catalog has a byte budget test, and the new descriptions were trimmed to stay
    within it rather than raising it.

12. **Where the live proof runs.** Locally, the live suites run on the Ubuntu laptop. On Windows
    the dedicated browser needs this user's native-messaging registration to name the executable
    under test, and that registration serves the owner's own Chrome and its installed server;
    re-pointing it would disturb both. Windows and macOS run every live suite, the latency suite
    and the display matrix included, in the release's live job, which gates publishing.

## Coverage

Every acceptance criterion maps to at least one task and to behaviour and red checks:

| Criterion           | Task(s)           | Behaviour proof                              | Red drill                                            |
| ------------------- | ----------------- | -------------------------------------------- | ---------------------------------------------------- |
| AC-SPD-FRAMES       | EXTENSION         | tabs suite's frame cases; latency suite      | cast never starts                                    |
| AC-SPD-INVIEW       | EXTENSION         | pure suite's in-view cases                   | in-view check ignored                                |
| AC-SPD-RELAY        | SERVER            | relay suite's round-trip case                | reader no longer signals (Windows, POSIX)            |
| AC-SPD-LATENCY      | LIVE              | latency suite, Windows and Linux             | live: cast never starts                              |
| AC-SPD-VIEW         | EXTENSION, SERVER | pure suite; contract suite; display matrix   | factor drops 1/dpr; coordinate check off             |
| AC-SPD-ZOOM         | EXTENSION, SERVER | pure suite's zoom cases; bridge; matrix      | crop ignores the view factor; zoom note dropped      |
| AC-SPD-PRESENTATION | SERVER, LIVE      | bridge; server; full browser; display matrix | not saved; read-only refusal off                     |
| AC-SPD-CLIPPED      | SERVER            | bridge's clipped case; display matrix        | note dropped                                         |
| AC-SPD-MATRIX       | LIVE              | display matrix, Windows and Linux            | live: click_at ignores the view factor               |
| AC-SPD-RECORD       | EXTENSION, SERVER | pure, recording and offscreen suites         | stretched frame; letterbox off; resolution unchecked |
| AC-SPD-COMPAT       | LIVE, RELEASE     | ctest, test:js, static analysis, every suite | catalog over its budget                              |
| AC-SPD-RELEASE      | RELEASE           | release-versions suite                       | manifest left at 1.13.0                              |

No conflicts with earlier plans: the closed ledgers are not re-recorded; AC-SPD-COMPAT re-runs
their suites as this work's regression proof. `docs/VERIFICATION.md` is not a change path.

## Addendum: scope revision 3

The live red drill for the latency suite (the cast that keeps the tab drawing removed) failed the
suite, but on one check of six: with the in-view skip in place, a frame-bound scroll of the page by
ref took 999 ms, under the 1,000 ms bound by a millisecond, and a page scroll 994. Measured in that
run, frame-bound scrolls took 245 to 1,416 ms and drawn-for ones 49 to 97. The bound is now
500 ms, five times the slowest drawn-for action, so each kind of scroll fails it when the tab is
not kept drawing; AC-SPD-LATENCY says so, and the suite, the changelog, the release page and the
plan's prose follow. The latency evidence and its drill are run again on the changed suite.

## Addendum: the server's share of the zoom and recording criteria

Closure validation found no red proof for the server's part of AC-SPD-ZOOM and AC-SPD-RECORD: the
bridge's note that says which part of the view a zoom shows had a test but no drill, and the
contract's check of a recording's resolution had neither. A contract test for the resolution
(standard and full copied, none left unset, an unknown word and a number refused) and two drills
(the zoom note dropped; the resolution check bypassed) were added, and the evidence run again.

## Addendum: scope revision 4

The relay suite's round-trip case asked for the fastest of five exchanges under 15 ms, against a
25 ms tick. On a loaded machine that gap closed: with every core busy the woken relay measured
23 ms once in six runs (reproduced on purpose, after one restore run of the drills failed the same
way). The tick is now a parameter of `relayPumpOnce` and `awaitBrowserReply`, 25 ms by default and
unchanged in the product, and the case runs it at a second: a woken exchange takes milliseconds and
one that waits out the tick a full second, so the bound of 500 ms holds under load (six of six with
every core busy) and the drill still fails it (1,000 ms). `browser_bridge_relay.h` and
`browser_bridge_relay_common.cpp` join TASK-SPD-SERVER's paths, and AC-SPD-RELAY says so.
