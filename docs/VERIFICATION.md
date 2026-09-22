# Verification

Evidence recorded 2026-08-20. Commands below ran against repository checkout, not mocked transport.

## Environments

| Platform | Toolchain                                | Result                                 |
| -------- | ---------------------------------------- | -------------------------------------- |
| Windows  | MSVC 19.44, CMake 3.31, Qt 6.10, Node 22 | Build + 9/9 suites + live Chrome pass  |
| Linux    | GCC 16 and Clang 22, Qt 6.11, Node 24    | Both builds + 9/9 suites + live Chrome |
| macOS    | Clang + Qt 6.10 GitHub Actions runner    | Build + 9/9 suites                     |

Live Windows browser: Chrome 151.0.7922.138. Minimum supported manifest version is Chrome 116.

## Browser identity and delivery

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Extension version: `1.2.1`
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

Result: **10/10 passed** under Windows/MSVC, Linux/GCC, Linux/Clang, and macOS/Clang.

| Test                               | Coverage                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `test_browser_contract`            | 40 browser-tool schemas, translation, refs, bounds, and validation     |
| `test_native_messaging`            | Native frame codec and host handshake                                  |
| `test_browser_bridge`              | Session, reply correlation, snapshots, and stale refs                  |
| `test_browser_extension_installer` | Public identity and isolated native-host lifecycle                     |
| `test_browser_uploads`             | Upload path rules, roots confinement, and byte-exact chunking          |
| `test_browser_bridge_security`     | ACL/permissions, nonce, rendezvous, and ownership                      |
| `test_browser_bridge_pipe`         | Platform IPC handshake, peer verification, timeout, framing, reconnect |
| `test_browser_bridge_relay`        | End-to-end relay/bridge/session with fake extension                    |
| `test_browser_mcp_server`          | Identity, 44 tools, profiles, envelopes, schemas, and MCP content      |
| `test_browser_extension_pure`      | 59 service-worker security, storage, geometry, and decision cases      |

## Strict analysis

- MSVC, GCC, and Clang compile with warnings-as-errors.
- `clang-tidy` production analysis passes with analyzer, bugprone, CERT, concurrency,
  core-guidelines, misc, performance, and portability families.
- Exhaustive `cppcheck` production analysis passes. Deliberate unused-function probe first proved
  dead-code checker fails correctly; probe was then removed.
- ESLint reports 0 errors; PSScriptAnalyzer reports 0 findings.
- Full-history Gitleaks scan: 0 leaks.
- `npm audit --audit-level=moderate`: 0 vulnerabilities.

## Sanitizers

| Gate       | Result |
| ---------- | ------ |
| ASan+UBSan | 9/9    |
| TSan       | 9/9    |

TSan uses [`tests/tsan.supp`](../tests/tsan.supp) for two exact QtTest watchdog/logger symbols from
prebuilt Qt. Project frames remain unsuppressed; any project race still fails job.

## MCP and native-host smoke

```shell
npm run smoke
npm run smoke:read-only
npm run extension -- status
```

Results:

- Initialize protocol `2024-11-05`, server `chrome-control-mcp`
- Full profile: 44 tools
- Read-only profile: 10 tools
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
