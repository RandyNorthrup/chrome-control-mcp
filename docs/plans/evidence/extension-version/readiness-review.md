# Readiness review: noticing an extension older or newer than its server

Reviewed 2026-10-31 against [the plan](../../extension-version.md), `docs/QUALITY.md`,
`docs/ARCHITECTURE.md`, `docs/RELEASES.md`, and the current source of
`src/browser_bridge_relay_common.cpp`, `src/browser_bridge_pipe.cpp`,
`src/browser_bridge_pipe_posix.cpp`, `src/browser_control.cpp`, `src/mcp_dispatch.cpp`,
`src/browser_mcp_tools.cpp` and `browser/extension/background.js`. This is a review of the
requirements, not evidence that any code works.

## Source facts the requirements rest on

- The relay speaks first (`bridge_offers`); the extension's `attach_session` is its only
  unprompted-looking frame and is an answer, so a field added to it changes no ordering. The relay
  reads only `type` and `session` from it.
- The server's handshake (both backends) checks `type`, `token` and `protocol` of the hello and
  ignores everything else, so an older running server accepts a hello with more fields. The
  relay's handshake reads only `type` and `protocol` of the welcome.
- The extension's `bridge_ready` handler reads only `protocol`; an older extension ignores a
  `version` field.
- The relay is started by Chrome from the native-host registration, which `--install` points at
  the managed `current` link, so the relay's version is the installed version. Its version and the
  server's are `kBrowserExtensionVersion`, which `test_release_versions` holds equal to the project
  version.
- `toolCallResult` builds the MCP `content` array, so a notice can be a block of its own after the
  reply's text: a JSON reply stays parseable. Every MCP client shows every text block.
- `browser_extension_status` is a native tool with no access to the connection today; it needs the
  connection's versions handed to it.
- The extension already counts nothing about running commands; `handleCommand` is the one path
  every command takes, so a counter there is complete. Held tabs are `session.tabs` across
  `sessions` and `pendingLeases`.

## Findings and resolutions

| #   | Finding                                                                                                                                                                                                        | Resolution                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Reload when idle" alone races the agent's next call: an agent that releases its last tab and at once opens another would land in the reload, and at connect time a call may already be waiting for the relay. | Idle now also means no command for 10 s in any session, checked 10 s after the report, after each command and on the alarm, and re-checked right before the reload. AC-EXTVER-RELOAD-BUSY says so. |
| 2   | A call that lands during the reload itself still fails.                                                                                                                                                        | Accepted and stated: it fails before it starts (no command is running by construction), and the next call waits for the bridge as it already does after any extension reload.                      |
| 3   | Versions come from peers; shown to an agent unchecked, a version string is text injected into its context.                                                                                                     | Every version is validated as `major.minor.patch` and bounded before use; anything else reads as not said (AC-EXTVER-COMPAT).                                                                      |
| 4   | Which action fixes a mismatch depends on all three versions: reloading an extension does not help when the installed copy is itself older than the server (a build-tree server).                               | The notice is chosen from server, installed and extension versions together; the plan lists the four cases.                                                                                        |
| 5   | "Once per connection" could still repeat for a worker that reconnects often.                                                                                                                                   | Accepted: each reconnect with a still-stale extension is still stale, and a native port keeps the worker alive, so reconnects are rare. Matching versions never produce a notice.                  |
| 6   | An agent that holds a tab for hours defers the reload for hours.                                                                                                                                               | By design (never interrupt work); the notice asks the user to reload by hand meanwhile.                                                                                                            |
| 7   | A 1.8.x extension cannot reload itself into 1.9.0.                                                                                                                                                             | Stated as a limit; the notice is what tells the user, and the live suite runs the real 1.8.2 extension to show it.                                                                                 |
| 8   | No process spam: a reload must not start a reconnect storm.                                                                                                                                                    | Once per installed version (AC-EXTVER-RELOAD-ONCE), and a reload reconnects one port per server as any extension start does.                                                                       |
| 9   | Requirement/acceptance/task coverage.                                                                                                                                                                          | Every requirement has acceptance; every criterion has an owning task; tasks depend only on tasks before them; each change path has one owner.                                                      |

## Terminology

"Installed version" is the relay's version: the copy Chrome starts. "Server version" is the
running MCP server's. "Extension version" is the running extension's manifest version, or "not
said" for one older than this change. "Notice" is the extra text block on a reply.

Verdict: ready to implement.

## Addendum, during implementation

The first readiness receipt went stale because the plan changed. Reviewed here:

- **Task scope grew** by enabling paths the plan had not named: `mcp_dispatch.h` (the notice is a
  parameter of `toolCallResult`), `tests/browser_model.mjs` (a suite can now stub the chrome.*
  members the model lacks: `runtime.reload`, `runtime.getManifest`, storage),
  `tests/e2e/devtools.mjs` (the live suite looks at the extension service worker itself), and
  `docs/VERIFICATION.md`. No requirement changed meaning.
- **AC-EXTVER-STATUS gained a field**: `connections`, how many times a browser has attached. The
  live run showed why it is needed: after the extension reloads, its new worker attaches inside one
  500 ms poll, so a gap between connections cannot be seen -- only a count that moved.
- **The live harness was unfaithful, and that hid a whole class of behaviour.** Chrome disabled the
  extension on its own `chrome.runtime.reload()` (`disableReasons.unsupportedDeveloperExtension`,
  read from chrome://extensions): an unpacked extension needs Developer mode, which `Load unpacked`
  requires and every real install therefore has, but which the test profile never had and
  `--load-extension` skips only at launch. The harness profile now has Developer mode on. The
  protocol self-reload had the same blind spot.
- **Finding 2 measured**: a call that lands in the half second after a reload meets the old relay
  before either it (250 ms stdin poll) or the server (250 ms idle peer check) has noticed Chrome
  dropped it, and fails "relay closed the connection 1 ms into listTabs (connection reset)". It
  cannot have run: the port it would reach was already closed. Still accepted: it can only follow
  at least 10 s with no command and no held tab, an agent retrying gets the new connection, and the
  live suite waits for the new connection as a careful caller would.

Verdict unchanged: the requirements are clear, covered, and consistent.

## Addendum, before closing

The second readiness receipt went stale because the rules file changed: `docs/QUALITY.md`'s status
table now counts this work's suites (24/23 ctest, 210 JavaScript tests) and lists the
extension-version live suite among the live gates. No gate, threshold or rule changed. The MCP
`instructions` gained one sentence -- pass a version note on to the user, who alone can act on it
-- which serves AC-EXTVER-NOTICE without changing it.

Verdict unchanged: the requirements are clear, covered, and consistent.

## Addendum, scope narrowed before closing

The third readiness receipt went stale because the plan changed: `docs/VERIFICATION.md` left
TASK-EXTVER-DOCS. It records evidence rather than being a change this feature makes, and bound as
one, every later CI result written there would have staled this plan -- the clipboard plan never
bound it, for the same reason. Closure also found three tasks citing no red proof for some of their
criteria; four drills were added that break exactly those checks (a version taken unchecked in the
extension; `browser_extension_status` without the notice, an unknown command passed on bare, and a
hello without an extension version refused, live) rather than citing proof from another layer. No
requirement or criterion changed; every behaviour receipt is re-run against the narrowed scope.

Verdict unchanged: the requirements are clear, covered, and consistent.
