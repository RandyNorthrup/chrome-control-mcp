# Architecture

## Decision

Browser control is an MCP server, not a skill. MCP supplies callable tools, image content,
persistent state, and native transport. Optional skills can add workflows without owning browser
execution.

## Process topology

```text
MCP client (one or more agents)            another MCP client
    | MCP JSON-RPC over stdio                  | MCP JSON-RPC over stdio
    v                                          v
chrome_control_mcp  (server A)             chrome_control_mcp  (server B)
    | BrowserControl, refs bound per tab       |
    | Windows: protected named pipe            |
    | Linux/macOS: protected Unix socket       |
    v                                          v
chrome_control_mcp  (relay for A)          chrome_control_mcp  (relay for B)
    |  Chrome native messaging, length-prefixed JSON, one port per server
    v
Chrome Control MCP extension service worker: one session per port
    | chrome.debugger / Chrome DevTools Protocol, one attachment per held tab
    v
the tabs each session holds
```

One executable serves both roles. Normal launch serves MCP. Chrome supplies the pinned extension
origin when it launches the native host, which selects relay mode. Any number of servers can drive
one browser at once; each has exactly one relay, and Chrome starts one relay process per port the
extension opens.

## Platform backends

| Concern             | Windows                                                     | Linux / macOS                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Bridge transport    | Named pipe                                                  | Unix-domain socket                               |
| Endpoint protection | Current-user DACL + Medium-integrity no-write-up label      | Private runtime directory + mode `0600` socket   |
| Peer identity       | Process token, session, image path, Chrome ancestor         | Peer UID/PID, image path, Chrome ancestor        |
| Rendezvous          | `%LOCALAPPDATA%/ChromeControlMCP/browser_bridge-<pid>.json` | Private runtime directory, same per-pid name     |
| Native-host install | HKCU Chrome NativeMessagingHosts key + generated manifest   | Chrome `NativeMessagingHosts` manifest directory |

Linux uses `SO_PEERCRED`. macOS uses `getpeereid` plus `LOCAL_PEERPID`. Both sides require the same
effective user, the recorded process, the same executable image, the nonce token, and the bridge
protocol version (2 since 1.8.0). The server also requires a Chrome process among the relay's
ancestors; that check is on in production and relaxed only by the unit tests.

## Servers, relays, and ports

Each server publishes its own rendezvous record, named for the process that published it
(`browser_bridge-<pid>.json`), so several can advertise at once. `stop()` removes a record only
while it still names the exiting process, and a server sweeps records left by processes that are
gone when it starts. `ensurePublished` re-publishes this server's record before a browser tool call
while no relay is connected, so a record lost to anything short of the server exiting heals without
a restart.

The Chrome-launched relay cannot be told which server it is for on argv, so it asks. It lists the
records of servers that are still running, sends them to the extension as `bridge_offers`, and
connects to the one the extension names in `attach_session`. Only running servers are offered
because a crashed server's record stays on disk until another server starts and sweeps it, and the
extension cannot tell a dead pid from a live one. The relay speaks first because the extension has
no filesystem access and so has no server to name until it is offered one. A server the extension
asks for that is no longer published yields no connection rather than a substitute.

The frames on the relay's stdio, in the order they can appear:

| Frame                                    | Direction         | When                                                       |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `bridge_offers {protocol, servers}`      | relay → extension | first, before anything else                                |
| `attach_session {session}`               | extension → relay | only in answer to `bridge_offers`                          |
| `bridge_ready {protocol}`                | relay → extension | the chosen server welcomed the relay; pumping starts       |
| `bridge_unavailable {error}`             | relay → extension | instead of `bridge_ready`, after which the relay exits     |
| `bridge_servers {servers}`               | relay → extension | while pumping, whenever the set of running servers changes |
| `command`, `cancel`                      | relay → extension | forwarded from the server                                  |
| `progress`, then one `result` or `error` | extension → relay | only in answer to a `command`                              |

Protocol 2 command frames may name the tab they act on (`tab_id`), and replies say which tab they
acted on (`tabId`, with that tab's own `domEpoch`) and which tabs the session stopped holding
(`goneTabIds`). A protocol-1 extension would ignore `tab_id` and act on its single current tab --
the wrong page, silently -- which is why this is a version and not an optional field. A mismatch
refuses every command and says which side to update. When the server's protocol is the newer one,
the extension reloads itself once for that protocol, since Chrome does not reload an unpacked
extension when its files change.

`bridge_servers` is how a server started later is found. A relay offers its list once, so before it
existed a second editor opening was noticed only when the extension's 30 s alarm next opened a port.
While it pumps, the relay lists the running servers again every second and sends the whole set,
newest first, whenever it differs from the set it last reported -- which starts as the offer. Order
alone is not a change: a server re-publishing its record moves it to the front of the listing
without anything having started or stopped. The frame asks for no answer and must not get one,
because nothing ever travels from the extension to the relay unprompted -- an older relay would read
such a frame as the reply to a command it had not sent. An extension that predates the frame logs an
unexpected type and ignores it. Every frame the relay writes -- the pump's, a forwarded cancel, this
notice, and the exit path's last flush -- goes out under one lock, so two threads can never
interleave a frame.

The extension holds one native port per server and one session per port -- Chrome starts a separate
host process per port, and the relay behind it attaches to exactly one server. Each port's listeners
close over their session, so an arriving frame never has to be matched back to one; only the
browser's own events need routing, because they name a tab and nothing else.

Every port is a process, so how often the extension opens one is rationed:

- With nothing attached, a failed attempt waits before the next, doubling from 2 s to a 2-minute
  ceiling, and the wait resets the moment a bridge answers. Tab events and a 30 s alarm also re-arm
  the connection, and obey the same wait.
- With a relay attached, new servers arrive through `bridge_servers`, which starts no process. The
  alarm opens a probe port only as a five-minute safety net, or when a server that refused the
  extension is due to be tried again; a refusing server is set aside on a doubling interval from one
  minute to thirty.
- The toolbar button pauses the bridge: open ports close, the browser is released, and nothing
  reaches for a server until it is resumed. The paused state survives a browser restart.

A server serves one relay at a time on an endpoint with a single instance, so a relay that has gone
must be let go promptly or the next one is turned away -- `ERROR_PIPE_BUSY` on Windows, parked
unanswered in the listen backlog elsewhere. The relay speaks on the pipe only to answer a command,
so while it is idle the server looks at the connection every 250 ms without reading from it: a
hangup ends the connection, and so do bytes arriving with no command outstanding, which a relay
keeping to the protocol never sends and which would otherwise be read as the reply to the next
command. Before this check a server whose relay died between commands -- Chrome restarting, the
extension reloading -- held the endpoint until a command happened along to fail; one was observed
unreachable for a whole day.

## Sessions, tabs, and agents

A session is one server's port. It holds tabs, not one tab: those it opened (`browser_new_tab`,
`browser_window new`, a popup its own command's page opened) and those it was given (the user's
active tab on its first call, one it took with `browser_select_tab`, one the user dragged into its
tab group). Every held tab has its own debugger attachment and its own page state -- snapshot
generation, screenshot transform, dialog arm, console and network logs, emulation, HTTP-auth
credentials, caught file picker -- so working in one tab never disturbs another.

Holding is exclusive. A second session that reaches for a held tab is refused, naming the holder.
Chrome already allows one debugger client per target, which covers the DevTools protocol; the lease
covers `chrome.tabs`, `chrome.windows`, cookies and downloads, where Chrome would let two sessions
collide without complaint.

Several agents can share one server -- sub-agents, parallel tasks of one client -- and the server
cannot tell them apart, because they arrive over one MCP connection. So the tab is addressed per
call: every tab-scoped tool takes `tab_id`, and every element ref is bound to the tab its snapshot
came from and is never reused. An agent that names itself (`agent`) gets its own tab group and
colour. One server still carries one command at a time, so agents behind it are isolated from each
other, not concurrent; separate servers run in parallel.

Tabs are let go of when the agent calls `browser_release`, when its server exits, and -- partly --
after ten minutes without a command. [MULTI_SESSION.md](MULTI_SESSION.md) describes which tabs
count as the assistant's, how popups are claimed, what each kind of release does, and the design
record behind all of it.

## Extension preparation

`browser_extension_install` verifies the staged extension files and executable, then installs only
the current-user Chrome native-host registration:

- Windows: generated manifest plus HKCU registration
- Linux: `${XDG_CONFIG_HOME:-~/.config}/google-chrome/NativeMessagingHosts`
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`

`chrome_control_mcp --install` does the same from a shell, after first putting the copy into the
managed install layout (see [TOOLS.md](TOOLS.md#updating-this-server)); the VS Code extension runs
it on every editor start. A build older than the version already current leaves that version in
place and says so, so starting an editor cannot roll an update back.

For isolated tests, `CHROME_CONTROL_MCP_NATIVE_HOST_DIR` overrides the Unix manifest directory, and
`CHROME_CONTROL_MCP_NATIVE_HOST_KEY` and `CHROME_CONTROL_MCP_DATA_DIR` give Windows the same
separation. Chrome itself reads only the fixed registration.

The committed extension manifest contains public identity material so unpacked loads keep a stable
ID. There is no private key, package signing, browser-store dependency, or enterprise-policy write.

## Request path

1. Assistant sends `tools/call` over MCP stdio.
2. MCP dispatch validates the JSON-RPC envelope, security profile, arguments, and schema.
3. `BrowserBridgeSession` translates the tool call. An element ref resolves only against the latest
   snapshot of the tab it came from, and the command is sent to that tab; a `tab_id` that names a
   different tab is refused.
4. The platform bridge sends one correlated command to the authenticated relay.
5. The relay forwards it through Chrome native messaging.
6. The extension acts through CDP and returns exactly one result or error, beating `progress` every
   5 s while it works.
7. The bridge correlates the reply, updates that tab's snapshot and ref state, drops refs bound to
   tabs the session let go of, and returns MCP text or image content.

## Browser model

- `browser_snapshot` joins the accessibility tree and DOM geometry into filtered roles, names,
  values, and `[ref=eN]` handles. A ref is bound to its tab, and a ref name is never reused for the
  life of the server.
- Ref actions use CDP `Input`; the user's operating-system mouse and keyboard remain free.
- A call that names no tab acts on the session's current tab. Only the session's own actions move
  it: `browser_new_tab`, `browser_select_tab`, `browser_window new`/`focus`, and a foreground tab its
  own page opened. The first such call, with nothing held yet, adopts the active tab of the last
  focused window. If the current tab closes or the user takes it back, the session moves to another
  tab it holds, and with none left it refuses rather than take over a tab the user is using. The
  user switching tabs or windows never redirects the next click or keystroke.
- Control never raises a window, takes OS focus, or changes which tab is in front:
  `browser_new_tab` opens in the background, `browser_select_tab` retargets the session without
  activating the tab, new windows request `focused: false`, and window `focus` only retargets the
  session. A popup the agent's page brings to the front is put back behind the tab the user had in
  front. CDP focus emulation keeps focus-gated pages working in the background. A compositor that
  focuses new windows anyway (Hyprland) is observed and reported as `took_os_focus`.
- `browser_screenshot` returns a native MCP image block. Control presence is hidden by default and
  can be included for user-facing documentation.
- `browser_click_at` and `browser_drag`'s x/y are pixels of the latest screenshot, bound to its tab,
  URL, DPR, pinch scale and offset, scroll, and viewport fingerprint; stale geometry fails closed.
  One screenshot pixel is one CSS px × DPR × pinch scale, measured from the visual viewport's
  origin; `browser_box` reports CSS geometry plus `screenshot_center` so coordinate clicks land at
  any display scale, browser zoom, and pinch.
- Local and session storage run inside an isolated world bound to the verified active-frame origin,
  using pristine Storage methods.
- A file picker the page opens during one of the agent's input or navigation commands is caught
  rather than shown, and `browser_upload` fills it.
- The same transport handles tabs, windows, emulation, permissions, cookies, downloads, print, HTTP
  auth, media, dialogs, and recording.

## Control presence and accessibility

Every held tab is marked, not only the one being driven: it sits in its agent's tab group, the
page carries a frame, a badge and an agent cursor, and the toolbar icon shows an `AI` badge for that
tab. The group, frame, badge and toolbar badge share one colour -- a colour no other live group has
-- and the group and badge share one name: `AI · <agent>`, `AI · <client>`, or `AI CONTROL`. A
session stood down for idleness loses the frame and badge, and its groups turn grey.

The frame, badge and cursor are registered with `Page.addScriptToEvaluateOnNewDocument`, so each new
document draws them as it is created. They are built node by node, never through `innerHTML`, so a
page that enforces Trusted Types draws them too and nothing lands in the page's console. They use
`pointer-events: none`, so they do not intercept page input or hit testing, and the overlay subtree
is `aria-hidden`, so it does not contaminate the assistant-facing accessibility snapshot. When a
tab's debugger attachment has already ended -- the user cancelled Chrome's debugging bar or opened
DevTools -- the overlay is removed through `chrome.scripting` instead.

## Repository layout

```text
browser/  unpacked extension and native-host resources
include/  public C++ headers under chrome_control_mcp namespace
src/      browser engine, MCP dispatch, platform bridges, updater, entrypoint
tests/    C++, service-worker, sanitizer, and live E2E suites (including a dedicated-browser
          harness that never touches the user's own Chrome)
scripts/  cross-platform build, smoke, and extension lifecycle helpers
tools/    measurement probes run against a real browser (reconnect cadence, scrolling)
vscode/   the VS Code Marketplace extension that installs and registers the server
docs/     architecture, security, tools, quality, verification, and release notes
```
