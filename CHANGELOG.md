# Changelog

All notable changes are documented here. Project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [1.1.2] - 2026-09-22

### Fixed

- The comment wrapping in `browser_extension_installer.cpp` that failed the `clang-format` gate
  on the 1.1.1 commit. No behaviour changes; 1.1.1 and 1.1.2 are the same program.

## [1.1.1] - 2026-09-22

### Fixed

- `browser_screenshot` no longer hangs, and no longer takes the session down with it, when the
  tab it captures is not the one Chrome is drawing. Chrome answers `Page.captureScreenshot` only
  once the tab produces a compositor frame, and a background tab -- which is where this session
  works by design -- produces none: the capture never returned, the app waited out its whole
  transport deadline, and the reset that followed detached the extension and ended the session
  over one screenshot. A capture of a tab that is not on screen now runs with a one-pixel
  screencast that makes Chrome composite it, and every capture path is bounded well inside the
  transport deadline, so a screenshot that truly cannot be taken is one failed call on a live
  bridge. Measured on the E2E fixture in a background tab: no reply in 30 s and a dead bridge
  before, 1.3 to 1.8 s and byte-identical output after.

### Changed

- The live suites' dedicated browser runs on Windows. It refused to, because Windows keeps
  native-messaging registrations in the registry rather than per profile, and a profile-local
  install was assumed to be the only way to leave the user's own Chrome alone. It is not: the
  registration already names the executable under test, and `CHROME_CONTROL_MCP_RUNTIME_DIR` is
  what keeps each browser to its own server. The run now asserts that the user's registration
  names the executable under test and proceeds, so `display_matrix_e2e.mjs` -- every pointer tool
  across display scales, window sizes, zoom levels, and pinches -- covers Windows too.
- `browser_extension_install` says plainly, in its description and in its reply, that loading the
  unpacked extension is a one-time manual step that cannot be automated, and why. README and
  `docs/TOOLS.md` say the same. An assistant reading only the tool's own text now has what it
  needs to hand the step to the user instead of looking for a workaround that does not exist.

## [1.1.0] - 2026-09-21

### Changed

- Control stays inside the browser. Session pins its own tab instead of re-resolving "active tab
  of last focused window" on every command, so a user switching Chrome tabs or windows mid-session
  no longer redirects the assistant's next click, keystroke, or snapshot onto the user's page. A
  foreground tab opened by the session's own page is followed. `browser_tabs`, tab indices, and
  `browser_new_tab` resolve in session's window.
- The session never changes which tab the user is looking at. `browser_new_tab` opens in the
  background and `browser_select_tab` retargets the session without activating the tab, so the
  assistant works in its own tab while the user keeps reading theirs. A closed session tab is not
  replaced by a neighbour -- every neighbour is a tab the user may be using -- so the session says
  it has no tab until given one.
- The tab under control is marked in the tab strip: a pink `AI CONTROL` tab group, the same pink as
  the frame and badge drawn on the page, so the user can see which tab the assistant is working in
  without opening it. It is never collapsed, it follows the session, and a tab the user already
  grouped is left in their group.
- `browser_scroll` replies once the scroll has come to rest, with `scrolled`: how far the content
  actually moved (0 at an edge). A wheel scroll is animated, and the page was still moving when
  the reply arrived, so a screenshot taken on it could catch the page mid-flight.
- Control never takes OS focus. `browser_select_tab` no longer raises its window, `browser_window`
  `new` opens with `focused: false`, and `focus` retargets session without raising window. CDP
  focus emulation keeps focus-gated pages working while Chrome is in background. When a compositor
  focuses a new window anyway (Hyprland), reply reports `took_os_focus: true`.

### Fixed

- `browser_drag`'s `from_x`/`from_y`/`to_x`/`to_y` are screenshot pixels, converted exactly as
  `browser_click_at` converts them and bound to the same screenshot. They were dispatched as CSS
  pixels while the only place a model reads coordinates from is a screenshot, so a drag missed its
  target by the display scale, zoom, and pinch on every display but an unzoomed 100% one.
- Coordinates under a trackpad pinch. A pinch moves every pixel on screen without changing the
  scroll offset, zoom, or viewport size a screenshot was bound to, so a coordinate click after one
  landed at the unpinched position; `browser_box`'s `screenshot_center` ignored the pinch; and the
  occlusion hit test read the visual viewport's coordinates as the layout viewport's, refusing
  clicks on elements nothing covered. The render fingerprint now carries the pinch's scale and
  offset, and every conversion goes through it.
- Full-page screenshots at any browser zoom but 100%. Chrome reads the capture clip in DIPs, not
  CSS pixels: the capture came out twice the document at 50% zoom, cut the document short at 110%
  and above, and failed outright on a small window at 25%. It also cut the last device-pixel row
  off a document whose height is fractional, because Chrome's `cssContentSize` truncates.
- A full-page screenshot of a pinch-zoomed page is refused instead of resetting the user's pinch:
  capturing beyond the viewport returns the page at 1x with the pinch's offset folded into the
  scroll, and nothing can put it back.
- `browser_click` by ref no longer refuses an element whose centre alone is covered. It tries
  points around the centre, as a user clicks the part of a button they can see, and waits up to a
  second for a macOS overlay scrollbar -- which the element's own scroll into view brings up over
  the page's edge -- to fade. When no point of the element takes a click it says that, rather than
  naming `<html>`.
- An unreadable scroll offset or pinch no longer reads as zero in the render fingerprint, which
  would have moved every hit test and coordinate conversion onto the unscrolled position.
- Every wait about the page is timed by the page, not by the extension's service worker. Chrome
  coalesces a background worker's timers into seconds: measured on a tab the user was not looking
  at, a 100 ms hover dwell answered in 6.3 s, a 150 ms drag hold took 10.2 s, `browser_wait_for`
  overran its own 1.5 s timeout to 10.3 s, `browser_download` reported failure for a file that had
  downloaded (its poll slept past its deadline), and `browser_window` `new` took 10.9 s watching
  for a focus that never comes. The same page's own timers kept time to the millisecond there.
- A drag's interpolated moves are sent in order and awaited together. Chrome answers a mouse move
  at a frame and draws a background tab rarely, so awaiting each move in turn cost 8.9 s for one
  drag against 0.23 s in a foreground tab; Chrome coalesces a real mouse the same way.
- A wait about the page cannot outlive its own deadline: the evaluate that times it carries one,
  so a page that blocks its main thread fails the wait instead of holding the command open for
  ever. `browser_download` attaches before timing its poll, and a wait whose page cannot time
  anything gives up rather than spinning.
- A coordinate read off a screenshot must be inside it, and an element that could not be brought
  on screen is refused rather than clicked at a point off the viewport: both reported `ok` before.
- A hit test that named no node no longer reads as "nothing is in the way": it is refused, as the
  fail-closed rule everywhere else in that path requires.
- `browser_scroll`'s `scrolled` counts each scroller once and matches them by name, so a page whose
  root is its own scroller is no longer reported as having moved twice as far, and a scroll chain
  that changes under the pointer cannot subtract one scroller's offset from another's.
- A drag that fails halfway releases where the pointer actually got to, not at the destination.
- `browser_window` `new` attaches before watching for OS focus, so `took_os_focus` is measured
  rather than answered instantly by a page that could not be asked.
- `browser_click` re-measures the element each time it waits out a scrollbar: the page is moving
  while that scrollbar shows, and the box it first measured no longer names the element.
- The controlled tab's pink group is created one at a time and orphans are cleared, so two pins in
  quick succession or a reloaded worker can no longer leave a marked tab nobody is driving.
- A screenshot says whether the control overlay is in the image, instead of repeating the request:
  a hide that did not take left the frame and badge in a capture described as free of them.
- `browser_http_auth` `clear` surfaces a failure to stop intercepting instead of reporting a clear
  that did not happen, which would leave every request in the page paused.
- `browser_hover`'s `duration_ms` and `browser_drag`'s `steps`/`hold_ms` refuse what they cannot
  honour rather than silently becoming the default, and `browser_drag` refuses an endpoint given as
  both a ref and coordinates instead of quietly preferring one.
- `browser_box` and `browser_scroll` use Chrome's CSS viewport metrics only; the other members are
  device pixels, and reading them as CSS put the wheel outside the viewport on a scaled display.
- `browser_download` says which state a download ended in. A reply carrying only `ok: false`
  reached the model as "the browser reported failure", with the one fact that explains it dropped.
- Coordinate clicks at non-100% display scale. `browser_box` reports CSS px while
  `browser_click_at` takes screenshot px; they differ on 125%/150% desktops, Retina, and zoomed
  pages. `browser_box` now adds `screenshot_center`, and tool descriptions name each unit.
- `browser_emulate` accepts fractional `device_scale_factor` (1.25, 1.5, 1.75); integer-only
  schema refused most common Windows scales.
- `browser_window` `focus` reported failure on Wayland/macOS when activation landed after
  `windows.update` resolved; focus no longer depends on OS activation.

### Tests

- New `tests/e2e/display_matrix_e2e.mjs`: every pointer tool across 35 combinations of display
  scale (1× to 3×, including 1.25×, 1.5×, 1.75×, 2.5×), window size (390×844 to 3840×2160),
  browser zoom (every one of Chrome's steps, 25% to 500%), trackpad pinch (1.5×, 2×, 3×), and both
  a scrollbar drawn over the page and one that takes layout space. The plan states what it covers
  and the suite asserts that before a browser starts, so a step that fits nowhere is a failure
  rather than a silent gap. Nothing trusts the arithmetic
  under test: a coordinate is proven by where its click landed on the fixture, and a screenshot by
  the pixels of its solid-colour targets measured against the page's own `getBoundingClientRect`.
- New `tests/e2e/isolated_chrome.mjs` and `isolated_run.mjs`: the live suites run against a
  dedicated Chrome for Testing -- its own profile, its own bridge, headless -- so they never touch
  the user's Chrome, its tabs, its focus, or its native-messaging registration, and can run the
  browser at any display scale, window size, and zoom. `CHROME_CONTROL_MCP_RUNTIME_DIR` names the
  bridge's rendezvous directory so a server and that browser pair only with each other.
- Full E2E asserts the user's tab is still the one in front after every call, and that a scroll's
  reply matches how far an element's box actually moved.
- First live macOS certification, every call in a background tab: 43/43 tools, 151 cases, with the
  per-call timings of a tab nobody is looking at recorded in `docs/VERIFICATION.md`.
- The interference suite drives the dedicated browser through its own DevTools endpoint (a second
  process cannot hand a URL to a headless Chrome) and now also checks that the user's tab stays in
  front while the session types, scrolls, and clicks, and that the session opens no windows.
- Full E2E adds display-scale matrix (1×–3×, 360–1280 px viewports) with independent PNG-size
  check, and asserts OS focus never moves.
- New `tests/e2e/user_interference_e2e.mjs` drives user tab/window changes from outside Chrome on
  Linux, macOS, and Windows and requires session to stay on its own tab.
- First live Linux certification (Hyprland/Wayland, 150% scale).

## [1.0.1] - 2026-09-16

### Fixed

- Browser bridge heals a lost rendezvous record without a restart. The stand-down
  below closed the case where the transient instance started _after_ the
  persistent server, but not the race where both start within the same instant:
  each passed the live-owner check before either had written the record, the
  transient one wrote last and — naming its own pid — removed the record on exit,
  and the persistent server was left listening on a pipe nothing could find, with
  no retry, for the life of the session. `BrowserBridgePipeServer::ensurePublished`
  now re-publishes the record when it is missing or names a server that has
  exited, and refuses when another live server of the same image owns it;
  `BrowserControl::invoke` retries the bridge start when the server stood down
  at launch and calls `ensurePublished` before each browser tool call while no
  relay is connected; the browser tools stay listed when the bridge could not
  start, and each call reports the reason (including the owning pid). The
  extension re-arms the native bridge from a 30-second `chrome.alarms` alarm so a
  service worker Chrome has retired still reconnects once a server publishes its
  record (`alarms` permission added). Three pipe-server tests cover the lost
  record, a record left by an exited server, and a server that is not running.
- Browser bridge no longer orphaned by a concurrent short-lived server. The
  rendezvous record lives at a fixed path while the pipe/socket name is
  per-process random, so a second, transient invocation (`mcp list`/`get`, a
  health probe, or any non-relay process) used to overwrite that record and, on
  exit, delete it — leaving the persistent server's pipe alive but undiscoverable
  and the extension reporting "not attached." A late instance now stands down
  (serving native tools with browser control off) when a live server of the same
  image already owns the bridge, and `stop()` only removes the rendezvous record
  when it still advertises the exiting process. Windows and POSIX backends both
  covered, with pipe-server unit tests.

## [1.0.0] - 2026-08-20

### Added

- Initial standalone MIT-licensed Chrome Control MCP release.
- 43 MCP tools, unpacked MV3 extension, visible control presence, and full live Chrome E2E coverage.
- Linux and macOS Unix-domain bridge backends with owner-only runtime state and peer credentials.
- Cross-platform Chrome native-host manifest lifecycle.
- Windows, Linux, and macOS build/test matrix.
- Unsigned Windows x64, Linux x64, macOS ARM64, and macOS x64 release archives with checksums.
- Separate AddressSanitizer + UndefinedBehaviorSanitizer and ThreadSanitizer gates.
- Cross-platform Node build, MCP smoke, and extension lifecycle commands.
- Modern README with verified overlay screenshots and UI Test Automation Playground credit.

### Changed

- Native API and documentation now use platform-neutral names.
- C++ warnings are errors under MSVC, GCC, and Clang.
- MCP/relay logs use standalone project identity.
- Quality gates now include strict lint, static analysis, full-history secret scanning, and locked
  dependency audit.

### Removed

- Unused JSON-RPC client payload helpers and obsolete test-only native-host loop.
- Redundant quality branch; development and delivery now happen directly on `main`.
