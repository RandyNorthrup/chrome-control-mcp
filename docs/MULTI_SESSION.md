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

The extension's service worker holds one session's worth of state in module-level globals:

| Global                                   | What it pins                                        |
| ---------------------------------------- | --------------------------------------------------- |
| `attachedTabId` (419)                    | the single CDP attachment                           |
| `sessionTabId` / `sessionWindowId` (427) | the tab this session adopted and steers             |
| `domEpoch` (435)                         | the DOM generation refs were captured against       |
| `lastSnapshotTabId` (439)                | the tab whose nodes populated the current ref index |
| `lastShot` (453)                         | the render a pixel coordinate is meaningful against |
| `lastTabListing` (459)                   | the positional tab indices last handed out          |
| `lastWindowListing` (465)                | the window ids the model is allowed to name         |
| `commandGeneration` (485)                | which polling handler is still current              |

Every one of those is a correctness guard, and every one assumes a single session. Two agents
sharing them would not fail loudly — they would each invalidate the other's view and keep going.
`lastTabListing` is the clearest example: agent A lists tabs, agent B opens one, agent A's index 3
now names a different page, and nothing in the current design can tell.

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

Make "session" a first-class thing that exists in all three layers.

### 1. Rendezvous becomes a directory

`ChromeControlMCP/bridge/<pid>.json`, one record per live server, each with its own endpoint name
and token. Readers enumerate and drop records whose pid is gone or resolves to a foreign image —
the same liveness rule [`liveBridgeOwnerExists`](../src/browser_bridge_pipe.cpp#L255) already
applies, just applied per entry instead of to a singleton.

The install lock added in the unreleased changes is a good precedent for the directory's
housekeeping: a crashed server must not leave anything a later one has to clear by hand.

### 2. The relay learns which server it is for

Chrome gives the relay no argv it controls, so it cannot discover its server today — it reads the
one well-known path. Add one frame at the front of the protocol: the extension sends
`{type:"attach", session:"<record id>"}` on stdin immediately after `connectNative`, and the relay
selects that record before connecting. This is additive and versioned by the existing
`kBrowserBridgeProtocol` handshake.

### 3. The extension keeps one port per server

`port` becomes a `Map<sessionId, Port>`. Every global in the table above moves into a per-session
record inside that map. Frames already carry an `id`; they gain a session, and the worker routes on
it.

This is the bulk of the work and the only part with real risk, because each of those globals is a
guard whose failure mode is silent. It should be done as a mechanical move into a session record
first, with the map holding exactly one entry, so the refactor is provably behaviour-preserving
before any second session exists.

### 4. Tab leases

A session adopts tabs as it does now, but the adoption is recorded against the session and a command
naming a tab outside its lease is refused with a typed error. Chrome's one-client-per-target rule
backstops the CDP path; the lease is what covers the non-CDP paths (`chrome.tabs`, `chrome.windows`,
cookies, downloads) where Chrome will happily let two sessions collide.

Simplest useful policy: a session leases the tab it adopts plus any tab its own actions open, and
`browser_tabs` / `browser_windows` report only what the session leases. An agent that wants a clean
workspace asks for its own window.

### 5. The pipe server serves N connections

One accept loop, one connection state per client, one command in flight per client. The single-op
model stays — it is per session rather than global.

## Order to build it in

1. Extension session record with one entry (no behaviour change, fully testable against the existing
   suites).
2. Rendezvous directory with one record (same).
3. Multi-connection pipe server, still one client in practice.
4. Relay `attach` frame.
5. Extension multi-port.
6. Tab leases.

Steps 1–4 ship no user-visible change and each is independently revertible. Only 5 and 6 turn the
feature on.

## What not to do

**Do not make the transport multi-client without the leases.** It is the tempting half — it is
mechanical, it demos well, and two agents would appear to work. They would be corrupting each
other's view of the page the whole time, silently, because every guard listed above is a single
global that the second session quietly overwrites. A wrong click in the user's other project is
worse than a refusal.

## Cost

Real feature work across C++, the extension, and the protocol: a new rendezvous shape, a protocol
frame, a service-worker refactor touching every correctness guard it owns, an accept loop rewrite,
and a lease model with its own test surface. The live-browser E2E suites would need a second-session
dimension, and the red drills for the leases matter more than the happy path — the thing to prove is
that a cross-lease command is refused, not that two agents can both click.

## Until then

The current behaviour is the mitigation: the second window serves its native tools, says browser
control is unavailable, and retries on every browser tool call, so it takes the browser over as soon
as the first server exits. Closing the other VS Code window is enough to hand it over.
