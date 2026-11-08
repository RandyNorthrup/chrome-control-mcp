# Faster actions, and screenshots shaped for the model

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them. The research
behind it is [docs/research/browser-mcp-speed-and-token-efficiency.md](../research/browser-mcp-speed-and-token-efficiency.md)
(items R4, R7 and R8; R9 is taken up in the limits below).

## Why

An agent works in a tab of its own, behind the user's. Measured on the Ubuntu laptop with 1.13.0,
in that tab: a scroll by ref took 2,036 to 3,092 ms, a page scroll one to two seconds, a click or
hover up to 1,057 ms, and even `browser_tabs` 26 ms. Instrumenting the extension found three
causes. Chrome draws a tab that is not in front about once a second, and acknowledges a dispatched
mouse event, and fires `scrollend`, only when it draws. Every action on an element scrolled it
into view and waited for the scroll to settle, even when it was already on screen. And the relay
looked for a reply from the browser every 25 ms, so replies arrived at 26, 51, 76 or 101 ms.

Screenshots were the device's own pixels. A 2x display's viewport is 2880x1800; Claude shrinks
any image whose long edge passes 1,568 px before it reads it, so three quarters of those bytes
are sent for nothing, and there was no way to look closer at one part of the page.

## Design

**Keep the agent's tab drawing while an action runs.** Each action that dispatches input or
scrolls (click, click_at, hover, drag, type, select, press_key, scroll, upload, clipboard) runs
inside `withFrames`: a one-pixel `Page.startScreencast` keeps the tab compositing, overlapping
actions on a tab share one cast, and it stops when the last one ends. A tab that a recording is
filming is left alone -- its own screencast already draws it, and a second would replace its frame
size. The off-screen screenshot path uses the same helper, which fixes a latent fault: a screenshot
of a tab being recorded used to stop the recording's frames. A browser that refuses the cast runs
the action anyway, at the old pace.

**Do not scroll what is already in view.** `whollyInViewFn` asks the page whether the element's
box lies inside the viewport and every clipping ancestor (shadow hosts included, no pinch); if so
the scroll and its settle are skipped.

**Wake the relay when the reply arrives.** The reader thread signals the loop as soon as it has a
reply: a manual-reset event on Windows, a self-pipe in the `poll` set on Linux and macOS. The
25 ms interval remains only as the cancellation check.

**A view, a zoom, and a presentation.** The default screenshot is a view: shrunk in the
extension's own canvas to one image pixel per CSS pixel, and further to keep the long edge within
1,568 (8,000 for a full page). The factor allows for the CSS pixel a capture can run past the
page's whole-pixel viewport. A zoom -- `ref`, or `x`/`y`/`width`/`height` in view pixels -- crops
the device-pixel capture to that part, at up to the device's pixels, without moving the page.
`purpose: "presentation"` returns the capture untouched; the server writes it as a PNG beside
`browser_print`'s PDFs (or in `CHROME_CONTROL_MCP_OUTPUT_DIR`) and replies with the path only, and
the read-only profile refuses it. Coordinates follow the view: `browser_click_at`, `browser_hover`
and `browser_drag` take view pixels, fractions allowed, within 0 to 16,384; `browser_box`'s
`screenshot_center` is in view pixels to a tenth. A full-page capture cut at Chrome's raster limit
now says so in the reply; the extension reported it, but the bridge dropped the note.

**Recordings in the page's shape.** `browser_record_start` sizes the encoder's canvas and the
screencast to the viewport's shape -- within 1280x800 for `resolution: "standard"`, the device's
pixels for `"full"` -- and a frame of another shape is fitted on black rather than stretched.

**A latency suite.** `tests/e2e/action_latency_e2e.mjs` runs click, hover and three kinds of
scroll in the agent's tab behind the browser's own, and holds each under half a second; it joins
`live.yml`.

## Non-goals and limits

- R9's per-command DevTools trims (showing the overlay once, resolving a ref once) are not taken
  up: measured after this work, a click on a visible element takes 27 to 55 ms end to end, and the
  remaining round trips are a few milliseconds each. PLAN.md keeps it open for a measurement.
- Action replies that say what changed (R3), `browser_fill_form` (R11) and opt-in unchanged
  snapshots (R10) are the next release's.
- A view still captures device pixels and resizes them; it does not change the Chrome stall on
  Windows in 3840x2160 configurations that PLAN.md tracks.

## Found by the release's live run

The live job that gates publishing ran 1.14.0's tag on three platforms and stopped it. Each finding
was run down before anything changed:

- **Linux, multi-agent: a popup went to the wrong agent.** The suite's own diagnostics (added to
  find this) showed the popup held by the first agent, whose tab the user had in front. Chrome
  names the window's active tab as the opener of a link opened from a background tab, and the
  extension trusted that opener first; with the faster replies the first agent's own click had
  finished a second before, still inside its two-second window. The browser's record of which page
  opened a tab (`webNavigation`) is now the only one believed where it exists.
- **Why the user's front tab was an agent's.** The harness turned on Developer mode through a
  `chrome://extensions` tab it opened in front while the suite was already running; the suite now
  ran fast enough to open its first tab beside it, and Chrome put that tab in front when the
  harness closed its own (reproduced locally once in two runs). The harness now opens its page
  behind the user's tab.
- **macOS, latency: a page scroll to the top took 0.8 s.** The scroll's reply said it had moved
  200 px and settled after waiting 751 to 791 ms; the same 200 px down took 16 to 32. A wheel far
  past the page's top makes it bounce on macOS (elastic overscroll), and the reply rightly waits
  for the bounce. The suite now scrolls back up the 200 it went down.
- **Windows, display matrix: Chrome exited mid-screenshot** in a configuration that captures
  3840-pixel-wide images, with nothing in its own output: the open item PLAN.md tracks, seen on
  earlier release tags. The same configurations passed in the next runs.
- **Linux, large uploads: the page's hash of the 300 MiB file was still running after 120 s** in one
  of four runs; it has not been reproduced (three runs on two cores locally, 75 s each). The page
  now reports how far its hash has got, so a recurrence says whether it stalled or was slow.

## Compatibility

- Every tool keeps its name and arguments; `purpose`, `x`/`y`/`width`/`height` on
  `browser_screenshot` and `resolution` on `browser_record_start` are new and optional, and the
  coordinate arguments widen from integers to numbers.
- A screenshot an agent reads is smaller on a display above 1x, and its coordinates follow it; a
  pixel position read off a 1.13 screenshot on such a display is not one to reuse.
- The catalog stays within its byte budget, and the read-only profile's 15 tools are unchanged.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-SPD",
    "title": "Faster actions, and screenshots shaped for the model",
    "scope_revision": 5,
    "brief": null,
    "brief_reason": "Scoped change in an existing product; README.md, docs/TOOLS.md, the research report docs/research/browser-mcp-speed-and-token-efficiency.md and the owner's screenshot decision of 2026-11-07 (view plus saved presentation) carry the context",
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
      "id": "REQ-SPD-ACTIONS",
      "statement": "An action in the agent's tab behind the user's replies without waiting for the frame Chrome draws a background tab about once a second, without a scroll it does not need, and without the relay's poll interval",
      "priority": "critical",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-SPD-SCREENSHOTS",
      "statement": "A screenshot an agent reads is at one image pixel per CSS pixel within the model's cap, with a zoom for detail, a full-resolution presentation saved to a file for people, coordinates that follow the view, and an honest note when a full page is cut",
      "priority": "critical",
      "acceptance": [
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-SPD-RECORDING",
      "statement": "A recording keeps the page's shape at a standard or full resolution, and a screenshot of a recorded tab leaves the recording running",
      "priority": "normal",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-SPD-COMPAT",
      "statement": "Every earlier suite, every MCP client, the catalog budget and the read-only profile keep working, and the release says what shipped",
      "priority": "critical",
      "acceptance": [
        "AC-SPD-COMPAT",
        "AC-SPD-POPUP",
        "AC-SPD-RELEASE"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-SPD-FRAMES",
      "requirement": "REQ-SPD-ACTIONS",
      "given": "The agent's tab, held by its session and not in front",
      "when": "a click, click_at, hover, drag, type, select, press_key, scroll, upload or clipboard command runs on it, alone or overlapping another",
      "then": "a one-pixel screencast keeps the tab drawing for the command's duration, overlapping commands share one cast, it stops when the last ends, a tab a recording is filming is left to the recording's own cast, and a refused cast lets the command run anyway",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-INVIEW",
      "requirement": "REQ-SPD-ACTIONS",
      "given": "An element wholly inside the viewport and every clipping ancestor, and one that is partly hidden",
      "when": "an action resolves where to act on it",
      "then": "the visible one is not scrolled and no settle is waited for; the partly hidden one is scrolled into view and settled as before",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-RELAY",
      "requirement": "REQ-SPD-ACTIONS",
      "given": "A relay waiting for the browser's reply",
      "when": "the reply arrives",
      "then": "the relay loop wakes at once (a Windows event, a POSIX self-pipe) rather than at its next look at the pipe: with that tick lengthened to a second, the fastest of three round trips is under 500 ms",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-LATENCY",
      "requirement": "REQ-SPD-ACTIONS",
      "given": "A real Chrome for Testing with the agent's tab behind the browser's own, on the Ubuntu laptop; Windows and macOS run the same suite in the release's live job, which gates publishing",
      "when": "the latency suite clicks, hovers and scrolls three times each",
      "then": "every scroll, click and hover replies in under 500 ms; with the cast that keeps the tab drawing removed, each kind of scroll fails that bound (measured 245 to 1,416 ms, the worst of each kind's three 994 ms or more)",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-VIEW",
      "requirement": "REQ-SPD-SCREENSHOTS",
      "given": "Viewports at display scales 1 to 3, browser zoom 25 to 500%, pinches, and widths whose device pixels pass 1,568",
      "when": "browser_screenshot runs with no purpose, and click_at, hover, drag and box use its coordinates",
      "then": "the image is one pixel per CSS pixel, never enlarged, long edge within 1,568 (8,000 for a full page) even when the capture runs a CSS pixel past the viewport; the same factor maps a view pixel, fractions included, to where the click lands; coordinates outside 0 to 16,384 are refused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-ZOOM",
      "requirement": "REQ-SPD-SCREENSHOTS",
      "given": "A ref, a region in view pixels, an element off screen, and a region off the image",
      "when": "browser_screenshot is asked to zoom",
      "then": "the image is that part at up to device pixels (long edge within 1,568), the reply says which part of the view it shows and at what magnification, the page is not moved, the off-screen element and the off-image region are refused, and a ref with a region, a partial region or a zoom of a full page is refused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-PRESENTATION",
      "requirement": "REQ-SPD-SCREENSHOTS",
      "given": "purpose presentation, with and without CHROME_CONTROL_MCP_OUTPUT_DIR, and under the read-only profile",
      "when": "browser_screenshot runs",
      "then": "the device-pixel PNG is written under a server-chosen screenshot-<stamp>.png name in that folder (Downloads/ChromeControlMCP otherwise), the reply is its path, size and dimensions with no image, a non-PNG payload is refused and nothing written, and the read-only profile refuses the call",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-CLIPPED",
      "requirement": "REQ-SPD-SCREENSHOTS",
      "given": "A full-page capture the extension reports as cut at the raster limit, and one it does not",
      "when": "the bridge builds the reply, as a view and as a presentation",
      "then": "the cut one names the document's size and the slice's in the view's text and in the presentation's reply; the whole one says nothing of the kind",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-MATRIX",
      "requirement": "REQ-SPD-SCREENSHOTS",
      "given": "The display matrix's 35 configurations in Chrome for Testing on the Ubuntu laptop; Windows and macOS run it in the release's live job, which gates publishing",
      "when": "each takes a view and a presentation of every screenshot, zooms to a ref, clicks and drags at points read off the presentation and carried into the view, and pinches",
      "then": "the presentation is the viewport in device pixels with every target where the page laid it out, the view is one pixel per CSS pixel within its cap, every click_at, drag and screenshot_center lands on its target, and the zoom is the element in device pixels",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-RECORD",
      "requirement": "REQ-SPD-RECORDING",
      "given": "A 2x 1440x900 viewport, a tall narrow one, a small one, an unreadable one, and a frame whose shape changed mid-recording",
      "when": "browser_record_start runs with resolution standard, full, or an unknown value, and frames are drawn; and a screenshot is taken of the recorded tab",
      "then": "the encoder's canvas and the screencast share the viewport's shape in even pixels (within 1280x800, or the device's pixels at quality 92), an unknown resolution starts nothing, a frame of another shape is fitted on black, and the screenshot leaves the recording's screencast running",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-COMPAT",
      "requirement": "REQ-SPD-COMPAT",
      "given": "The 1.14.0 tree on Windows and on the Ubuntu laptop",
      "when": "ctest, the JavaScript suites, the smoke test, the static analysis and every live suite run",
      "then": "all pass: the catalog within 43,500 bytes, the read-only profile's 15 tools, every earlier live suite (full browser, user interference, multi-agent, clipboard, extension versions incl. the store key, profiles, large upload) unchanged, and clang-tidy, cppcheck and Semgrep clean",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-POPUP",
      "requirement": "REQ-SPD-COMPAT",
      "given": "Two sessions: one whose tab the user has in front and whose click has just finished, and one whose click in its own background tab opens a target=_blank popup, which Chrome reports with the tab in front as its openerTabId",
      "when": "the browser reports the new tab and the page that opened it",
      "then": "the popup is held by the session whose page opened it, as opened from that page, and never by the session whose tab is in front; with the live harness opening its own pages behind the user's tab, the multi-agent suite passes",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-SPD-RELEASE",
      "requirement": "REQ-SPD-COMPAT",
      "given": "The version files, the changelog, the README and the release page",
      "when": "the release-versions suite reads them",
      "then": "every one says 1.14.0, the changelog and README's What's new start with it, and its release page exists",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    }
  ],
  "tasks": [
    {
      "id": "TASK-SPD-EXTENSION",
      "purpose": "The extension: frames kept drawing during actions, the in-view check, the view, zoom and presentation shaping and its coordinates, the recording's frame size and letterboxing, and their unit tests",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-RECORD",
        "AC-SPD-POPUP"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        },
        {
          "path": "browser/extension/offscreen.js",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-SPD-CTEST-3",
        "EV-SPD-UNIT-JS-3",
        "EV-SPD-LINUX-3",
        "EV-SPD-LIVE-LATENCY-3",
        "EV-SPD-LIVE-MATRIX-3",
        "EV-SPD-LIVE-REGRESSION-3",
        "EV-SPD-RED-FRAMES-3",
        "EV-SPD-RED-RECORDED-3",
        "EV-SPD-RED-INVIEW-3",
        "EV-SPD-RED-VIEW-DPR-3",
        "EV-SPD-RED-VIEW-CAP-3",
        "EV-SPD-RED-POINT-3",
        "EV-SPD-RED-ZOOM-3",
        "EV-SPD-RED-RECORD-FRAME-3",
        "EV-SPD-RED-RECORD-ENCODER-3",
        "EV-SPD-RED-LETTERBOX-3",
        "EV-SPD-RED-POPUP-3"
      ]
    },
    {
      "id": "TASK-SPD-SERVER",
      "purpose": "The server: the relay's wake on Windows and POSIX, the screenshot and record_start arguments and their checks, numeric coordinates, the presentation's save and the clipped note in the bridge, the read-only refusal, the catalog's descriptions, and their tests",
      "acceptance": [
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD"
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
          "path": "src/browser_bridge_relay.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
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
          "path": "tests/test_browser_bridge_relay.cpp",
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
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-SPD-CTEST-3",
        "EV-SPD-LINUX-3",
        "EV-SPD-LIVE-MATRIX-3",
        "EV-SPD-RED-RELAY-WIN-3",
        "EV-SPD-RED-RELAY-POSIX-3",
        "EV-SPD-RED-PRESENTATION-3",
        "EV-SPD-RED-CLIPPED-3",
        "EV-SPD-RED-READ-ONLY-3",
        "EV-SPD-RED-COORDINATES-3",
        "EV-SPD-RED-ZOOM-NOTE-3",
        "EV-SPD-RED-RESOLUTION-3"
      ]
    },
    {
      "id": "TASK-SPD-LIVE",
      "purpose": "The live suites: the latency suite and its place in live.yml, the display matrix's view, presentation and zoom checks, the full-browser scale matrix's view and presentation, and an output folder for every isolated run",
      "acceptance": [
        "AC-SPD-LATENCY",
        "AC-SPD-MATRIX",
        "AC-SPD-PRESENTATION",
        "AC-SPD-COMPAT",
        "AC-SPD-POPUP"
      ],
      "depends_on": [
        "TASK-SPD-EXTENSION",
        "TASK-SPD-SERVER"
      ],
      "changes": [
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "action": "create"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "action": "modify"
        },
        {
          "path": ".github/workflows/live.yml",
          "action": "modify"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-SPD-LIVE-LATENCY-3",
        "EV-SPD-LIVE-MATRIX-3",
        "EV-SPD-LIVE-FULL-3",
        "EV-SPD-LIVE-REGRESSION-3",
        "EV-SPD-RED-LIVE-LATENCY-3",
        "EV-SPD-RED-LIVE-MATRIX-3",
        "EV-SPD-RED-PRESENTATION-3",
        "EV-SPD-RED-CATALOG-3",
        "EV-SPD-RED-POPUP-3",
        "EV-SPD-GATES-3",
        "EV-SPD-SMOKE-3"
      ]
    },
    {
      "id": "TASK-SPD-RELEASE",
      "purpose": "The version 1.14.0 in every file that carries it, and the documentation of what shipped: tools, architecture, privacy, README, changelog, plan and the release page",
      "acceptance": [
        "AC-SPD-RELEASE",
        "AC-SPD-COMPAT"
      ],
      "depends_on": [
        "TASK-SPD-EXTENSION",
        "TASK-SPD-SERVER",
        "TASK-SPD-LIVE"
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
          "path": "docs/PRIVACY.md",
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
          "path": "docs/releases/v1.14.0.md",
          "action": "create"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "action": "modify"
        }
      ],
      "status": "verified",
      "blocker": null,
      "superseded_by": null,
      "evidence": [
        "EV-SPD-CTEST-3",
        "EV-SPD-UNIT-JS-3",
        "EV-SPD-RED-RELEASE-3",
        "EV-SPD-RED-CATALOG-3",
        "EV-SPD-GATES-3",
        "EV-SPD-SMOKE-3",
        "EV-SPD-LIVE-REGRESSION-3"
      ]
    }
  ],
  "evidence": [
    {
      "id": "EV-SPD-READINESS",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the source, the 1.13.0 measurements and the research report: eleven findings (shared casts, recorded tabs, refused casts, what in view means, one factor for image and coordinates, fractional coordinates, where a presentation may be written and who may write it, a zoom that does not scroll, test output folders, a latency guard, compatibility), each resolved in the design; every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/speed/readiness-review.md",
        "sha256": "8046a0a5962a1f87f0038630aaf146f295a2db23a70c6573b59fa6809c0d920d"
      },
      "red": null,
      "reason": "Scope revision 2: the latency and matrix criteria name where their live proof runs (the Ubuntu laptop locally; Windows and macOS in the release's live job), and the review gained that finding",
      "scope_sha256": "e096a601a0b7a528becb6635729250956154e6847e3994cfd7682887949b772a",
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
      "id": "EV-SPD-READINESS-2",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the source, the 1.13.0 measurements and the research report: twelve findings (shared casts, recorded tabs, refused casts, what in view means, one factor for image and coordinates, fractional coordinates, where a presentation may be written and who may write it, a zoom that does not scroll, test output folders, a latency guard, compatibility), each resolved in the design, and where the live proof runs (finding 12); every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/speed/readiness-review.md",
        "sha256": "092cd3b3f3ab54d358b2696d77cb533c4541e8f7ef314b76c5c1f4a3c263b571"
      },
      "red": null,
      "reason": "Scope revision 3: the latency bound tightened from 1,000 to 500 ms after the live red drill passed one frame-bound scroll at 999 ms; recorded in the readiness review's addendum",
      "scope_sha256": "75f94e572a59448b83d6bb3eba0a65daddfcfb93d29fbaa7f55baf8e0f915a6c",
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
      "id": "EV-SPD-READINESS-3",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the source, the 1.13.0 measurements and the research report: twelve findings (shared casts, recorded tabs, refused casts, what in view means, one factor for image and coordinates, fractional coordinates, where a presentation may be written and who may write it, a zoom that does not scroll, test output folders, a latency guard, compatibility), each resolved in the design, and where the live proof runs (finding 12); scope revision 3 tightened the latency bound to 500 ms after its live drill (addendum); every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/speed/readiness-review.md",
        "sha256": "162aa68a22c06acc03e94c388557ae5fa591063139c50688431bea24fb01a44f"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
      "id": "EV-SPD-CTEST",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
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
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.14.0 tree: all 28 suites pass, among them test_browser_bridge_relay (the fastest of five round trips under 15 ms), test_browser_bridge (a presentation saved under a server-chosen name in CHROME_CONTROL_MCP_OUTPUT_DIR with its path and size and no image; a non-PNG refused and nothing written; a zoom's reply says which part of the view it shows; a clipped full page says so in a view and in a presentation, a whole one does not), test_browser_contract (purpose, zoom region and resolution checked; coordinates numbers, fractions kept, outside 0 to 16,384 refused; the schema says number), test_browser_mcp_server (the read-only profile refuses a presentation; the catalog within 43,500 bytes), and every JavaScript suite",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-ctest.txt",
        "sha256": "5b421c3747558590c0a668f17023ed4bd05dd936c28504c5eff9a8d87b74f626"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-GATES",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "npm",
        "run",
        "lint"
      ],
      "method": "ESLint and PSScriptAnalyzer clean over the tree, the new latency suite included; Prettier flags no file that is committed (the seven it lists are the untracked research notes in reports/ and research_notes/, which are not part of this change)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-gates.txt",
        "sha256": "8d99bf587759f41ae42de03abdad77f2fd9b8ab168981855feb0789be58731c4"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LINUX",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_speed.sh",
        "static"
      ],
      "method": "The Ubuntu 26.04.1 laptop (GCC 15.2.0, Qt 6.10.2, Clang 21.1.8): the 1.14.0 build with no warnings, ctest 27/27 (the POSIX relay's wake pipe among them), clang-tidy 21.1.8 and exhaustive cppcheck 2.19.0 clean, Semgrep 1.174.0 with no findings",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/linux-summary.txt",
        "sha256": "6ddea9869595610b1480c25ad0c8986201d553f9721fee920771d7e4cf356d73"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-FULL",
      "acceptance": [
        "AC-SPD-PRESENTATION",
        "AC-SPD-VIEW",
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/full_browser_e2e.mjs"
      ],
      "method": "The full-browser suite in Chrome for Testing 153 on the laptop: 49 tools exercised, 207 cases; across five display scales the view PNG is the viewport's CSS size and a presentation is saved as screenshot-*.png at the viewport times the scale, and a click at browser_box's screenshot_center lands.",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-full-browser.json",
        "sha256": "78a1dfd55a3d85260666ddb1aac9bbccfb1a97e85ef239464969065ac36ec873"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-LATENCY",
      "acceptance": [
        "AC-SPD-LATENCY",
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_latency_e2e.mjs"
      ],
      "method": "Chrome for Testing 153 on the laptop, the agent's tab behind the browser's own: click, hover, scroll a region by ref, scroll the page by ref and scroll the page, three times each, every one under the 500 ms bound (worst: click 30 ms, hover 51, scrolls 84, 85 and 52); browser_tabs 3 ms and the dialog read 5 at worst; 6/6",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-action-latency.json",
        "sha256": "e7d8c7e18638f0248582b9b1f6eda0881db59890f8622b4690a537c3d2be1a86"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "ce60fb9dc62496d99183b16f1bd06f53bc5db5c520e20b4422c876b0de5ec5ce",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-MATRIX",
      "acceptance": [
        "AC-SPD-MATRIX",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/display_matrix_e2e.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "--parallel=2"
      ],
      "method": "The display matrix's 35 configurations in Chrome for Testing 153 on the laptop, 3,475 checks, all passing: each screenshot taken as a view and a presentation; the presentation the viewport in device pixels with every target where the page laid it out, the reply's size matching; the view one pixel per CSS pixel within 1,568 (and a full page within 8,000); click_at, drag and screenshot_center landing on their targets through the view's factor, pinched or not; a zoom by ref the element in device pixels; a clipped full page saying so in both.",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-display-matrix.json",
        "sha256": "8526363c7e208432dbcf07703c9801ff147f2a9a8e983b71e16fc749d447e55d"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "ce60fb9dc62496d99183b16f1bd06f53bc5db5c520e20b4422c876b0de5ec5ce",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-REGRESSION",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_speed.sh",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.14.0 build: full browser, user interference, multi-agent, per-agent clipboard, large upload, extension version (current, Chrome Web Store key, older, and the released 1.11.1 extension), two profiles and the profiles upgrade (the closed-history rule: earlier plans are not re-stamped).",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/linux-summary.txt",
        "sha256": "6ddea9869595610b1480c25ad0c8986201d553f9721fee920771d7e4cf356d73"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-CATALOG",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "red",
      "status": "stale",
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
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "85ca1b5fbbe4e5453fed505be39ecc97a966ffc8d0a78981e5cda21a7dd47168"
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
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "005f49fd1d30f585e0bfb70c187441abcbd8821add65b021e0f1912b9f8e87b3"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-CLIPPED",
      "acceptance": [
        "AC-SPD-CLIPPED"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (clipped-note-dropped): the view's reply drops the note that a full page was cut. Planted, the suite failed in screenshotReply_clippedFullPageSaysSo; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "85ca1b5fbbe4e5453fed505be39ecc97a966ffc8d0a78981e5cda21a7dd47168"
      },
      "red": {
        "mutation": "the view's reply drops the note that a full page was cut",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_clippedFullPageSaysSo",
        "observed_diagnostic": "screenshotReply_clippedFullPageSaysSo",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "2fdf2c95e4bcd8b293ab370bc6ae25b3c9987515cd2873c12f86b8a5da981f89"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "dc3ed28fd6806f54c0c21bf21624a6f0220e1d3337556e6d4b0d3629d6c39a8f",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-COORDINATES",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_contract$"
      ],
      "method": "Drill (coordinates-unchecked): a coordinate outside 0 to 16,384 is passed on. Planted, the suite failed in buildCommand_screenshotCoordinatesTakeFractions; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "85ca1b5fbbe4e5453fed505be39ecc97a966ffc8d0a78981e5cda21a7dd47168"
      },
      "red": {
        "mutation": "a coordinate outside 0 to 16,384 is passed on",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_screenshotCoordinatesTakeFractions",
        "observed_diagnostic": "buildCommand_screenshotCoordinatesTakeFractions",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "bb2c8e76c5e950c1e1100d5139766763ec390204757fc2df673486b0136240c3"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-FRAMES",
      "acceptance": [
        "AC-SPD-FRAMES"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (frames-never-start): the cast that keeps the tab drawing never starts. Planted, the suite failed in an input-driven command runs with the tab compositing, and the cast ends with it; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the cast that keeps the tab drawing never starts",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an input-driven command runs with the tab compositing, and the cast ends with it",
        "observed_diagnostic": "an input-driven command runs with the tab compositing, and the cast ends with it",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "4cea970ab44d99261b66d4b1cfdff5705b2ebab8170cdcf35a8e3738d4bd8eca"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2407b988714d777b2b5eb990ef9d1d91bc51b93e99e52ce0e7bb13ba0e2895f6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-INVIEW",
      "acceptance": [
        "AC-SPD-INVIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (in-view-ignored): an element already in view is scrolled and settled anyway. Planted, the suite failed in an element wholly in view is acted on where it stands; one that is not is scrolled to first; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "an element already in view is scrolled and settled anyway",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an element wholly in view is acted on where it stands; one that is not is scrolled to first",
        "observed_diagnostic": "an element wholly in view is acted on where it stands; one that is not is scrolled to first",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9337507c414890f0da68483ec1a28dd2488e88b1345b76f1dc02e7230fa93f91"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2407b988714d777b2b5eb990ef9d1d91bc51b93e99e52ce0e7bb13ba0e2895f6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LETTERBOX",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_offscreen.mjs"
      ],
      "method": "Drill (offscreen-stretch): a frame of another shape is scaled to the canvas's width, not fitted. Planted, the suite failed in a frame of another shape keeps its own, on black, rather than being stretched; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a frame of another shape is scaled to the canvas's width, not fitted",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a frame of another shape keeps its own, on black, rather than being stretched",
        "observed_diagnostic": "a frame of another shape keeps its own, on black, rather than being stretched",
        "before": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
          }
        ],
        "after": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "044456c22598bd4261be393f2f4ffbfde0bcb8d204866c86cd097023c398e226"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LIVE-LATENCY",
      "acceptance": [
        "AC-SPD-LATENCY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_latency_e2e.mjs"
      ],
      "method": "Drill (latency-frames-never-start): in real Chrome, the cast that keeps the agent's tab drawing never starts (each kind of scroll then took 1,066 to 3,083 ms at worst). Planted, the suite failed in scroll the page by ref replies without waiting for a background frame; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-red-drills.txt",
        "sha256": "f04bad8da5d0d3497358756d86693e4cdccef02eeff9f42db40c98ffea2ddd9e"
      },
      "red": {
        "mutation": "in real Chrome, the cast that keeps the agent's tab drawing never starts (each kind of scroll then took 1,066 to 3,083 ms at worst)",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "scroll the page by ref replies without waiting for a background frame",
        "observed_diagnostic": "scroll the page by ref replies without waiting for a background frame",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "4cea970ab44d99261b66d4b1cfdff5705b2ebab8170cdcf35a8e3738d4bd8eca"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "ce60fb9dc62496d99183b16f1bd06f53bc5db5c520e20b4422c876b0de5ec5ce",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LIVE-MATRIX",
      "acceptance": [
        "AC-SPD-MATRIX"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/display_matrix_e2e.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "--only=2x-1440x900-zoom100-overlay"
      ],
      "method": "Drill (matrix-point-factor-ignored): in real Chrome at 2x, click_at converts a view pixel as a device pixel. Planted, the suite failed in click_at on target mid's pixels hits it; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-red-drills.txt",
        "sha256": "f04bad8da5d0d3497358756d86693e4cdccef02eeff9f42db40c98ffea2ddd9e"
      },
      "red": {
        "mutation": "in real Chrome at 2x, click_at converts a view pixel as a device pixel",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "click_at on target mid's pixels hits it",
        "observed_diagnostic": "click_at on target mid's pixels hits it",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a52f1ade4acc480a19787b5b252cf15c0dd44494f07a6c907fa5a6b594c5d807"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "ce60fb9dc62496d99183b16f1bd06f53bc5db5c520e20b4422c876b0de5ec5ce",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-POINT",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (point-factor-ignored): click_at converts a view pixel as a device pixel. Planted, the suite failed in browser_click_at reads a view's pixels back through the factor it was shrunk by; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "click_at converts a view pixel as a device pixel",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "browser_click_at reads a view's pixels back through the factor it was shrunk by",
        "observed_diagnostic": "browser_click_at reads a view's pixels back through the factor it was shrunk by",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a52f1ade4acc480a19787b5b252cf15c0dd44494f07a6c907fa5a6b594c5d807"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-PRESENTATION",
      "acceptance": [
        "AC-SPD-PRESENTATION"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (presentation-not-saved): a presentation is not written to a file. Planted, the suite failed in screenshotReply_presentationIsSavedNotShown; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "85ca1b5fbbe4e5453fed505be39ecc97a966ffc8d0a78981e5cda21a7dd47168"
      },
      "red": {
        "mutation": "a presentation is not written to a file",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_presentationIsSavedNotShown",
        "observed_diagnostic": "screenshotReply_presentationIsSavedNotShown",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "98d36556359b5ec938b1aab05cd653ff9309f58fd2b1c2917a3a2cae24cb1189"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "ce60fb9dc62496d99183b16f1bd06f53bc5db5c520e20b4422c876b0de5ec5ce",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-READ-ONLY",
      "acceptance": [
        "AC-SPD-PRESENTATION"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_mcp_server$"
      ],
      "method": "Drill (read-only-presentation): the read-only profile lets a presentation write its file. Planted, the suite failed in readOnlyRefusesAPresentationScreenshot; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "85ca1b5fbbe4e5453fed505be39ecc97a966ffc8d0a78981e5cda21a7dd47168"
      },
      "red": {
        "mutation": "the read-only profile lets a presentation write its file",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "readOnlyRefusesAPresentationScreenshot",
        "observed_diagnostic": "readOnlyRefusesAPresentationScreenshot",
        "before": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
          }
        ],
        "after": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
          }
        ],
        "mutated": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "dea303dcb9d7091308e2219f16b6ae642e8507d642d1528590e26f145b2b876d"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "ce60fb9dc62496d99183b16f1bd06f53bc5db5c520e20b4422c876b0de5ec5ce",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORD-ENCODER",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_recording.mjs"
      ],
      "method": "Drill (record-encoder-fixed): the encoder's canvas is 1280x800 whatever the frames. Planted, the suite failed in a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the encoder's canvas is 1280x800 whatever the frames",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel",
        "observed_diagnostic": "a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6e7af34b51630141b607fd03c64a953e5802c7de3766db00926cef90fb4fcfbf"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORD-FRAME",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (record-frame-stretched): a standard recording is sized at the device's pixels. Planted, the suite failed in a recording's frames keep the viewport's shape, in even pixels; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a standard recording is sized at the device's pixels",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a recording's frames keep the viewport's shape, in even pixels",
        "observed_diagnostic": "a recording's frames keep the viewport's shape, in even pixels",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "779a2fefb5c68409e4f32c7e088b58dee367116c2cfaf2d7f8de69d6a2c8980a"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORDED",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (recorded-tab-cast): a tab a recording films gets a forcing cast of its own. Planted, the suite failed in a tab a recording is filming keeps the recording's cast: none started, none stopped; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a tab a recording films gets a forcing cast of its own",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a tab a recording is filming keeps the recording's cast: none started, none stopped",
        "observed_diagnostic": "a tab a recording is filming keeps the recording's cast: none started, none stopped",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "40b219bf33f65fa1dc92208742a7282f28185b19e62e457a7bd0fe729681a19f"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELAY-POSIX",
      "acceptance": [
        "AC-SPD-RELAY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_bridge_relay"
      ],
      "method": "Drill (relay-wake-posix): the POSIX relay's reader no longer writes to its wake pipe. Planted, the suite failed in relay_answersAsSoonAsTheReplyIsIn; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/unit-red-drills.txt",
        "sha256": "a609c93157d230359db1a67e5fa1e67f4d1df0fde16a9f3b875beffaae6756fb"
      },
      "red": {
        "mutation": "the POSIX relay's reader no longer writes to its wake pipe",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "observed_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "before": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "a02c6408ff40d67d6180edd4bbba8dbd3d6080391b4411282c93a52abaee2a8c"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "dc3ed28fd6806f54c0c21bf21624a6f0220e1d3337556e6d4b0d3629d6c39a8f",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELAY-WIN",
      "acceptance": [
        "AC-SPD-RELAY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge_relay$"
      ],
      "method": "Drill (relay-wake-windows): the Windows relay's reader no longer wakes the loop. Planted, the suite failed in relay_answersAsSoonAsTheReplyIsIn; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "85ca1b5fbbe4e5453fed505be39ecc97a966ffc8d0a78981e5cda21a7dd47168"
      },
      "red": {
        "mutation": "the Windows relay's reader no longer wakes the loop",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "observed_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "before": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "6c4d425074cec4171791a11cc0d1f644683e5f17fa23f15e9e8a5521f6b52504"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "dc3ed28fd6806f54c0c21bf21624a6f0220e1d3337556e6d4b0d3629d6c39a8f",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELEASE",
      "acceptance": [
        "AC-SPD-RELEASE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_release_versions.mjs"
      ],
      "method": "Drill (release-version): the extension's manifest is left at 1.13.0. Planted, the suite failed in every file that states the version states the same one; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the extension's manifest is left at 1.13.0",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "every file that states the version states the same one",
        "observed_diagnostic": "every file that states the version states the same one",
        "before": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ],
        "after": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-VIEW-CAP",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (view-cap-whole-viewport): the cap ignores the CSS pixel a capture can run past the viewport. Planted, the suite failed in a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the cap ignores the CSS pixel a capture can run past the viewport",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "observed_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "86ca2ba4fa9334ec39d6ac25cf0ab4c97bd49f2105d53240dfab3c1901162cca"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-VIEW-DPR",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (view-factor-device): the view keeps device pixels below the cap. Planted, the suite failed in a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the view keeps device pixels below the cap",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "observed_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "b8be6cf2b323c100d28bc1670d391975e4be79d9efc7c41bc900e2ce79314b35"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-ZOOM",
      "acceptance": [
        "AC-SPD-ZOOM"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (zoom-crop-unscaled): a zoom region is cropped as device pixels, not view pixels. Planted, the suite failed in a zoom crops the device-pixel capture, clamped to it, at up to its own pixels; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a zoom region is cropped as device pixels, not view pixels",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a zoom crops the device-pixel capture, clamped to it, at up to its own pixels",
        "observed_diagnostic": "a zoom crops the device-pixel capture, clamped to it, at up to its own pixels",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "5e39a293c803e51fb51fbd5602fd06d8e43da2ba7fc7965e78cb8a82ca91f1d5"
          }
        ]
      },
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "2617f89eb1b18228ef1d3a772d443565fa74377d250450e30eced299c5a2853e",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-SMOKE",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test in both profiles: 54 tools in full and 15 read-only, unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-smoke.txt",
        "sha256": "8f381b739f67e15bf466ff810149c5497c1711371886a85518f0c59729e56927"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-UNIT-JS",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-RECORD",
        "AC-SPD-RELEASE",
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 14 JavaScript suites, 274 tests: frames kept drawing during an action, shared by overlapping work, left alone on a recorded tab, and a refused cast tolerated; an element wholly in view acted on without a scroll, a hidden one scrolled first, and the in-page check across clipping ancestors and shadow hosts; the view's factor (CSS pixels, the 1,568 cap allowing for a capture a CSS pixel past the viewport, never enlarged), the full-page factor, zoom crops, click_at's conversion through the factor; the recording's resolution, frame size, encoder and screencast sizes, and letterboxing in the recorder; the version in every file; every earlier suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-test-js.txt",
        "sha256": "fb90bb1d393374f1f5619d2b89ffa42359bf6a1aa324532da95120ae3a8fcc0a"
      },
      "red": null,
      "reason": "Closure found no server-side red proof for AC-SPD-ZOOM and AC-SPD-RECORD; a contract test for the recording's resolution and two drills were added, changing tests/test_browser_contract.cpp, so every check was run again",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "6bc17d376afca220e37d7b0d4355a1f23e1fee22c80e0eedb5b2a21bdaefd55b"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "5c3fc445f05aa7ef2fdaa79f9667040616fc2d43cd7a8b275229f8166c9b6910"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "c6cfffc5f3c55e7d4d64c9e7a2dd322fc551cc86274a82ad7ef4c7c393284e1d"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "5af48b2e8103d9109107bf8b5176dc2b0d8ff0d66661806f1211bd12027ae122"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-READINESS-4",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the source, the 1.13.0 measurements and the research report: twelve findings (shared casts, recorded tabs, refused casts, what in view means, one factor for image and coordinates, fractional coordinates, where a presentation may be written and who may write it, a zoom that does not scroll, test output folders, a latency guard, compatibility), each resolved in the design, and where the live proof runs (finding 12); scope revision 3 tightened the latency bound to 500 ms after its live drill (addendum); a later addendum adds the server's red proof for the zoom note and the resolution check; every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/speed/readiness-review.md",
        "sha256": "f1f991d3423293f88276d578e55a3726e000560c5bf9adcc507521d8c0e40c84"
      },
      "red": null,
      "reason": "Scope revision 4: the relay's tick became a parameter so its round-trip case holds under load; two relay paths joined TASK-SPD-SERVER and AC-SPD-RELAY's wording changed; recorded in the readiness review's addendum",
      "scope_sha256": "48c978f4d55ba772bfadbf481657ac712bb094e864cdd5281abc07177aa07de4",
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
      "id": "EV-SPD-READINESS-5",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the source, the 1.13.0 measurements and the research report: twelve findings (shared casts, recorded tabs, refused casts, what in view means, one factor for image and coordinates, fractional coordinates, where a presentation may be written and who may write it, a zoom that does not scroll, test output folders, a latency guard, compatibility), each resolved in the design, and where the live proof runs (finding 12); scope revision 3 tightened the latency bound to 500 ms after its live drill (addendum); a later addendum adds the server's red proof for the zoom note and the resolution check; scope revision 4 lengthens the relay tick under test so its case holds under load; every criterion mapped to tasks, behaviour proof and a red drill",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/speed/readiness-review.md",
        "sha256": "422ac9ac4500356f7a3c70d49f95280c8a4c6af7030a0eb562d56424dab3ec6b"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
      "id": "EV-SPD-CTEST-2",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
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
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.14.0 tree: all 28 suites pass, among them test_browser_bridge_relay (with the relay's tick lengthened to a second, the fastest of three round trips under 500 ms), test_browser_bridge (a presentation saved under a server-chosen name in CHROME_CONTROL_MCP_OUTPUT_DIR with its path and size and no image; a non-PNG refused and nothing written; a zoom's reply says which part of the view it shows; a clipped full page says so in a view and in a presentation, a whole one does not), test_browser_contract (purpose and zoom region checked; a recording's resolution standard or full and nothing else; coordinates numbers, fractions kept, outside 0 to 16,384 refused; the schema says number), test_browser_mcp_server (the read-only profile refuses a presentation; the catalog within 43,500 bytes), and every JavaScript suite",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-ctest.txt",
        "sha256": "1919242c3c1a9bff42bd5e66d10f5f1598597c5a5cccabdee85f7228b3b7582b"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-GATES-2",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "npm",
        "run",
        "lint"
      ],
      "method": "ESLint and PSScriptAnalyzer clean over the tree, the new latency suite included; Prettier flags no file that is committed (the seven it lists are the untracked research notes in reports/ and research_notes/, which are not part of this change)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-gates.txt",
        "sha256": "a384ce38863ad0108f3ed4886ae8c7f46ec07b769bd2e4b7218be1ad58a6ee06"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LINUX-2",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-RELEASE"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_speed.sh",
        "static"
      ],
      "method": "The Ubuntu 26.04.1 laptop (GCC 15.2.0, Qt 6.10.2, Clang 21.1.8): the 1.14.0 build with no warnings, ctest 27/27 (the POSIX relay's wake pipe among them), clang-tidy 21.1.8 and exhaustive cppcheck 2.19.0 clean, Semgrep 1.174.0 with no findings",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/linux-summary.txt",
        "sha256": "a34a4ef58a1ec1f39c716b3f1d5aed9506a77a1baafccd0345b32e75cd39748e"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-FULL-2",
      "acceptance": [
        "AC-SPD-PRESENTATION",
        "AC-SPD-VIEW",
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/full_browser_e2e.mjs"
      ],
      "method": "The full-browser suite in Chrome for Testing 153 on the laptop: 49 tools exercised, 207 cases; across five display scales the view PNG is the viewport's CSS size and a presentation is saved as screenshot-*.png at the viewport times the scale, and a click at browser_box's screenshot_center lands.",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-full-browser.json",
        "sha256": "3f22999bcdbf43ccc1854e76bb311d7b511379287716b5a6aa3507369844ce38"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-LATENCY-2",
      "acceptance": [
        "AC-SPD-LATENCY",
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_latency_e2e.mjs"
      ],
      "method": "Chrome for Testing 153 on the laptop, the agent's tab behind the browser's own: click, hover, scroll a region by ref, scroll the page by ref and scroll the page, three times each, every one under the 500 ms bound (worst: click 42 ms, hover 63, scrolls 97, 97 and 51); browser_tabs 3 ms and the dialog read 4 at worst; 6/6",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-action-latency.json",
        "sha256": "6d507e9788c002560a5d5a8bfdd7195519206f84548b54987cc5a09dd20b52c6"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "27e4944152989ed0b328769004516b757d5a3241ddd34617b929d8c871ff633e",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-MATRIX-2",
      "acceptance": [
        "AC-SPD-MATRIX",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/display_matrix_e2e.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "--parallel=2"
      ],
      "method": "The display matrix's 35 configurations in Chrome for Testing 153 on the laptop, 3,475 checks, all passing: each screenshot taken as a view and a presentation; the presentation the viewport in device pixels with every target where the page laid it out, the reply's size matching; the view one pixel per CSS pixel within 1,568 (and a full page within 8,000); click_at, drag and screenshot_center landing on their targets through the view's factor, pinched or not; a zoom by ref the element in device pixels; a clipped full page saying so in both.",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-display-matrix.json",
        "sha256": "fe119417fc57f4767eb85caf56d9c69076a392b298bb91012af38fa7f2f8a95e"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "27e4944152989ed0b328769004516b757d5a3241ddd34617b929d8c871ff633e",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-REGRESSION-2",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_speed.sh",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.14.0 build: full browser, user interference, multi-agent, per-agent clipboard, large upload, extension version (current, Chrome Web Store key, older, and the released 1.11.1 extension), two profiles and the profiles upgrade (the closed-history rule: earlier plans are not re-stamped).",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/linux-summary.txt",
        "sha256": "a34a4ef58a1ec1f39c716b3f1d5aed9506a77a1baafccd0345b32e75cd39748e"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-CATALOG-2",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "red",
      "status": "stale",
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
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
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
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "005f49fd1d30f585e0bfb70c187441abcbd8821add65b021e0f1912b9f8e87b3"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-CLIPPED-2",
      "acceptance": [
        "AC-SPD-CLIPPED"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (clipped-note-dropped): the view's reply drops the note that a full page was cut. Planted, the suite failed in screenshotReply_clippedFullPageSaysSo; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "the view's reply drops the note that a full page was cut",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_clippedFullPageSaysSo",
        "observed_diagnostic": "screenshotReply_clippedFullPageSaysSo",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "2fdf2c95e4bcd8b293ab370bc6ae25b3c9987515cd2873c12f86b8a5da981f89"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "9b016b811e877681dcde7ce95d3db73d6565f3c28a63dfdcd42a50c928ee6f55",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-COORDINATES-2",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_contract$"
      ],
      "method": "Drill (coordinates-unchecked): a coordinate outside 0 to 16,384 is passed on. Planted, the suite failed in buildCommand_screenshotCoordinatesTakeFractions; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "a coordinate outside 0 to 16,384 is passed on",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_screenshotCoordinatesTakeFractions",
        "observed_diagnostic": "buildCommand_screenshotCoordinatesTakeFractions",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "bb2c8e76c5e950c1e1100d5139766763ec390204757fc2df673486b0136240c3"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-FRAMES-2",
      "acceptance": [
        "AC-SPD-FRAMES"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (frames-never-start): the cast that keeps the tab drawing never starts. Planted, the suite failed in an input-driven command runs with the tab compositing, and the cast ends with it; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the cast that keeps the tab drawing never starts",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an input-driven command runs with the tab compositing, and the cast ends with it",
        "observed_diagnostic": "an input-driven command runs with the tab compositing, and the cast ends with it",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "4cea970ab44d99261b66d4b1cfdff5705b2ebab8170cdcf35a8e3738d4bd8eca"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2407b988714d777b2b5eb990ef9d1d91bc51b93e99e52ce0e7bb13ba0e2895f6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-INVIEW-2",
      "acceptance": [
        "AC-SPD-INVIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (in-view-ignored): an element already in view is scrolled and settled anyway. Planted, the suite failed in an element wholly in view is acted on where it stands; one that is not is scrolled to first; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "an element already in view is scrolled and settled anyway",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an element wholly in view is acted on where it stands; one that is not is scrolled to first",
        "observed_diagnostic": "an element wholly in view is acted on where it stands; one that is not is scrolled to first",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9337507c414890f0da68483ec1a28dd2488e88b1345b76f1dc02e7230fa93f91"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2407b988714d777b2b5eb990ef9d1d91bc51b93e99e52ce0e7bb13ba0e2895f6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LETTERBOX-2",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_offscreen.mjs"
      ],
      "method": "Drill (offscreen-stretch): a frame of another shape is scaled to the canvas's width, not fitted. Planted, the suite failed in a frame of another shape keeps its own, on black, rather than being stretched; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a frame of another shape is scaled to the canvas's width, not fitted",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a frame of another shape keeps its own, on black, rather than being stretched",
        "observed_diagnostic": "a frame of another shape keeps its own, on black, rather than being stretched",
        "before": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
          }
        ],
        "after": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "044456c22598bd4261be393f2f4ffbfde0bcb8d204866c86cd097023c398e226"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LIVE-LATENCY-2",
      "acceptance": [
        "AC-SPD-LATENCY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_latency_e2e.mjs"
      ],
      "method": "Drill (latency-frames-never-start): in real Chrome, the cast that keeps the agent's tab drawing never starts (each kind of scroll then took 1,068 to 3,092 ms at worst). Planted, the suite failed in scroll the page by ref replies without waiting for a background frame; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-red-drills.txt",
        "sha256": "ed9f7b74eccb74e2549c4eadd985ad596327853ce28692cd2dbef48983f1a563"
      },
      "red": {
        "mutation": "in real Chrome, the cast that keeps the agent's tab drawing never starts (each kind of scroll then took 1,068 to 3,092 ms at worst)",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "scroll the page by ref replies without waiting for a background frame",
        "observed_diagnostic": "scroll the page by ref replies without waiting for a background frame",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "4cea970ab44d99261b66d4b1cfdff5705b2ebab8170cdcf35a8e3738d4bd8eca"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "27e4944152989ed0b328769004516b757d5a3241ddd34617b929d8c871ff633e",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LIVE-MATRIX-2",
      "acceptance": [
        "AC-SPD-MATRIX"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/display_matrix_e2e.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "--only=2x-1440x900-zoom100-overlay"
      ],
      "method": "Drill (matrix-point-factor-ignored): in real Chrome at 2x, click_at converts a view pixel as a device pixel. Planted, the suite failed in click_at on target mid's pixels hits it; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-red-drills.txt",
        "sha256": "ed9f7b74eccb74e2549c4eadd985ad596327853ce28692cd2dbef48983f1a563"
      },
      "red": {
        "mutation": "in real Chrome at 2x, click_at converts a view pixel as a device pixel",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "click_at on target mid's pixels hits it",
        "observed_diagnostic": "click_at on target mid's pixels hits it",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a52f1ade4acc480a19787b5b252cf15c0dd44494f07a6c907fa5a6b594c5d807"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "27e4944152989ed0b328769004516b757d5a3241ddd34617b929d8c871ff633e",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-POINT-2",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (point-factor-ignored): click_at converts a view pixel as a device pixel. Planted, the suite failed in browser_click_at reads a view's pixels back through the factor it was shrunk by; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "click_at converts a view pixel as a device pixel",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "browser_click_at reads a view's pixels back through the factor it was shrunk by",
        "observed_diagnostic": "browser_click_at reads a view's pixels back through the factor it was shrunk by",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "a52f1ade4acc480a19787b5b252cf15c0dd44494f07a6c907fa5a6b594c5d807"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-PRESENTATION-2",
      "acceptance": [
        "AC-SPD-PRESENTATION"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (presentation-not-saved): a presentation is not written to a file. Planted, the suite failed in screenshotReply_presentationIsSavedNotShown; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "a presentation is not written to a file",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_presentationIsSavedNotShown",
        "observed_diagnostic": "screenshotReply_presentationIsSavedNotShown",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "98d36556359b5ec938b1aab05cd653ff9309f58fd2b1c2917a3a2cae24cb1189"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "27e4944152989ed0b328769004516b757d5a3241ddd34617b929d8c871ff633e",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-READ-ONLY-2",
      "acceptance": [
        "AC-SPD-PRESENTATION"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_mcp_server$"
      ],
      "method": "Drill (read-only-presentation): the read-only profile lets a presentation write its file. Planted, the suite failed in readOnlyRefusesAPresentationScreenshot; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "the read-only profile lets a presentation write its file",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "readOnlyRefusesAPresentationScreenshot",
        "observed_diagnostic": "readOnlyRefusesAPresentationScreenshot",
        "before": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
          }
        ],
        "after": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
          }
        ],
        "mutated": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "dea303dcb9d7091308e2219f16b6ae642e8507d642d1528590e26f145b2b876d"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "27e4944152989ed0b328769004516b757d5a3241ddd34617b929d8c871ff633e",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORD-ENCODER-2",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_recording.mjs"
      ],
      "method": "Drill (record-encoder-fixed): the encoder's canvas is 1280x800 whatever the frames. Planted, the suite failed in a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the encoder's canvas is 1280x800 whatever the frames",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel",
        "observed_diagnostic": "a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6e7af34b51630141b607fd03c64a953e5802c7de3766db00926cef90fb4fcfbf"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORD-FRAME-2",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (record-frame-stretched): a standard recording is sized at the device's pixels. Planted, the suite failed in a recording's frames keep the viewport's shape, in even pixels; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a standard recording is sized at the device's pixels",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a recording's frames keep the viewport's shape, in even pixels",
        "observed_diagnostic": "a recording's frames keep the viewport's shape, in even pixels",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "779a2fefb5c68409e4f32c7e088b58dee367116c2cfaf2d7f8de69d6a2c8980a"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORDED-2",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (recorded-tab-cast): a tab a recording films gets a forcing cast of its own. Planted, the suite failed in a tab a recording is filming keeps the recording's cast: none started, none stopped; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a tab a recording films gets a forcing cast of its own",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a tab a recording is filming keeps the recording's cast: none started, none stopped",
        "observed_diagnostic": "a tab a recording is filming keeps the recording's cast: none started, none stopped",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "40b219bf33f65fa1dc92208742a7282f28185b19e62e457a7bd0fe729681a19f"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELAY-POSIX-2",
      "acceptance": [
        "AC-SPD-RELAY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "./build/test_browser_bridge_relay"
      ],
      "method": "Drill (relay-wake-posix): the POSIX relay's reader no longer writes to its wake pipe. Planted, the suite failed in relay_answersAsSoonAsTheReplyIsIn; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/unit-red-drills.txt",
        "sha256": "7ed1b6ae7357e88e559e8162de51853c6e543e2e29b09823825ac2ff029a8654"
      },
      "red": {
        "mutation": "the POSIX relay's reader no longer writes to its wake pipe",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "observed_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "before": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "64d47a61de27e057966453be7fa16c98331f25b5e6297cb750e791078224301f"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "9b016b811e877681dcde7ce95d3db73d6565f3c28a63dfdcd42a50c928ee6f55",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELAY-WIN-2",
      "acceptance": [
        "AC-SPD-RELAY"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge_relay$"
      ],
      "method": "Drill (relay-wake-windows): the Windows relay's reader no longer wakes the loop. Planted, the suite failed in relay_answersAsSoonAsTheReplyIsIn; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "the Windows relay's reader no longer wakes the loop",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "observed_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "before": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "41ff02ae792a60265441339da17164dfb47b6126a6aab0d326ff94f1498d4692"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "9b016b811e877681dcde7ce95d3db73d6565f3c28a63dfdcd42a50c928ee6f55",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELEASE-2",
      "acceptance": [
        "AC-SPD-RELEASE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_release_versions.mjs"
      ],
      "method": "Drill (release-version): the extension's manifest is left at 1.13.0. Planted, the suite failed in every file that states the version states the same one; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the extension's manifest is left at 1.13.0",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "every file that states the version states the same one",
        "observed_diagnostic": "every file that states the version states the same one",
        "before": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ],
        "after": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RESOLUTION-2",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_contract$"
      ],
      "method": "Drill (resolution-unchecked): an unknown recording resolution is passed on to the extension. Planted, the suite failed in buildCommand_recordStartResolution; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "an unknown recording resolution is passed on to the extension",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_recordStartResolution",
        "observed_diagnostic": "buildCommand_recordStartResolution",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "3b9a3f954e554cc2801161064c01c3ff0ac586850aa4f807655fbbd9318207db"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-VIEW-CAP-2",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (view-cap-whole-viewport): the cap ignores the CSS pixel a capture can run past the viewport. Planted, the suite failed in a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the cap ignores the CSS pixel a capture can run past the viewport",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "observed_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "86ca2ba4fa9334ec39d6ac25cf0ab4c97bd49f2105d53240dfab3c1901162cca"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-VIEW-DPR-2",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (view-factor-device): the view keeps device pixels below the cap. Planted, the suite failed in a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "the view keeps device pixels below the cap",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "observed_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "b8be6cf2b323c100d28bc1670d391975e4be79d9efc7c41bc900e2ce79314b35"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-ZOOM-2",
      "acceptance": [
        "AC-SPD-ZOOM"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (zoom-crop-unscaled): a zoom region is cropped as device pixels, not view pixels. Planted, the suite failed in a zoom crops the device-pixel capture, clamped to it, at up to its own pixels; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "f94a8ab0621416157acb7b80bae8f60f48c84729bdd7a7496e7814088f852a01"
      },
      "red": {
        "mutation": "a zoom region is cropped as device pixels, not view pixels",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a zoom crops the device-pixel capture, clamped to it, at up to its own pixels",
        "observed_diagnostic": "a zoom crops the device-pixel capture, clamped to it, at up to its own pixels",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "5e39a293c803e51fb51fbd5602fd06d8e43da2ba7fc7965e78cb8a82ca91f1d5"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-ZOOM-NOTE-2",
      "acceptance": [
        "AC-SPD-ZOOM"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge$"
      ],
      "method": "Drill (zoom-note-dropped): a zoom's reply no longer says which part of the view it shows. Planted, the suite failed in screenshotReply_zoomSaysWhatItShows; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "b54e05958439bace2785bb29faa0559f02c5de042959e4bed0d315d88478cf07"
      },
      "red": {
        "mutation": "a zoom's reply no longer says which part of the view it shows",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_zoomSaysWhatItShows",
        "observed_diagnostic": "screenshotReply_zoomSaysWhatItShows",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "9f2e2402295af14259d391f0261f0a592620424bdf157c7c1e5ff8ec1f9d7648"
          }
        ]
      },
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "2543e5ebecda4b07c74370701141b5ac4e2dbe78c4673cd8c5d25fde03b0eee6",
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
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-SMOKE-2",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test in both profiles: 54 tools in full and 15 read-only, unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-smoke.txt",
        "sha256": "8f381b739f67e15bf466ff810149c5497c1711371886a85518f0c59729e56927"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-UNIT-JS-2",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-RECORD",
        "AC-SPD-RELEASE",
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 14 JavaScript suites, 274 tests: frames kept drawing during an action, shared by overlapping work, left alone on a recorded tab, and a refused cast tolerated; an element wholly in view acted on without a scroll, a hidden one scrolled first, and the in-page check across clipping ancestors and shadow hosts; the view's factor (CSS pixels, the 1,568 cap allowing for a capture a CSS pixel past the viewport, never enlarged), the full-page factor, zoom crops, click_at's conversion through the factor; the recording's resolution, frame size, encoder and screencast sizes, and letterboxing in the recorder; the version in every file; every earlier suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-test-js.txt",
        "sha256": "78852f1d2f4b05cc5d80866e4e639dc68e13088de4876dddfcaf22608245f52e"
      },
      "red": null,
      "reason": "Scope revision 5: the release's live job found a popup going to the wrong agent and a harness race; the extension, the live suites and the docs changed, so every check was run again",
      "scope_sha256": "3915e7bd2e5a1f62802c00b9804f57ca415a14b6fca09847e08c96ff1fb6407d",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "033aee9325470c649485aafa5827b4fcbb60d3fb8d168899acc33431734e911d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "47024c0fb29a79ae92a3dda84544ab8a5040d5673b8ce48866212c43216bd81e"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "0776be3dbb2ae9e67a82c21211effcac5e0257f2353f3ee035a1c5561e35df9f"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "96af66146e25c3d9f4366295185236881ad390716d1ae2a4d870c7b720ddccb9"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "c957e5352ea8bfb3e5d77d043ef675d4f17702c4260eef5d38bbd4afeb35812c"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "3f48eab2019442cef315ca5e89fdf199a44528008b34452822918ae8e04f4290"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-READINESS-6",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-LATENCY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-MATRIX",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-POPUP",
        "AC-SPD-RELEASE"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Requirements reviewed against the source, the 1.13.0 measurements and the research report: twelve findings (shared casts, recorded tabs, refused casts, what in view means, one factor for image and coordinates, fractional coordinates, where a presentation may be written and who may write it, a zoom that does not scroll, test output folders, a latency guard, compatibility), each resolved in the design, and where the live proof runs (finding 12); scope revision 3 tightened the latency bound to 500 ms after its live drill (addendum); a later addendum adds the server's red proof for the zoom note and the resolution check; scope revision 4 lengthens the relay tick under test so its case holds under load; every criterion mapped to tasks, behaviour proof and a red drill; scope revision 5 adds AC-SPD-POPUP and records what the release's live job found (addendum)",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/speed/readiness-review.md",
        "sha256": "e2063f66869ed51ff5cd4ff9d2de096fe367e521931466855c85e72d6a44618b"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
      "id": "EV-SPD-CTEST-3",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-POPUP",
        "AC-SPD-RELEASE"
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
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.14.0 tree: all 28 suites pass, among them test_browser_bridge_relay (with the relay's tick lengthened to a second, the fastest of three round trips under 500 ms), test_browser_bridge (a presentation saved under a server-chosen name in CHROME_CONTROL_MCP_OUTPUT_DIR with its path and size and no image; a non-PNG refused and nothing written; a zoom's reply says which part of the view it shows; a clipped full page says so in a view and in a presentation, a whole one does not), test_browser_contract (purpose and zoom region checked; a recording's resolution standard or full and nothing else; coordinates numbers, fractions kept, outside 0 to 16,384 refused; the schema says number), test_browser_mcp_server (the read-only profile refuses a presentation; the catalog within 43,500 bytes), and every JavaScript suite, among them the tabs suite's two-agent popup case",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-ctest.txt",
        "sha256": "614784664a4f44acce63dbe07663cfc87a3739b699e43d4820718491ff5347c1"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-GATES-3",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "lint"
      ],
      "method": "ESLint and PSScriptAnalyzer clean over the tree, the new latency suite included; Prettier flags no file that is committed (the seven it lists are the untracked research notes in reports/ and research_notes/, which are not part of this change)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-gates.txt",
        "sha256": "a384ce38863ad0108f3ed4886ae8c7f46ec07b769bd2e4b7218be1ad58a6ee06"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LINUX-3",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED",
        "AC-SPD-RECORD",
        "AC-SPD-COMPAT",
        "AC-SPD-POPUP",
        "AC-SPD-RELEASE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_speed.sh",
        "static"
      ],
      "method": "The Ubuntu 26.04.1 laptop (GCC 15.2.0, Qt 6.10.2, Clang 21.1.8): the 1.14.0 build with no warnings, ctest 27/27 (the POSIX relay's wake pipe among them), clang-tidy 21.1.8 and exhaustive cppcheck 2.19.0 clean, Semgrep 1.174.0 with no findings",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/linux-summary.txt",
        "sha256": "6184ceaeb9b408b4f040f6ac2139ca2708c8a7d41c82697949dc22bff2167100"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-FULL-3",
      "acceptance": [
        "AC-SPD-PRESENTATION",
        "AC-SPD-VIEW",
        "AC-SPD-COMPAT"
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
      "method": "The full-browser suite in Chrome for Testing 153 on the laptop: 49 tools exercised, 207 cases; across five display scales the view PNG is the viewport's CSS size and a presentation is saved as screenshot-*.png at the viewport times the scale, and a click at browser_box's screenshot_center lands.",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-full-browser.json",
        "sha256": "12a414f628c1ac1b60b4f0f523da3d67691605d52e64ab9fc41f349e86b3c570"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-LATENCY-3",
      "acceptance": [
        "AC-SPD-LATENCY",
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-RELAY"
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
      "method": "Chrome for Testing 153 on the laptop, the agent's tab behind the browser's own: click, hover, scroll a region by ref, scroll the page by ref and scroll the page back up, three times each, every one under the 500 ms bound (worst: click 34 ms, hover 50, scrolls 83, 82 and 51); browser_tabs 2 ms and the dialog read 4 at worst; each scroll's reply says how far it moved and that it settled; 6/6",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-action-latency.json",
        "sha256": "dea9219e4f287c987a988231c650feee2630e5dd960645f5b31d2761553f942e"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-MATRIX-3",
      "acceptance": [
        "AC-SPD-MATRIX",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-PRESENTATION",
        "AC-SPD-CLIPPED"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/display_matrix_e2e.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "--parallel=2"
      ],
      "method": "The display matrix's 35 configurations in Chrome for Testing 153 on the laptop, 3,475 checks, all passing: each screenshot taken as a view and a presentation; the presentation the viewport in device pixels with every target where the page laid it out, the reply's size matching; the view one pixel per CSS pixel within 1,568 (and a full page within 8,000); click_at, drag and screenshot_center landing on their targets through the view's factor, pinched or not; a zoom by ref the element in device pixels; a clipped full page saying so in both.",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-display-matrix.json",
        "sha256": "9af96780f7dfbb8c89d8bb73969505323d56e5e117d1529e06840d5dedeeb245"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-LIVE-REGRESSION-3",
      "acceptance": [
        "AC-SPD-COMPAT",
        "AC-SPD-POPUP"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ssh",
        "linuxlt",
        "bash",
        "~/ccm-evidence/lt_evidence_speed.sh",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.14.0 build: full browser, user interference, multi-agent (25/25: the popup held by the agent whose click opened it, with the harness now opening its Developer-mode page behind the user's tab), per-agent clipboard, large upload (7/7, the page reporting its hash's progress), extension version (current, Chrome Web Store key, older, and the released 1.11.1 extension), two profiles and the profiles upgrade (the closed-history rule: earlier plans are not re-stamped)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/linux-summary.txt",
        "sha256": "6184ceaeb9b408b4f040f6ac2139ca2708c8a7d41c82697949dc22bff2167100"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-CATALOG-3",
      "acceptance": [
        "AC-SPD-COMPAT"
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
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
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
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "005f49fd1d30f585e0bfb70c187441abcbd8821add65b021e0f1912b9f8e87b3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-CLIPPED-3",
      "acceptance": [
        "AC-SPD-CLIPPED"
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
      "method": "Drill (clipped-note-dropped): the view's reply drops the note that a full page was cut. Planted, the suite failed in screenshotReply_clippedFullPageSaysSo; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "the view's reply drops the note that a full page was cut",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_clippedFullPageSaysSo",
        "observed_diagnostic": "screenshotReply_clippedFullPageSaysSo",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "2fdf2c95e4bcd8b293ab370bc6ae25b3c9987515cd2873c12f86b8a5da981f89"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "af0e6fa3933d90693fc5645515656f5ab75438cab6f81d5b5c1be0fd39ba514e",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-COORDINATES-3",
      "acceptance": [
        "AC-SPD-VIEW"
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
      "method": "Drill (coordinates-unchecked): a coordinate outside 0 to 16,384 is passed on. Planted, the suite failed in buildCommand_screenshotCoordinatesTakeFractions; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "a coordinate outside 0 to 16,384 is passed on",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_screenshotCoordinatesTakeFractions",
        "observed_diagnostic": "buildCommand_screenshotCoordinatesTakeFractions",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "bb2c8e76c5e950c1e1100d5139766763ec390204757fc2df673486b0136240c3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-FRAMES-3",
      "acceptance": [
        "AC-SPD-FRAMES"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (frames-never-start): the cast that keeps the tab drawing never starts. Planted, the suite failed in an input-driven command runs with the tab compositing, and the cast ends with it; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "the cast that keeps the tab drawing never starts",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an input-driven command runs with the tab compositing, and the cast ends with it",
        "observed_diagnostic": "an input-driven command runs with the tab compositing, and the cast ends with it",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "ca1a7fce59e10f52cafe39f8c2c64f16f75824676762765468b3899d4688cc59"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "ab92e10117de5259c06b80b820561b4420dad990635b31a16e8cb1d6abb15420",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-INVIEW-3",
      "acceptance": [
        "AC-SPD-INVIEW"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (in-view-ignored): an element already in view is scrolled and settled anyway. Planted, the suite failed in an element wholly in view is acted on where it stands; one that is not is scrolled to first; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "an element already in view is scrolled and settled anyway",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "an element wholly in view is acted on where it stands; one that is not is scrolled to first",
        "observed_diagnostic": "an element wholly in view is acted on where it stands; one that is not is scrolled to first",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "cbb91852d026e4ff54dba6cd9eedae98e75972747ff5bd83d83d8eb2da7e0181"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "ab92e10117de5259c06b80b820561b4420dad990635b31a16e8cb1d6abb15420",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LETTERBOX-3",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_offscreen.mjs"
      ],
      "method": "Drill (offscreen-stretch): a frame of another shape is scaled to the canvas's width, not fitted. Planted, the suite failed in a frame of another shape keeps its own, on black, rather than being stretched; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "a frame of another shape is scaled to the canvas's width, not fitted",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a frame of another shape keeps its own, on black, rather than being stretched",
        "observed_diagnostic": "a frame of another shape keeps its own, on black, rather than being stretched",
        "before": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
          }
        ],
        "after": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/offscreen.js",
            "sha256": "044456c22598bd4261be393f2f4ffbfde0bcb8d204866c86cd097023c398e226"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LIVE-LATENCY-3",
      "acceptance": [
        "AC-SPD-LATENCY"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "tests/e2e/action_latency_e2e.mjs"
      ],
      "method": "Drill (latency-frames-never-start): in real Chrome, the cast that keeps the agent's tab drawing never starts (each kind of scroll then took 2,081 to 3,098 ms at worst, a click and a hover 1.1 s). Planted, the suite failed in scroll the page by ref replies without waiting for a background frame; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-red-drills.txt",
        "sha256": "2a87cfa77a9639c04e13c1edb6304c969c5062352b482b1be78dfd9947cb88fe"
      },
      "red": {
        "mutation": "in real Chrome, the cast that keeps the agent's tab drawing never starts (each kind of scroll then took 2,081 to 3,098 ms at worst, a click and a hover 1.1 s)",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "scroll the page by ref replies without waiting for a background frame",
        "observed_diagnostic": "scroll the page by ref replies without waiting for a background frame",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "ca1a7fce59e10f52cafe39f8c2c64f16f75824676762765468b3899d4688cc59"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-LIVE-MATRIX-3",
      "acceptance": [
        "AC-SPD-MATRIX"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/display_matrix_e2e.mjs",
        "--chrome=/home/randy/ccm-tools/cft/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--chrome-arg=--no-sandbox",
        "--only=2x-1440x900-zoom100-overlay"
      ],
      "method": "Drill (matrix-point-factor-ignored): in real Chrome at 2x, click_at converts a view pixel as a device pixel. Planted, the suite failed in click_at on target mid's pixels hits it; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/live-red-drills.txt",
        "sha256": "2a87cfa77a9639c04e13c1edb6304c969c5062352b482b1be78dfd9947cb88fe"
      },
      "red": {
        "mutation": "in real Chrome at 2x, click_at converts a view pixel as a device pixel",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "click_at on target mid's pixels hits it",
        "observed_diagnostic": "click_at on target mid's pixels hits it",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "640858375884c5577fa1052db412db6a494bd0425eb9c70236833fce7e21d0e1"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-POINT-3",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (point-factor-ignored): click_at converts a view pixel as a device pixel. Planted, the suite failed in browser_click_at reads a view's pixels back through the factor it was shrunk by; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "click_at converts a view pixel as a device pixel",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "browser_click_at reads a view's pixels back through the factor it was shrunk by",
        "observed_diagnostic": "browser_click_at reads a view's pixels back through the factor it was shrunk by",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "640858375884c5577fa1052db412db6a494bd0425eb9c70236833fce7e21d0e1"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-POPUP-3",
      "acceptance": [
        "AC-SPD-POPUP"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (popup-opener-trusted): a new tab's own openerTabId is trusted again, the tab in front included. Planted, the suite failed in a popup goes to the agent whose page opened it, not to the agent whose tab is in front; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "a new tab's own openerTabId is trusted again, the tab in front included",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a popup goes to the agent whose page opened it, not to the agent whose tab is in front",
        "observed_diagnostic": "a popup goes to the agent whose page opened it, not to the agent whose tab is in front",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "e82c1f4f72d4b63fdee5ec52c3c5ee9d6544713f4b9ac3d9a0e1c6bd16f5fa49"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-PRESENTATION-3",
      "acceptance": [
        "AC-SPD-PRESENTATION"
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
      "method": "Drill (presentation-not-saved): a presentation is not written to a file. Planted, the suite failed in screenshotReply_presentationIsSavedNotShown; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "a presentation is not written to a file",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_presentationIsSavedNotShown",
        "observed_diagnostic": "screenshotReply_presentationIsSavedNotShown",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "98d36556359b5ec938b1aab05cd653ff9309f58fd2b1c2917a3a2cae24cb1189"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-READ-ONLY-3",
      "acceptance": [
        "AC-SPD-PRESENTATION"
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
      "method": "Drill (read-only-presentation): the read-only profile lets a presentation write its file. Planted, the suite failed in readOnlyRefusesAPresentationScreenshot; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "the read-only profile lets a presentation write its file",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "readOnlyRefusesAPresentationScreenshot",
        "observed_diagnostic": "readOnlyRefusesAPresentationScreenshot",
        "before": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
          }
        ],
        "after": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
          }
        ],
        "mutated": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "dea303dcb9d7091308e2219f16b6ae642e8507d642d1528590e26f145b2b876d"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "79856a07b07a1655e8c16479c29b4e87942dbb8d30ac7dea2f0e212816ec47ea",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORD-ENCODER-3",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_recording.mjs"
      ],
      "method": "Drill (record-encoder-fixed): the encoder's canvas is 1280x800 whatever the frames. Planted, the suite failed in a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "the encoder's canvas is 1280x800 whatever the frames",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel",
        "observed_diagnostic": "a recording's frames are the viewport's shape: standard fits 1280x800, full is every pixel",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "68a58c501f7f3f4ec8a884c04090bbc6e4f34d3db4feb6631ca9afd3b2232522"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORD-FRAME-3",
      "acceptance": [
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (record-frame-stretched): a standard recording is sized at the device's pixels. Planted, the suite failed in a recording's frames keep the viewport's shape, in even pixels; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "a standard recording is sized at the device's pixels",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a recording's frames keep the viewport's shape, in even pixels",
        "observed_diagnostic": "a recording's frames keep the viewport's shape, in even pixels",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "e2ebf8c9b0b9a914d2f69c54eedeab8411b0484d59669c92c9074e39f7cc0611"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RECORDED-3",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-RECORD"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (recorded-tab-cast): a tab a recording films gets a forcing cast of its own. Planted, the suite failed in a tab a recording is filming keeps the recording's cast: none started, none stopped; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "a tab a recording films gets a forcing cast of its own",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a tab a recording is filming keeps the recording's cast: none started, none stopped",
        "observed_diagnostic": "a tab a recording is filming keeps the recording's cast: none started, none stopped",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "4146b2a151fe48bcbc2e506e31fcc21e549921f541eee6dd9b39539c8c4d091c"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELAY-POSIX-3",
      "acceptance": [
        "AC-SPD-RELAY"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_bridge_relay"
      ],
      "method": "Drill (relay-wake-posix): the POSIX relay's reader no longer writes to its wake pipe. Planted, the suite failed in relay_answersAsSoonAsTheReplyIsIn; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/unit-red-drills.txt",
        "sha256": "309b0eae87f37ec1d89bc15f9612bc00d72e0ce568c1eeb1298165491fa6338c"
      },
      "red": {
        "mutation": "the POSIX relay's reader no longer writes to its wake pipe",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "observed_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "before": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay_posix.cpp",
            "sha256": "64d47a61de27e057966453be7fa16c98331f25b5e6297cb750e791078224301f"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "af0e6fa3933d90693fc5645515656f5ab75438cab6f81d5b5c1be0fd39ba514e",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELAY-WIN-3",
      "acceptance": [
        "AC-SPD-RELAY"
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
        "^test_browser_bridge_relay$"
      ],
      "method": "Drill (relay-wake-windows): the Windows relay's reader no longer wakes the loop. Planted, the suite failed in relay_answersAsSoonAsTheReplyIsIn; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "the Windows relay's reader no longer wakes the loop",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "observed_diagnostic": "relay_answersAsSoonAsTheReplyIsIn",
        "before": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay.cpp",
            "sha256": "41ff02ae792a60265441339da17164dfb47b6126a6aab0d326ff94f1498d4692"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "af0e6fa3933d90693fc5645515656f5ab75438cab6f81d5b5c1be0fd39ba514e",
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
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RELEASE-3",
      "acceptance": [
        "AC-SPD-RELEASE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_release_versions.mjs"
      ],
      "method": "Drill (release-version): the extension's manifest is left at 1.13.0. Planted, the suite failed in every file that states the version states the same one; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "the extension's manifest is left at 1.13.0",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "every file that states the version states the same one",
        "observed_diagnostic": "every file that states the version states the same one",
        "before": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ],
        "after": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/manifest.json",
            "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-RESOLUTION-3",
      "acceptance": [
        "AC-SPD-RECORD"
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
      "method": "Drill (resolution-unchecked): an unknown recording resolution is passed on to the extension. Planted, the suite failed in buildCommand_recordStartResolution; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "an unknown recording resolution is passed on to the extension",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "buildCommand_recordStartResolution",
        "observed_diagnostic": "buildCommand_recordStartResolution",
        "before": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "after": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_contract.cpp",
            "sha256": "3b9a3f954e554cc2801161064c01c3ff0ac586850aa4f807655fbbd9318207db"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-VIEW-CAP-3",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (view-cap-whole-viewport): the cap ignores the CSS pixel a capture can run past the viewport. Planted, the suite failed in a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "the cap ignores the CSS pixel a capture can run past the viewport",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "observed_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "cdad838502f5bf3b6b8eee0dabc916e1929fe84e35c9050e61723557027c1efb"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-VIEW-DPR-3",
      "acceptance": [
        "AC-SPD-VIEW"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (view-factor-device): the view keeps device pixels below the cap. Planted, the suite failed in a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "the view keeps device pixels below the cap",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "observed_diagnostic": "a view is one image pixel per CSS pixel, its long edge within 1568, never enlarged",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "311859fe2e51f35edadefa53e97bbf39bd38896da092e355b9f27319d2e8575e"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-ZOOM-3",
      "acceptance": [
        "AC-SPD-ZOOM"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_pure.mjs"
      ],
      "method": "Drill (zoom-crop-unscaled): a zoom region is cropped as device pixels, not view pixels. Planted, the suite failed in a zoom crops the device-pixel capture, clamped to it, at up to its own pixels; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/js-red-drills.txt",
        "sha256": "ddbb38cd33542f2c83bc0d615425eebd7d3270ee9ed1e17408d4e4873630b0e8"
      },
      "red": {
        "mutation": "a zoom region is cropped as device pixels, not view pixels",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a zoom crops the device-pixel capture, clamped to it, at up to its own pixels",
        "observed_diagnostic": "a zoom crops the device-pixel capture, clamped to it, at up to its own pixels",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "602b7cfcb64b4a246860756e395d9321f7941c3f08e88b321b5d4c0e1b2d47bd"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-RED-ZOOM-NOTE-3",
      "acceptance": [
        "AC-SPD-ZOOM"
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
      "method": "Drill (zoom-note-dropped): a zoom's reply no longer says which part of the view it shows. Planted, the suite failed in screenshotReply_zoomSaysWhatItShows; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-unit-red-drills.txt",
        "sha256": "9aac12ec39484df4f2f120e9428fa76c9bd7054dbfaa96294e4a750c91816171"
      },
      "red": {
        "mutation": "a zoom's reply no longer says which part of the view it shows",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "screenshotReply_zoomSaysWhatItShows",
        "observed_diagnostic": "screenshotReply_zoomSaysWhatItShows",
        "before": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge.cpp",
            "sha256": "9f2e2402295af14259d391f0261f0a592620424bdf157c7c1e5ff8ec1f9d7648"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "476afc81dec40532f19a0bc679ea8ae137ae47c1e728b00044a6b5ad45c77c9e",
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
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        }
      ]
    },
    {
      "id": "EV-SPD-SMOKE-3",
      "acceptance": [
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test in both profiles: 54 tools in full and 15 read-only, unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-smoke.txt",
        "sha256": "8f381b739f67e15bf466ff810149c5497c1711371886a85518f0c59729e56927"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    },
    {
      "id": "EV-SPD-UNIT-JS-3",
      "acceptance": [
        "AC-SPD-FRAMES",
        "AC-SPD-INVIEW",
        "AC-SPD-VIEW",
        "AC-SPD-ZOOM",
        "AC-SPD-RECORD",
        "AC-SPD-POPUP",
        "AC-SPD-RELEASE",
        "AC-SPD-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 14 JavaScript suites, 275 tests: frames kept drawing during an action, shared by overlapping work, left alone on a recorded tab, and a refused cast tolerated; an element wholly in view acted on without a scroll, a hidden one scrolled first, and the in-page check across clipping ancestors and shadow hosts; the view's factor (CSS pixels, the 1,568 cap allowing for a capture a CSS pixel past the viewport, never enlarged), the full-page factor, zoom crops, click_at's conversion through the factor; the recording's resolution, frame size, encoder and screencast sizes, and letterboxing in the recorder; a popup claimed only by the session whose page opened it, never the one whose tab is in front; the version in every file; every earlier suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/speed/windows-test-js.txt",
        "sha256": "ea1bc7fa91898a66fe07f949a8363a466db986f7cef42eb4f62f5f445940298c"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
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
          "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
        },
        {
          "path": "PLAN.md",
          "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
        },
        {
          "path": "README.md",
          "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
        },
        {
          "path": "browser/extension/offscreen.js",
          "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
        },
        {
          "path": "docs/releases/v1.14.0.md",
          "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
        },
        {
          "path": "package-lock.json",
          "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
        },
        {
          "path": "package.json",
          "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
        },
        {
          "path": "src/browser_bridge_relay.cpp",
          "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
        },
        {
          "path": "src/browser_bridge_relay_posix.cpp",
          "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
        },
        {
          "path": "tests/e2e/action_latency_e2e.mjs",
          "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
        },
        {
          "path": "tests/e2e/full_browser_e2e.mjs",
          "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
        },
        {
          "path": "tests/e2e/large_upload_e2e.mjs",
          "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
        },
        {
          "path": "tests/test_browser_bridge.cpp",
          "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
        },
        {
          "path": "tests/test_browser_extension_offscreen.mjs",
          "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
        },
        {
          "path": "tests/test_browser_extension_pure.mjs",
          "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
        },
        {
          "path": "tests/test_browser_extension_recording.mjs",
          "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
        },
        {
          "path": "tests/test_browser_extension_uploads.mjs",
          "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
        },
        {
          "path": "vscode/package.json",
          "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
        }
      ]
    }
  ],
  "checkpoint": {
    "scope_sha256": "ecb48ae8daf094af027f112542cd86220c3194274f6bedb5035360ba5c4cd461",
    "inputs": [
      {
        "path": ".github/workflows/live.yml",
        "sha256": "4da00728a9d2cd0933c3e6003c7d59e076395a5c6950574585b14fe789dc30b2"
      },
      {
        "path": "CHANGELOG.md",
        "sha256": "a4288a6ab7d2735fe395a4fe6de7ee25abbd28640f78d595cd8cdc83d8925f1f"
      },
      {
        "path": "CMakeLists.txt",
        "sha256": "b1b719346f1110d74a0a8e6e78412553f06c3cc82923a2a944c7d06a57f126ba"
      },
      {
        "path": "PLAN.md",
        "sha256": "208bf53af5816f7476afe0fecb4dfb13c66488126b0ebec6cf7d1223b7323041"
      },
      {
        "path": "README.md",
        "sha256": "1c4f4580e9b2009b763da3f2212bb4cb1352d6cf2e751064727cb912bfe15ea9"
      },
      {
        "path": "browser/extension/background.js",
        "sha256": "2ad52b3f7eca131c5c3854e3a3b4fc0e55e4f3668bace85151e1d4a91057cd7d"
      },
      {
        "path": "browser/extension/manifest.json",
        "sha256": "098a74b1e4cdce10173af4bbbad67272f2486170f5a49722b7857cc51976ad23"
      },
      {
        "path": "browser/extension/offscreen.js",
        "sha256": "9afbb2583f34d3154dc53052d39748dfbd5e3be848a956b785fbdbbd1e7e648b"
      },
      {
        "path": "docs/ARCHITECTURE.md",
        "sha256": "9cb7f383c75a194a2ca3314fcab96256f159e2dc21496e097c05b7759f835227"
      },
      {
        "path": "docs/MULTI_SESSION.md",
        "sha256": "eee0dc6c55f6960fc8c96b46eb4def4a2c09b8b9f894e0d5d97e654cc1b9b097"
      },
      {
        "path": "docs/PRIVACY.md",
        "sha256": "2927345acf8b10b29f58dbe80d91acef62721a98f96a3048a7d39ffbb4bfb982"
      },
      {
        "path": "docs/QUALITY.md",
        "sha256": "f14cf32431382cdb70da6f72e9003207d51a75e5415a0d742e445ba98988027b"
      },
      {
        "path": "docs/TOOLS.md",
        "sha256": "aef5ba7ed32817f072c18c004907f8ff7577e4b247137c5cac7c1730df5c26e1"
      },
      {
        "path": "docs/releases/v1.14.0.md",
        "sha256": "cf7899f8823d4add298e8ebe0a26109e0ed52fa5242c867cdae4733f7a10f45a"
      },
      {
        "path": "include/chrome_control_mcp/browser_bridge.h",
        "sha256": "d9043f0996427608ed6722370370d53726d526d7497741ce51b1d9c9da0d8c4d"
      },
      {
        "path": "include/chrome_control_mcp/browser_bridge_relay.h",
        "sha256": "9c77af016df7532224ef43bb3b6b34e776d5cba203843c05e087780f25ef3543"
      },
      {
        "path": "include/chrome_control_mcp/browser_extension_installer.h",
        "sha256": "074edc26d2aa377669b05b24244cce7b0f266e750607968077051d35a7cf25ba"
      },
      {
        "path": "package-lock.json",
        "sha256": "3caee5665acfde4ba750a2e71b93e57a81ff6a555b1e2529f0bd2a955f60ca63"
      },
      {
        "path": "package.json",
        "sha256": "c2d0233aa603aad583b9ee66c1d96ba8f9f3bb3bdbd2cfcf567ca0534f255129"
      },
      {
        "path": "src/browser_bridge.cpp",
        "sha256": "8e7ba7175d2ba9948452e472ebc394c2f5025ad773895fcbb672212c14810b04"
      },
      {
        "path": "src/browser_bridge_relay.cpp",
        "sha256": "9379450bee6ffa611376100f789ada0d2d99e8fbc7a2ec37a95bdb9b353ddb6d"
      },
      {
        "path": "src/browser_bridge_relay_common.cpp",
        "sha256": "9e9fb5e9ffb890d9526b669ce1a2a390e4bb75d443c9b2d09cbe6fc5bfea3c77"
      },
      {
        "path": "src/browser_bridge_relay_posix.cpp",
        "sha256": "848c5f5dda72658652c64f2a1ff0c48ac374dc0f099a94a975701bad0ef2087b"
      },
      {
        "path": "src/browser_contract.cpp",
        "sha256": "c17f424a27869b3939b0ceb2b44fffa2a542dbb1816d3fbdf1e34fec2fead604"
      },
      {
        "path": "src/mcp_dispatch.cpp",
        "sha256": "0ae564ead10c056cc002718cb8c06dcc270230824bf9eeba04db463116945c6d"
      },
      {
        "path": "tests/e2e/action_latency_e2e.mjs",
        "sha256": "03016cb568a700bd143de0d0ae6ef8638a99750fa86069eca80fa0cad8ab766c"
      },
      {
        "path": "tests/e2e/display_matrix_e2e.mjs",
        "sha256": "2b926b904717f7724e72326bc725e668821d8a6e0b5dbbf2dadcd9bb0187d48a"
      },
      {
        "path": "tests/e2e/full_browser_e2e.mjs",
        "sha256": "b50af290e6090ad1e01ec2205a34150e698e21d8b0c3bfc92a0e651128834f6b"
      },
      {
        "path": "tests/e2e/isolated_chrome.mjs",
        "sha256": "29aa3f53ee350a385ab7ea0503840a34093d761b1f77c7972fa0dfeef70627ee"
      },
      {
        "path": "tests/e2e/large_upload_e2e.mjs",
        "sha256": "6d1cc648e9825f4f8159c5b5274c6451ffbc656eecf569235f0198643e5fc57a"
      },
      {
        "path": "tests/e2e/multi_agent_e2e.mjs",
        "sha256": "2ebb12302569c8abc5b19f0e66df8ebb29c7b66659a6fe3fb8590c584051c29f"
      },
      {
        "path": "tests/test_browser_bridge.cpp",
        "sha256": "1b70c57361399152ff200d400b2eeb7613275dbe4d5e67102493682b96c7ebc0"
      },
      {
        "path": "tests/test_browser_bridge_relay.cpp",
        "sha256": "6e4182e4caa599e21ceee58e33c277e541a511ddabec4ee8458eb20e125a9d73"
      },
      {
        "path": "tests/test_browser_contract.cpp",
        "sha256": "2a23272a1fa1b0b7f36d3034c0978e306401b31cc3009544527d0804e2d2881c"
      },
      {
        "path": "tests/test_browser_extension_offscreen.mjs",
        "sha256": "06abfbd0a74063979b3b35985e20dfb61de1d60e70112687d77659e5b31fe241"
      },
      {
        "path": "tests/test_browser_extension_pure.mjs",
        "sha256": "4a515deceea6077a53f43b2f53a04f6e255bbb3982375dabd75cd58be09f7246"
      },
      {
        "path": "tests/test_browser_extension_recording.mjs",
        "sha256": "e1a51132c22ff15a18dcdb3427ce29d5e72be1beb2678d7847736aaf0eb2037b"
      },
      {
        "path": "tests/test_browser_extension_tabs.mjs",
        "sha256": "864e16d4e463f42ed54982e039dc752be006a0c96bc04f48d3b5606357aa7ef1"
      },
      {
        "path": "tests/test_browser_extension_uploads.mjs",
        "sha256": "cd2053870c6000f6e9609651f30f8f13c7e7a17775132c04ae8d6c02a569d324"
      },
      {
        "path": "tests/test_browser_mcp_server.cpp",
        "sha256": "6782879be725b647b407c77d5d068ff38e6519df879d32be5835e20c156a530a"
      },
      {
        "path": "vscode/package-lock.json",
        "sha256": "07736439216efa9613f968e10597f408e6ed5ca434b0a9c235dd19ed05f22887"
      },
      {
        "path": "vscode/package.json",
        "sha256": "144b266a8a905bfa8597168e67220f2478fa036595bb6ea97192b2b996ff71b3"
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
      "TASK-SPD-EXTENSION",
      "TASK-SPD-SERVER",
      "TASK-SPD-LIVE",
      "TASK-SPD-RELEASE"
    ],
    "pending_operations": [],
    "next_action": "Closed. Commit and push; once CI passes, tag v1.14.0: the release runs every live suite on Windows, macOS and Linux before it publishes the GitHub release, the VS Code packages and the Chrome Web Store submission.",
    "source_revision": "4f41d25"
  }
}
```
