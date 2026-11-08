# Running more than one agent against one browser

Any number of Chrome Control MCP servers can drive one Chrome at once, and any number of agents can
share one server. Each agent works in its own tabs, a tab one session holds is refused to every
other, and what an agent opened is closed when it is done.

This document has three parts: how it works as of 1.8.0, why 1.8.0 changed the unit of isolation
from the server to the agent, and the 1.5.0 design record that first made more than one server
possible. [ARCHITECTURE.md](ARCHITECTURE.md) covers the transport in more detail and
[TOOLS.md](TOOLS.md#sharing-the-browser-tabs-agents-and-tab_id) the tool arguments.

## How it works (1.8.0)

### Servers and ports

Each server publishes its own rendezvous record (`browser_bridge-<pid>.json`). The extension opens
one native port per server, Chrome starts one relay process per port, and each relay attaches to
exactly one server: the fan-out is at the extension, not at the pipe. A relay offers only servers
that are still running, and while it is attached it reports changes to that set (`bridge_servers`)
from its own directory check, which starts no process -- so a server started later is attached in
about a second. A server whose relay goes away notices within 250 ms and listens again.

### Sessions and the tabs they hold

A session is one server's port. It holds tabs, each with its own debugger attachment and page state:
snapshot generation, screenshot transform, dialog arm, console and network logs, emulation,
HTTP-auth credentials, caught file picker. Nothing about a page is session-wide.

Every held tab has one of two origins, which decide what happens to it at the end:

| Origin  | How the session came to hold it                                                                                                            | When it is let go       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| opened  | `browser_new_tab`, `browser_window new`, or a popup its own command's page opened                                                          | closed                  |
| adopted | the user's active tab on its first call that names no tab, a tab it took with `browser_select_tab`, or one the user dragged into its group | handed back, not closed |

Holding is exclusive. A second session that reaches for a held tab is refused, naming the holder by
client and server pid. Chrome's one-debugger-client-per-tab rule backs this for the DevTools
protocol; the lease covers `chrome.tabs`, `chrome.windows`, cookies and downloads, where Chrome
would let two sessions collide. `browser_tabs` lists every tab in the session's window, marking the
session's own (`held`, `current`, `agent`, `opened_by_session`) and the ones another session holds
(`controlled_by_other_session`), and `your_tabs` lists everything the session holds in any window.

### Agents inside one server

Sub-agents and parallel tasks of one client arrive over one MCP connection, and the server cannot
tell them apart. So nothing relies on telling them apart:

- Every tab-scoped tool takes `tab_id`, and `browser_new_tab` returns one. A call that names no tab
  acts on the session's current tab, which another agent may have moved.
- Every element ref is bound to the tab its snapshot came from, and a ref name is never reused for
  the life of the server. A ref goes stale only when its own tab's page changes.
- An agent may name itself (`agent` on `browser_new_tab` or `browser_select_tab`). Its tabs then get
  their own group -- one per agent per window, since a tab group belongs to one window -- titled
  `AI · <agent>`, in a colour no other live group has. Unnamed agents share the session's group,
  titled `AI · <client>` from the MCP client's `clientInfo.name`, or `AI CONTROL`. The first group
  anyone gets is pink. Tabs an agent's pages open join its group.
- The server's MCP `instructions` tell every client this: open your own tab, pass `tab_id`, refs are
  bound to tabs, uploads need no dialog, call `browser_release` when done.

### Whose tab it is

Chrome gives a tab an opener for more than a page opening it: Ctrl+T and the new-tab button name the
tab the user was looking at, a middle-clicked link names the page it was in, and a tab opened from a
grouped tab is put into that group. So an opener says nothing about who opened a tab. A tab is the
session's only if:

1. the session opened it (`browser_new_tab`, `browser_window new`);
2. its own page opened it while one of its input or navigation commands was running, or within 2 s
   after: `browser_click`, `_click_at`, `_js_click`, `_hover`, `_drag`, `_type`, `_press_key`,
   `_select`, `_set_value`, `_media`, `_navigate`, `_back`, `_forward`, `_reload`, `_upload`;
3. it was given it, as above; or
4. the user dragged it into one of the session's groups.

Anything else is the user's: it is taken back out of an AI group Chrome put it in, and the session
does not move to it. Chrome's new-tab page is never claimed, because no page's click can open it.

The tab strip is how the user hands tabs over and takes them back. A held tab dragged out of the AI
group -- into no group, or into one of the user's own -- is the user's again; the session lets go
of it without closing it. A tab dragged into an AI group is lent to that session and handed back
later. A tab dragged between two of one session's agent groups becomes the other agent's. The
worker recognises its own grouping calls, and a tab leaving its group because it moved to another
window, and reads neither as a hand-over. A held tab that already sits in a group of the user's own
stays there, and a pinned tab, which Chrome cannot group, is marked on the page only.

### Popups

A tab the agent's page opens is matched to the session in one of two ways, whichever applies
first, both inside the command window above:

- The browser's own navigation record (`webNavigation.onCreatedNavigationTarget`) names a held tab
  as the source. It names the page that opened the tab for every kind of opening, a `target=_blank`
  link included.
- The driven page's `Page.windowOpen` request and the new tab's address match within 5 s, in either
  order. A tab Chrome has only just created often has no address yet, so a blank tab matches any
  request made during the command.

The tab's own `openerTabId` is used only in a browser without that navigation record. It is not the
page that opened the tab: for a link opened from a tab in the background, Chrome names the window's
active tab. Until 1.14.0 it was trusted first, and a popup one agent's click opened could go to
another agent whose tab the user had in front, while that agent's own click still counted as
opening things.

The claimed tab is held as opened, in the group of the agent whose page opened it, and listed on
that command's reply as `opened_tabs`. If Chrome opened it in front, it becomes the session's current
tab -- it is where the agent's click led -- and the tab the user had in front is put back in front.
Chrome may activate the popup a moment after reporting it, so a claimed popup is watched for 1.5 s.

### Marking

Every held tab is attached and marked, not only the one being driven. The frame and badge are
registered with `Page.addScriptToEvaluateOnNewDocument`, so each new document draws them as it is
created; re-drawing on `Page.frameNavigated` raced the new document and lost. They take the group's
colour and name, so a page can be matched to its group and its agent at a glance, and they are built
node by node, so pages that enforce Trusted Types (YouTube, Gmail, Google Docs, Chrome's error pages)
draw them without an error in the page's console.

### Letting go

| Event                                       | Tabs the session opened                   | Tabs it was given         | Group and marking                                                             |
| ------------------------------------------- | ----------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `browser_release`                           | closed; with `keep_open: true`, left open | handed back, never closed | removed                                                                       |
| `browser_release` with `tab_id`             | the agent's, as above (see below)         | the agent's, as above     | removed from those tabs                                                       |
| its server exits                            | closed                                    | handed back               | removed                                                                       |
| its relay drops while the server runs       | kept, still held                          | kept, still held          | frame off, group kept; all of it resumes when a relay reattaches              |
| ten minutes without a command               | kept, still held                          | kept, still held          | debugger and frame off, group grey, title ends `(idle)`; next command resumes |
| the user pauses the bridge from the toolbar | left open                                 | handed back               | removed                                                                       |

With a `tab_id`, "the agent's" means that tab, every tab opened from it (a popup records the tab
whose page opened it, transitively), and, when the agent gave itself a name, every tab under that
name. Other agents' tabs are untouched. An unnamed agent cannot be told apart from another unnamed
agent on the same server, so for it the tab and what it opened is the whole of what is certainly its
own. Until 1.8.2 this released the one tab only, and the agent's popups and other tabs stayed open,
held, for as long as its server ran.

A tab Chrome refuses to close -- it does while the user is dragging a tab -- is retried three times
over about 2.5 s. One still open after that is handed back like a borrowed tab and listed in the
reply's `not_closed`; it is never reported as closed, and never left in an AI group with nothing
holding it.

Two tabs are never closed, whatever the session opened: the one the user is looking at (the active
tab of the focused window) and the browser's last tab, since Chrome would quit with it. Detaching
the debugger is also what lets Chrome take down its "started debugging this browser" bar once
nothing else is attached, which is why an idle session lets go of it. A session that is recording
is not stood down for idleness.

A server exiting is noticed the same way a relay dropping is: the port goes, and the session is
parked -- tabs detached but still held, so no other session may take them. The next list of running
servers decides. Either the reconnect after the lost port or another attached relay's
`bridge_servers` notice provides it within seconds: a server still listed gets a port and its tabs
back; a server no longer listed has ended, and its tabs are released as if by `browser_release`. If
no relay can be started at all to ask, a parked session is released after ten minutes.

Holdings are mirrored to `chrome.storage.session`, so a worker Chrome retired and restarted parks
them the same way and settles them on the first offer. Groups this extension left behind with
nothing tracking them -- a browser restart restores groups under new ids, a crashed worker, an older
version -- are ungrouped, never closed.

### File pickers

Measured on Chrome 153: a file chooser opened in a tab that is not the active tab of its window is
cancelled (the page gets `cancel`); in an active tab of an unfocused window a native dialog opens
over whatever the user is doing. Neither is usable by an agent, and
`Page.setInterceptFileChooserDialog` does work from `chrome.debugger` in a background tab.

So while one of the session's input or navigation commands is running, and for 2 s after, pickers on
the tab it acts on are caught instead of shown: `<input type=file>` through
`Page.setInterceptFileChooserDialog`, and `showOpenFilePicker` through a stand-in installed only on
held tabs, which calls the browser's own picker whenever it is not armed. The command's reply says a
chooser opened (`file_chooser`). `browser_upload` with no ref fills what was caught -- including an
input a script created and clicked without ever adding it to the document, which no ref could name.
A `showOpenFilePicker` answer is a read-only file handle; one left unanswered for five minutes is
answered the way a dismissed dialog would be. With a ref to a drop zone that has no input,
`browser_upload` delivers the files as a drag and drop, and reports failure if the element does not
accept one. Outside that window nothing is caught, so the user's own clicks open the ordinary dialog,
even in a held tab. Folder pickers are not supported yet: the reply says the page asked for a folder,
and nothing is assigned.

### Clipboards

Agents used to share the operating system's one clipboard with each other and with the user: one
agent's Ctrl+V pasted another's copy, or the user's, and a page's copy button clicked by an agent
wrote the user's clipboard. Since 1.9.0 each agent has its own -- per session and agent name, like
its tab group -- held by the extension in memory and cleared when the agent lets go. The agent's copy,
cut and paste keys, `browser_clipboard`, and the page's own clipboard API in a held tab (honoured only
during the agent's input commands on that tab, plus 2 s) all use it, and nothing an agent does reaches
the system clipboard. The behaviour, what a paste delivers, and the limits are in
[TOOLS.md](TOOLS.md#clipboards); the security model is in [SECURITY.md](SECURITY.md#clipboards).

### Not starting processes for nothing

Every port is a process. The rules that keep it so: an attached relay's `bridge_servers` report
costs nothing; a probe runs only when a report names a server nothing holds, and at most one at a
time; with an attached relay the alarm's probe is a five-minute safety net, not a thirty-second
tick; a server that refused the extension is set aside on a doubling interval (one minute to thirty)
rather than retried on every offer; and the 1.7.0 reconnect backoff and pause switch are unchanged.
Measured with no server running: 6 attempts in 75 s, the same as 1.7.0.

### Limits

- **Serial within one server.** One server carries one command at a time over its pipe. Two agents
  behind one server are isolated from each other, not concurrent: a long `browser_wait_for` from one
  delays the other's next call. Separate servers run in parallel.
- **Folder uploads** are not supported yet.
- **Pages an extension may not control** -- Chrome's error and security-warning pages ("Privacy
  error"), the browser's own pages, other extensions' pages -- can be held and grouped but not
  driven or drawn on. A command there says what the page is and what to do instead.

## Chrome profiles (1.10.0)

A server serves every Chrome profile its extension is loaded in, each over a connection of its own,
and an agent chooses one per call: `browser_new_tab` with `profile` (a name or an account email),
or the profile whose window the user last used. After that, every call with the tab's `tab_id`
goes to that profile, and a call naming no tab goes to the profile the last call went to.

What is per profile is what lives in that profile's extension: each agent's tab group and colour,
its clipboard, its held tabs and their leases. An agent working in two profiles has a group in
each, and a clipboard in each -- copying in one and pasting in the other is not offered. Profiles of
two Chromes at once are not served together. The design record is
[plans/chrome-profiles.md](plans/chrome-profiles.md).

## Why 1.8.0 changed the unit of isolation

1.5.0 made the unit of isolation the **server**. Daily use showed that was the wrong unit, and that
three things the design took for granted were not true.

1. **A second server could be stranded for hours.** Measured on a workstation: two servers running,
   one relay. The unattached server had published its record the evening before. Its pipe has one
   instance, and the server only looked at the pipe when it sent a command -- so when the relay died
   (Chrome restarting), the server held a dead connection until its next tool call, and every relay
   in between got `ERROR_PIPE_BUSY`. The server now checks an idle connection every 250 ms and
   re-listens the moment its relay is gone. Relays offer only servers that are running, and an
   attached relay tells the extension when the set of running servers changes (`bridge_servers`),
   so a new editor is attached in about a second without the extension starting a process to ask.
2. **Several agents share one server.** Sub-agents and parallel tasks of one client sit behind one
   MCP connection, and the server cannot tell them apart. With one current tab and one ref index
   per server, agent B opening a tab moved agent A. So the tab is now addressed per call (`tab_id`
   on every tab-scoped tool), every element ref is bound to the tab its snapshot came from and never
   reused for the life of the server, and the extension holds **many** tabs per session, each with
   its own debugger attachment, snapshot generation, screenshot transform, dialog arm and logs. An
   agent may name itself (`agent` on `browser_new_tab`); its tabs then get their own group and
   colour.
3. **An opener is not an author.** Chrome sets `openerTabId` for the user's own Ctrl+T and
   middle-click, and it puts a tab opened from a grouped tab into that group. Following openers is
   how the user's new tab was pulled into the AI group with the session moved onto it. Ownership now
   follows the four rules above, and anything else is the user's.

## Design record: 1.5.0

_Historical._ Written on 2026-09-22, before the code, and implemented in 1.5.0. It is kept as the
record of what the constraints turned out to be and which of its own decisions were wrong before the
code was written. Its code references are permalinks to the commit it was written against
(`15e5afe`); the state inventory describes the worker as it was before 1.5.0. Where 1.8.0 replaced a
decision, a note says so.

Before 1.5.0 exactly one Chrome Control MCP server controlled the browser. A second one -- a second
VS Code window, a second project -- served its native tools with browser control off and retried on
every browser tool call, picking the browser up when the first server exited. That was deliberate
and enforced, not accidental: a server that found a live owner of its own image refused to publish
over it.

### What is actually single-instance

Three transport chokepoints and one pile of state. The state is the hard part.

#### Transport

1. **One rendezvous record.** [`browser_bridge_security.cpp:181`][sec-181] resolves a fixed per-user
   path, `ChromeControlMCP/browser_bridge.json`. One file names one server.
2. **One extension port.** [`background.js:410`][bg-410] holds a module-level `let port = null` and a
   single `connectNative(HOST_NAME)`. Chrome spawns one relay process per port, so the extension is
   the fan-in point.
3. **One pipe connection.** [`browser_bridge_pipe.cpp:400`][pipe-400] accepts, handshakes, serves,
   disconnects, and loops. One connection at a time by construction.

#### State

The extension's service worker holds one session's worth of state in module-level globals. There are
more of them than the transport chokepoints suggest -- [`detachAll`][bg-1076] is the honest
inventory, because it is the function that has to clear everything one session owns:

| Global                                                   | What it pins                                           |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `port`, `health`, `bridgeReady`                          | the transport tri-state, written and read as one unit  |
| `attachedTabId`                                          | the single CDP attachment                              |
| `sessionTabId` / `sessionWindowId`                       | the tab this session adopted and steers                |
| `domEpoch`                                               | the DOM generation refs were captured against          |
| `lastSnapshotTabId` / `lastSnapshotEpoch`                | the tab and generation the ref index is valid for      |
| `lastShot`                                               | the render a pixel coordinate is meaningful against    |
| `lastTabListing`                                         | the positional tab indices last handed out             |
| `lastWindowListing`                                      | the window ids the model is allowed to name            |
| `pendingDialogPolicy` / `dialogArmActive` / `lastDialog` | the one-shot dialog arm and its report                 |
| `commandGeneration`                                      | which polling handler is still current                 |
| `inflightRequests` / `networkInstrumented`               | network-idle tracking                                  |
| `originalUserAgent`                                      | the emulation override to restore                      |
| `httpAuthCreds`                                          | armed HTTP-auth credentials                            |
| `lastFetchError`                                         | an interception failure from a page we no longer drive |
| `uploadChunks`                                           | a partially delivered file                             |
| `controlGroupId` / `controlGroupTabId`                   | the tab group marking the controlled tab               |
| `reconnectTimer`                                         | the pending transport re-arm                           |

Every one is a correctness guard, and every one assumes a single session. Two agents sharing them
would not fail loudly -- they would each invalidate the other's view and keep going.
`lastTabListing` is the clearest example: agent A lists tabs, agent B opens one, agent A's index 3
now names a different page, and nothing in the current design can tell.

Several are read in pairs that must stay mutually consistent -- `lastSnapshotTabId` with
`lastSnapshotEpoch` with the live `domEpoch`; `lastShot.epoch` against `domEpoch`;
`pendingDialogPolicy` with `dialogArmActive`; `sessionTabId` with `sessionWindowId`. Splitting one of
a pair across sessions without the other silently re-validates a stale ref.

One pre-existing divergence to fix while doing this: the `chrome.debugger.onDetach` listener
([background.js:1110][bg-1110]) duplicates `detachAll` but does not bump `commandGeneration`, does
not clear `originalUserAgent`, and does not call `clearUploads()`. Two spellings of the same reset is
exactly the shape of bug this refactor should end.

#### What already scales

The MCP process is already per-agent, and so is the element ref index: `ref_index_` lives in
`BrowserBridgeSession` ([`browser_bridge.h:143`][bh-143]), one per server process. Nothing needs
doing there.

> Correction to an earlier verbal answer: I said the ref index and DOM epoch were per-session in the
> MCP process and left the impression that was the blocker. The ref index is, and it is fine. The
> state that blocks this is in the **extension**, which materially changes where the work lands.

_Superseded in 1.8.0:_ the MCP process is per client, not per agent, and agents sharing one client
share its server. Refs are now bound to the tab their snapshot came from.

### What Chrome fixes for us

`chrome.debugger.attach({tabId}, "1.3")` binds one debugger client per **target**, not per
extension. One extension can hold attachments to several tabs at once -- it just tracks one today.
And Chrome refuses a second client on an already-attached tab, so **tab-level isolation is enforced
by the browser**, not by us. Two sessions cannot both drive one tab even if we get the bookkeeping
wrong. That is a meaningful safety floor for this design.

### Design

Make "session" a first-class thing. It turns out to live in two layers, not three.

#### 1. One rendezvous record per server, named by pid

`browser_bridge-<pid>.json`, beside the sockets that already carry a pid, in the directory the
records already live in.

**Not** a `bridge/` subdirectory. `bridgeRuntimeDirectory` caps that directory at 64 bytes
([browser_bridge_security.cpp:88][sec-88]) so the sibling `bridge-<pid>-<nonce>.sock` fits
`sockaddr_un::sun_path` -- 104 bytes on macOS, re-checked at
[browser_bridge_pipe_posix.cpp:301][pposix-301] and
[browser_bridge_relay_posix.cpp:165][rposix-165]. A nested directory spends that budget for nothing.
Identity in the filename spends none of it, and the directory's existing 0700 + `owner == euid`
hardening covers the new files unchanged.

Two consequences:

- **The single-owner stand-down goes away.** `liveBridgeOwnerExists` currently makes a second server
  refuse browser control outright ([browser_bridge_pipe.cpp:278][pipe-278]). Each server now
  publishes its own record and never stands down. The function survives, narrowed to "is this
  record's pid still a live instance of me", which is what enumeration needs.
- **Stale records must now be swept.** Today a dead server's record is silently overwritten by the
  next `start()`, so nothing ever enumerates or removes anything. One record per pid means they
  accumulate. This leak already exists for sockets -- `stop()` removes only this process's own
  ([browser_bridge_pipe_posix.cpp:423][pposix-423]), so a crashed server's
  `bridge-<pid>-<nonce>.sock` is never cleaned up. The sweep should take both.

#### 2. The relay is told which server it is for

Chrome gives the relay no argv it controls, so it cannot discover its server today. One exchange is
added at the front of the stdio hop, and **the relay speaks first**, as it already does there:

1. relay → extension `{type:"bridge_offers", protocol, servers:[<pid>, …]}`
2. extension → relay `{type:"attach_session", session:"<pid>"}`
3. relay connects to that record, handshakes, and sends `bridge_ready` as before

An earlier draft had the extension sending `attach_session` unprompted, immediately after
`connectNative`. That was wrong twice over.

**The extension cannot name a server.** It has no filesystem access, so it cannot enumerate records
and has no pid to send. The offers list is how it learns them -- which is why the relay has to speak
first, not merely why it is tidier.

**An unprompted frame is unsafe in one skew direction.** The relay touches stdin nowhere before the
handshake, and afterwards only as the first `command`'s _reply_
([browser_bridge_relay_common.cpp:139][rc-139]). A newer extension posting a frame at connect time
to an older relay would have it eaten as that reply, failing the id gate and putting every later
exchange one step out of phase. That pairing is real here: Chrome does not reload an unpacked
extension when its files change, so a Chrome holding a stale loaded copy is the normal case after an
update, in either direction.

Offers-first degrades cleanly both ways. An older extension treats `bridge_offers` as an unknown
type -- `console.warn` and nothing else ([background.js:644][bg-644]) -- so it never replies and the
relay times out. A newer extension talking to an older relay sees `bridge_ready` arrive first and
simply never sends `attach_session`. No frame is ever sent unprompted, in either direction.

Named `attach_session`, not `attach`: `{type:"attach"}` is already load-bearing on the _pipe_ hop as
the negative case proving any first frame other than `hello` is refused
([test_browser_bridge_pipe.cpp:304][tpipe-304]). Different hop, so no functional collision -- but no
reason to make a reader check.

The wait for the reply must be bounded. `stdinReadExact`
([browser_bridge_relay_common.cpp:28][rc-28]) is an unbounded blocking `std::cin.read` with no
deadline, so an extension that never answers would hang the host forever. On timeout the relay
writes `bridge_unavailable` saying the extension did not answer the offer and that it is older than
the server, then exits 0 -- the same shape as every other startup failure, and the message has to
carry the diagnosis because the protocol version is never exchanged on this path. A fail-closed
timeout, not a fallback.

#### 3. The extension keeps one port per server

`port` becomes a `Map<pid, session>`, and every global in the table above moves into the session
record. Routing is by which port a frame arrived on, so no frame shape changes.

This is the bulk of the work and the only part with real risk, because each of those globals is a
guard whose failure mode is silent. It should be done as a mechanical move into a session record
first, with the map holding exactly one entry, so the refactor is provably behaviour-preserving
before any second session exists.

Nine listeners touch session state, and only two -- `port.onMessage` and `port.onDisconnect` -- have
a session handle available, via the `Port` object closed over at `connect` time. The rest need
something else:

| listener                                                                     | what it must key on                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `chrome.debugger.onDetach`, `chrome.debugger.onEvent`                        | `source.tabId`, via a reverse index attachment → session     |
| `chrome.tabs.onCreated`                                                      | `tab.openerTabId`, via a reverse index adopted tab → session |
| `chrome.alarms.onAlarm`, `tabs.onUpdated`/`onActivated`, `runtime.onMessage` | nothing -- worker-wide, and iterate all sessions             |

The two `.then` callbacks in the dialog path ([background.js:1269][bg-1269]) run after their
listener returns, so they must capture the resolved session rather than look it up again.

_Superseded in 1.8.0:_ page state moved again, from the session to each held tab, and
`tabs.onCreated` no longer trusts `openerTabId` on its own (see [Whose tab it is](#whose-tab-it-is)).

#### 4. Tab leases

A session adopts tabs as it does now, but the adoption is recorded against the session and a command
naming a tab outside its lease is refused with a typed error. Chrome's one-client-per-target rule
backstops the CDP path; the lease is what covers the non-CDP paths (`chrome.tabs`, `chrome.windows`,
cookies, downloads) where Chrome will happily let two sessions collide.

Simplest useful policy: a session leases the tab it adopts plus any tab its own actions open, and
`browser_tabs` / `browser_windows` report only what the session leases. An agent that wants a clean
workspace asks for its own window.

_As built:_ `browser_tabs` lists every tab in the window and flags the ones another session holds
(`controlled_by_other_session`) instead of hiding them, so a refusal never looks like a missing tab.

#### What does NOT change

**The pipe server.** An earlier draft of this document had it serving N connections. That was wrong.
Each MCP server process publishes its own record, with its own endpoint and its own token, and the
extension opens one port per server -- so Chrome spawns one relay per server, and each server still
has exactly one relay. The fan-out is at the extension.

That matters, because it is the expensive change that turns out not to be needed:
`nMaxInstances = 1` and `FILE_FLAG_FIRST_PIPE_INSTANCE` ([browser_bridge_pipe.cpp:296][pipe-296])
stay, and with them the guarantee that a second process cannot squat the endpoint. The single
in-flight slot, the one condition variable, and `generation_` as connection identity all stay
correct. A reconnecting relay is a second _sequential_ connection, which the accept loop already
handles and `reconnect_secondClientServedWithNewGeneration` already tests.

**`ref_index_`.** Already per server process ([browser_bridge.h:143][bh-143]).

### Order to build it in

0. **A test seam for the transport layer.** Nothing covers it today: no test in `tests/` references
   `onHostMessage`, `bridge_ready`, `BRIDGE_PROTOCOL`, `connectNative`, or `postMessage`, and
   `test_browser_extension_pure.mjs` loads `background.js` with a `chrome` stub but deliberately
   scopes itself to pure decision functions. Refactoring twenty-odd silent correctness guards with
   no net under them is not something to attempt first.
1. Session record holding exactly one entry -- a mechanical move, provably behaviour-preserving.
2. Per-pid rendezvous records, with enumeration and a stale sweep; one server in practice.
3. The `attach_session` frame, with the extension sending a single session.
4. Extension multi-port.
5. Tab leases.

Steps 0-3 ship no user-visible change and each is independently revertible. Only 4 and 5 turn the
feature on.

### What not to do

**Do not make the transport multi-client without the leases.** It is the tempting half -- it is
mechanical, it demos well, and two agents would appear to work. They would be corrupting each
other's view of the page the whole time, silently, because every guard listed above is a single
global that the second session quietly overwrites. A wrong click in the user's other project is
worse than a refusal.

### Cost

Real feature work across C++, the extension, and the protocol: a new rendezvous shape with a sweep, a
protocol frame that has to be read earlier than the relay reads anything today, a service-worker
refactor touching every correctness guard it owns, and a lease model with its own test surface. The
live-browser E2E suites would need a second-session dimension -- two servers sharing one
`CHROME_CONTROL_MCP_RUNTIME_DIR` -- and the red drills for the leases matter more than the happy
path: the thing to prove is that a cross-lease command is refused, not that two agents can both
click.

[sec-181]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_security.cpp#L181
[sec-88]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_security.cpp#L88
[bg-410]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/browser/extension/background.js#L410
[bg-644]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/browser/extension/background.js#L644
[bg-1076]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/browser/extension/background.js#L1076
[bg-1110]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/browser/extension/background.js#L1110
[bg-1269]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/browser/extension/background.js#L1269
[pipe-278]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_pipe.cpp#L278
[pipe-296]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_pipe.cpp#L296
[pipe-400]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_pipe.cpp#L400
[pposix-301]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_pipe_posix.cpp#L301
[pposix-423]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_pipe_posix.cpp#L423
[rposix-165]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_relay_posix.cpp#L165
[rc-28]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_relay_common.cpp#L28
[rc-139]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/src/browser_bridge_relay_common.cpp#L139
[bh-143]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/include/chrome_control_mcp/browser_bridge.h#L143
[tpipe-304]: https://github.com/RandyNorthrup/chrome-control-mcp/blob/15e5afefd9c2289673b44b77113c011e83d0a11f/tests/test_browser_bridge_pipe.cpp#L304
