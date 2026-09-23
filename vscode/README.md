# Chrome Control MCP

**Visible, precise Chrome control for AI assistants. Local by design.**

This extension installs the [Chrome Control MCP](https://github.com/RandyNorthrup/chrome-control-mcp)
server and registers it with the editor, so its 47 browser tools are available to chat without
editing an `mcp.json` or knowing a path.

Active automation stays visible: a pink frame, an **AI CONTROL** badge, and a pulsing agent cursor
show when an assistant is driving Chrome, and the tab under control sits in a pink **AI CONTROL**
tab group so it is identifiable in the tab strip without opening it.

## What it does

| Capability         | Included                                                                         |
| ------------------ | -------------------------------------------------------------------------------- |
| Works beside you   | Drives its own visible tab; never changes which tab is in front or takes focus   |
| Semantic control   | Accessibility-tree snapshots with stable element refs                            |
| Real input         | Click, type, keys, hover, drag, select, scroll, dialogs, and media               |
| File upload        | Attach local files to a page's file input, as the user's own picker would        |
| Visual reasoning   | Viewport and full-page PNG capture, and guarded coordinate clicks                |
| Browser management | Navigation, tabs, tab groups, windows, emulation, and waits                      |
| Browser state      | Cookies, local and session storage, permissions, downloads, print, and HTTP auth |
| In-place updates   | The server updates itself without overwriting the copy that is running           |

The server talks to your ordinary Chrome through native messaging and the Chrome DevTools
Protocol. It opens no TCP listener, and nothing leaves your machine.

## Setup

Installing this extension does the first two steps for you:

1. **The server is installed** into a per-user directory on first activation. Nothing needs
   administrator rights.
2. **The editor is told about it** through the MCP server provider API, so no configuration file
   needs editing.
3. **Chrome has to be pointed at the extension folder once**, by you. Run **Chrome Control MCP:
   Show the Chrome extension folder to load** from the command palette: it copies the folder path
   and opens it. Then in Chrome open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked**, and pick that folder.

**That third step cannot be automated, and this extension does not pretend otherwise.** Branded
Chrome 137 and later ignore `--load-extension`; only Chromium and Chrome for Testing still honour
it. Installing by enterprise policy needs a Web Store listing and a packaged, signed extension,
which this project deliberately does not have. Driving Chrome's own windows with a UI-automation
tool is not an install path either: it takes over your screen and breaks on any Chrome or locale
change.

It is a one-time step. Updates reuse the same folder and need no further clicks.

## Updating

The server updates itself. Ask your assistant to run `browser_update_check`, then
`browser_update_apply`.

A running executable cannot be overwritten on Windows, so the update does not try to. Each version
is installed into its own directory and a stable link is repointed at it, which works while the
server is running. The editor's server command, Chrome's unpacked-extension folder, and the
native-messaging registration all point through that link, so none of them changes when a new
version lands.

Updating this extension from the marketplace and letting the server update itself converge on the
same install; whichever is newer is the one that runs.

## Commands

| Command                                                 | What it does                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Chrome Control MCP: Repair install                      | Reinstalls and re-registers the server and native host         |
| Chrome Control MCP: Show the Chrome extension folder... | Copies and opens the folder to load into `chrome://extensions` |

## Security

The server pins the extension origin, limits and validates IPC, authenticates the
same-user/same-executable relay, rejects stale element refs and screenshot coordinates, bounds
payloads, and exposes strict JSON Schemas. Windows uses a current-user ACL-protected named pipe;
Linux and macOS use a mode-`0600` Unix socket in a private runtime directory plus operating-system
peer credentials.

For inspection-only use, set these in the server environment:

```text
CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only
CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT=true
```

The read-only profile exposes 12 tools and independently rejects hidden mutating calls.

## Requirements

- Google Chrome 116 or later
- Windows x64, Linux x64, or macOS (Apple silicon or Intel)

Builds are intentionally unsigned and unnotarized; this project has no signing key and does not
require one.

## Links

[Repository](https://github.com/RandyNorthrup/chrome-control-mcp) ·
[Tool catalog](https://github.com/RandyNorthrup/chrome-control-mcp/blob/main/docs/TOOLS.md) ·
[Security](https://github.com/RandyNorthrup/chrome-control-mcp/blob/main/docs/SECURITY.md) ·
[Verification](https://github.com/RandyNorthrup/chrome-control-mcp/blob/main/docs/VERIFICATION.md)

Released under the MIT License. Copyright © 2026 Randy Northrup.
