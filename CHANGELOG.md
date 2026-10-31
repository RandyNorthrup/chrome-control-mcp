# Changelog

All notable changes are documented here. Project follows [Semantic Versioning](https://semver.org/).

## [1.9.0] - 2026-10-31

Every agent gets a clipboard of its own.

### Added

- **Per-agent clipboards.** Agents shared the operating system's one clipboard with each other and
  with the user: one agent's Ctrl+V pasted another's copy, or the user's, and its copy replaced
  theirs. Each agent -- per server and agent name, like its tab group -- now has its own, held by
  the extension in memory and emptied when the agent lets go of its last tab, its server exits, or
  the user pauses the bridge. Nothing an agent does reads or writes the system clipboard.
- **Copy, cut and paste keys** (`browser_press_key` with Control or Meta and C, X, V; Control+Insert,
  Shift+Insert, Shift+Delete; Control/Meta+Shift+V for text only) are answered from the agent's
  clipboard instead of being sent to Chrome. A copy runs the page's own `copy` handlers, as a real
  one does, and otherwise takes the selection as text and HTML. A paste gives the focused element a
  real `paste` event with `text/plain`, `text/html` and files, then `beforeinput insertFromPaste`,
  and types the text in only if the page took neither -- whole into a field, line by line with
  Shift+Enter elsewhere, so a paste never sends a chat message.
- **`browser_clipboard`**: write text, HTML and files (by path, read like `browser_upload`'s), read,
  clear, copy, cut, and paste (into the focused element or a ref; `plain` for text only). 53 tools.
- The MCP `instructions` tell every client about it, and steer agents away from shell clipboard
  commands, which every agent and the user share.

### Fixed

- A page's copy button clicked by an agent wrote the user's clipboard. Agent tabs run under focus
  emulation, so a background page believed it was focused, and Chrome lets a focused page write.
  In a held tab, `navigator.clipboard` and `document.execCommand('copy' | 'cut')` now use the
  agent's clipboard, only while the agent's own input reaches that tab (and for 2 s after); a page
  asking at any other time is refused. A tab handed back gets the browser's own functions again.
- `Shift+Insert` and `Control+Insert` were refused as an unsupported key.
- A `browser_upload` that the contract then rejected (a stale ref, say) had already sent its files,
  which stayed in the extension's buffer until the session ended. Arguments are now checked before
  any file is read or sent.

### Changed

- A command whose connection to the browser broke is told why. The server reported every failed
  read as "browser did not reply within 30000 ms (connection reset)" -- also when the browser's
  relay closed the connection a moment after the command went out, or sent something unreadable --
  so a stalled browser could not be told from a broken bridge. Silence keeps that wording; a closed
  connection now says "the browser's relay closed the connection N ms into <command>", and an
  unreadable reply says so.
- When a display-matrix screenshot fails, the suite asks Chrome over its own DevTools whether it
  still answers, so the intermittent Windows 4K-capture stall can be placed: in Chrome, or in the
  path through the extension.

## [1.8.2] - 2026-10-31

### Fixed

- `browser_release` left an agent's tabs open behind it. Reported from daily use: two tabs an
  agent had opened were still open after it released. Release by `tab_id` -- which every agent
  sharing a server is told to use -- let go of that one tab only, so the popups its clicks had
  opened, and its other tabs, stayed open and held for as long as its server ran (greyed after ten
  idle minutes, never closed). It now releases the agent's tabs: that tab, every tab opened from it
  (a popup records the tab that opened it, across a worker restart too), and, for an agent that
  gave itself a name, every tab under that name. Other agents' tabs are untouched.
- A tab Chrome refused to close -- it refuses while the user is dragging a tab -- was reported as
  closed and left open in an AI group with nothing holding it. The close is now checked and
  retried; a tab still open after that is handed back, listed in `not_closed`, and never reported
  as closed.

## [1.8.1] - 2026-10-31

### Fixed

- `browser_upload` reported a successful upload as `files: []` on pages that read the file and then
  empty their input -- GitHub's uploaders do exactly that. The reply now lists what was delivered,
  read before the page's own handlers run, and says `page_cleared_input: true` when the page reset
  it. Found uploading this repository's social preview through the tool itself.
- An agent named in anything but ASCII lost its name. The server accepts any printable name, but
  the extension kept only ASCII, so `café` was titled `caf` and a name with no ASCII at all put
  that agent's tabs in the session's shared group. Names in any script are kept; control and format
  characters are still dropped, and the length is counted in characters, not UTF-16 units.
- The MCP `instructions` every client receives said held tabs carry a pink frame. Since 1.8.0 the
  frame is in the colour of the tab's group.
- The Semgrep gate had stopped running. The Qt install step switched the analysis job to the newest
  Python, 3.15, under which `semgrep-core` crashes at start-up ("failed to create domain backup
  thread"); reproduced locally, and the same scan under the job's pinned 3.12 is clean. The job now
  keeps its own Python.
- Two JavaScript suites ran only under `npm run test:js`, which CI never calls:
  `test_browser_extension_tabs` (most of 1.8.0's tab handling) and `test_release_versions`. ctest,
  and so CI on all three platforms, now runs both.
- A relay test failed once on the macOS runner with nothing wrong: its beats were 250 ms apart
  against a 400 ms silence budget, so one late wake-up was enough. The budget is now outlasted by
  half again rather than by a quarter, and the assertion that names the server's reason comes
  first, so a real failure says why.

### Changed

- Agents' tab-group colours are handed out pink, cyan, orange, blue, green, yellow, red, then
  purple. Purple used to come second, and beside the first agent's pink it was the hardest pair to
  tell apart.
- The README, the VS Code Marketplace page and the docs are rewritten for 1.8: a new banner and
  social preview, screenshots of three agents from two clients in one window, setup for any MCP
  client, tools grouped by job, and current verification figures. The Marketplace listing gains a
  matching description, keywords and gallery colour.
- Dev-only tooling pins `minimatch` and `glob` past advisories published since 1.7.0.

## [1.8.0] - 2026-10-31

Several agents in one browser, each in its own tabs, and nothing left behind when they are done.
Every item below was reported from daily use; the design record is in
[docs/MULTI_SESSION.md](docs/MULTI_SESSION.md#180-agents-not-servers).

### Fixed

- A second editor's server could go hours without reaching the browser. Measured: two servers
  running, one relay. The server held its single pipe instance for a relay that had died with
  Chrome, and only noticed when it next sent a command; every relay in between was refused with
  `ERROR_PIPE_BUSY`. An idle server now checks its connection every 250 ms and listens again as
  soon as the relay is gone. Relays offer only servers that are running.
- A server that starts while another is attached is found in about a second. The attached relay
  reports changes to the set of running servers (`bridge_servers`) from its own directory check,
  which starts no process; it used to wait for a probe on a thirty-second alarm.
- Opening a tab yourself -- Ctrl+T, the new-tab button, a middle-click -- while an AI tab was in
  front pulled the new tab into the AI group and moved the assistant onto it. Chrome names the tab
  you were looking at as the new tab's opener, and the extension took that to mean the assistant
  opened it. A tab is now the assistant's only if it opened it, its own command's page opened it,
  it was given it, or you dragged it into the AI group; Chrome's own grouping of your tab is undone.
- Agents sharing one server retargeted each other. The server kept one current tab and one set of
  element refs, so one agent's `browser_new_tab` or snapshot moved the other's next click. Refs are
  now bound to the tab they came from and never reused, and every tab-scoped tool takes `tab_id`.
- Closing the tab the assistant was driving left the rest of its group unmarked, and the frame
  could vanish after a navigation. Every held tab is now attached and marked, and the frame is
  drawn into each new document as it is created rather than re-drawn after it raced the page.
- When a session ended only the tab it was driving was ungrouped, so tabs Chrome had added to the
  group kept an "AI CONTROL" group with nobody behind it, and tabs the assistant opened stayed open.
- An upload button whose script creates and clicks a file input could not be used: the input is in
  no document, so no ref could name it, and Chrome cancels the file dialog in a tab that is not in
  front (measured on Chrome 153). File pickers a page opens during an agent's command are now
  caught instead of shown, and `browser_upload` with no ref fills them.
- Opening an editor rolled an update back. The VS Code extension installs the build it bundles on
  every editor start, and that install repointed the managed `current` link at itself even when a
  newer version was already current -- leaving Chrome on an extension newer than the server its
  relay now launched. An older build now leaves a newer install in place and says so.
- The control highlight broke on pages that enforce Trusted Types -- YouTube, Gmail, Google Docs,
  Chrome's own error pages. The cursor was built with `innerHTML`, which those pages refuse, so it
  was never drawn, and the exception it threw landed in the page's console, where
  `browser_console` reported it to the agent as the page's own error. It is built node by node now.
- A link that opens a new tab (`target=_blank`) left that tab behind as a stray, in front of the
  user. Such a link opens with no opener Chrome names to an extension, so the tab was never matched
  to the agent whose click opened it, and Chrome switched the user's window to it. The tab is now
  matched through the browser's own record of where it was opened from (and, failing that, the
  page's own request to open it), joins the agent's group, and the tab the user had in front is put
  back in front. Found on the-internet.herokuapp.com; covered by the live suite.
- A page Chrome will not let an extension control -- its own "Privacy error" and other warning
  pages, the browser's pages, another extension's -- answered every command with a bare
  "Cannot attach to this target." The reply now says what the page is and what to do.

### Added

- `browser_release`: the agent saying it is done. Tabs it opened are closed, tabs it borrowed are
  handed back (never closed), and its group and marking are removed. `tab_id` releases one tab;
  `keep_open` hands opened tabs over instead of closing them. The tab you are looking at and the
  browser's last tab are never closed.
- Cleanup without being asked: when a server exits its tabs are released the same way; after ten
  minutes without a command a session is stood down (debugger detached, which removes Chrome's
  debugging bar, marking removed, group greyed and titled "idle") and its next command resumes it.
  A relay that drops and comes back resumes its tabs instead.
- `tab_id` on every tab-scoped tool, `tab_id` in `browser_new_tab`, `browser_select_tab` and
  `browser_close_tab` replies, and `your_tabs` in `browser_tabs`.
- `agent` on `browser_new_tab` and `browser_select_tab`: each agent's tabs get their own group,
  titled for it, in a colour no other group has; the frame and badge on the page use the same
  colour and name.
- `browser_upload` delivers files by drag and drop to a drop zone with no input, and answers a
  page's `showOpenFilePicker`. Folder pickers are not supported yet.
- MCP `instructions` telling any client how to share the browser: its own tab, `tab_id`, refs bound
  to tabs, uploads without a dialog, and `browser_release` when done.
- `tests/e2e/multi_agent_e2e.mjs`: two servers and two agents in one live browser, run in CI.

### Changed

- Bridge protocol 2. The extension and the server must be the same release; a mismatch says which
  side to update. A Chrome still running an older copy of the extension reloads it once by itself.
- `browser_new_tab` with no `url` opens `about:blank` rather than the new-tab page, which the
  debugger cannot attach to.
- The extension requests two new permissions: `scripting`, used only to take the frame off a page
  whose debugger attachment has already ended, and `webNavigation`, used only to learn which tab a
  new tab was opened from.
- With a relay attached, the extension's background probe for new servers runs every five minutes
  instead of every thirty seconds, and a server that refuses it is set aside on a doubling interval
  -- fewer processes started than before, not more.
- One server still carries one command at a time: two agents sharing a server are isolated, not
  concurrent. Separate servers run in parallel.

## [1.7.0] - 2026-09-25

The three things 1.6.1 shipped without fixing, and the reason each one had survived: none of them
had a test that could fail.

### Fixed

- `browser_scroll` aimed at a ref inside a nested scroll container reported `scrolled 0` while the
  element visibly moved. The two reads either side of the wheel matched scrollers by a name that
  counted ancestors up from whatever element the point landed on -- a property of the CONTENT, not
  of the container. Scrolling the content out from under the point renamed the very scroller that
  had moved, so nothing matched and the distance came back as zero; the in-page rest-detector
  compared the same list and saw a change that was only the renaming. Scrollers are named by their
  path from the document root now. The live fixture's scroll region gained rows of differing depth
  so the rename actually happens there, and the suite checks the reported distance against the
  measured movement of an element inside it.
- An element the page wires up itself -- a div with a click handler, a card with `cursor: pointer`
  -- earned no ref. To the accessibility tree it is `generic` with no name, which the capture
  dropped, so the model was shown scenery where the page had a button and the only way to reach it
  was `browser_click_at` with a pixel read off a screenshot. The capture now reads three signals
  out of the DOMSnapshot it already takes: Chrome's own `isClickable` (which covers an inline
  `onclick` and an `addEventListener` wiring alike -- measured against a real Chrome, not assumed),
  the page's own pointer-handler attributes, and the computed cursor. `cursor` is inherited, so a
  card only counts when its parent does not: promoting on the computed value alone turned one
  clickable card into a ref for every part of it. The outline says which signal earned the ref --
  `(clickable)`, `(hoverable)`, `(pointer)`.
- `browser did not reply within 30000 ms (connection reset)` was a silence budget being spent as a
  work budget. Handlers are allowed far longer than 30 s by design (`browser_download` polls to
  120 s), so a slow page, a big download or a loaded machine surfaced as a transport failure and a
  reset connection for work that was proceeding normally. The extension now reports progress every
  5 s while a command runs; the relay forwards those beats without mistaking one for the reply, and
  each restarts the server's deadline. Silence still fails in 30 s. A command that beats but never
  finishes is abandoned at 180 s with a refusal that names it and says it ran too long, rather than
  blaming the connection. The beat also keeps the MV3 service worker alive while it works, which is
  the other half of why long commands died.

- A reply too big to cross the pipe inside one budget failed as a timeout while it was arriving
  perfectly well. The read loop handed every chunk the same shrinking deadline, so the budget
  bounded the whole TRANSFER rather than a gap in it -- and the progress beats cannot help there,
  because once the extension starts posting the reply there are no more beats to send. Found by a
  CI run that lost a 5120x2880 screenshot to
  `browser did not reply within 30000 ms (connection reset)`, which is the exact message this
  release exists to stop printing for work that is going fine. A chunk that moved bytes now
  restarts the budget, bounded by the ceiling on the whole exchange.
- `browser_wait_for` silently clamped `timeout_ms` to 25 s. That cap was there to dodge the very
  budget above -- its comment said so -- and a caller asking for 60 s got 25 and was told nothing.
  The budget restarts on a beat now, so the cap is the same 120 s ceiling `browser_download`
  already uses, and the description states it.
- `browser_scroll` reported `settled` for a wheel that had not been acted on yet. "Nothing moved"
  was treated as "an edge already reached" -- true at an edge, wrong when the scroll simply has not
  begun, which on a heavily zoomed page is the common case: at 25% zoom a request of 200 is 800 CSS
  px of animated travel. The reply then said `scrolled 0, settled true` and the page went on moving,
  so the next call read a position it had already left and the scroll after that over-reported by
  the difference. Reported twice by CI, on two platforms and two configurations. `room` already
  distinguished the two cases and was already in the reply: nothing moved with room left now waits
  to find out, and nothing moved with no room is still answered at once.
- The in-page rest detector reported a scroll as settled when the serialized offsets merely looked
  different. The chain under the point changes composition as content moves, so a scroller entering
  or leaving it read as movement -- while `scrollDistance`, which matches only the names present in
  both reads, correctly reported 0. So `browser_scroll` could answer "settled, scrolled 0" and the
  page would go on moving after the reply, leaving the next call to read a stale position. Both now
  measure by one rule.
- The extension asked for a bridge that was not there every couple of seconds, for as long as the
  browser was open. Every attempt starts a process -- `connectNative` makes Chrome launch the native
  host, which looks for a published server, finds none, says so and exits -- and the 2 s retry was
  re-armed by its own disconnect, with one further attempt on every `tabs.onUpdated` and
  `tabs.onActivated`. So a machine with the extension installed and no editor running spawned host
  processes continuously, faster while its owner was browsing. Reported from a machine where it was
  disruptive enough to interfere with unrelated work, and the only way out was to disable the
  extension. The interval now doubles while nothing answers, from 2 s to a 2-minute ceiling, and
  resets the moment a bridge does answer -- so a server that is running is still found within two
  seconds. The waiting applies to the tab events and the alarm as well, which were the paths that
  made the old interval moot.

### Added

- `tools/backoff_probe.mjs`, which measures the reconnect cadence in a real browser rather than
  against mocked timers: it loads the extension with no server to find and counts the attempts. On
  a 75-second watch it records 6, where the retry it replaced would have made at least 37.
- A pause switch on the toolbar button, because backing off is not the same as being able to stop.
  Clicking it while the bridge is connected pauses it: the open ports are closed, the browser is
  released, and nothing reaches for it again until it is resumed. Clicking while paused resumes and
  connects at once; clicking while it is merely not connected retries immediately rather than
  waiting out the interval. The badge reads `off` while paused and nothing at all otherwise, and the
  state survives a browser restart -- somebody who turned it off because it was in their way must
  not find it back on tomorrow. This needs the `storage` permission, which is new.
- `browser_extension_uninstall` has live coverage for the first time, driven through the built
  server against a real registration. Nothing had ever run it: the live suite cannot remove the
  registration it is using, and the unit tests stop at the installer class. What made it
  untestable on Windows was the registration being one fixed key per user -- POSIX has had
  `CHROME_CONTROL_MCP_NATIVE_HOST_DIR` from the beginning and Windows had no equivalent, so the
  only key to test against was the user's own. `CHROME_CONTROL_MCP_NATIVE_HOST_KEY` and
  `CHROME_CONTROL_MCP_DATA_DIR` are that missing half. Chrome still reads only the fixed key.

### Changed

- `browser_extension_uninstall` says when there was nothing to remove. Removing a registration that
  was never there succeeds at the system-call level on both platforms -- a missing key and a
  missing file are not errors -- and the reply said "Browser extension bridge unregistered" for a
  machine it had not changed. It now answers "Nothing to unregister", and the summary for a real
  removal is unchanged.

## [1.6.1] - 2026-09-25

Everything a fresh-install run on a clean Windows 11 VM turned up: 50 of the 51 tools driven
against live sites, each checked by its effect rather than its reply.

### Fixed

- `browser_network` dropped redirects. A redirect re-fires `requestWillBeSent` under the same
  request id, and the pending entry was overwritten without being logged -- so a form POST that
  302s appeared only as the GET that followed, the opposite of what the tool is for. Both hops are
  logged now, the first with its status and a `redirected_to`.
- `browser_select` could not match a label copied out of the snapshot. Pages write `&nbsp;` for
  alignment, which puts U+00A0 in `option.text` while the snapshot shows an ordinary space; `===`
  made those different strings. Both the single and multi paths compare with whitespace collapsed.
- `browser_permission` passed `ask` to Chrome for `javascript`, `images` and `popups`, which the
  API rejects -- those are on-or-off. The error named neither the tool, the permission, nor what
  would have worked. It is checked per type now, and says all three. Chrome's extension API cannot
  return one site to the browser default; the refusal says so rather than implying it can.
- `browser_media` could not reach a `<video>` that draws its own controls: not focusable, no
  accessibility value, so no ref. `video` and `audio` are interactable roles now.
- `browser_hover` could not reach an element with no ref -- a link with no `href`, a div with only
  an `onmouseenter` handler. It takes `x`/`y` like `browser_click_at`, refused unless the
  screenshot they came from still matches the live render, and refuses both at once.
- The recording timeline's field is `cmd`, not the `name` the description claimed.
- `browser_back` can fail after a `browser_navigate` nobody clicked on, because Chrome creates no
  history entry without user interaction. The description says so instead of leaving it looking
  like a fault.
- `browser_extension_install` told every caller to load the extension by hand even when it was
  already loaded and connected.
- A live-suite failure reported `SyntaxError: Unexpected token 'b'` when a tool answered with
  prose instead of JSON. It now reports what the tool actually said.
- The live suites' attach budget was 90 s, which two Windows configurations exceeded under the
  matrix's two-at-a-time browser startup and both passed on a re-run. A deadline sitting on the
  edge manufactures failures rather than finding them; it is 180 s, and the extra is spent only
  when an attach is actually slow.

## [1.6.0] - 2026-09-24

### Added

- `browser_console`: the page's own console output, its uncaught exceptions and unhandled
  rejections, and what the browser said about the page (a blocked mixed-content load, a CSP
  violation, a subresource that failed) -- that last group never reaches the page's console API.
  An agent that clicked a button and saw nothing happen had no way to learn that the page threw.
- `browser_network`: the requests the page made -- method, URL, resource type, status, MIME type,
  and the milliseconds until the response arrived. A request that never got a response carries the
  browser's error text instead of a status. The Network domain was already enabled for
  `wait_for network_idle`; none of it had ever been surfaced.
- Both are bounded rings of bounded entries, separate `omitted` (what the reply left out) from
  `dropped` (what the buffer discarded), and are in the read-only profile: neither can change what
  the page does or what the user sees.
- The live browser suites run on Windows. They ran on macOS alone, and Windows is where the
  versioned install layout lives -- the junction identity fault shipped there in 1.4.0 and again
  in 1.5.0 with green unit tests throughout, because nothing drove a live browser there.
- Live coverage for `browser_record_start` / `browser_record_stop`, which shipped in 1.5.0 with
  none. Nothing in the suite's `NOT_EXERCISED_HERE` now reads "not written yet".

### Fixed

- The network log filled with the `data:` icons the media element's controls load, crowding out
  every request the page actually made. Inline content is counted for `network_idle` and left out
  of the log.
- A request was logged when its body finished loading, which lost the document's own request every
  time -- that request completes the navigation which drops anything still awaiting a response --
  and never logged a `fetch()` whose body nobody reads. Entries are written when the response
  arrives; `ms` is what the server took rather than what the body cost to stream.
- The Windows live job configured with `-G Ninja` and no MSVC environment, so CMake took MinGW
  from the runner's PATH and the build failed on warnings MSVC does not raise.

### Changed

- The control cursor is 24px rather than 32px. At that size its SVG renders at scale 1, so the
  arrow's tip lands on exact integers rather than the rounding 32px needed.
- No JavaScript evaluation tool, written down in `docs/TOOLS.md` and `docs/SECURITY.md` as a
  decision rather than an omission: an eval would bypass the isolated-world storage checks, the
  dialog policy, the freshness gating on ref and coordinate actions and the refusal of
  `javascript:` URLs, and could delete the control overlay. There is no read-only
  `Runtime.evaluate`, so a "read-only eval" would be a promise the code could not keep.

## [1.5.5] - 2026-09-24

### Fixed

- A drag that failed part-way could stop the session answering. Every step's commands are sent
  before any is awaited (awaiting each in turn costs 8.9 s in a background tab), so a command that
  rejected while an earlier step was still being awaited had no handler attached yet -- and V8
  raises `unhandledrejection` for that, which a service worker runtime may tear the worker down
  over. The bridge then reported `browser did not reply within 30000 ms (connection reset)`,
  naming the transport for a fault in the handler. Each in-flight command is now marked handled as
  it is created, and a real failure still stops the drag where it stopped.
- A drag re-sent the whole cursor-overlay script on every step -- three element lookups, two
  `cssText` assignments and an `innerHTML` that reparses an SVG, up to 60 times, to move a cursor
  by two numbers. A position-only nudge now moves a cursor that is already there, with the full
  build kept as the fallback.
- Both `package-lock.json` files said 1.3.1 while the project shipped 1.4.0 through 1.5.4. `npm
ci` validates dependencies against the lock, not the root version, so nothing had ever noticed.

### Added

- `tests/test_release_versions.mjs`: every file that states a version must state the same one
  (CMake, both `package.json`s, both lockfiles, the extension manifest, the installer header), and
  the version being shipped must have a changelog entry and a release note. The release checklist
  was a person remembering six files; it is now run by the gate.

## [1.5.4] - 2026-09-23

### Fixed

- A `[ref]` named a position in the snapshot rather than a node. Refs were numbered by document
  order and renumbered on every snapshot, so an element that gained a ref-worthy sibling above it
  answered to a different ref the next time the page was captured -- and every ref a model still
  held went on resolving, silently, to the element beside the one it named. `browser_snapshot`
  advertises "a stable [ref]"; it now is one. The previous index is carried forward by
  `backendNodeId`, so a node keeps the ref it was issued and only a new node takes a new number.
  This reached `browser_click`, `browser_type`, `browser_drag` and `browser_scroll` alike: an
  action could land on the wrong element and report success.
- An action could be aimed at where an element used to be. Bringing an element into view moves the
  page, and that move is not always finished when the command that asked for it returns, so the
  box could be read while the page was still settling. The page is now allowed to come to rest
  first. Shared by click, hover, drag and reveal.
- A scroll by `[ref]` now verifies that its point still lands on that element, re-reads the box
  once if it has slipped, and is refused -- naming what it hit -- rather than wheeling a stranger
  and reporting the element that was asked for. The hit test climbs shadow boundaries, which
  `elementFromPoint` and `Node.contains` do not.

### Added

- `browser_scroll` reports `point`, `hit` and `room` alongside `scrolled`. `scrolled` 0 with
  `room` 0 is an edge already reached; `scrolled` 0 with room left means the wheel never reached
  the scroller, which is a fault rather than an answer.
- `tools/scroll_probe.mjs`, a pure-CDP diagnostic that needs no MCP server, extension or build, so
  it can answer in about two minutes wherever a platform disagrees about input.

## [1.5.3] - 2026-09-23

### Fixed

- `browser_record_start` told assistants that "Chrome shows its own recording indicator while this
  runs". It does not, and never did on the path that shipped: the note survived from the
  `tabCapture` design that was ruled out before any code was written. Frames come from the debugger
  the session already holds, so there is no separate recording indicator -- what Chrome shows is the
  debugging banner that is up for the whole session, recording or not. `docs/SECURITY.md` had this
  right; the tool description a model reads did not.

### Changed

- README: the claim that a session "never takes your OS focus" is now what the code actually
  promises -- it never asks for focus, and `browser_window new` reports `took_os_focus` when a
  compositor focuses the new window regardless, which `docs/VERIFICATION.md` has recorded on
  Hyprland since 2026-09-18. Recording and multi-session gained the tool names and behaviour the
  capability table only alluded to, and the two screenshots were retaken -- concurrently, by two
  servers, which is what makes them evidence of multi-session rather than two separate captures.

## [1.5.2] - 2026-09-23

Three faults that only a real browser could find. 1.5.1 fixed the identity
check that stopped the bridge attaching; with it attaching, the first things it
tried were broken.

### Fixed

- **`browser_navigate` did nothing but report that your URL was not http(s).**
  `dispatchCommand` passes the session it is acting for as every handler's first
  argument, and `handleNavigate` was still declared `(tabId, args)`. It read
  `args.url` off a tab id, found `undefined`, and refused a perfectly good URL.
  Broken since 1.5.0, when the session was threaded through the worker.

  ESLint could not see it. `no-undef` made that refactor verifiable by failing
  on any function that USED a binding it no longer had, and `handleNavigate`
  never mentions `session` -- a missing parameter is silent in JavaScript. All
  41 handlers that the command table names directly were audited the same way;
  `navigate` was the only one. A test now compares every entry's declared arity
  against what the dispatcher passes it.

- **Recording never worked.** `browser_record_start` failed on its first real
  start with "canvas.captureStream is not a function": the offscreen document
  built an `OffscreenCanvas`, and `captureStream()` exists on
  `HTMLCanvasElement` only. Having a DOM is the entire reason that document
  exists, so it now creates a canvas element.

  `browser/extension/offscreen.js` was the one shipped file no test loaded --
  the recording suite stubs the document out and tests the worker's side of the
  conversation. It has a suite of its own now, whose harness gives the context
  an `OffscreenCanvas` with no `captureStream`, exactly as Chrome does.

- **A second session could neither list tabs nor open one of its own while the
  first held the tab in front.** `sessionWindow()` answers which window a
  session is working in, and every caller of it -- listing tabs, resolving an
  index, opening a tab -- wants only the id. It got one by calling
  `activeTab()`, which ADOPTS the user's active tab as the session's and
  refuses when another session already holds it. So a second editor was told
  "that tab is being driven by another Chrome Control MCP session", and advised
  to open a new tab, which failed the same way. Asking which window now reads
  the window and takes no tab from anyone.

  This is the case multi-session exists for, and it worked only while the first
  session happened not to hold the tab in front.

- **An orphaned relay left the bridge unreachable until it was killed by hand.**
  Reloading the extension closes the relay's port, but the relay spends nearly
  all its life blocked reading the pipe, where that is invisible. It stayed
  alive holding its end of a pipe created with `nMaxInstances = 1`, so every
  relay Chrome started afterwards was refused with `ERROR_PIPE_BUSY`.

  The relay now watches its own standard input and ends the process when Chrome
  lets go. The check peeks and never consumes, because the pump reads the same
  descriptor on another thread; only a definite hangup counts, so a relay run
  from a console is not killed by a check that cannot interpret its stdin.

### Changed

- `--install` reports whether it copied anything. It is a no-op when the version
  is already installed and already current -- which is right, because the VS
  Code extension calls it on every activation -- but it answered `ok` either
  way, so a rebuilt tree of the same version looked installed when nothing had
  moved.

## [1.5.1] - 2026-09-23

### Fixed

- **The bridge could not attach on a Windows managed install.** Every relay refused every server
  with "The bridge is served by ...\versions\1.5.0\chrome_control_mcp.exe, but this relay is
  ...\current\chrome_control_mcp.exe", and no browser tool worked.

  Both processes were the same file. `current` is a directory junction onto `versions/<version>`,
  and the two halves of the identity check asked different questions: a process asked about ITSELF
  with `GetModuleFileNameW`, which reports the path it was launched through, and about its PEER
  with `QueryFullProcessImageNameW`, which reports what that path resolves to. Under a junction
  those are two names for one file, so each side called the other a foreign image and closed the
  connection.

  The POSIX half already canonicalized both sides, with a comment naming `current/` as the reason.
  The Windows half never got that fix, and the copies of it in the pipe server and the relay had no
  way to disagree visibly -- so both are now one module, `windows_process_identity`, which asks
  about itself and about a peer through the same call and canonicalizes the answer.

  The same comparison decides whether another server's rendezvous record is live, so the fault also
  made every peer's record look abandoned: servers swept each other's records and republished their
  own, and the multi-session support released in 1.5.0 quietly worked against itself.

  Latent since the versioned install layout landed; it became reachable when 1.5.0's self-update
  first put both the MCP command path and the native-host registration behind `current`.

### Changed

- `docs/TOOLS.md` counted 43 live browser tools out of 49; the 49 is right and the breakdown was
  not -- it is 41 browser tools plus the 2 recording tools added in 1.5.0. README now lists
  multi-session and recording among the capabilities, states that a new build needs the MCP server
  restarted and the extension reloaded before it takes effect, and no longer implies the two
  `browser_record_*` tools are part of the 44/44 live-Chrome figure.

## [1.5.0] - 2026-09-23

### Added

- **More than one agent can drive the browser at once.** Two editors on two projects each got an
  MCP server, but only one of them got the browser: the second stood down and served its native
  tools with browser control off. Now each server gets a session of its own.

  The extension holds one native port per server and one session per port, and the sessions are
  kept apart by a lease: a tab one session is driving is refused to another, by name, so "busy"
  reads differently from "gone". Tabs held elsewhere are marked in `browser_tabs` rather than
  hidden -- the operator sees the whole window either way, and a listing that gave no reason for
  the refusal would read as a bug.

  Chrome enforces one debugger client per tab, which covers the DevTools half; the lease is what
  covers `chrome.tabs`, `chrome.windows`, cookies and downloads, where Chrome would happily let two
  sessions collide.

- **`browser_record_start` and `browser_record_stop` record a tab to a `.webm`.** Video only; no
  audio. Stop returns the saved path, never the bytes -- the bridge is one command, one reply, with
  hard caps on the reply, so a recording could not fit through it.

  Beside the video it writes `<name>.timeline.json`: every command that ran while recording, with
  its id, its name, its offset in milliseconds, and the DOM generation at that moment. That is what
  lets the frames be read against what drove them.

  Frames come from the DevTools protocol (`Page.startScreencast`), not `chrome.tabCapture`. Chrome
  requires the `activeTab` grant for tab capture, and that grant comes only from a user invoking the
  extension on that specific tab, so an agent-driven start could not obtain one. The only permission
  recording adds is `offscreen`, for a hidden page to run the encoder in -- `MediaRecorder` needs a
  DOM and the service worker has none. `debugger` was already held and is strictly more powerful.

  Two refusals rather than silent substitutions: a second start for a session is refused instead of
  replacing the first, and changing tabs is refused while recording instead of ending it. A session
  that ends mid-recording discards the encoder and the partial bytes rather than writing a truncated
  file that would read as a finished one.

### Changed

- Rendezvous records are named for the process that published them
  (`browser_bridge-<pid>.json`), so several servers can advertise at once. Records left by servers
  that have exited are swept when a server starts, which a single shared record never needed because
  it was simply overwritten.

- The relay is told which server to attach to instead of computing one path. It offers the published
  servers to the extension and connects to the one it names; a server the extension asked for that is
  no longer published yields no connection rather than a substitute.

- The full profile advertises 49 tools; the read-only profile still advertises 12. Recording is
  absent from read-only.

- The bridge's Windows and POSIX halves no longer keep byte-identical copies of the same code. The
  relay's stdio, frame decode, handshake, and pump are the same everywhere and now live in one
  translation unit, leaving only connecting and watching an endpoint per platform. The pipe server's
  constructors, rendezvous publishing, and state accessors likewise. Peer credentials and process
  images -- three copies between the Linux and macOS halves of two units -- are one unit. Four
  copies of `setError` are one definition, and the frame header size is defined beside the codec
  that reads it rather than once per reader.

- `BrowserBridgePipeServer::Options::protocol` defaults to `kBrowserBridgeProtocol` instead of a
  literal `1` beside a comment claiming the two match, which is how a bumped protocol ends up
  announced on one side only.

### Fixed

- A browser-initiated detach now releases what a deliberate one does. `detachAll` cleared thirteen
  things and the `onDetach` listener cleared ten; the three it forgot were the three with no symptom
  at the moment they went wrong -- a polling handler kept driving a tab nothing was attached to, a
  User-Agent captured from a page the session no longer drove could be restored over the next one,
  and a half-delivered upload survived into the next session.

- **Two installs running at once can no longer corrupt each other.** Every step that changes what is
  installed read the tree and then acted on what it read, with nothing holding the two together. Two
  updaters would have shared one staging directory name and overwritten each other's partial
  download -- so the checksum that proved the first could have been checked against the second --
  and one could have deleted the version directory the other was about to link. An exclusive,
  cross-process lock on the install root now spans each whole check-and-change. It is an open handle
  on `<root>/.install.lock`, so the operating system releases it if the holder crashes and there is
  no stale lock to clear by hand.

  `pointCurrentAtVersion`, `pruneInstalledVersions`, and `installStagedRelease` require that lock and
  refuse to run without it, which is checked rather than assumed: a lock released early fails loudly
  instead of quietly reopening the race. A second install does not wait out the first's download; it
  reports that one is in progress.

### Removed

- The native-messaging handshake unit (`native_host.cpp`). It answered a `ping` with a `pong` and
  carried a comment promising later message types. It was compiled only into its own test, was
  absent from the shipping binary, and nothing on either side of the bridge ever sent a `ping`. The
  real framing and relay behaviour live in the bridge relay, which is tested where it runs.

- The `ancestorChainContainsImageForTesting` wrapper. It existed only because the function it called
  was file-local; that function is now declared where its callers can reach it, and the tests call
  it directly.

## [1.4.0] - 2026-09-22

### Added

- **Chrome Control MCP is a VS Code extension.** It publishes to the marketplace as four
  platform-specific packages, each carrying the build for that platform, so installing it needs no
  download afterwards and no path to configure. On activation it installs the server into the
  managed layout and registers it with the editor through the MCP server provider API. Two commands
  cover the rest: one repairs the install and its native-host registration, the other copies and
  opens the folder Chrome has to be pointed at.

  Marketplace updates and the server updating itself land in the same managed install, so they do
  not fight: whichever version is newer is the one that runs.

- `--install` puts a copy of this program into the managed layout, registers the native host, and
  prints the command path and the Chrome extension folder as one line of JSON. It is how an
  unpacked release archive becomes an install without first configuring an MCP client, and running
  it on a copy that is already installed repairs a registration another copy overwrote. `--version`
  prints the build.

- **This server can update itself, and the update no longer fights the operating system.** The
  files it would have to replace are the ones it is executing, and Windows does not allow that, so
  updating meant closing the client, replacing files by hand, and repairing whatever the new path
  broke. Three tools replace that:
  - `browser_update_status` answers where this build is installed, which versions are present, and
    what the stable link points at. No network.
  - `browser_update_check` asks GitHub which release is newest.
  - `browser_update_apply` installs it.

  Nothing locked is ever written. Each version is installed into `<root>/versions/<version>` and a
  `current` link -- a directory junction on Windows, a symbolic link on Linux and macOS -- is
  repointed at it. Repointing that link is proven to work while a server launched through it keeps
  serving, and that server exits cleanly afterwards; the new build takes effect the next time the
  client starts one.

- **An update no longer invalidates the three things that point at this program.** The MCP client's
  command, Chrome's unpacked-extension folder, and the native-messaging registration now all name a
  path under `current`, so a new version changes none of them. Previously each of those named a
  version-stamped directory, and every upgrade silently broke all three at once -- including the one
  that costs a trip through `chrome://extensions`.

- A copy running from a build tree or an unpacked download is moved into the managed layout by the
  first `browser_update_apply`, which then installs the newest release on top of it. That move is
  the only time the client's command path changes.

- Install root is `%LOCALAPPDATA%\Programs\ChromeControlMCP` on Windows, and under the per-user
  data directory on Linux and macOS. `CHROME_CONTROL_MCP_INSTALL_ROOT` overrides it. Nothing needs
  administrator rights: a junction is used rather than a symbolic link precisely because Windows
  asks for elevation or Developer Mode for the latter.

- Downloads are verified against the SHA-256 published beside them in the same release, and a
  mismatch is discarded rather than installed. That is transport integrity, not a signature --
  archive and checksum come from one origin -- and this project still ships no signing key.

### Fixed

- `browser_update_*` would have been routed to the browser bridge, because everything named
  `browser_*` was. A question about this program's own install would have answered "the extension
  is not attached", which is exactly the state someone is in when they reach for it.

### Changed

- Releases now publish a `.vsix` per platform beside the archives, and the checksums file covers
  them too.
- Release archives now carry the Qt Network runtime and the platform's Qt TLS backend, which the
  update path needs to reach the release host. The SPDX inventory is unchanged: both come from the
  qtbase source already recorded.
- The version number has one home. The server, the updater, and the packaged archive all read the
  CMake project version instead of keeping separate copies that can drift -- a stale copy in an
  updater being the one place that silently does the wrong thing.

## [1.3.1] - 2026-09-22

### Fixed

- A bridge refused because Chrome starts a DIFFERENT copy of this program now says so. Two copies
  are easy to end up with -- a build directory beside an installed one -- and Chrome starts
  whichever executable its native-messaging registration names. When that is not the copy serving
  MCP, the relay refuses the bridge, correctly, and every browser tool answered "the extension is
  not attached": true, and impossible to act on. The refusal now names the registered executable,
  names the one serving, explains that Chrome starts the registered one, and says to call
  `browser_extension_install` on the server that is running.
- The relay's own message said "not the Chrome Control MCP binary" about a process that often WAS
  that binary, just another copy of it, which sends the reader hunting for an impostor. It now
  names both images, or, when the serving process cannot be read at all, says that instead of
  claiming a mismatch it did not observe.

## [1.3.0] - 2026-09-22

### Changed

- `browser_upload` works on pages that hide their file input, which is nearly all of them. The
  real `<input type="file">` is set to display:none and a styled button, label, or menu item is
  put in front of it; a hidden element has no box and no accessibility node, so it had no ref, and
  the tool that exists to give it a file could not be aimed at it. Two halves fix that, and either
  one is enough on its own:
  - A ref may now name **the control a person would click**. The page-side search runs outward
    from it: the element itself, the input a label points at, one inside it, the input of an
    enclosing label, then the single file input of the nearest ancestor that has exactly one. A
    scope holding several is reported as ambiguous rather than guessed at, so a file is never
    attached to an input the caller did not name.
  - **The snapshot names file inputs whether or not the page shows them**, collected from the DOM
    after the accessibility pass and listed as `filechooser "name" [ref=eN] (hidden)`. They are
    kept for naming only -- they carry no box, so no coordinate path can act on one -- and the
    scan is capped like the media scan, reporting truncation rather than hiding it.

  Proved against the shape the web actually uses: the E2E fixture now hides an input behind a
  button, and the suite uploads through the button and by naming the input directly, each time
  asserting what the PAGE read back rather than what the tool reported.

## [1.2.2] - 2026-09-22

### Fixed

- The roots test in `browser_uploads.cpp` searched with a raw loop, which `cppcheck` reads as a
  `std::any_of` waiting to happen, and which failed the analysis gate on the 1.2.1 commit. It now
  says what it does: whether any configured root contains this path. No behaviour changes; 1.2.0,
  1.2.1 and 1.2.2 are the same program.

## [1.2.1] - 2026-09-22

### Fixed

- The loop that reads `browser_upload`'s paths bound a `QJsonValueConstRef` to a
  `const QJsonValue &`, converting through a temporary on every element and failing the
  `clang-tidy` gate on the 1.2.0 commit. No behaviour changes; 1.2.0 and 1.2.1 are the same
  program.

## [1.2.0] - 2026-09-22

### Added

- `browser_upload` attaches local files to a page's file input, which is the last thing a person
  still had to do by hand in a browser an assistant was otherwise driving. The page receives real
  `File` objects and runs its own `input`/`change` handlers, so a site that reads `files[0]` or
  submits the form sees exactly what the user's own picker would have given it.

  It was left out before on the grounds that it could not be done: CDP's `DOM.setFileInputFiles`
  answers "Not allowed" to an extension's debugger session. It can be done, just not that way. The
  bytes are delivered to the page and a function running IN the page builds the `File` and assigns
  it through a `DataTransfer`, which is ordinary web platform behaviour needing no privileged API.
  Files cross the bridge in pieces because Chrome carries at most 1 MiB in one message from a
  native host; the extension holds them only until the upload is applied and drops them whenever
  the session ends.

  This is the one tool that reads the user's disk. It is absent from the read-only profile, refuses
  a relative path or a path outside `CHROME_CONTROL_MCP_UPLOAD_ROOTS` when that is set, bounds a
  file at 16 MiB and a call at 8 files, and sends no path to the extension or the page --
  canonicalising first, so a symlink or a `..` cannot point inside a root and read outside it.

## [1.1.2] - 2026-09-22

### Fixed

- The comment wrapping in `browser_extension_installer.cpp` that failed the `clang-format` gate
  on the 1.1.1 commit. No behaviour changes; 1.1.1 and 1.1.2 are the same program.

## [1.1.1] - 2026-09-22

### Fixed

- `browser_screenshot` no longer hangs, and no longer takes the session down with it, when the
  tab it captures is not the one Chrome is drawing. Chrome answers `Page.captureScreenshot` only
  once the tab produces a compositor frame, and a background tab -- which is where this session
  works by design -- produces none: the capture never returned, the app waited out its whole
  transport deadline, and the reset that followed detached the extension and ended the session
  over one screenshot. A capture of a tab that is not on screen now runs with a one-pixel
  screencast that makes Chrome composite it, and every capture path is bounded well inside the
  transport deadline, so a screenshot that truly cannot be taken is one failed call on a live
  bridge. Measured on the E2E fixture in a background tab: no reply in 30 s and a dead bridge
  before, 1.3 to 1.8 s and byte-identical output after.

### Changed

- The live suites' dedicated browser runs on Windows. It refused to, because Windows keeps
  native-messaging registrations in the registry rather than per profile, and a profile-local
  install was assumed to be the only way to leave the user's own Chrome alone. It is not: the
  registration already names the executable under test, and `CHROME_CONTROL_MCP_RUNTIME_DIR` is
  what keeps each browser to its own server. The run now asserts that the user's registration
  names the executable under test and proceeds, so `display_matrix_e2e.mjs` -- every pointer tool
  across display scales, window sizes, zoom levels, and pinches -- covers Windows too.
- `browser_extension_install` says plainly, in its description and in its reply, that loading the
  unpacked extension is a one-time manual step that cannot be automated, and why. README and
  `docs/TOOLS.md` say the same. An assistant reading only the tool's own text now has what it
  needs to hand the step to the user instead of looking for a workaround that does not exist.

## [1.1.0] - 2026-09-21

### Changed

- Control stays inside the browser. Session pins its own tab instead of re-resolving "active tab
  of last focused window" on every command, so a user switching Chrome tabs or windows mid-session
  no longer redirects the assistant's next click, keystroke, or snapshot onto the user's page. A
  foreground tab opened by the session's own page is followed. `browser_tabs`, tab indices, and
  `browser_new_tab` resolve in session's window.
- The session never changes which tab the user is looking at. `browser_new_tab` opens in the
  background and `browser_select_tab` retargets the session without activating the tab, so the
  assistant works in its own tab while the user keeps reading theirs. A closed session tab is not
  replaced by a neighbour -- every neighbour is a tab the user may be using -- so the session says
  it has no tab until given one.
- The tab under control is marked in the tab strip: a pink `AI CONTROL` tab group, the same pink as
  the frame and badge drawn on the page, so the user can see which tab the assistant is working in
  without opening it. It is never collapsed, it follows the session, and a tab the user already
  grouped is left in their group.
- `browser_scroll` replies once the scroll has come to rest, with `scrolled`: how far the content
  actually moved (0 at an edge). A wheel scroll is animated, and the page was still moving when
  the reply arrived, so a screenshot taken on it could catch the page mid-flight.
- Control never takes OS focus. `browser_select_tab` no longer raises its window, `browser_window`
  `new` opens with `focused: false`, and `focus` retargets session without raising window. CDP
  focus emulation keeps focus-gated pages working while Chrome is in background. When a compositor
  focuses a new window anyway (Hyprland), reply reports `took_os_focus: true`.

### Fixed

- `browser_drag`'s `from_x`/`from_y`/`to_x`/`to_y` are screenshot pixels, converted exactly as
  `browser_click_at` converts them and bound to the same screenshot. They were dispatched as CSS
  pixels while the only place a model reads coordinates from is a screenshot, so a drag missed its
  target by the display scale, zoom, and pinch on every display but an unzoomed 100% one.
- Coordinates under a trackpad pinch. A pinch moves every pixel on screen without changing the
  scroll offset, zoom, or viewport size a screenshot was bound to, so a coordinate click after one
  landed at the unpinched position; `browser_box`'s `screenshot_center` ignored the pinch; and the
  occlusion hit test read the visual viewport's coordinates as the layout viewport's, refusing
  clicks on elements nothing covered. The render fingerprint now carries the pinch's scale and
  offset, and every conversion goes through it.
- Full-page screenshots at any browser zoom but 100%. Chrome reads the capture clip in DIPs, not
  CSS pixels: the capture came out twice the document at 50% zoom, cut the document short at 110%
  and above, and failed outright on a small window at 25%. It also cut the last device-pixel row
  off a document whose height is fractional, because Chrome's `cssContentSize` truncates.
- A full-page screenshot of a pinch-zoomed page is refused instead of resetting the user's pinch:
  capturing beyond the viewport returns the page at 1x with the pinch's offset folded into the
  scroll, and nothing can put it back.
- `browser_click` by ref no longer refuses an element whose centre alone is covered. It tries
  points around the centre, as a user clicks the part of a button they can see, and waits up to a
  second for a macOS overlay scrollbar -- which the element's own scroll into view brings up over
  the page's edge -- to fade. When no point of the element takes a click it says that, rather than
  naming `<html>`.
- An unreadable scroll offset or pinch no longer reads as zero in the render fingerprint, which
  would have moved every hit test and coordinate conversion onto the unscrolled position.
- Every wait about the page is timed by the page, not by the extension's service worker. Chrome
  coalesces a background worker's timers into seconds: measured on a tab the user was not looking
  at, a 100 ms hover dwell answered in 6.3 s, a 150 ms drag hold took 10.2 s, `browser_wait_for`
  overran its own 1.5 s timeout to 10.3 s, `browser_download` reported failure for a file that had
  downloaded (its poll slept past its deadline), and `browser_window` `new` took 10.9 s watching
  for a focus that never comes. The same page's own timers kept time to the millisecond there.
- A drag's interpolated moves are sent in order and awaited together. Chrome answers a mouse move
  at a frame and draws a background tab rarely, so awaiting each move in turn cost 8.9 s for one
  drag against 0.23 s in a foreground tab; Chrome coalesces a real mouse the same way.
- A wait about the page cannot outlive its own deadline: the evaluate that times it carries one,
  so a page that blocks its main thread fails the wait instead of holding the command open for
  ever. `browser_download` attaches before timing its poll, and a wait whose page cannot time
  anything gives up rather than spinning.
- A coordinate read off a screenshot must be inside it, and an element that could not be brought
  on screen is refused rather than clicked at a point off the viewport: both reported `ok` before.
- A hit test that named no node no longer reads as "nothing is in the way": it is refused, as the
  fail-closed rule everywhere else in that path requires.
- `browser_scroll`'s `scrolled` counts each scroller once and matches them by name, so a page whose
  root is its own scroller is no longer reported as having moved twice as far, and a scroll chain
  that changes under the pointer cannot subtract one scroller's offset from another's.
- A drag that fails halfway releases where the pointer actually got to, not at the destination.
- `browser_window` `new` attaches before watching for OS focus, so `took_os_focus` is measured
  rather than answered instantly by a page that could not be asked.
- `browser_click` re-measures the element each time it waits out a scrollbar: the page is moving
  while that scrollbar shows, and the box it first measured no longer names the element.
- The controlled tab's pink group is created one at a time and orphans are cleared, so two pins in
  quick succession or a reloaded worker can no longer leave a marked tab nobody is driving.
- A screenshot says whether the control overlay is in the image, instead of repeating the request:
  a hide that did not take left the frame and badge in a capture described as free of them.
- `browser_http_auth` `clear` surfaces a failure to stop intercepting instead of reporting a clear
  that did not happen, which would leave every request in the page paused.
- `browser_hover`'s `duration_ms` and `browser_drag`'s `steps`/`hold_ms` refuse what they cannot
  honour rather than silently becoming the default, and `browser_drag` refuses an endpoint given as
  both a ref and coordinates instead of quietly preferring one.
- `browser_box` and `browser_scroll` use Chrome's CSS viewport metrics only; the other members are
  device pixels, and reading them as CSS put the wheel outside the viewport on a scaled display.
- `browser_download` says which state a download ended in. A reply carrying only `ok: false`
  reached the model as "the browser reported failure", with the one fact that explains it dropped.
- Coordinate clicks at non-100% display scale. `browser_box` reports CSS px while
  `browser_click_at` takes screenshot px; they differ on 125%/150% desktops, Retina, and zoomed
  pages. `browser_box` now adds `screenshot_center`, and tool descriptions name each unit.
- `browser_emulate` accepts fractional `device_scale_factor` (1.25, 1.5, 1.75); integer-only
  schema refused most common Windows scales.
- `browser_window` `focus` reported failure on Wayland/macOS when activation landed after
  `windows.update` resolved; focus no longer depends on OS activation.

### Tests

- New `tests/e2e/display_matrix_e2e.mjs`: every pointer tool across 35 combinations of display
  scale (1× to 3×, including 1.25×, 1.5×, 1.75×, 2.5×), window size (390×844 to 3840×2160),
  browser zoom (every one of Chrome's steps, 25% to 500%), trackpad pinch (1.5×, 2×, 3×), and both
  a scrollbar drawn over the page and one that takes layout space. The plan states what it covers
  and the suite asserts that before a browser starts, so a step that fits nowhere is a failure
  rather than a silent gap. Nothing trusts the arithmetic
  under test: a coordinate is proven by where its click landed on the fixture, and a screenshot by
  the pixels of its solid-colour targets measured against the page's own `getBoundingClientRect`.
- New `tests/e2e/isolated_chrome.mjs` and `isolated_run.mjs`: the live suites run against a
  dedicated Chrome for Testing -- its own profile, its own bridge, headless -- so they never touch
  the user's Chrome, its tabs, its focus, or its native-messaging registration, and can run the
  browser at any display scale, window size, and zoom. `CHROME_CONTROL_MCP_RUNTIME_DIR` names the
  bridge's rendezvous directory so a server and that browser pair only with each other.
- Full E2E asserts the user's tab is still the one in front after every call, and that a scroll's
  reply matches how far an element's box actually moved.
- First live macOS certification, every call in a background tab: 43/43 tools, 151 cases, with the
  per-call timings of a tab nobody is looking at recorded in `docs/VERIFICATION.md`.
- The interference suite drives the dedicated browser through its own DevTools endpoint (a second
  process cannot hand a URL to a headless Chrome) and now also checks that the user's tab stays in
  front while the session types, scrolls, and clicks, and that the session opens no windows.
- Full E2E adds display-scale matrix (1×–3×, 360–1280 px viewports) with independent PNG-size
  check, and asserts OS focus never moves.
- New `tests/e2e/user_interference_e2e.mjs` drives user tab/window changes from outside Chrome on
  Linux, macOS, and Windows and requires session to stay on its own tab.
- First live Linux certification (Hyprland/Wayland, 150% scale).

## [1.0.1] - 2026-09-16

### Fixed

- Browser bridge heals a lost rendezvous record without a restart. The stand-down
  below closed the case where the transient instance started _after_ the
  persistent server, but not the race where both start within the same instant:
  each passed the live-owner check before either had written the record, the
  transient one wrote last and — naming its own pid — removed the record on exit,
  and the persistent server was left listening on a pipe nothing could find, with
  no retry, for the life of the session. `BrowserBridgePipeServer::ensurePublished`
  now re-publishes the record when it is missing or names a server that has
  exited, and refuses when another live server of the same image owns it;
  `BrowserControl::invoke` retries the bridge start when the server stood down
  at launch and calls `ensurePublished` before each browser tool call while no
  relay is connected; the browser tools stay listed when the bridge could not
  start, and each call reports the reason (including the owning pid). The
  extension re-arms the native bridge from a 30-second `chrome.alarms` alarm so a
  service worker Chrome has retired still reconnects once a server publishes its
  record (`alarms` permission added). Three pipe-server tests cover the lost
  record, a record left by an exited server, and a server that is not running.
- Browser bridge no longer orphaned by a concurrent short-lived server. The
  rendezvous record lives at a fixed path while the pipe/socket name is
  per-process random, so a second, transient invocation (`mcp list`/`get`, a
  health probe, or any non-relay process) used to overwrite that record and, on
  exit, delete it — leaving the persistent server's pipe alive but undiscoverable
  and the extension reporting "not attached." A late instance now stands down
  (serving native tools with browser control off) when a live server of the same
  image already owns the bridge, and `stop()` only removes the rendezvous record
  when it still advertises the exiting process. Windows and POSIX backends both
  covered, with pipe-server unit tests.

## [1.0.0] - 2026-08-20

### Added

- Initial standalone MIT-licensed Chrome Control MCP release.
- 43 MCP tools, unpacked MV3 extension, visible control presence, and full live Chrome E2E coverage.
- Linux and macOS Unix-domain bridge backends with owner-only runtime state and peer credentials.
- Cross-platform Chrome native-host manifest lifecycle.
- Windows, Linux, and macOS build/test matrix.
- Unsigned Windows x64, Linux x64, macOS ARM64, and macOS x64 release archives with checksums.
- Separate AddressSanitizer + UndefinedBehaviorSanitizer and ThreadSanitizer gates.
- Cross-platform Node build, MCP smoke, and extension lifecycle commands.
- Modern README with verified overlay screenshots and UI Test Automation Playground credit.

### Changed

- Native API and documentation now use platform-neutral names.
- C++ warnings are errors under MSVC, GCC, and Clang.
- MCP/relay logs use standalone project identity.
- Quality gates now include strict lint, static analysis, full-history secret scanning, and locked
  dependency audit.

### Removed

- Unused JSON-RPC client payload helpers and obsolete test-only native-host loop.
- Redundant quality branch; development and delivery now happen directly on `main`.
