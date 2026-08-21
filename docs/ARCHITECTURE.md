# Architecture

## Decision

Browser control is an MCP server, not a skill. MCP provides callable tools, image content,
persistent state, and native transport. An optional skill can add workflows without owning
execution.

## Process topology

```text
AI assistant
    | MCP JSON-RPC over stdio
    v
chrome_control_mcp.exe (long-lived MCP process)
    | BrowserControl + session/ref state
    | hardened per-user named pipe
    v
chrome_control_mcp.exe (short-lived Chrome native-host relay)
    | Chrome native messaging, length-prefixed JSON
    v
Chrome Control MCP unpacked extension service worker
    | chrome.debugger / Chrome DevTools Protocol
    v
active Chrome tab
```

One executable serves both roles. Normal launch serves MCP. Chrome supplies the pinned extension
origin when launching the native host, which switches the executable into relay mode.

## Extension preparation

`browser_extension_install` verifies the staged extension files, writes a native-messaging host
manifest under `%LOCALAPPDATA%\ChromeControlMCP`, and registers that manifest under the current
user. It returns the extension directory the user loads once from `chrome://extensions`.

The committed manifest contains public identity material so unpacked loads keep the same extension
ID. There is no private key, packaged browser artifact, browser-store dependency, or Chrome
enterprise-policy write.

## Request path

1. Assistant sends `tools/call` to MCP stdio.
2. MCP dispatch validates JSON-RPC, security profile, argument object, and schema.
3. `BrowserBridgeSession` translates the tool call. Element refs resolve only against the latest
   snapshot.
4. `BrowserBridgePipeServer` sends one correlated command through the named pipe.
5. Relay forwards the command over Chrome native messaging.
6. Extension acts through CDP and returns exactly one result or error.
7. Bridge correlates the reply, updates snapshot/ref state, and returns MCP text or image content.

## Browser model

- `browser_snapshot` joins accessibility-tree and DOM geometry into filtered roles, names, values,
  and stable `[ref=eN]` handles.
- Ref actions use CDP `Input`; the user's OS mouse and keyboard remain free.
- `browser_screenshot` returns a native MCP image block. Control presence is hidden by default and
  can be included explicitly for user-facing documentation.
- `browser_click_at` binds coordinates to the latest screenshot tab, URL, DPR, scroll, and viewport
  fingerprint; stale geometry fails closed.
- The same transport handles tabs, windows, emulation, permissions, storage, cookies, downloads,
  print, HTTP auth, media, and dialogs.
- Local/session storage runs in an isolated world bound to the active frame's verified origin,
  using the isolated world's pristine Storage methods. This avoids page-script tampering and the
  `DOMStorage` debugger domain that Chrome extensions do not expose.

## Repository layout

```text
browser/  unpacked extension source and native-host registration resources
include/  public C++ headers under chrome_control_mcp namespace
src/      browser engine, MCP dispatch, native relay, preparation flow, entrypoint
tests/    C++ and extension-worker suites
scripts/  build, smoke, and extension lifecycle helpers
docs/     architecture, security, tools, and verification
```
