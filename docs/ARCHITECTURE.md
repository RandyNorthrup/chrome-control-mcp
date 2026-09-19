# Architecture

## Decision

Browser control is an MCP server, not a skill. MCP supplies callable tools, image content,
persistent state, and native transport. Optional skills can add workflows without owning browser
execution.

## Process topology

```text
AI assistant
    | MCP JSON-RPC over stdio
    v
chrome_control_mcp[.exe] (long-lived MCP process)
    | BrowserControl + session/ref state
    | Windows: protected named pipe
    | Linux/macOS: protected Unix-domain socket
    v
chrome_control_mcp[.exe] (short-lived Chrome native-host relay)
    | Chrome native messaging, length-prefixed JSON
    v
Chrome Control MCP unpacked extension service worker
    | chrome.debugger / Chrome DevTools Protocol
    v
active Chrome tab
```

One executable serves both roles. Normal launch serves MCP. Chrome supplies pinned extension origin
when launching native host, which selects relay mode.

## Platform backends

| Concern             | Windows                                                   | Linux / macOS                                      |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Bridge transport    | Named pipe                                                | Unix-domain socket                                 |
| Endpoint protection | Current-user DACL + Medium-integrity no-write-up label    | Private runtime directory + mode `0600` socket     |
| Peer identity       | Process token, session, image path, Chrome ancestor       | Peer UID/PID, image path, optional Chrome ancestor |
| Rendezvous          | `%LOCALAPPDATA%/ChromeControlMCP/browser_bridge.json`     | Private runtime directory                          |
| Native-host install | HKCU Chrome NativeMessagingHosts key + generated manifest | Chrome `NativeMessagingHosts` manifest directory   |

Linux uses `SO_PEERCRED`. macOS uses `getpeereid` plus `LOCAL_PEERPID`. Both sides require same
effective user, recorded process, same executable image, nonce token, and protocol version.

## Rendezvous ownership

One server per user owns the browser: the rendezvous record names its pid and endpoint, and the
Chrome-launched relay binds to whatever the record names. A server that finds a live owner of the
same image at start stands down (native tools only) rather than overwrite it; `stop()` removes the
record only while it still names the exiting process. Because two servers can start within the same
instant and both pass that check, the long-lived server also re-checks before every browser tool
call while no relay is connected (`ensurePublished`): a record that is missing, or names a process
that has exited, is re-published; a record naming another live owner is left alone and the call
reports which pid holds the bridge. The extension retries the native connection every 2 s while
its service worker is alive and from a 30 s alarm otherwise, so it lands on the published server
without a browser restart.

## Extension preparation

`browser_extension_install` verifies staged extension files and executable, then installs only
current-user Chrome native-host registration:

- Windows: generated manifest plus HKCU registration
- Linux: `${XDG_CONFIG_HOME:-~/.config}/google-chrome/NativeMessagingHosts`
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`

`CHROME_CONTROL_MCP_NATIVE_HOST_DIR` overrides Unix manifest directory for isolated tests.

Committed extension manifest contains public identity material so unpacked loads keep stable ID.
There is no private key, package signing, browser-store dependency, or enterprise-policy write.

## Request path

1. Assistant sends `tools/call` over MCP stdio.
2. MCP dispatch validates JSON-RPC envelope, security profile, arguments, and schema.
3. `BrowserBridgeSession` translates tool call. Element refs resolve only against latest snapshot.
4. Platform bridge sends one correlated command to authenticated relay.
5. Relay forwards command through Chrome native messaging.
6. Extension acts through CDP and returns exactly one result or error.
7. Bridge correlates reply, updates snapshot/ref state, and returns MCP text or image content.

## Browser model

- `browser_snapshot` joins accessibility tree and DOM geometry into filtered roles, names, values,
  and stable `[ref=eN]` handles.
- Ref actions use CDP `Input`; user's operating-system mouse and keyboard remain free.
- Session pins its own tab. First command adopts active tab of last focused window; afterwards
  only session's own actions (select/new tab, window new/focus, tab its page opens) move it. User
  switching tabs or windows never redirects next click or keystroke.
- Control never raises a window, takes OS focus, or changes which tab is in front: `browser_new_tab`
  opens in the background, `browser_select_tab` retargets the session without activating the tab,
  new windows request `focused: false`, and window `focus` only retargets session. The session
  drives its own tab over the debugger protocol while the user works in another tab. CDP focus
  emulation keeps focus-gated pages working in background. A compositor that focuses new windows
  anyway (Hyprland) is observed and reported as `took_os_focus`.
- `browser_screenshot` returns native MCP image block. Control presence is hidden by default and can
  be included for user-facing documentation.
- `browser_click_at` and `browser_drag`'s x/y are pixels of the latest screenshot, bound to its
  tab, URL, DPR, pinch scale and offset, scroll, and viewport fingerprint; stale geometry fails
  closed. One screenshot pixel is one CSS px × DPR × pinch scale, measured from the visual
  viewport's origin; `browser_box` reports CSS geometry plus `screenshot_center` so coordinate
  clicks land at any display scale, browser zoom, and pinch.
- Local/session storage runs inside isolated world bound to verified active-frame origin using
  pristine Storage methods.
- Same transport handles tabs, windows, emulation, permissions, cookies, downloads, print, HTTP
  auth, media, and dialogs.

## Control presence and accessibility

Visible frame, badge, and agent cursor use `pointer-events: none`, so they do not intercept page
input or hit testing. Overlay subtree is `aria-hidden` so it does not contaminate assistant-facing
accessibility snapshot. Fixed-position sizing keeps presence usable across viewport sizes.

## Repository layout

```text
browser/  unpacked extension and native-host resources
include/  public C++ headers under chrome_control_mcp namespace
src/      browser engine, MCP dispatch, platform bridges, entrypoint
tests/    C++, service-worker, sanitizer, and live E2E suites (including a dedicated-browser
          harness that never touches the user's own Chrome)
scripts/  cross-platform build, smoke, and extension lifecycle helpers
docs/     architecture, security, tools, quality, and verification
```
