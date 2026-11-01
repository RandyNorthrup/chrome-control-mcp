# Readiness review: Chrome profiles, chosen per call

Reviewed 2026-10-31 against [the plan](../../chrome-profiles.md), `docs/QUALITY.md`,
`docs/ARCHITECTURE.md`, `docs/MULTI_SESSION.md`, and the current source of
`src/browser_bridge_pipe.cpp`, `src/browser_bridge_pipe_posix.cpp`, `src/browser_bridge.cpp`,
`src/browser_control.cpp`, `src/browser_contract.cpp` and `browser/extension/background.js`. This is a
review of the requirements, not evidence that any code works.

## Source facts the requirements rest on

- The server owns one pipe instance (`CreateNamedPipeW(..., 1, ...)`, `FILE_FLAG_FIRST_PIPE_INSTANCE`)
  on Windows and `listen(fd, 1)` with one `connection_fd_` on POSIX; one I/O thread accepts,
  handshakes and serves. A second relay meets a busy pipe and is reported unavailable, and the
  extension sets that server aside for 1-30 minutes.
- Chrome gives every profile its own instance of an extension, with its own `chrome.tabs`,
  `chrome.windows` and storage; each instance opens its own native port, and Chrome starts a relay
  per port. The extension's "one port per server" rule is per instance, so each profile already
  asks for its own connection to each server.
- Measured: a headed Chrome for Testing 153 under Xvfb opens a second profile through its process
  singleton and loads the `--load-extension` extension in it -- two service workers of this
  extension's ID in one browser. A headless Chrome does not open the second profile at all.
- Tab and window ids are unique within one Chrome process, which every profile of one user data
  directory shares; across two processes they collide.
- The server already walks each relay's ancestry to a Chrome process when it verifies the peer
  (`hasAncestorImage`), so it can know which Chrome a connection comes from without the relay
  saying so.
- `BrowserBridgeSession::onHostConnected` clears every ref; with several connections that would let
  one profile connecting wipe another's refs. Refs are already bound to tabs, and per-tab removal
  (`dropTab`) exists.
- `browser_tabs` lists the session's window in its profile (`sessionWindow`), with indices that
  index-addressed calls (`closeTab`, `groupTabs`) rely on, per connection.
- `chrome.identity.getProfileUserInfo({accountStatus: "ANY"})` gives the signed-in account's email
  and needs the `identity` and `identity.email` permissions; Chrome exposes no profile name.

## Findings and resolutions

| #   | Finding                                                                                                                                                                                                        | Resolution                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Refusing "another Chrome" would also refuse the same user's Chrome after a restart, while its old relays have not been noticed gone (up to about half a second), and the extension would back off for minutes. | An exited Chrome no longer counts: its connections are dropped and the new Chrome admitted at once (AC-PROF-OTHER-BROWSER).                                      |
| 2   | The update that brings this adds permissions. If an unpacked extension reloading into files with more permissions came back disabled, every user's extension would stop on that update.                        | New AC-PROF-UPGRADE: a live reload from a copy without the permissions into one with them must come back enabled and named.                                      |
| 3   | A listing across profiles fails as a whole if one profile does not answer.                                                                                                                                     | AC-PROF-ALL: the failing profile is named in the reply and the others still listed.                                                                              |
| 4   | "Last focused" is undefined when no window has ever had focus (fresh start, headless).                                                                                                                         | The oldest connection is chosen (AC-PROF-NEW-TAB).                                                                                                               |
| 5   | An extension or relay older than this work sends no profile and does not know the new commands.                                                                                                                | Called `unnamed`, treated as never focused (AC-PROF-SINGLE).                                                                                                     |
| 6   | Names and emails come from the extension and end up in an agent's context.                                                                                                                                     | Checked as untrusted text, bounded and stripped like client names (AC-PROF-NAME). The email reaching agents is the user's decision and is stated in SECURITY.md. |
| 7   | Unbounded connections would let anything that can reach the pipe pin threads.                                                                                                                                  | A bound of eight, refused past it (AC-PROF-SEVERAL).                                                                                                             |
| 8   | Index-addressed calls cannot be routed by the index alone once two profiles' listings are merged.                                                                                                              | They act in the agent's current profile, whose listing the indices come from; stated as a limit.                                                                 |
| 9   | An unknown `tab_id` must still produce the error it does today.                                                                                                                                                | It is looked for in every profile; not found, it goes to the current profile, whose extension answers as before (AC-PROF-BY-TAB).                                |
| 10  | Requirement/acceptance/task coverage.                                                                                                                                                                          | Every requirement has acceptance; every criterion has an owning task; tasks depend only on tasks before them; each change path has one owner.                    |

## Terminology

"Profile" is a Chrome profile, seen by the server as one connection. "Name" is what the user gave
it, else its email, else a generated name. "Current profile" is the one the server's last routed
call went to. "Last-focused profile" is the one whose window most recently had focus, else the
oldest connection.

Verdict: ready to implement.

## Addendum, before evidence

Re-reviewed after the first readiness receipt went stale, against the plan, the rules file and the
implemented source.

- **Paths.** TASK-PROF-DOCS gains `docs/releases/v1.10.0.md`, `docs/QUALITY.md`, and the release's
  version bump (`kBrowserExtensionVersion` in `browser_extension_installer.h`, `vscode/package.json`
  and both lockfiles); its purpose now says so. TASK-PROF-ROUTING drops
  `include/chrome_control_mcp/browser_contract.h`: the `profile` check lives entirely in
  `browser_contract.cpp`, and the header did not change.
- **Rules.** `docs/QUALITY.md` now counts 25 ctest suites on Windows and 24 elsewhere, 12 `test:js`
  files, lists the profiles live suite, and its status table carries 1.10.0's local counts. No gate
  was added, removed or relaxed.
- **Found while implementing, no criterion changed.** Windows' `DisconnectNamedPipe` discards
  unread data, so a refused relay never read why; a bounded linger read before the disconnect lets
  it (AC-PROF-SEVERAL's refusal is observed as the reason arriving). The extension acts only on
  tabs a session holds, so the live suite takes a tab it did not open with `browser_select_tab`
  before using it -- a fact of the test, not of the requirement.
- **Terminology.** Finding 8's resolution said "the agent's current profile"; as the terminology
  below it already says, the current profile is the one the server's last routed call went to,
  which two agents behind one server share. The docs say "the current profile".
- **Coverage.** Unchanged: every requirement has acceptance, every criterion an owning task, tasks
  depend only on tasks before them, and each change path has one owner.

Verdict: still ready; no requirement or criterion changed meaning.

## Addendum, after the first evidence pass

The first full pass found three things; none changed a requirement or criterion.

- **A profile attached nameless.** The two-profile live case saw one profile listed as `unnamed`:
  a port opened as the worker starts can be offered servers before the profile's name has been read
  from storage, and `attach_session` then carried no name. AC-PROF-NAME already required the name;
  the extension now waits for the read (bounded at two seconds) before attaching, and a new unit test
  and red drill cover it. A rename or `profileState` later would have corrected the name, but status
  showed `unnamed` until then.
- **Static analysis.** clang-tidy (three loop variables converting `QJsonValueRef`, one `const`
  local blocking a move) and cppcheck (three raw loops) flagged the new code; fixed the way the
  codebase already does.
- **One display-matrix check failed once** -- "the browser's own tab stayed in front throughout",
  one of 3335 checks, in a matrix whose only change in single-profile use is the extension's.
  It did not recur in six runs of that configuration, a full matrix and ten launch probes. The check
  now says which tab was in front, so TASK-PROF-LIVE gains `tests/e2e/display_matrix_e2e.mjs`.

Coverage unchanged. Verdict: still ready.

The rules file's JavaScript count moves from 216 to 217 for that new unit test; no gate changed.

## Addendum, after the second evidence pass

The second pass found what the first display-matrix failure most likely was. The extension answers
an offer with no session when every server already has one of its ports -- its probe for new
servers, or a surplus port at startup -- and the relay connected such a port to the newest server
anyway. A server of one connection turned it away; a server of several admitted it as a second
connection of the same profile, which then answered for the first's tabs and closed: the matrix saw
"the browser's relay closed the connection 1054 ms into click". The relay now connects such a port
nowhere, and the server serves a relay older than 1.10.0, which still connects it, only alone from
its Chrome. Both are what AC-PROF-SINGLE already required. A new live check (the upgrade case forces
a probe), two unit tests and three drills cover it.

The drill on the upgrade case's kept name did not fail: the check read the first listed profile
while the pre-reload connection could still be listed. The check now waits for one connection.

No requirement or criterion changed; no path was added. Verdict: still ready.
