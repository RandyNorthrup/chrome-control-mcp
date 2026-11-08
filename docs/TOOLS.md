# Tool catalog

The full profile advertises 54 tools: 48 browser tools, which reach Chrome through the extension,
and 6 native tools the server answers itself -- 3 to set up the extension's native-messaging host and
3 to update the server. The [read-only profile](#read-only-profile) advertises 15.

Every tool advertises strict JSON Schema with `additionalProperties: false`. Exact descriptions,
argument types, enums, bounds, and defaults come from live `tools/list`; this page explains how the
tools fit together rather than duplicating a large schema that could drift from source.

## Sharing the browser: tabs, agents, and `tab_id`

One server serves one MCP client, and several agents can share that client: sub-agents, parallel
tasks. The server cannot tell them apart. A call that names no tab acts on the session's _current
tab_, which every agent on the server shares, so an agent that leans on it is one other agent's
`browser_new_tab` away from acting on the wrong page. The initialize result's standard MCP
`instructions` tell every client this, and the tools are built around it:

- **`tab_id` on every tab-scoped tool.** Each tool whose command acts on one tab takes an optional
  positive integer `tab_id`; omitted, the call uses the session's current tab. An agent opens its
  own tab with `browser_new_tab` -- the reply carries its `tab_id` -- and passes it on every call.
  Naming a tab does not make it current, so it never moves another agent. The set of tools that take
  it is generated from the command list, not written into each schema, and a test pins it.
  `browser_select_tab` takes exactly one of `tab_id` or `index`; `browser_close_tab` takes either or
  neither (neither closes the session's current tab). Both reply with the `tab_id` they acted on.
- **`browser_new_tab` opens in the background.** With no `url` it opens `about:blank` rather than
  Chrome's new-tab page, which the debugger cannot attach to.
- **Refs are bound to their tab.** A ref acts on the tab its snapshot came from, whatever tab is
  current; the snapshot text carries a `tab_id:` line after the title. A call whose own `tab_id`
  names a different tab than its ref is refused naming both, and a `browser_drag` whose `ref` and
  `to_ref` came from two tabs is refused. Staleness is per tab: one agent's page navigating leaves
  every other tab's refs live.
- **Ref names are never reused.** New elements are numbered above every ref the server has issued,
  on any tab, for its whole life. A ref from before a navigation, a reconnect, or a closed tab
  answers "Unknown element ref" instead of silently naming whatever took its number.
- **A tab another session holds is refused**, naming that session. `browser_tabs` lists every tab in
  the session's window and marks which are the session's (`held`, `current`, `agent`,
  `opened_by_session`) and which another session holds (`controlled_by_other_session`); its
  `your_tabs` lists every tab the session holds, in any window.
- **`agent` on `browser_new_tab` and `browser_select_tab`.** A short name for the agent doing the
  work: 1-24 printable characters after trimming; anything else is refused, not cleaned up. Tabs
  with the same name share one tab group (one per window), titled `AI · <name>`, so the user can
  tell agents apart; tabs a page opens from them join the same group. Omitted, the tab joins the
  session's shared group. Any script works: `café` and `研究` are titled as given (before 1.8.1 the
  extension kept only ASCII, so `café` became `caf` and a name with no ASCII joined the shared
  group).
- **What a command caused is in its reply.** A tab the command's page opened is listed in
  `opened_tabs` (with its `tab_id`, its URL, and whether it became current), and a file picker the
  page asked for in `file_chooser`. See [MULTI_SESSION.md](MULTI_SESSION.md#popups) for how a popup
  is told apart from a tab the user opened.
- **`browser_release` when the task is done.** Tabs the session opened are closed; tabs it borrowed
  from the user are handed back, never closed; the tab group and highlight are removed. The tab the
  user is looking at and the browser's last tab are never closed. `tab_id` releases the agent's own
  tabs and no one else's -- that tab, every tab opened from it (popups, links that open a new tab),
  and, for an agent that gave itself a name, every tab under that name -- which is what an agent
  sharing the server should do. (Before 1.8.2 it released that one tab only, and an agent's popups
  stayed open behind it.) `keep_open: true` hands the tabs it opened to the user instead of closing
  them. The reply lists what was `closed`, `handed_back`, and `kept_open`; a tab Chrome would not
  close (it refuses while the user drags a tab) is retried, and one still open after that is handed
  back and listed in `not_closed`, never reported as closed.

An agent that never calls `browser_release` is still cleaned up: when its server exits its tabs are
released the same way, and after ten minutes without a command its tabs are stood down -- left open
and held, but with the debugger detached and the group greyed -- until its next command.
[MULTI_SESSION.md](MULTI_SESSION.md#letting-go) has the full table.

Each group is titled with the agent's name when one was given, otherwise with the MCP client's
`clientInfo.name` from `initialize` (`AI · <client>`), otherwise `AI CONTROL`. The client name is
sent on every command frame, with control and format characters dropped and cut to at most 32
characters. Each group gets a
colour no other live group has; the first is pink. The frame and badge drawn on the page and the
toolbar badge use the same colour and name, so a page can be matched to its agent at a glance.

### Chrome profiles

One server serves every Chrome profile the extension is loaded in -- up to eight, one connection
each -- and every call goes to one of them, or to all:

| Call                                                     | Goes to                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| a call naming a `tab_id`, or a `ref`                     | the profile holding that tab; one never seen is looked for in each |
| `browser_new_tab`, `browser_window` with `action: "new"` | `profile` if given, else the profile whose window was last focused |
| `browser_window` focus or close with `window_id`         | the profile holding that window                                    |
| `browser_cookies`, `browser_permission`                  | `profile` if given, else the current profile                       |
| `browser_tabs`, `browser_windows`                        | every profile, merged, each entry naming its `profile`             |
| `browser_release` without `tab_id`                       | every profile                                                      |
| anything else naming no tab                              | the current profile: the one the last routed call went to          |

`profile` is a profile's name or its account email, without regard to case; one that matches no
connected profile is refused with the names that are. With one profile connected, every call goes to
it and nothing changes. A profile is called by the name given on the extension's options page, else
its signed-in account's email, else a generated name that stays the same. When no window has ever
had focus the oldest connection counts as last focused, and a profile whose extension is older than
1.10.0 is called `unnamed` and never counts as focused. Index-addressed calls (`browser_close_tab`
by `index`, `browser_group_tabs`) act in the current profile, whose listing the indices
come from -- prefer `tab_id`.

## Navigation and capture

- `browser_navigate`
- `browser_snapshot`
- `browser_find`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_read`
- `browser_screenshot`

### Screenshots: a view for the agent, a presentation for people

A model is billed for an image by its pixels, and Claude shrinks any image whose long edge passes
1,568 px to that size before it reads it. So by default `browser_screenshot` returns a **view**: one
image pixel per CSS pixel, long edge at most 1,568 -- the detail a model can use. A 1440×900
viewport on a 2x Retina panel comes back as 1440×900 (about 1,700 image tokens), not as 2880×1800,
four times the bytes to send for detail that is shrunk away before the model sees it. A full-page
view keeps one pixel per CSS pixel, both edges within 8,000 px.

- **Zoom for detail.** `ref` crops the screenshot to that element; `x`, `y`, `width` and `height`
  crop it to a region given in view pixels. A zoom is shown at up to the device's own pixels
  (long edge still at most 1,568), and its reply says which part of the view it shows and at what
  magnification. A zoom never moves the page: an element off screen is refused, not scrolled to.
- **`purpose: "presentation"`** is for people: the device's own pixels, lossless, saved as a PNG
  beside `browser_print`'s PDFs. The reply is the file's path, size and dimensions -- the image never
  enters the model's context. The read-only security profile refuses it, since it writes a file.
- `browser_click_at`, `browser_hover` and `browser_drag` read coordinates off the last view, and
  `browser_box`'s `screenshot_center` is in view pixels too. A zoom or a presentation does not
  replace the view those coordinates belong to. See
  [Coordinates, display scale, zoom, and pinch](#coordinates-display-scale-zoom-and-pinch).
- A full-page capture of a document past Chrome's 16,384-pixel raster limit holds only its top-left
  slice. The reply says so, with the document's size and the slice's, in the view's text and in a
  presentation's reply alike.

Files go to `ChromeControlMCP` in the user's Downloads folder, or to the folder named by the
`CHROME_CONTROL_MCP_OUTPUT_DIR` environment variable when it is set.

`browser_screenshot` hides the control frame, badge, and agent cursor by default so they do not
obscure model-facing captures. Set `include_control_overlay: true` for user-facing documentation
that should show the exact control presence visible in Chrome.

`browser_navigate` and `browser_new_tab` open `http` and `https` URLs only; a bare host such as
`example.com` is read as `https://example.com`. `javascript:`, `data:` and `file:` URLs are refused,
so an agent cannot make a page out of its own text or open the user's files in a tab.

### Finding an element without reading the whole page

An element's ref comes from the page's outline. `browser_snapshot` gives the whole outline;
`browser_find` gives only the lines that match, in the same format and with the same refs, so the
usual step -- find the button, then click it -- costs a few hundred bytes instead of the page.
Measured on public pages: a whole snapshot of Wikipedia's "Web browser" article is 38 KB, a find
1.3 KB.

- **`browser_find`** takes `text` (words in an element's name or value, any case), `query` (the
  same as a phrase, where a role word such as "button", "link", "field", "checkbox", "tab", "menu"
  or "heading" becomes a role filter: `"Send message button"`), or `regex`; optionally `role` and
  `max_results` (1 to 20, default 10). Matches rank exact name first, then a name that starts with
  the words, a whole word, the words anywhere, and for a phrase how many of its words a name has;
  elements with refs and elements on screen come first among equals. Each result is followed by
  the dialog, landmark or article it sits in, and `off-screen` when it is. With no match, the reply
  names the three closest names on the page. Matching is code, not a model: the same query on the
  same page always gives the same answer.
- A find takes the same capture as a snapshot and installs its refs the same way, so the two are
  interchangeable for every later call: a ref from either acts on any element tool, belongs to its
  tab, and is refused after the page navigates.
- **`browser_snapshot`** takes `ref` (one element's subtree: a dialog, form, region or list --
  landmarks, dialogs, forms, tables, lists and articles carry refs for this), `depth` (levels below
  the root), `filter` (`"interactive"`: elements with refs, plus headings; `"viewport"`: what is on
  screen, with a count of the rest) and `max_chars`. Over `max_chars`, the outline is not cut at
  its end: everything on screen and every landmark and heading line stays, and the largest regions
  holding none of that collapse to one line each, naming the ref that reads them. With no options a
  snapshot is the whole outline, as before, up to its 2,000-element capture.
- Every outline leaves out repetition: a text line that repeats its parent's name (a link's own
  label, Chrome's inline text runs), wrappers that hold a single line, and indentation for nesting
  that is not shown. The line format -- `- role "name" [ref=eN] (flags)` -- is unchanged.
- **`browser_read`** returns 30,000 characters at a time by default (`max_chars` up to 200,000);
  a longer page's reply carries `next_offset`, which `offset` takes to continue, and `total`.
  `ref` or `selector` reads one element; `mode: "main"` reads the page's main content. The reply
  stays the JSON it has always been.
- An extension older than 1.12.0 does not say where elements are: `filter: "viewport"`, and read's
  `ref`, `selector` and `mode`, then say to reload the extension at chrome://extensions. Find,
  the other options and paging work with it.

## Input and page interaction

- `browser_click`
- `browser_type`
- `browser_press_key`
- `browser_scroll`
- `browser_dialog`
- `browser_click_at`
- `browser_hover`
- `browser_drag`
- `browser_select`
- `browser_set_value`
- `browser_upload`
- `browser_clipboard`
- `browser_media`
- `browser_js_click`

### Clipboards

Every agent has a clipboard of its own, and nothing an agent does reaches the system clipboard --
the one the user and every other program share. Chrome has no clipboard per tab or per extension,
so the extension keeps one per agent: per session (MCP server) and agent name, exactly like the
agent's tab group, or the session's shared one when no name was given. It lives in the extension's
memory only, is never written anywhere, and is emptied when the agent lets go of its last tab, when
its server exits, and when the user pauses the bridge.

Three things use it:

- **Copy, cut and paste keys.** `browser_press_key` with Control or Meta and C, X or V (and
  Control+Insert, Shift+Insert, Shift+Delete; Control/Meta+Shift+V pastes without formatting) is
  answered from the agent's clipboard instead of being sent to Chrome as a key. The reply carries
  what happened under `clipboard`.
- **`browser_clipboard`.** `write` puts `text`, `html` and/or files (`paths`, absolute, read by the
  server exactly as for `browser_upload`) on it; `read` returns it; `clear` empties it; `copy` and
  `cut` take the selection, or with a `ref` that element's contents; `paste` pastes into the focused
  element, or into the `ref`, with `plain: true` for text only. Text and HTML may be at most 512 KiB
  together in one write (Chrome accepts at most 1 MiB in one message from the server); larger text
  goes in a file.
- **The page's own copy and paste buttons.** In a tab an agent holds, `navigator.clipboard` and
  `document.execCommand('copy' | 'cut')` use that agent's clipboard. A page may use it only while
  one of the agent's own input commands on that tab is running and for 2 s after -- the moment a
  person's click would give it -- and is refused outside it, as a page without clipboard permission
  is. A reply says when the page wrote or read the agent's clipboard (`page_clipboard`). When the
  tab is handed back the page gets the browser's own functions again.

A copy is what a real copy is: the page's `copy` event runs first, and data a page puts there (a
"read more" footer, rich formats) is what is copied; otherwise the selection is, as text and HTML.
Nothing selected leaves the clipboard as it was, and a password field gives nothing. A paste is what
a real paste is: a `paste` event carrying `text/plain`, `text/html` and `File`s -- where nearly every
editor and every "paste an image anywhere" page reads one -- then, for an editable region whose page
did not take it, a `beforeinput` of type `insertFromPaste` with the same data. If the page took
neither, the text is typed in: whole into a text field, line by line with Shift+Enter elsewhere (a
plain Enter sends a message in every chat box). HTML only ever reaches the page's own paste handler,
which sanitizes it as it would a real paste. The reply's `taken_by` says which happened.

Limits: inside a frame from another site, copy is not available and a paste is typed as text. A shell
command an agent runs outside the browser (`Set-Clipboard`, `pbcopy`) still uses the system
clipboard; the MCP instructions steer agents to `browser_clipboard` instead. On Linux, selecting
text still sets the primary selection, as every selection in Chrome does. A clipboard does not
survive the extension's service worker restarting.

### Uploads

`browser_upload` gives a page local files as the user's own picker would: the page receives real
`File` objects and runs its own handlers. It can reach the page three ways:

- **A picker the page opened.** While one of the agent's input or navigation commands is running,
  and for 2 s after, a file picker the page opens on that tab is caught instead of shown -- an
  `<input type="file">` and `showOpenFilePicker` alike -- and the command's reply says so in
  `file_chooser`. `browser_upload` with `paths` and no `ref` then fills it. This is the only way to
  reach an input a script creates and clicks without adding it to the document, which no ref could
  name. A `showOpenFilePicker` answer is a read-only file handle.
- **A ref to the input, or to the control that opens it.** Nearly every page hides the real
  `<input type="file">` behind a styled button, label, or menu item, so either may be named. Hidden
  inputs are listed in the snapshot as `filechooser "name" [ref=eN] (hidden)`. A control with several
  file inputs in scope is refused rather than guessed at. The input gets the files and its `input`
  and `change` events.
- **A ref to a drop zone.** An element with no file input near it gets the files as a drag and drop.
  If it does not accept the drag, the call fails rather than report an upload nobody saw.

The reply lists the `files` delivered (name, size and type) and how: `delivered_by` is `input`,
`drop` or `picker`. `page_cleared_input: true` means the page's own handler took the files and
emptied its input, as many upload widgets do; the files were delivered, and an empty input afterwards
is not a failed upload.

A file can be up to 2 GiB, or what `CHROME_CONTROL_MCP_UPLOAD_MAX_MB` sets (whole MiB, 1 to 8192); a
larger one is refused before any of it is sent, saying so. Since 1.11.0 a file goes to the page a
piece at a time, straight from the disk into the page that will use it, so neither this server nor
the extension holds it whole. Delivery runs at the pace of Chrome's extension debugger channel --
measured at 2 to 6 MB/s -- so a 390 MB video takes one to three minutes, and the call holds this
server meanwhile, as every call does; a client that times calls out sooner than that needs a longer
timeout for large files. If the page navigates
or the tab is let go while a file is arriving, nothing is assigned and the reply says why. An
extension older than 1.11.0 carries at most 16 MiB a file, and a larger file is refused with a note
to reload it; files put on a clipboard (`browser_clipboard`) are held whole and stay at 16 MiB.

More than one file needs an input or picker that takes several. Folder pickers are not supported
yet: a page asking for a folder is told so and nothing is assigned. Outside the command window above
nothing is caught, so the user's own clicks on an upload button open the ordinary dialog, even in a
tab the assistant holds. The window exists because Chrome cancels a file dialog in a tab that is not
the active tab of its window and shows one over the user's work when it is (measured on Chrome
153). See [`SECURITY.md`](SECURITY.md#uploads) for the limits and `CHROME_CONTROL_MCP_UPLOAD_ROOTS`.

### Controls the page wires up itself

A real page builds most of its controls out of plain elements: a `<div>` with a click handler, a
card that is clickable because it is styled `cursor: pointer`. None of that reaches the
accessibility tree -- those arrive as `generic` with no name and nothing saying they can be acted
on -- so a snapshot built from roles alone shows the model scenery where the page has a button.

The capture reads three signals out of the DOM snapshot it already takes, and an element that has a
box and matches one of them earns a ref with the reason attached:

| Flag          | What it means                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `(clickable)` | Chrome's own `isClickable`: a click handler, whether inline or added with `addEventListener`    |
| `(hoverable)` | the element carries a pointer handler attribute (`onmouseenter`, `onpointerdown`, and the rest) |
| `(pointer)`   | its computed cursor is `pointer` and its parent's is not                                        |

`cursor` is an inherited property, which is why the parent is part of the last rule: a card and
everything drawn inside it all compute `pointer`, and the ref belongs on the card. An element laid
out to nothing gets no ref however it is wired -- there is nothing to aim at.

These flags are descriptive. A ref is a ref: `browser_click`, `browser_hover` and the rest take
them exactly as they take a button's.

## Tabs and windows

- `browser_tabs`
- `browser_select_tab`
- `browser_new_tab`
- `browser_close_tab`
- `browser_group_tabs`
- `browser_ungroup_tabs`
- `browser_windows`
- `browser_window`
- `browser_release`

## Inspection and synchronization

- `browser_wait_for`
- `browser_get_value`
- `browser_get_attribute`
- `browser_box`
- `browser_focus`
- `browser_reveal`
- `browser_console`
- `browser_network`

### What the page said, and what it fetched

`browser_console` reports the page's own console messages, its uncaught exceptions and unhandled
rejections, and what the browser said about the page -- a blocked mixed-content load, a CSP
violation, a subresource that failed. That last group never reaches the page's console API, so
without it a page that simply does not work gives no reason why.

Read it when an action appeared to do nothing. A click that changed nothing usually threw, and
until this existed nothing in the toolset could see that.

`browser_network` reports the requests the page made since the session attached to that tab: method,
URL, resource type, status, MIME type, and the milliseconds until the response arrived. A request
that never got a response carries the browser's error text instead of a status, because a transport
failure has no status and reporting `0` would read as a server answering `0`. `failed_only: true`
narrows to failures and `4xx`/`5xx`.

A redirect is two hops under one request id, and both are logged: the hop that redirected carries
its own status (302) and `redirected_to`, and the request it landed on is its own entry. Without
that, a form POST that redirects appeared only as the GET which followed -- the opposite of what
the tool is for.

An entry is written when the response arrives, not when the body finishes loading. That is
deliberate, and both reasons were measured: the document's own request completes the navigation it
caused, and the navigation drops anything still awaiting a response -- so waiting for the body lost
the single most useful entry in the log every time. And a `fetch()` whose body is never read never
finishes loading at all, so it would sit in flight for the life of the session. `ms` is therefore
what the server took, not what the body cost to stream.

Both are per-tab rings with a hard cap, because every field in them is written by the site. Each
reply says what it left out in two different senses, and they mean different things:

- `omitted` -- entries this reply did not carry, because `limit` was smaller than the buffer.
- `dropped` -- entries the buffer itself discarded to stay bounded.

An empty list with `dropped: 0` is silence. An empty list with `dropped` above zero is lost
history. `browser_network` also reports `in_flight`, so an empty list is not mistaken for a page
that asked for nothing when it is still waiting.

### Why there is no JavaScript evaluation tool

An arbitrary-JavaScript tool would void most of the defenses in [`SECURITY.md`](SECURITY.md) in a
single call: it reads and writes storage outside the isolated world that verifies the live origin,
it redefines `window.confirm` past the dialog policy, it clicks without any of the freshness gating
that `[ref]` and coordinate actions require, `browser_navigate` refuses `javascript:` URLs and this
would be the same thing through another door, and it can delete the control frame and badge that
are the user's only on-page signal that a session is driving the tab.

It also cannot be made safe by narrowing it: there is no read-only `Runtime.evaluate`, so a
"read-only eval" would be a promise the code could not keep. `browser_console` and
`browser_network` answer what evaluation is usually reached for. `browser_js_click` remains the
one narrow escape hatch, for an element that will not take a real click.

## Browser state and advanced operations

- `browser_emulate`
- `browser_print`
- `browser_permission`
- `browser_storage`
- `browser_cookies`
- `browser_download`
- `browser_record_start`
- `browser_record_stop`
- `browser_http_auth`

## Recording

`browser_record_start` records one tab -- the one `tab_id` names, or the session's current tab -- to
a `.webm`; `browser_record_stop` ends it and returns where it was saved. Video only -- no audio is
captured.

The video keeps the viewport's own shape. `resolution: "standard"` (the default) fits it within
1280×800; `"full"` records the device's own pixels, at a higher JPEG quality per frame. The reply
gives the frame size chosen. If the page changes shape mid-recording, later frames are fitted into
the first frame's size on black rather than stretched.

The video never comes back through a tool reply. The bridge is one command, one reply, with hard
caps on the reply (16 MiB for a screenshot, 8 MiB for text), so a recording of any length could not
fit. Stop returns a path, the way `browser_download` does.

Beside the video it writes `<name>.timeline.json`: every command that ran while recording, with its
id, its name, its offset in milliseconds, and the DOM generation at that moment. That is the
machine-readable half -- what drove the page, lined up against the frames that show it.

Two rules, both refusals rather than silent substitutions:

- **A second start for a session is refused.** Restarting would discard the first recording with no
  way to tell it had happened.
- **Changing the current tab is refused while recording.** A recording follows one tab, and ending
  it because the operator changed tabs would lose the video to an action they could have done in the
  other order. `browser_select_tab`, `browser_new_tab`, and `browser_window new`/`focus` all refuse;
  `browser_window close` does not, because it does not retarget the session. Calls that name another
  held tab with `tab_id` still work, and do not move the recording.

If the recorded tab's debugger attachment ends -- the tab closes or is released, the user takes it
back, DevTools opens, the relay drops -- or the session ends, the recording is **discarded**, not
finalized. The frames stop arriving and the encoded bytes cover only part of what was asked for, so
writing them out would hand back a file that looks complete and is not. A session that is recording
is never stood down for idleness.

Frames come from the DevTools protocol, not `chrome.tabCapture`; see
[SECURITY.md](SECURITY.md#recording-is-not-an-escalation) for why, and for what the `offscreen`
permission does and does not grant.

## Coordinates, display scale, zoom, and pinch

A screenshot is the visual viewport -- the part of the page on screen -- and its origin is the
visual viewport's. Chrome captures it in device pixels: one CSS pixel spans
`devicePixelRatio × pinch scale` of them, where `devicePixelRatio` is the display's scale (a Windows
125% setting, a Retina panel, a Linux fractional scale) times the browser's zoom. A presentation is
that capture untouched; a view shrinks it to one image pixel per CSS pixel (so a pinch still
magnifies it), and further if its long edge would pass 1,568.

- `browser_click_at`, `browser_hover`'s `x`/`y` and `browser_drag`'s `from_x`/`from_y`/`to_x`/`to_y`
  are pixels of the most recent view screenshot of that tab, and may be fractions: a wide viewport's
  view is smaller than its CSS pixels, and a zoom shows detail between view pixels. They are bound
  to that image: if the page scrolls, zooms, pinches, resizes, reloads, or navigates in between, the
  call is refused rather than converted against a render the pixel no longer names.
- `browser_box` reports the element's CSS geometry and `screenshot_center`, the same point in view
  pixels to a tenth -- ready for `browser_click_at` at any scale, zoom, or pinch.
- `browser_click` by `[ref]` aims at the centre of the element's box, and when something covers the
  centre it tries points around it, as a user clicks the part of a button they can see. A macOS
  overlay scrollbar, which shows over the page's edge while the page scrolls, is given up to a
  second to fade. If no point of the element takes a click, the call is refused and says so.
- `browser_scroll` replies once the scroll has come to rest, with `scrolled`, how far the content
  actually moved -- a wheel scroll is animated and is still moving when the event is acknowledged.
  A scroll that moved nothing is reported with the two things that tell its causes apart: `hit`,
  the element the wheel landed on, and `room`, how far the scrollers under that point could still
  travel that way when it was dispatched. `scrolled` 0 with `room` 0 is an edge already reached;
  `scrolled` 0 with room left means the wheel never reached the scroller, which is a fault worth
  reporting rather than an answer.
- `browser_screenshot` with `full_page: true` captures the whole document, rounded up to Chrome's
  whole-DIP clip. On a pinch-zoomed page it is refused: capturing beyond the viewport resets the
  pinch and moves the page, and nothing can put the pinch's offset back.

An operating-system screen magnifier (macOS Zoom, Windows Magnifier) does not affect any of this:
it magnifies the composited screen, while every coordinate here is a page coordinate, captured from
the page's own compositor and dispatched back to it.

## Extension preparation

- `browser_extension_install`
- `browser_extension_uninstall`
- `browser_extension_status`

`browser_extension_install` registers the per-user native messaging host -- for both builds of the
extension, the unpacked one and the Chrome Web Store one -- and returns the folder to load unpacked
from `chrome://extensions`. Adding the extension is a one-time manual step for the person at the
keyboard, and no tool here can do it: branded Chrome 137 and later ignore `--load-extension`, and an
install from the [Chrome Web Store](https://chromewebstore.google.com/detail/mbkacllnbffbadcajpkkpelifdkfgcbd) is the user's own click too. An assistant should
report the folder and the clicks, or the store listing, rather than search for a way around it. `browser_extension_uninstall` removes that host
registration; Chrome extension removal remains manual. No private key or packaged extension is
used.

`browser_extension_status` reports what is on disk -- the folder, the native-host registration, the
pinned ID (`extension_id`) and the Chrome Web Store build's (`store_extension_id`) -- and, under `running`, what Chrome is actually running beside this server: `connected`,
`connections` (how many times a browser has attached), `server_version`, `extension_version` and
`installed_version` (null when not said: older than 1.9.0), and `notice`, the same advice the first
reply on a connection carries, empty when everything agrees -- all of the newest connection -- and
`profiles`, one entry per connected Chrome profile with its `name`, `email` (null when not signed
in), versions and `notice`.

`browser_extension_uninstall` reports whether it actually removed anything. Removing a registration
that was never there succeeds at the system-call level on both platforms -- a missing key and a
missing file are not errors -- so a reply of "Browser extension bridge unregistered" means a
registration was found and removed, and "Nothing to unregister" means the machine was already in
that state and nothing was changed.

## Updating this server

- `browser_update_status`
- `browser_update_check`
- `browser_update_apply`

`browser_update_status` answers where this build is installed and needs no network.
`browser_update_check` asks GitHub which release is newest. `browser_update_apply` installs it.

A running executable cannot be overwritten on Windows, so the update never tries. Each version is
installed into `<root>/versions/<version>` and a `current` link -- a directory junction on Windows,
a symbolic link elsewhere -- is repointed at it. Nothing the operating system has locked is
touched, and the link can be repointed while a server launched through it keeps serving.

Everything outside this program names a path under `current`: the MCP client's command, Chrome's
unpacked-extension folder, and the native-messaging registration. None of them changes when a new
version is installed.

A copy running from a build tree or an unpacked download cannot update in place, because the file
that would have to be replaced is the one executing. `browser_update_apply` moves such a copy into
the managed layout first and then installs the newest release on top of it. That move is the only
time the client's command path changes. `chrome_control_mcp --install` makes the same move from a
shell, without an MCP client. Neither ever moves `current` back: a build older than the version
already current leaves that version in place and says so, which is what keeps an editor that
installs its bundled build on every start from rolling an update back.

A new build takes effect when the MCP client next starts the server, so restart it. Chrome does not
reload an unpacked extension when its files change. From 1.9.0 on the extension reloads itself for
a newer installed copy, once no agent holds a tab and none has used it for 10 s; an extension older
than 1.9.0 cannot, so for that one update reload it at `chrome://extensions` (or restart Chrome).
Whenever the running extension, the installed copy and the server disagree, the first browser reply
on that connection carries one more text block saying which is behind and what to do, in any MCP
client, and a command an older extension does not know says the same. The extension and the server
must also speak the same bridge protocol: when a server speaks a newer one than the loaded
extension, the extension reloads itself once; otherwise every command is refused with a message
saying which side to update.

Install root, unless `CHROME_CONTROL_MCP_INSTALL_ROOT` names another:

| Platform | Root                                                 |
| -------- | ---------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\Programs\ChromeControlMCP`           |
| Linux    | `~/.local/share/ChromeControlMCP/app`                |
| macOS    | `~/Library/Application Support/ChromeControlMCP/app` |

The downloaded archive is checked against the SHA-256 published beside it in the same release. That
catches a truncated or corrupted download. It is not a signature: checksum and archive come from the
same origin over the same transport, and this project ships no signing key.

Unpacking uses the system `tar`, which reads both the zip shipped for Windows and the gzipped tar
shipped elsewhere. Windows 10 1803 and later include one.

## Read-only profile

`CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only` advertises 15 tools, 12 browser and 3 native:

- `browser_box`
- `browser_console`
- `browser_extension_status`
- `browser_find`
- `browser_get_attribute`
- `browser_get_value`
- `browser_network`
- `browser_read`
- `browser_screenshot`
- `browser_snapshot`
- `browser_tabs`
- `browser_update_check`
- `browser_update_status`
- `browser_wait_for`
- `browser_windows`

`browser_focus`, `browser_hover` and `browser_reveal` are absent because they change what the page
shows -- focus, hover state, scroll position. `browser_release` is absent because it closes tabs.
`browser_update_apply` is absent by design: it replaces the program on disk, which is a mutation
whatever the browser profile says. `browser_screenshot` is listed, but `purpose: "presentation"` is
refused: it writes a file. A view or a zoom works as usual.

The server also refuses non-read-only calls if a client invokes hidden tool names directly.
