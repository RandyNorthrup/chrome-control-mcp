# Changelog

All notable changes are documented here. Project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Control stays inside the browser. Session pins its own tab instead of re-resolving "active tab
  of last focused window" on every command, so a user switching Chrome tabs or windows mid-session
  no longer redirects the assistant's next click, keystroke, or snapshot onto the user's page. A
  foreground tab opened by the session's own page is followed; a closed session tab falls back to
  its own window. `browser_tabs`, tab indices, and `browser_new_tab` resolve in session's window.
- Control never takes OS focus. `browser_select_tab` no longer raises its window, `browser_window`
  `new` opens with `focused: false`, and `focus` retargets session without raising window. CDP
  focus emulation keeps focus-gated pages working while Chrome is in background. When a compositor
  focuses a new window anyway (Hyprland), reply reports `took_os_focus: true`.

### Fixed

- Coordinate clicks at non-100% display scale. `browser_box` reports CSS px while
  `browser_click_at` takes screenshot px; they differ on 125%/150% desktops, Retina, and zoomed
  pages. `browser_box` now adds `screenshot_center`, and tool descriptions name each unit.
- `browser_emulate` accepts fractional `device_scale_factor` (1.25, 1.5, 1.75); integer-only
  schema refused most common Windows scales.
- `browser_window` `focus` reported failure on Wayland/macOS when activation landed after
  `windows.update` resolved; focus no longer depends on OS activation.

### Tests

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
