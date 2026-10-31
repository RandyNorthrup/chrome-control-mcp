# Verification

What has been checked, on what, and when. The first section is the current release. Everything
after [Earlier evidence](#earlier-evidence) is a dated record of the build it names: its tool counts,
suite counts and versions were true of that build and are not current. A result is recorded here
only when a command actually produced it.

## Current: 1.8.1 (2026-10-31)

1.8.1 changes the extension (upload replies, agent names in any script, colour order), the MCP
`instructions` text, the CI analysis job and which suites ctest runs. The bridge protocol and every
other native path are as in [1.8.0](#180-2026-10-31), whose evidence below still stands for them.

### Native and unit suites

| Where          | Toolchain                         | Result                          |
| -------------- | --------------------------------- | ------------------------------- |
| Windows, local | MSVC, warnings as errors          | 22/22 ctest suites              |
| Linux, local   | GCC                               | 21/21 ctest suites              |
| Local          | Node, `npm run test:js`           | 190/190 tests across 9 files    |
| Linux, local   | Semgrep 1.174.0 under Python 3.12 | 221 rules, 51 files: 0 findings |

The Windows count is one higher because `test_windows_process_identity` builds only on Windows.
ctest runs the twelve C++ suites (eleven off Windows) and all ten JavaScript suites; `npm run
test:js` is the nine of those that need no built server. Until 1.8.1 two of them,
`test_browser_extension_tabs` and `test_release_versions`, ran only under `test:js`, which CI never
calls.

New in these counts, each red-drilled (the fix reverted, the test seen to fail, then restored):

- Agent names in any script: two unit tests fail against the old ASCII-only strip, and so does the
  live check below, whose tab then lands in the session's shared group.
- The relay's progress-beat test with its wider margin fails, naming the server's reason ("browser
  did not reply within 1000 ms"), when the relay stops forwarding beats.

### CI on `fce2acb`

Every job of the Quality run on `fce2acb`, the 1.8.1 change set, passed:

| Job                                       | Result                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Format, lint, and secret scan             | passed                                                                                                  |
| PowerShell static analysis                | passed                                                                                                  |
| Windows, Linux, macOS build and tests     | ctest 22/22 on Windows, 21/21 on Linux and macOS; the built server smoked in both profiles              |
| ASan + UBSan, TSan                        | 21/21 each                                                                                              |
| Native and semantic static analysis       | clang-tidy and exhaustive cppcheck clean; Semgrep under Python 3.12.15: 221 rules, 53 files, 0 findings |
| Windows, Linux, macOS live browser suites | passed, each with the display matrix at 35/35 configurations and 3,335 checks                           |

The live browser jobs run against Chrome for Testing 153.0.8010.52, pinned in the workflow: the
display-scale, zoom and pinch matrix, the user interference suite, and the multi-agent suite (with
its new checks for an agent named `研究` and for `page_cleared_input`) on all three platforms, and the
full browser suite, 48 tools exercised, on Windows and macOS. The Linux runner's Chrome never answers
a screenshot under an emulated fractional device scale, so the full suite does not run there; the
workflow records why.

### Semgrep

The analysis job's Semgrep step had crashed before scanning since Python 3.15 reached the runners.
The Qt install action set up the newest Python for itself, and the job then ran Semgrep under it
instead of under the 3.12 it pins; `semgrep-core` segfaults at start-up under 3.15 ("failed to create
domain backup thread"). Reproduced locally: the same scan crashes the same way under 3.15.2 and is
clean under 3.12.16. The job now tells the Qt action to leave Python alone.

### Live browser, isolated Chrome for Testing 153 (Linux, 2026-10-31)

| Suite                       | Result                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `full_browser_e2e.mjs`      | ok: 48 of the 52 tools exercised, 177 live cases, Chrome state restored |
| `multi_agent_e2e.mjs`       | 24/24                                                                   |
| `user_interference_e2e.mjs` | 10/10                                                                   |

The four tools the full suite does not drive are `browser_update_check`, `browser_update_status`
and `browser_update_apply`, covered by `test_updater` and the update-path evidence below, and
`browser_release`, which `multi_agent_e2e.mjs` drives.

`multi_agent_e2e.mjs` runs two servers with two agents behind one of them in one live browser:
separate tabs by `tab_id`, refs bound to their tabs, a group per agent -- one of them named `研究`,
whose group must carry that name -- refusal of another server's tab, uploads through a
script-created input (whose reply must name the file and say the page emptied the input), a drop
zone and `showOpenFilePicker` with no dialog, a `target=_blank` popup claimed while the user's front
tab stays in front, and cleanup on `browser_release` and on server exit.

No new run in a real Chrome profile was made for 1.8.1; the [1.8.0](#180-2026-10-31) run stands.

### Open: a Chrome stall in one display configuration

On the `v1.8.0` tag's Quality run, the Windows display matrix's `1.75x-2194x1234-zoom100-classic`
configuration (pinch 3) stopped at 58 of its checks: a full-page `browser_screenshot` failed with
`browser did not reply within 30000 ms (connection reset)`. Every command beats every 5 s while it
runs, from a timer started before the handler's first `await`, so 30 s of silence means nothing
from the extension reached the server at all -- not a slow capture.

Run six times locally on Windows (headless Chrome for Testing 153, that configuration alone), it
passed five times; the sixth stopped on `DevTools Input.synthesizePinchGesture timed out`, the
suite's own DevTools call to Chrome, which does not pass through the server, the relay or the
extension. Runs of the same configuration took between 37 and 93 s. The configuration passed in all
four other Windows CI runs on record and on Linux and macOS.

So Chrome itself stalls, intermittently, in this configuration, and that stall is what the CI
screenshot met. Why Chrome stalls is not established, and this stays open in
[PLAN.md](../PLAN.md).

### Chrome's file chooser, measured on Chrome 153

- A file chooser opened in a tab that is not the active tab of its window is cancelled; the page
  gets `cancel`.
- In the active tab of an unfocused window, a native dialog opens over whatever the user is doing.
- `Page.setInterceptFileChooserDialog` works from `chrome.debugger` in a background tab.

These are why file pickers are caught rather than shown
([MULTI_SESSION.md](MULTI_SESSION.md#file-pickers)).

### Identity and counts

- MCP initialize: protocol `2024-11-05`, server `chrome-control-mcp`, with client-agnostic
  `instructions`.
- Full profile: 52 tools, 46 browser and 6 native. Read-only profile: 14 tools, 11 browser and 3
  native. Pinned by `test_browser_mcp_server`, by `test_browser_contract` (46 browser tools), and by
  `scripts/mcp_smoke.mjs`, which CI runs against every server it builds.
- Bridge protocol: 2 (`kBrowserBridgeProtocol`, `BRIDGE_PROTOCOL`).
- Extension version 1.8.1, ID `iojehhmnaigcejfcpmilpclmeljhlkaa`, native host
  `com.chromecontrolmcp.browser`, minimum Chrome 116. Delivered as an unpacked directory; no private
  key, packaged browser artifact, store account, or enterprise policy.

### Test suites

| Suite                                 | Runs in        | Coverage                                                                                          |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `test_browser_contract`               | ctest          | 46 browser-tool schemas, command translation, `tab_id` and `agent` validation, refs bound to tabs |
| `test_native_messaging`               | ctest          | native frame codec and host handshake                                                             |
| `test_browser_bridge`                 | ctest          | reply correlation, per-tab snapshots and staleness, refs dropped for released tabs, client name   |
| `test_browser_extension_installer`    | ctest          | public identity and isolated native-host lifecycle                                                |
| `test_browser_uploads`                | ctest          | upload path rules, roots confinement, and byte-exact chunking                                     |
| `test_browser_bridge_security`        | ctest          | ACL/permissions, nonce, per-pid rendezvous records, runtime-directory override                    |
| `test_browser_bridge_pipe`            | ctest          | IPC handshake, peer verification, deadlines and beats, idle-peer departure, reconnect, sweep      |
| `test_browser_bridge_relay`           | ctest          | relay/bridge/session end to end, offers of running servers only, `bridge_servers`, progress       |
| `test_install_layout`                 | ctest          | version-directory safety, link swap under an open file, pruning, install lock                     |
| `test_updater`                        | ctest          | asset naming, checksums, version order, staged install, an older build leaving a newer current    |
| `test_browser_mcp_server`             | ctest          | identity, `instructions`, 52 tools, profiles, envelopes, schemas, MCP content                     |
| `test_windows_process_identity`       | ctest, Windows | identity across a junction, from a child launched through one                                     |
| `test_browser_extension_pure`         | both           | service-worker security, storage, geometry, and decision functions                                |
| `test_browser_extension_transport`    | both           | reconnect backoff and pause, offers, readiness handshake, protocol mismatch, refused commands     |
| `test_browser_extension_session`      | both           | what a tab stops believing when its debugger attachment ends                                      |
| `test_browser_extension_multisession` | both           | one port per server, and the leases that keep sessions apart                                      |
| `test_browser_extension_recording`    | both           | recording refusals, the timeline, and discard when the tab or session ends                        |
| `test_browser_extension_offscreen`    | both           | the recorder host loaded for real, against a captureStream-less OffscreenCanvas                   |
| `test_vscode_payload`                 | both           | VSIX payload rules, with red drills for a link that survives pruning                              |
| `test_extension_install_cycle`        | ctest          | install, status and uninstall tools driven through the built server against a real registration   |
| `test_browser_extension_tabs`         | both           | whose tab it is, popups, per-agent groups and names, release, parking, idle, file choosers        |
| `test_release_versions`               | both           | one version everywhere, with its changelog entry and release note                                 |

"Both" means ctest and `npm run test:js`; CI runs ctest on Windows, Linux and macOS.

### Reproducing

```shell
npm ci
npm run build              # configure, build, and run ctest
npm run test:js            # the JavaScript suites
npm run smoke
npm run smoke:read-only
npm run extension -- status
```

Equivalent native commands:

```shell
cmake -S . -B build -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
```

The Windows generator may add `-A x64`; multi-config builds place the executable under
`build/Release`.

The live suites, in a dedicated Chrome for Testing that never touches your own profile:

```shell
node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> tests/e2e/full_browser_e2e.mjs
node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> tests/e2e/multi_agent_e2e.mjs
node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=2 --executable=<server>
node tools/backoff_probe.mjs <chrome> <unpacked extension dir> [seconds]
```

### Claim boundary

Verified for 1.8.1: source build and automated suites on Windows and Linux locally and on all three
platforms in CI; strict native analysis and a clean Semgrep scan; sanitizers; the live suites in
Chrome for Testing on all three platforms in CI and on Linux locally; and, for everything
1.8.1 leaves unchanged, the 1.8.0 evidence below, including a real-world run in a real Chrome
profile on Windows. Not verified: a real Chrome profile on macOS or Linux; why Chrome stalls in the
one display configuration above. No Linux machine has ever installed a release through
`browser_update_apply`. This is strong software evidence, not a claim about every website, Chrome
release, desktop environment, or machine configuration.

## Earlier evidence

Each section below records the build it names. Tool totals and suite counts in them are those of
that build.

### 1.8.0 (2026-10-31)

Tag `v1.8.0`, commit `ef9ae34`; CI results are for `0ebfbfc`, the next commit, which changed only
JavaScript dependency pins.

- **Native and unit suites, local:** Windows/MSVC 20/20 ctest suites; Linux/GCC 19/19; Linux/Clang
  clang-tidy and exhaustive cppcheck clean; 188/188 JavaScript tests under `npm run test:js`, two
  of whose files ctest did not yet run.
- **CI on `0ebfbfc`:** format, lint and secret scan, PowerShell analysis, Windows, Linux and macOS
  build and tests (with the built server smoked in both profiles), ASan + UBSan, TSan, and the live
  browser suites on all three platforms passed. clang-tidy and cppcheck passed; the Semgrep step
  crashed before scanning, so no Semgrep result exists for 1.8.0 (cause and fix under 1.8.1).
- **Release workflow for `v1.8.0`:** all four archives built, ran ctest and were smoked as staged;
  the GitHub release and the VS Code Marketplace publish succeeded.
- **The tag's own Quality run** also failed `npm audit` (fixed by `0ebfbfc`'s pins); one macOS
  relay test, `relay_forwardsProgressBeatsAndStillDeliversTheReply`, on a timing margin of about
  125 ms, widened in 1.8.1; and one Windows display-matrix configuration, a Chrome stall recorded
  as open under 1.8.1.
- **Live browser, isolated Chrome for Testing 153 on Linux:** `full_browser_e2e.mjs` ok, 48 of 52
  tools and 177 live cases; `multi_agent_e2e.mjs` 22/22; `user_interference_e2e.mjs` 10/10.
- **Real Chrome, the maintainer's own Windows profile:** an ad hoc run (not a committed suite)
  passed 23/23 real-world checks -- two servers posing as two different clients, three agents, live
  sites: Wikipedia; the-internet.herokuapp.com (a login, a real file upload through the page's own
  input with no dialog shown, a `target=_blank` popup); YouTube, a Trusted Types page, where the
  highlight drew without an error -- and uploads to local fixtures. Exit cleanup and a `keep_open`
  hand-over behaved as documented, and each server kept one relay process throughout. Checked by
  hand: Ctrl+T from an AI tab opened a tab that stayed out of the AI group, and the agent stayed on
  its own tab.
- **Reconnect cadence** with no server running, measured with `tools/backoff_probe.mjs`: 6 attempts
  in 75 s, unchanged from 1.7.0.

### 1.5.2, live Chrome (2026-09-23)

Windows 11 Pro 26200, Chrome with the unpacked extension loaded from the managed install. Every
line below is a real call against a real browser; each of the four faults was found this way and
none of them was visible to the suites before it.

| Checked                                   | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Bridge attaches after an extension reload | Attached with no intervention                                           |
| `browser_navigate`, https                 | `https://example.org/` loaded                                           |
| `browser_navigate`, http                  | `http://uitestingplayground.com/textinput` loaded                       |
| Snapshot / type / click                   | 11 refs; 14 characters typed; click landed at (458, 462)                |
| `browser_record_start` / `_stop`          | 886,899-byte `.webm`, EBML magic `1a45dfa3`, 6 commands in the timeline |
| Recording timeline tracks the DOM         | `dom_epoch` 0 -> 1 -> 2 across two navigations                          |
| Orphaned relay after an extension reload  | The relay exited on its own; the bridge recovered with nothing killed   |
| Two servers at once                       | Both rendezvous records present; neither swept the other                |
| Second session opens its own tab          | Opened, snapshotted and closed its own tab while the first held another |
| A tab held elsewhere                      | Listed and flagged `controlled_by_other_session`, not hidden            |
| Lease refusal                             | Named the holding server by pid                                         |

The recording figure is what made `browser_record_start` and `browser_record_stop` verified at
all: they shipped in 1.5.0 and failed on their first real start, because the file that encodes the
video was the one shipped file no test loaded.

### Suites, analysis, and smoke, as of 1.4.0-1.5.x (2026-09-22 to 2026-09-23)

| Platform | Toolchain                                | Result                                   |
| -------- | ---------------------------------------- | ---------------------------------------- |
| Windows  | MSVC 19.50, CMake 3.31, Qt 6.10, Node 24 | Build + 19/19 suites + live Chrome pass  |
| Linux    | GCC 16 and Clang 22, Qt 6.11, Node 24    | Both builds + 17/17 suites + live Chrome |
| macOS    | Clang + Qt 6.10 GitHub Actions runner    | Build + 17/17 suites                     |

The suite totals were then 19/19 under Windows/MSVC and 18/18 under Linux/GCC, Linux/Clang, and
macOS/Clang; `test_install_layout` and `test_updater` were newer than the local Linux and macOS
desktop runs in the table and had passed on all three platforms in GitHub Actions, which is where
the 17/17 figures came from. The extension version was 1.4.0.

`test_windows_process_identity` re-launches the test binary through a real directory junction and
has that child decide whether the parent is the same program -- the position the relay is in, and
the only position from which the bug it guards is visible. Its teardown removes the junction as a
link and never recursively, because the first version of the test used `QTemporaryDir`, whose
recursive cleanup followed the junction and deleted the build directory it pointed at.

The update path was exercised end to end on Windows and on macOS 15.7.4, where a published archive
installs and `browser_update_check` reaches the release host over HTTPS through the bundled TLS
backend.

Strict analysis then:

- MSVC, GCC, and Clang compiled with warnings as errors.
- `clang-tidy` production analysis passed with the analyzer, bugprone, CERT, concurrency,
  core-guidelines, misc, performance, and portability families.
- Exhaustive `cppcheck` production analysis passed. A deliberate unused-function probe first proved
  the dead-code checker fails correctly; the probe was then removed.
- ESLint reported 0 errors; PSScriptAnalyzer 0 findings.
- PSScriptAnalyzer throws `Object reference not set to an instance of an object` on a cold module
  import, which is why the worker retries. Measured against 1.25.0, the newest release: three
  passes over the eight tracked scripts produced one such failure on the first invocation and none
  afterwards, so the retry mitigates a defect that is still upstream rather than one this project
  introduced.
- Full-history Gitleaks scan: 0 leaks.
- `npm audit --audit-level=low`, for both the root and the extension package: 0 vulnerabilities.

Sanitizers then:

| Gate       | Result | Where                                           |
| ---------- | ------ | ----------------------------------------------- |
| ASan+UBSan | 17/17  | GitHub Actions, and locally on Arch, GCC 16.2.1 |
| TSan       | 17/17  | GitHub Actions (Qt 6.10.0)                      |

ASan+UBSan was re-run locally on Arch with GCC 16.2.1 and Qt 6.11.2: thirteen suites passed and
neither sanitizer reported anything, including the bridge pipe, relay, and security suites, which
are the ones that actually run threads.

TSan runs with no suppressions. It carried a suppression file naming two Qt symbols until that file
was audited with `print_suppressions=1`: neither entry ever matched, and the job reported no race
with or without them. One named the wrong function and the other used `thread:`, which suppresses
thread-leak reports rather than data races, so neither could have matched. The file is gone, and any
race this gate sees now fails it.

Qt 6.11.2 does carry a race in `QPlainTestLogger::stopLogging`, between QtTest's watchdog thread and
main's stack during teardown, which is visible when these suites are built against it. It has no
project frame in either stack and appears even in `test_install_layout`, which starts no thread of
this project's own. The Qt this workflow pins, 6.10.0, does not exhibit it.

Smoke then: initialize protocol `2024-11-05`, server `chrome-control-mcp`; full profile 49 tools;
read-only profile 12 tools; staged extension present with pinned ID; Linux isolated install →
status → uninstall lifecycle passed with a generated mode-`0600` manifest.

### Windows live Chrome (2026-09-22)

Windows 11 Pro 26200, MSVC 19.50, Qt 6.10.0, CMake 4.4.3, Node 24.13.0, Chrome for Testing
153.0.8010.52.

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

#### The capture hang this platform found

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

### macOS live Chrome (2026-09-19)

macOS 15.7.4 (Intel), Chrome 153.0.8010.48, Chrome for Testing 153.0.8010.52, Qt 6.11.1, Node
26.5.0, CMake 4.4.0.

```shell
node tests/e2e/full_browser_e2e.mjs build/chrome_control_mcp            # the user's own Chrome
node tests/e2e/isolated_run.mjs --chrome=<CfT> tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=3
```

- Full E2E on the user's own Chrome, every call in a background tab: **43/43 tools, 151 reversible
  live cases**, 12.5 s of tool time, the extension attaching in 0.8 s. The user's tab was asserted
  to still be the one in front after every single call, and the machine's front application (their
  editor) was unchanged before and after.
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

#### What a background tab costs, measured

Chrome answers a tab nobody is looking at differently, and the numbers drove several fixes. Per
call, on the user's own Chrome, before and after:

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

### Linux live Chrome (2026-09-18)

Arch Linux, Hyprland (Wayland), 1920×1080 panel at 150% scale, Chrome 146 (native Wayland), GCC
16.2, Qt 6.11.2, Node 24.

```shell
node tests/e2e/full_browser_e2e.mjs build/chrome_control_mcp
node tests/e2e/user_interference_e2e.mjs build/chrome_control_mcp
```

- Full E2E: **43/43 tools, 146 reversible live cases**, Chrome state restored.
- Coordinate clicks land from `screenshot_center` at real 150% scale and emulated 1×, 1.25×, 1.5×,
  2×, and 3× across 1280×800 to 360×640 viewports; PNG width checked as viewport × scale.
- OS focus unchanged after tab selection and window retarget. Hyprland focuses every newly mapped
  window despite `focused: false`; the tool reported it as `took_os_focus` and the E2E recorded it.
- User interference: **7/7 checks**. The user opened a foreground tab and then a new window from
  outside Chrome; snapshots, typing, screenshots, and tab listing stayed on the session's tab.
- Red drills: a box's CSS centre fed to `browser_click_at` missed at 150% scale; an integer-only
  `device_scale_factor` refused 1.25×; restoring last-focused-window targeting made the
  interference E2E read the user's page. Each failed as intended and passed after restoration.

### Initial release (2026-08-20)

Commands ran against the repository checkout, not a mocked transport. Live Windows browser: Chrome
151.0.7922.138.

Live Chrome workflow against [UI Test Automation Playground](http://uitestingplayground.com/) with
the unpacked extension loaded:

```powershell
./scripts/live_browser_verify.ps1 -Site http://uitestingplayground.com/
```

Result: success. It opened a dedicated temporary tab, navigated through a semantic element ref,
captured a live accessibility/DOM snapshot, typed probe text and read the exact value back, clicked
the update button and observed the changed text, captured an `image/png` screenshot with opt-in
control presence, and closed the temporary tab. The user confirmed the visible pink frame, the
`AI CONTROL` badge, and the agent cursor -- the single marking of that release, before groups and
frames took a per-agent colour. Verified screenshot:
[`docs/assets/chrome-control-overlay-playground.png`](assets/chrome-control-overlay-playground.png).

Full live tool E2E:

```powershell
$env:CHROME_CONTROL_MCP_SHOWCASE_DIR = "$PWD/docs/assets"
node tests/e2e/full_browser_e2e.mjs dist/chrome_control_mcp.exe
```

Result: **43/43 advertised MCP tools across 97 reversible live cases**, through the real MCP
process, native host, extension, and Chrome: navigation, capture, input, tabs, windows, inspection,
state, advanced operations, and extension lifecycle. Storage, cookies, permissions, download bytes,
PDF header, and HTTP auth were verified; the test download and PDF were deleted, fixture state
cleared, fixture tabs and windows closed, and the original active tab restored. The responsive
overlay screenshot was captured and visually inspected.
