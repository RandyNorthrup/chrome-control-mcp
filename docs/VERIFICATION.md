# Verification

Evidence recorded 2026-08-20. Commands below ran against repository checkout, not mocked transport.

## Environments

| Platform | Toolchain                                | Result                                |
| -------- | ---------------------------------------- | ------------------------------------- |
| Windows  | MSVC 19.44, CMake 3.31, Qt 6.10, Node 22 | Build + 9/9 suites + live Chrome pass |
| Linux    | GCC 16 and Clang 22, Qt 6.11, Node 24    | Both builds + 9/9 suites              |
| macOS    | Clang + Qt 6.10 GitHub Actions runner    | Build + 9/9 suites                    |

Live Windows browser: Chrome 151.0.7922.138. Minimum supported manifest version is Chrome 116.

## Browser identity and delivery

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Extension version: `1.0.0`
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

Result: **9/9 passed** under Windows/MSVC, Linux/GCC, Linux/Clang, and macOS/Clang.

| Test                               | Coverage                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `test_browser_contract`            | 40 browser-tool schemas, translation, refs, bounds, and validation     |
| `test_native_messaging`            | Native frame codec and host handshake                                  |
| `test_browser_bridge`              | Session, reply correlation, snapshots, and stale refs                  |
| `test_browser_extension_installer` | Public identity and isolated native-host lifecycle                     |
| `test_browser_bridge_security`     | ACL/permissions, nonce, rendezvous, and ownership                      |
| `test_browser_bridge_pipe`         | Platform IPC handshake, peer verification, timeout, framing, reconnect |
| `test_browser_bridge_relay`        | End-to-end relay/bridge/session with fake extension                    |
| `test_browser_mcp_server`          | Identity, 43 tools, profiles, envelopes, schemas, and MCP content      |
| `test_browser_extension_pure`      | 33 service-worker security, storage, geometry, and decision cases      |

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
- Full profile: 43 tools
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

## Claim boundary

Source build, automated suites, static analysis, sanitizers, public identity, isolated native-host
lifecycle, stdio MCP, and Windows live Chrome are verified. Linux transport and installer have real
local runtime proof. macOS has source/CI compile-test coverage; live Chrome proof on physical macOS
remains planned. This is strong software evidence, not a claim about every website, Chrome release,
desktop environment, or machine configuration.
