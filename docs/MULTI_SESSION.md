# Running more than one agent against one browser

Today exactly one Chrome Control MCP server controls the browser. A second one — a second VS Code
window, a second project — serves its native tools with browser control off and retries on every
browser tool call, so it picks the browser up when the first server exits. That is deliberate and
it is enforced, not accidental: [`browser_bridge_pipe.cpp:255`](../src/browser_bridge_pipe.cpp#L255)
refuses to publish over a record a live server of our own image owns.

This document is about what it would take to lift that, and what it would cost. Nothing here is
implemented.

## What is actually single-instance

Three transport chokepoints and one pile of state. The state is the hard part.

### Transport

1. **One rendezvous record.** [`browser_bridge_security.cpp:181`](../src/browser_bridge_security.cpp#L181)
   resolves a fixed per-user path, `ChromeControlMCP/browser_bridge.json`. One file names one
   server.
2. **One extension port.** [`background.js:410`](../browser/extension/background.js#L410) holds a
   module-level `let port = null` and a single `connectNative(HOST_NAME)`. Chrome spawns one relay
   process per port, so the extension is the fan-in point.
3. **One pipe connection.** [`browser_bridge_pipe.cpp:400`](../src/browser_bridge_pipe.cpp#L400)
   accepts, handshakes, serves, disconnects, and loops. One connection at a time by construction.

### State

The extension's service worker holds one session's worth of state in module-level globals. There are
more of them than the transport chokepoints suggest —
[`detachAll`](../browser/extension/background.js#L1076) is the honest inventory, because it is the
function that has to clear everything one session owns:

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
would not fail loudly — they would each invalidate the other's view and keep going. `lastTabListing`
is the clearest example: agent A lists tabs, agent B opens one, agent A's index 3 now names a
different page, and nothing in the current design can tell.

Several are read in pairs that must stay mutually consistent — `lastSnapshotTabId` with
`lastSnapshotEpoch` with the live `domEpoch`; `lastShot.epoch` against `domEpoch`;
`pendingDialogPolicy` with `dialogArmActive`; `sessionTabId` with `sessionWindowId`. Splitting one of
a pair across sessions without the other silently re-validates a stale ref.

One pre-existing divergence to fix while doing this: the `chrome.debugger.onDetach` listener
([background.js:1110](../browser/extension/background.js#L1110)) duplicates `detachAll` but does not
bump `commandGeneration`, does not clear `originalUserAgent`, and does not call `clearUploads()`.
Two spellings of the same reset is exactly the shape of bug this refactor should end.

### What already scales

The MCP process is already per-agent, and so is the element ref index: `ref_index_` lives in
`BrowserBridgeSession` ([`browser_bridge.h:143`](../include/chrome_control_mcp/browser_bridge.h#L143)),
one per server process. Nothing needs doing there.

> Correction to an earlier verbal answer: I said the ref index and DOM epoch were per-session in the
> MCP process and left the impression that was the blocker. The ref index is, and it is fine. The
> state that blocks this is in the **extension**, which materially changes where the work lands.

## What Chrome fixes for us

`chrome.debugger.attach({tabId}, "1.3")` binds one debugger client per **target**, not per
extension. One extension can hold attachments to several tabs at once — it just tracks one today.
And Chrome refuses a second client on an already-attached tab, so **tab-level isolation is enforced
by the browser**, not by us. Two sessions cannot both drive one tab even if we get the bookkeeping
wrong. That is a meaningful safety floor for this design.

## Design

Make "session" a first-class thing. It turns out to live in two layers, not three.

### 1. One rendezvous record per server, named by pid

`browser_bridge-<pid>.json`, beside the sockets that already carry a pid, in the directory the
records already live in.

**Not** a `bridge/` subdirectory. `bridgeRuntimeDirectory` caps that directory at 64 bytes
([browser_bridge_security.cpp:88](../src/browser_bridge_security.cpp#L88)) so the sibling
`bridge-<pid>-<nonce>.sock` fits `sockaddr_un::sun_path` — 104 bytes on macOS, re-checked at
[browser_bridge_pipe_posix.cpp:301](../src/browser_bridge_pipe_posix.cpp#L301) and
[browser_bridge_relay_posix.cpp:165](../src/browser_bridge_relay_posix.cpp#L165). A nested directory
spends that budget for nothing. Identity in the filename spends none of it, and the directory's
existing 0700 + `owner == euid` hardening covers the new files unchanged.

Two consequences:

- **The single-owner stand-down goes away.** `liveBridgeOwnerExists` currently makes a second server
  refuse browser control outright
  ([browser_bridge_pipe.cpp:278](../src/browser_bridge_pipe.cpp#L278)). Each server now publishes its
  own record and never stands down. The function survives, narrowed to "is this record's pid still a
  live instance of me", which is what enumeration needs.
- **Stale records must now be swept.** Today a dead server's record is silently overwritten by the
  next `start()`, so nothing ever enumerates or removes anything. One record per pid means they
  accumulate. This leak already exists for sockets — `stop()` removes only this process's own
  ([browser_bridge_pipe_posix.cpp:423](../src/browser_bridge_pipe_posix.cpp#L423)), so a crashed
  server's `bridge-<pid>-<nonce>.sock` is never cleaned up. The sweep should take both.

### 2. The relay is told which server it is for

Chrome gives the relay no argv it controls, so it cannot discover its server today. One exchange is
added at the front of the stdio hop, and **the relay speaks first**, as it already does there:

1. relay → extension `{type:"bridge_offers", protocol, servers:[<pid>, …]}`
2. extension → relay `{type:"attach_session", session:"<pid>"}`
3. relay connects to that record, handshakes, and sends `bridge_ready` as before

An earlier draft had the extension sending `attach_session` unprompted, immediately after
`connectNative`. That was wrong twice over.

**The extension cannot name a server.** It has no filesystem access, so it cannot enumerate records
and has no pid to send. The offers list is how it learns them — which is why the relay has to speak
first, not merely why it is tidier.

**An unprompted frame is unsafe in one skew direction.** The relay touches stdin nowhere before the
handshake, and afterwards only as the first `command`'s _reply_
([browser_bridge_relay_common.cpp:139](../src/browser_bridge_relay_common.cpp#L139)). A newer
extension posting a frame at connect time to an older relay would have it eaten as that reply,
failing the id gate and putting every later exchange one step out of phase. That pairing is real
here: Chrome does not reload an unpacked extension when its files change, so a Chrome holding a
stale loaded copy is the normal case after an update, in either direction.

Offers-first degrades cleanly both ways. An older extension treats `bridge_offers` as an unknown
type — `console.warn` and nothing else
([background.js:644](../browser/extension/background.js#L644)) — so it never replies and the relay
times out. A newer extension talking to an older relay sees `bridge_ready` arrive first and simply
never sends `attach_session`. No frame is ever sent unprompted, in either direction.

Named `attach_session`, not `attach`: `{type:"attach"}` is already load-bearing on the _pipe_ hop as
the negative case proving any first frame other than `hello` is refused
([test_browser_bridge_pipe.cpp:304](../tests/test_browser_bridge_pipe.cpp#L304)). Different hop, so
no functional collision — but no reason to make a reader check.

The wait for the reply must be bounded. `stdinReadExact`
([browser_bridge_relay_common.cpp:28](../src/browser_bridge_relay_common.cpp#L28)) is an unbounded
blocking `std::cin.read` with no deadline, so an extension that never answers would hang the host
forever. On timeout the relay writes `bridge_unavailable` saying the extension did not answer the
offer and that it is older than the server, then exits 0 — the same shape as every other startup
failure, and the message has to carry the diagnosis because the protocol version is never exchanged
on this path. A fail-closed timeout, not a fallback.

### 3. The extension keeps one port per server

`port` becomes a `Map<pid, session>`, and every global in the table above moves into the session
record. Routing is by which port a frame arrived on, so no frame shape changes.

This is the bulk of the work and the only part with real risk, because each of those globals is a
guard whose failure mode is silent. It should be done as a mechanical move into a session record
first, with the map holding exactly one entry, so the refactor is provably behaviour-preserving
before any second session exists.

Nine listeners touch session state, and only two — `port.onMessage` and `port.onDisconnect` — have a
session handle available, via the `Port` object closed over at `connect` time. The rest need
something else:

| listener                                                                     | what it must key on                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `chrome.debugger.onDetach`, `chrome.debugger.onEvent`                        | `source.tabId`, via a reverse index attachment → session     |
| `chrome.tabs.onCreated`                                                      | `tab.openerTabId`, via a reverse index adopted tab → session |
| `chrome.alarms.onAlarm`, `tabs.onUpdated`/`onActivated`, `runtime.onMessage` | nothing — worker-wide, and iterate all sessions              |

The two `.then` callbacks in the dialog path
([background.js:1269](../browser/extension/background.js#L1269)) run after their listener returns,
so they must capture the resolved session rather than look it up again.

### 4. Tab leases

A session adopts tabs as it does now, but the adoption is recorded against the session and a command
naming a tab outside its lease is refused with a typed error. Chrome's one-client-per-target rule
backstops the CDP path; the lease is what covers the non-CDP paths (`chrome.tabs`, `chrome.windows`,
cookies, downloads) where Chrome will happily let two sessions collide.

Simplest useful policy: a session leases the tab it adopts plus any tab its own actions open, and
`browser_tabs` / `browser_windows` report only what the session leases. An agent that wants a clean
workspace asks for its own window.

### What does NOT change

**The pipe server.** An earlier draft of this document had it serving N connections. That was wrong.
Each MCP server process publishes its own record, with its own endpoint and its own token, and the
extension opens one port per server — so Chrome spawns one relay per server, and each server still
has exactly one relay. The fan-out is at the extension.

That matters, because it is the expensive change that turns out not to be needed: `nMaxInstances = 1`
and `FILE_FLAG_FIRST_PIPE_INSTANCE`
([browser_bridge_pipe.cpp:296](../src/browser_bridge_pipe.cpp#L296)) stay, and with them the
guarantee that a second process cannot squat the endpoint. The single in-flight slot, the one
condition variable, and `generation_` as connection identity all stay correct. A reconnecting relay
is a second _sequential_ connection, which the accept loop already handles and
`reconnect_secondClientServedWithNewGeneration` already tests.

**`ref_index_`.** Already per server process
([browser_bridge.h:143](../include/chrome_control_mcp/browser_bridge.h#L143)).

## Order to build it in

0. **A test seam for the transport layer.** Nothing covers it today: no test in `tests/` references
   `onHostMessage`, `bridge_ready`, `BRIDGE_PROTOCOL`, `connectNative`, or `postMessage`, and
   `test_browser_extension_pure.mjs` loads `background.js` with a `chrome` stub but deliberately
   scopes itself to pure decision functions. Refactoring twenty-odd silent correctness guards with
   no net under them is not something to attempt first.
1. Session record holding exactly one entry — a mechanical move, provably behaviour-preserving.
2. Per-pid rendezvous records, with enumeration and a stale sweep; one server in practice.
3. The `attach_session` frame, with the extension sending a single session.
4. Extension multi-port.
5. Tab leases.

Steps 0–3 ship no user-visible change and each is independently revertible. Only 4 and 5 turn the
feature on.

## What not to do

**Do not make the transport multi-client without the leases.** It is the tempting half — it is
mechanical, it demos well, and two agents would appear to work. They would be corrupting each
other's view of the page the whole time, silently, because every guard listed above is a single
global that the second session quietly overwrites. A wrong click in the user's other project is
worse than a refusal.

## Cost

Real feature work across C++, the extension, and the protocol: a new rendezvous shape with a sweep, a
protocol frame that has to be read earlier than the relay reads anything today, a service-worker
refactor touching every correctness guard it owns, and a lease model with its own test surface. The
live-browser E2E suites would need a second-session dimension — two servers sharing one
`CHROME_CONTROL_MCP_RUNTIME_DIR` — and the red drills for the leases matter more than the happy
path: the thing to prove is that a cross-lease command is refused, not that two agents can both
click.

## Until then

The current behaviour is the mitigation: the second window serves its native tools, says browser
control is unavailable, and retries on every browser tool call, so it takes the browser over as soon
as the first server exits. Closing the other VS Code window is enough to hand it over.
