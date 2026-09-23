# Verification

Evidence recorded 2026-08-20. Commands below ran against repository checkout, not mocked transport.

## Environments

| Platform | Toolchain                                | Result                                   |
| -------- | ---------------------------------------- | ---------------------------------------- |
| Windows  | MSVC 19.50, CMake 3.31, Qt 6.10, Node 24 | Build + 18/18 suites + live Chrome pass  |
| Linux    | GCC 16 and Clang 22, Qt 6.11, Node 24    | Both builds + 17/17 suites + live Chrome |
| macOS    | Clang + Qt 6.10 GitHub Actions runner    | Build + 17/17 suites                     |

Live Windows browser: Chrome 151.0.7922.138. Minimum supported manifest version is Chrome 116.

## Browser identity and delivery

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Extension version: `1.4.0`
- Delivery: unpacked extension directory
- Public manifest identity derives pinned extension ID
- No private key, packaged browser artifact, store account, or enterprise policy

## Cross-platform build

```shell
npm ci
npm run build
```

Equivalent native commands:

```shell
cmake -S . -B build -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
```

Windows generator may add `-A x64`; multi-config builds place executable under `build/Release`.

## Automated tests

Result: **18/18 passed** under Windows/MSVC and **17/17** under Linux/GCC, Linux/Clang, and
macOS/Clang. The counts differ by one because `test_windows_process_identity` builds only on
Windows.

| Test                                  | Coverage                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `test_browser_contract`               | 40 browser-tool schemas, translation, refs, bounds, and validation          |
| `test_native_messaging`               | Native frame codec and host handshake                                       |
| `test_browser_bridge`                 | Session, reply correlation, snapshots, and stale refs                       |
| `test_browser_extension_installer`    | Public identity and isolated native-host lifecycle                          |
| `test_browser_uploads`                | Upload path rules, roots confinement, and byte-exact chunking               |
| `test_browser_bridge_security`        | ACL/permissions, nonce, rendezvous, and ownership                           |
| `test_browser_bridge_pipe`            | Platform IPC handshake, peer verification, timeout, framing, reconnect      |
| `test_browser_bridge_relay`           | End-to-end relay/bridge/session with fake extension                         |
| `test_install_layout`                 | Version-directory safety, link swap under an open file, and pruning         |
| `test_updater`                        | Asset naming, checksum parsing, version order, and staged install           |
| `test_browser_mcp_server`             | Identity, 49 tools, profiles, envelopes, schemas, and MCP content           |
| `test_browser_extension_pure`         | 69 service-worker security, storage, geometry, and decision cases           |
| `test_browser_extension_transport`    | Native port, readiness handshake, and how a command is refused              |
| `test_browser_extension_session`      | What a session releases when its debugger attachment ends                   |
| `test_browser_extension_multisession` | One port per server, and the tab leases that keep sessions apart            |
| `test_browser_extension_recording`    | Recording refusals, the timeline, and discard on a session's death          |
| `test_vscode_payload`                 | VSIX payload rules, with red drills for a link that survives pruning        |
| `test_windows_process_identity`       | Windows only: identity across a junction, from a child launched through one |

`test_install_layout` and `test_updater` are newer than the local Linux and macOS desktop runs
recorded above, but both have since passed on all three platforms in GitHub Actions, which is where
the 17/17 figures for Linux and macOS come from.

`test_windows_process_identity` builds only on Windows, which is why the Windows count is one
higher. It re-launches the test binary through a real directory junction and has that child decide
whether the parent is the same program -- the position the relay is in, and the only position from
which the bug it guards is visible. Its teardown removes the junction as a link and never
recursively, because the first version of the test used `QTemporaryDir`, whose recursive cleanup
followed the junction and deleted the build directory it pointed at.

The update path itself has been exercised end to end on Windows and on macOS 15.7.4, where a
published archive installs and `browser_update_check` reaches the release host over HTTPS through
the bundled TLS backend. No Linux machine has installed a release through `browser_update_apply`.

## Strict analysis

- MSVC, GCC, and Clang compile with warnings-as-errors.
- `clang-tidy` production analysis passes with analyzer, bugprone, CERT, concurrency,
  core-guidelines, misc, performance, and portability families.
- Exhaustive `cppcheck` production analysis passes. Deliberate unused-function probe first proved
  dead-code checker fails correctly; probe was then removed.
- ESLint reports 0 errors; PSScriptAnalyzer reports 0 findings.
- PSScriptAnalyzer throws `Object reference not set to an instance of an object` on a cold
  module import, which is why the worker retries. Measured against 1.25.0, the newest release:
  three passes over the eight tracked scripts produced one such failure on the first
  invocation and none afterwards, so the retry mitigates a defect that is still upstream
  rather than one this project introduced.
- Full-history Gitleaks scan: 0 leaks.
- `npm audit --audit-level=low`, for both the root and the extension package: 0
  vulnerabilities.

## Sanitizers

| Gate       | Result | Where                                           |
| ---------- | ------ | ----------------------------------------------- |
| ASan+UBSan | 17/17  | GitHub Actions, and locally on Arch, GCC 16.2.1 |
| TSan       | 17/17  | GitHub Actions (Qt 6.10.0)                      |

ASan+UBSan was re-run locally against this release on Arch with GCC 16.2.1 and Qt 6.11.2: thirteen
suites pass and neither sanitizer reports anything, including the bridge pipe, relay, and security
suites, which are the ones that actually run threads.

TSan runs with no suppressions. It carried a suppression file naming two Qt symbols until that file
was audited with `print_suppressions=1`: neither entry ever matched, and the job reported no race
with or without them. One named the wrong function and the other used `thread:`, which suppresses
thread-leak reports rather than data races, so neither could have matched. The file is gone, and any
race this gate sees now fails it.

Qt 6.11.2 does carry a race in `QPlainTestLogger::stopLogging`, between QtTest's watchdog thread and
main's stack during teardown, which is visible when these suites are built against it. It has no
project frame in either stack and appears even in `test_install_layout`, which starts no thread of
this project's own. The Qt this workflow pins, 6.10.0, does not exhibit it.

## MCP and native-host smoke

```shell
npm run smoke
npm run smoke:read-only
npm run extension -- status
```

Results:

- Initialize protocol `2024-11-05`, server `chrome-control-mcp`
- Full profile: 49 tools
- Read-only profile: 12 tools
- Staged extension present with pinned ID
- Linux isolated install → status → uninstall lifecycle passed with generated mode-`0600` manifest

## Live Chrome workflow

Executed against [UI Test Automation Playground](http://uitestingplayground.com/) with unpacked
extension loaded:

```powershell
./scripts/live_browser_verify.ps1 -Site http://uitestingplayground.com/
```

Result: success.

- Opened dedicated temporary tab
- Navigated through semantic element ref
- Captured live accessibility/DOM snapshot
- Typed probe text and read exact value back
- Clicked update button and observed changed text
- Captured `image/png` screenshot with opt-in control presence
- User confirmed visible pink frame, `AI CONTROL` badge, and agent cursor
- Closed temporary tab

Verified screenshot:
[`docs/assets/chrome-control-overlay-playground.png`](assets/chrome-control-overlay-playground.png).

## Full live tool E2E

```powershell
$env:CHROME_CONTROL_MCP_SHOWCASE_DIR = "$PWD/docs/assets"
node tests/e2e/full_browser_e2e.mjs dist/chrome_control_mcp.exe
```

Latest completed run: **43/43 advertised MCP tools passed across 97 reversible live cases**.

- Exercised navigation, capture, input, tabs, windows, inspection, state, advanced operations, and
  extension lifecycle through real MCP process, native host, extension, and Chrome
- Verified storage, cookies, permissions, download bytes, PDF header, and HTTP auth
- Deleted exact test download and PDF, cleared fixture state, closed fixture tabs/windows, and
  restored original active tab
- Captured and visually inspected responsive overlay screenshot

## Linux live Chrome

Evidence recorded 2026-09-18 on Arch Linux, Hyprland (Wayland), 1920×1080 panel at 150% scale,
Chrome 146 (native Wayland), GCC 16.2, Qt 6.11.2, Node 24.

```shell
node tests/e2e/full_browser_e2e.mjs build/chrome_control_mcp
node tests/e2e/user_interference_e2e.mjs build/chrome_control_mcp
```

- Full E2E: **43/43 tools, 146 reversible live cases**, Chrome state restored.
- Coordinate clicks land from `screenshot_center` at real 150% scale and emulated 1×, 1.25×, 1.5×,
  2×, and 3× across 1280×800 to 360×640 viewports; PNG width checked as viewport × scale.
- OS focus unchanged after tab selection and window retarget. Hyprland focuses every newly mapped
  window despite `focused: false`; tool reported it as `took_os_focus` and E2E recorded it.
- User interference: **7/7 checks**. User opened a foreground tab and then a new window from outside
  Chrome; snapshots, typing, screenshots, and tab listing stayed on session tab.
- Red drills: box CSS center fed to `browser_click_at` missed at 150% scale; integer-only
  `device_scale_factor` refused 1.25×; restoring last-focused-window targeting made interference
  E2E read user's page. Each failed as intended and passed after restoration.

## macOS live Chrome

Evidence recorded 2026-09-19 on macOS 15.7.4 (Intel), Chrome 153.0.8010.48, Chrome for Testing
153.0.8010.52, Qt 6.11.1, Node 26.5.0, CMake 4.4.0.

```shell
node tests/e2e/full_browser_e2e.mjs build/chrome_control_mcp            # the user's own Chrome
node tests/e2e/isolated_run.mjs --chrome=<CfT> tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=3
```

- Full E2E on the user's own Chrome, every call in a background tab: **43/43 tools, 151 reversible
  live cases**, 12.5 s of tool time, the extension attaching in 0.8 s. The user's tab was asserted to still be the one in front after
  every single call, and the machine's front application (their editor) was unchanged before and
  after.
- User interference, in a dedicated browser: **10/10 checks**. A tab and then a window opened as the
  user; snapshots, typing, screenshots, scrolling, and clicking stayed on the session's tab, the
  user's tab stayed in front throughout, and the session opened no windows of its own.
- Display matrix, in dedicated browsers: **35/35 configurations, 3335/3335 checks** across display
  scales 1×, 1.25×, 1.5×, 1.75×, 2×, 2.5×, 3×; windows from 390×844 to 3840×2160; every one of
  Chrome's zoom steps from 25% to 500%; trackpad pinch at 1.5×, 2×, and 3×; and both a scrollbar
  drawn over the page and one that takes layout space. Every coordinate is proven by where its click
  landed on the fixture, and every screenshot by the pixels of its solid-colour targets measured
  against the page's own `getBoundingClientRect`. Eight configurations end in a refusal instead of a
  click -- a target flush with the page's edge under a pinch at 67% zoom or less, where the pinched
  page's scrollbar covers all of it -- and each refusal is accepted only because the browser's own
  hit test agrees no point of the target is on top.

### What a background tab costs, measured

Chrome answers a tab nobody is looking at differently, and the numbers drove several fixes above.
Per call, on the user's own Chrome, before and after:

| Call                                               | Before    | After    |
| -------------------------------------------------- | --------- | -------- |
| `browser_drag` (12 interpolated moves)             | 8,883 ms  | 103 ms   |
| `browser_scroll` 300 px                            | 10,133 ms | 52 ms    |
| `browser_hover` with `duration_ms: 100`            | 6,255 ms  | 155 ms   |
| `browser_drag` with `hold_ms: 150`                 | 10,221 ms | 206 ms   |
| `browser_wait_for`, 1.5 s timeout, never satisfied | 10,273 ms | 1,553 ms |
| `browser_window` `new`                             | 10,904 ms | 286 ms   |

Two causes, both measured rather than assumed. Chrome coalesces a background extension service
worker's timers into seconds, while the same page's own timers keep time to the millisecond there
(50 ms → 86, 100 → 101, 250 → 281, 1000 → 1003): every wait about the page is now timed by the
page. And Chrome answers _continuous_ input -- mouse moves, wheels -- at a frame, which a hidden tab
is drawn at rarely: the interpolated moves of a drag are now sent in order and awaited together, as
Chrome coalesces a real mouse anyway. Reads, snapshots, screenshots, clicks, and keystrokes were
never affected (26-129 ms).

## Windows live Chrome

Evidence recorded 2026-09-22 on Windows 11 Pro 26200, MSVC 19.50, Qt 6.10.0, CMake 4.4.3, Node
24.13.0, Chrome for Testing 153.0.8010.52.

```shell
node tests/e2e/full_browser_e2e.mjs build/Release/chrome_control_mcp.exe
node tests/e2e/isolated_run.mjs --chrome=<CfT> --chrome-arg=--headless=new tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=2
```

- Full E2E, every call in a background tab: **44/44 tools, 153 reversible live cases**, the
  extension attaching in 2.1 s, Chrome state restored. The upload case writes a temporary file,
  attaches it to the fixture's file input, and asserts what the PAGE read back: the name, the
  size, and the file's own bytes.
- User interference, in a dedicated browser: **10/10 checks**. A tab and then a window opened as
  the user; the session's tab kept every snapshot, keystroke, screenshot, and listing.
- Display matrix, in dedicated browsers: **35/35 configurations, 3335/3335 checks** across display
  scales 1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x, 3x; windows from 390x844 to 3840x2160; every Chrome zoom
  step from 25% to 500%; pinch at 1.5x, 2x, and 3x; and both scrollbar kinds.

### The capture hang this platform found

A dedicated browser on Windows hides a background tab, where macOS's did not, and that is what
exposed it: `Page.captureScreenshot` returns only once the tab produces a compositor frame, and a
tab nobody is looking at produces none. The capture never answered, the app waited out its whole
30 s transport deadline, and the reset that followed detached the extension -- one screenshot ended
the session. Reproduced on the E2E fixture in a background tab, then fixed by capturing with a
one-pixel screencast running, which makes Chrome composite the tab:

| Capture of the fixture in a background tab | Before                         | After |
| ------------------------------------------ | ------------------------------ | ----- |
| First capture                              | no reply in 30 s, bridge reset | 1.8 s |
| Second capture                             | extension no longer attached   | 1.3 s |

The forced path returns the same image, not a different one: at 2x, foreground plain capture and
background screencast-forced capture were byte-identical, 114,526 bytes for the viewport and
178,520 for the full page.

## Claim boundary

Source build, automated suites, static analysis, sanitizers, public identity, isolated native-host
lifecycle, stdio MCP, and Windows, Linux (Wayland), and macOS live Chrome are verified. Linux and
macOS transport and installer have real local runtime proof. The display matrix runs on dedicated
browsers on all three platforms; hidden-tab behaviour is proven on physical macOS above and, since
2026-09-22, on Windows, where a dedicated browser does hide a background tab and found the capture
hang recorded below. This is strong software evidence, not a claim about every website, Chrome
release, desktop environment, or machine configuration.
