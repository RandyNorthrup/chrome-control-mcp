# Verification

Verified on Windows x64, 2026-08-20:

- MSVC 19.44.35222
- CMake 3.31.3
- Qt 6.10.3 MSVC 2022 x64
- Node.js 22.19.0
- Chrome 151.0.7922.138
- Release configuration

## Browser identity and delivery

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Extension version: `1.0.0`
- Delivery: unpacked extension directory
- Public manifest identity derives the pinned extension ID
- No private extension key, packaged browser artifact, store account, or Chrome enterprise policy

## Build

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 `
  -DCMAKE_PREFIX_PATH=C:/Qt/6.10.3/msvc2022_64 -DBUILD_TESTING=ON
cmake --build build --config Release --parallel
```

Result: success. Executable, unpacked extension, and Qt runtime staged under `build\Release`.

Install bundle verified with:

```powershell
cmake --install build --config Release --prefix dist
```

Bundle contents:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `chrome_control_mcp.exe`  | `DC6164DACABC5267A05B350D9021C5B3585D998F4CF46863C0A31E1729D64AF9` |
| `extension/background.js` | `F89BBF6409E928F33647C8E6D9CE78F3B3D414C893D48D6C8F438437EA57AB0C` |
| `extension/manifest.json` | `3E319B32E064C125699CC74F0E2759E6FC800604974A726478175F8ACB6683A5` |
| `Qt6Core.dll`             | `B712B4754588E89F855DC0AA087D6304B2FD21B0E0639D1CDEB9CB969BD5FB72` |
| `LICENSE`                 | `33C1DE52600AA788C54CC819E905E20A62B37D4EA4B33FFFB71D389E5198D752` |

## Tests

```powershell
ctest --test-dir build -C Release --output-on-failure
```

Result: 9/9 passed.

| Test                               | Coverage                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `test_browser_contract`            | 40-tool schemas, translation, refs, screenshot overlay option, bounds, validation |
| `test_native_messaging`            | Native frame codec and host handshake                                             |
| `test_browser_bridge`              | Session, reply correlation, snapshots, stale refs                                 |
| `test_browser_extension_installer` | Public identity and isolated native-host lifecycle                                |
| `test_browser_bridge_security`     | Project pipe prefix, DACL, label, nonce, rendezvous                               |
| `test_browser_bridge_pipe`         | Pipe handshake, verification, timeout, framing                                    |
| `test_browser_bridge_relay`        | End-to-end relay/pipe/session with fake extension                                 |
| `test_browser_mcp_server`          | Identity, 43 tools, profiles, MCP envelopes/content                               |
| `test_browser_extension_pure`      | 33 service-worker guard, storage-domain, geometry, and decision cases             |

## MCP process smoke

```powershell
.\scripts\mcp_smoke.ps1 -Executable .\dist\chrome_control_mcp.exe
.\scripts\mcp_smoke.ps1 -Executable .\dist\chrome_control_mcp.exe -ReadOnly
```

Results:

- Initialize protocol `2024-11-05`, server `chrome-control-mcp`
- Full profile: 43 tools
- Read-only profile: 10 tools
- Unpacked extension files present in bundle
- Extension status returns pinned ID
- Extension state after current-user registration: `prepared`

## Live Chrome workflow

Executed against `http://uitestingplayground.com/` with extension loaded in Chrome:

```powershell
.\scripts\live_browser_verify.ps1 -Site http://uitestingplayground.com/
```

Result: success.

- Opened dedicated temporary tab
- Navigated from homepage to Text Input through element ref
- Captured live accessibility/DOM snapshot
- Typed probe text and read exact value back
- Clicked update button and observed changed text
- Captured `image/png` screenshot (`74,160` base64 characters) with opt-in control presence
- Held control presence for 20 seconds; user confirmed pink frame, `AI CONTROL` badge, and agent
  cursor were visible
- Closed temporary tab

The verified screenshot is committed at
[`docs/assets/chrome-control-overlay-playground.png`](assets/chrome-control-overlay-playground.png).

Use `-HoldSeconds 20` to hold control frame, badge, and agent cursor for manual observation before
temporary-tab cleanup.

## Full live tool E2E

Executed the reversible local fixture harness with the unpacked extension loaded:

```powershell
$env:CHROME_CONTROL_MCP_SHOWCASE_DIR = "$PWD\docs\assets"
node .\tests\e2e\full_browser_e2e.mjs .\dist\chrome_control_mcp.exe
```

Result: **43/43 advertised MCP tools passed across 98 live cases**.

- Exercised every navigation, capture, input, tab, window, inspection, state, advanced, and
  extension-lifecycle tool through the real MCP process, native host, extension, and Chrome
- Verified storage set/get/keys/remove/clear in local and session storage
- Verified cookies, permission block/restore, download bytes, printed PDF header, and HTTP auth
- Verified tab selection, grouping/ungrouping, closing, window create/focus/close, and history
- Verified extension unregister/re-register and final prepared state
- Deleted the exact test download and PDF, cleared fixture state, closed fixture tabs/windows, and
  restored the original active tab
- Captured and visually inspected the committed responsive fixture overlay screenshot

The harness first exposed two live integration defects that unit tests had missed: scrolled-page
occlusion hit-testing used viewport coordinates against a document-coordinate CDP command, and
storage used a debugger domain unavailable to Chrome extensions. Both paths now have regression
coverage and passed this full rerun.

## Claim boundary

Build, 9 automated suites, public identity, isolated native-host lifecycle, stdio MCP, package
staging, every advertised MCP tool, and the public-site Chrome workflow are verified. Privileged
mutations were exercised only against the dedicated loopback fixture and were reversed afterward;
this is strong end-to-end software evidence, not a claim about every website, Chrome release, or
machine configuration.
