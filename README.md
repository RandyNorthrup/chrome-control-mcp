<div align="center">

# Chrome Control MCP

**Visible, precise Chrome control for AI assistants. Local by design.**

[![Quality](https://github.com/RandyNorthrup/chrome-control-mcp/actions/workflows/quality.yml/badge.svg)](https://github.com/RandyNorthrup/chrome-control-mcp/actions/workflows/quality.yml)
[![Release](https://img.shields.io/github/v/release/RandyNorthrup/chrome-control-mcp?color=ec4899)](https://github.com/RandyNorthrup/chrome-control-mcp/releases/latest)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/RandyNorthrup.chrome-control-mcp?color=2563eb&label=marketplace)](https://marketplace.visualstudio.com/items?itemName=RandyNorthrup.chrome-control-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-7c3aed.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-2563eb.svg)
![C++20](https://img.shields.io/badge/C%2B%2B-20-00599c.svg)
![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285f4.svg)
![MCP tools](https://img.shields.io/badge/MCP%20tools-47-ff1493.svg)

<p>
  Standalone Model Context Protocol server connecting an AI assistant to your existing Chrome
  through native messaging and Chrome DevTools Protocol.
</p>

[Install](#install) · [Updating](#staying-up-to-date) · [Tool catalog](docs/TOOLS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Verification](docs/VERIFICATION.md)

</div>

![Chrome Control MCP driving UI Test Automation Playground with its visible pink control frame, AI CONTROL badge, and agent cursor](docs/assets/chrome-control-overlay-playground.png)

Active automation stays visible: pink frame, **AI CONTROL** badge, and pulsing agent cursor show
when an assistant controls Chrome, and the tab under control sits in a pink **AI CONTROL** tab
group, so it is identifiable in the tab strip without opening it. Model-facing screenshots hide the
page overlay by default; documentation captures can opt in.

## Why this project

| Capability          | Included                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Works beside you    | Session drives its own visible tab; never changes which tab is in front, raises a window, or takes your OS focus |
| Semantic control    | Accessibility-tree snapshots with stable element refs                                                            |
| Real input          | Click, type, keys, hover, drag, select, scroll, dialogs, and media                                               |
| File upload         | Attach local files to a page's file input, as the user's own picker would                                        |
| Visual reasoning    | Viewport/full-page PNG capture and guarded coordinate clicks                                                     |
| Browser management  | Navigation, tabs, tab groups, windows, emulation, and waits                                                      |
| Browser state       | Cookies, local/session storage, permissions, downloads, print, and HTTP auth                                     |
| Extension lifecycle | Prepare, inspect, and unregister current-user native-host integration                                            |
| In-place updates    | Check, download, verify, and install a new release without overwriting the running executable                    |

All **47 MCP tools** use strict JSON Schemas. Long-lived MCP process preserves session and
element-ref state while Chrome remains an ordinary user-controlled browser.

## See it work

| Public UI test site                                                                                         | Responsive E2E fixture                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Text Input test controlled through Chrome Control MCP](docs/assets/chrome-control-overlay-playground.png) | ![Chrome Control MCP exercising form, pointer, and dialog controls in its local test fixture](docs/assets/chrome-control-overlay-fixture.png) |
| Navigation, snapshot, typing, read-back, ref click, and screenshot                                          | Form state, coordinate click, hover, drag, dialog handling, and control presence                                                              |

Both images are direct `browser_screenshot` results from live extension, not mockups.

> **Testing shout-out:** Inflectra's [UI Test Automation Playground](http://uitestingplayground.com/)
> and [open-source repository](https://github.com/inflectra/ui-test-automation-playground) provide
> focused, practical browser interaction scenarios. They have been invaluable for testing this
> project's full MCP-to-Chrome path.

## Install

### From the VS Code Marketplace

Install **Chrome Control MCP** from the marketplace, or:

```shell
code --install-extension RandyNorthrup.chrome-control-mcp
```

The marketplace serves the build for your platform. The extension installs the server on first
activation and registers it with the editor through the MCP server definition provider API, so there
is no `mcp.json` to edit and no path to know. Marketplace updates and the server updating itself
land in the same install; whichever is newer runs.

One manual step remains, and only once. Run **Chrome Control MCP: Show the Chrome extension folder
to load** from the command palette: it copies the folder path and opens it. Then in Chrome open
`chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick that folder.
Why that cannot be automated is explained under [Prepare Chrome](#3-prepare-chrome). The other
command, **Chrome Control MCP: Repair install**, reinstalls the server and its native-host
registration.

### From a release archive

[Download the latest release](https://github.com/RandyNorthrup/chrome-control-mcp/releases/latest)
for Windows x64, Linux x64, Apple silicon macOS, or Intel macOS, unpack it, and run:

```shell
# Windows
.\chrome_control_mcp.exe --install

# Linux / macOS
./chrome_control_mcp --install
```

That installs the server where it can update itself and prints the command path to give your
assistant, plus the folder to load into Chrome. Both stay the same through every later update.

Each archive carries the MCP executable, the unpacked extension, the matching Qt Core and Qt Network
runtime, the platform's Qt TLS backend, licenses, and an SPDX inventory; the Linux archives also
carry the ICU libraries Qt Core links against there. SHA-256 checksums are published beside the
assets.

All artifacts are intentionally unsigned and unnotarized; this project has no signing key and does
not require one. See the [release guide](docs/RELEASES.md) for verification, platform warnings, and
the exact packaging boundary.

## Quick start (from source)

### 1. Install build requirements

- Windows 10/11 x64, Linux x64, or macOS
- Google Chrome 116+
- CMake 3.25+
- Qt 6.5+ with Core, Network, and Test components
- C++20 compiler: Visual Studio 2022, GCC, or Clang
- Node.js 20.19+

### 2. Build and test

```shell
npm ci
npm run build
```

Default output:

| Platform      | Executable                             | Staged extension           |
| ------------- | -------------------------------------- | -------------------------- |
| Windows       | `build/Release/chrome_control_mcp.exe` | `build/Release/extension/` |
| Linux / macOS | `build/chrome_control_mcp`             | `build/extension/`         |

PowerShell users may run `./scripts/build.ps1 -Configuration Release` instead. Both paths build
with warnings-as-errors and run all native plus extension unit suites.

### 3. Prepare Chrome

```shell
npm run extension -- install
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, then select folder
printed by command.

**This step is manual and cannot be automated. That is Chrome's decision, not an omission here.**
Branded Chrome 137 and later ignore `--load-extension`; only Chromium and Chrome for Testing still
honour it. Installing by enterprise policy needs a Web Store listing and a packaged, signed
extension, which this project deliberately does not have. Driving the browser's own windows with a
UI-automation tool is not an install path either: it takes over the user's screen and breaks on any
Chrome or locale change. An assistant asked to set this up should print the folder and the three
clicks and hand the keyboard back; there is no workaround to go looking for.

No signing key, packaged extension, store account, administrator access, or enterprise policy is
needed. Public `key` in `manifest.json` only pins unpacked extension ID; it cannot sign software.

### 4. Connect an assistant

Use absolute executable path.

```shell
# Windows
codex mcp add chrome-control -- "C:\absolute\path\chrome_control_mcp.exe"

# Linux / macOS
codex mcp add chrome-control -- /absolute/path/chrome_control_mcp
```

Claude Code uses same executable:

```shell
claude mcp add --scope local chrome-control -- /absolute/path/chrome_control_mcp
```

Prefer the path `--install` prints over a build-directory path: only the former survives an
update.

Transport is newline-delimited JSON-RPC over stdio. Server opens no TCP listener.

## Staying up to date

```text
browser_update_status   where this build is installed, and which versions are present
browser_update_check    what the newest release is
browser_update_apply    install it
```

`browser_update_status` touches no network. The executable also answers `--version`, and `--install`
puts a copy into the managed layout without an MCP client in the loop.

A running executable cannot be overwritten on Windows, so the update never tries to. Each version
is installed into `<root>/versions/<version>` and a `current` link -- a directory junction on
Windows, a symbolic link on Linux and macOS -- is repointed at it. The link can be repointed while
a server started through it keeps serving; the new build takes effect the next time the client
starts the server.

The MCP command path, Chrome's unpacked-extension folder, and the native-messaging registration all
point through `current`, so none of them changes when a new version lands. No reconfiguring, and no
second trip to `chrome://extensions`.

The first `browser_update_apply` from a build tree or an unpacked download moves that copy into the
managed layout and prints the path to point your client at. That is the only time the path changes.

| Platform | Install root                                         |
| -------- | ---------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\Programs\ChromeControlMCP`           |
| Linux    | `~/.local/share/ChromeControlMCP/app`                |
| macOS    | `~/Library/Application Support/ChromeControlMCP/app` |

Set `CHROME_CONTROL_MCP_INSTALL_ROOT` to install somewhere else. Downloads are checked against the
SHA-256 published with the release, which catches a corrupted or truncated transfer; it is not a
signature, and this project still ships no signing key.

## Architecture

```mermaid
flowchart LR
    A[AI assistant] -->|MCP over stdio| B[chrome_control_mcp]
    B -->|Windows named pipe<br/>Linux/macOS Unix socket| C[Native-host relay]
    C -->|Chrome native messaging| D[Unpacked MV3 extension]
    D -->|Chrome DevTools Protocol| E[The session's own tab]
```

One executable serves MCP server and native-host relay roles. Browser control belongs in MCP
because it needs callable tools, image results, hardened IPC, and persistent session state. A skill
may add workflows, but does not replace server.

## Security model

Full control is powerful. Chrome Control MCP pins extension origin, limits and validates IPC,
authenticates same-user/same-executable relay, rejects stale element refs and screenshot
coordinates, bounds major payloads, and exposes strict schemas.

Windows uses current-user ACL-protected named pipe. Linux and macOS use mode-`0600` Unix socket
inside private runtime directory plus operating-system peer credentials.

For inspection-only use:

```text
CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only
CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT=true
```

Read-only profile exposes 12 tools and independently rejects hidden mutating calls.
`browser_update_apply` is not among them: it replaces the program on disk, which is a mutation
whatever the browser profile says.

## Verification

Local gates currently cover:

- 13/13 native and extension suites on Windows, Linux, and macOS, with MSVC, GCC, and Clang
- Warnings-as-errors plus `clang-tidy` and exhaustive `cppcheck`
- Separate ASan+UBSan and TSan runs
- Full-history Gitleaks scan and npm dependency audit
- 44/44 live browser and extension tools through real Chrome on Windows. The three
  `browser_update_*` tools are not browser tools and are not part of that run; their evidence is
  below.
- 35/35 display configurations on Windows and macOS: scales 1x to 3x, zoom 25% to 500%, pinch, and
  both scrollbar kinds, each coordinate proven by where its click landed
- Public UI Playground navigation, snapshot, typing, click, and PNG capture
- Reversible native-host install/status/uninstall lifecycle

The update path is verified on Windows and macOS: the link is repointed while a server launched
through it keeps serving and exits cleanly, and on macOS 15.7.4 a published archive installs and
reaches the release host over HTTPS through its bundled TLS backend. No Linux machine has yet
installed a release through `browser_update_apply`.

GitHub Actions builds and tests Windows, Linux, and macOS on every direct push.

```shell
npm run smoke
npm run smoke:read-only
node tests/e2e/full_browser_e2e.mjs
```

PowerShell live public-site check:

```powershell
./scripts/live_browser_verify.ps1 -Site http://uitestingplayground.com/
```

[See exact evidence and claim boundaries](docs/VERIFICATION.md).

## Project identity

| Item         | Value                              |
| ------------ | ---------------------------------- |
| MCP server   | `chrome-control-mcp`               |
| Executable   | `chrome_control_mcp[.exe]`         |
| Extension    | `Chrome Control MCP`               |
| Extension ID | `iojehhmnaigcejfcpmilpclmeljhlkaa` |
| Native host  | `com.chromecontrolmcp.browser`     |

Unregister current-user native host with `npm run extension -- uninstall`, then remove unpacked
extension manually from `chrome://extensions` when retiring it.

## License

Released under [MIT License](LICENSE). Copyright © 2026 Randy Northrup.

## Support this project

If this project saves you time, you can
[buy me a coffee](https://www.paypal.com/donate/?hosted_button_id=Q9VC7B42R7K82)
via PayPal. Thank you!
