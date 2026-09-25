# Tool catalog

Full profile advertises 49 tools: 41 live browser tools, 2 recording tools, 3 extension lifecycle
tools, and 3
self-update tools.

## Navigation and capture

- `browser_navigate`
- `browser_snapshot`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_read`
- `browser_screenshot`

`browser_screenshot` hides the control frame, badge, and agent cursor by default so they do not
obscure model-facing captures. Set `include_control_overlay: true` for user-facing documentation
that should show the exact control presence visible in Chrome.

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
- `browser_media`
- `browser_js_click`

`browser_upload` attaches local files to a page's file input, as the user's own picker would: the
page receives real `File` objects and runs its `input`/`change` handlers. The ref may name the
input itself or the control that opens it, because nearly every page hides the real
`<input type="file">` behind a styled button, label, or menu item. Hidden inputs are listed in the
snapshot as `filechooser "name" [ref=eN] (hidden)`, so either can be named. A control with several
file inputs in scope is refused rather than guessed at. See [`SECURITY.md`](SECURITY.md) for the
limits and `CHROME_CONTROL_MCP_UPLOAD_ROOTS`.

## Tabs and windows

- `browser_tabs`
- `browser_select_tab`
- `browser_new_tab`
- `browser_close_tab`
- `browser_group_tabs`
- `browser_ungroup_tabs`
- `browser_windows`
- `browser_window`

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

`browser_network` reports the requests the page made since the session attached: method, URL,
resource type, status, MIME type, and the milliseconds until the response arrived. A request that
never got a response carries the browser's error text instead of a status, because a transport
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

Both are rings with a hard cap, because every field in them is written by the site. Each reply
says what it left out in two different senses, and they mean different things:

- `omitted` -- entries this reply did not carry, because `limit` was smaller than the buffer.
- `dropped` -- entries the buffer itself discarded to stay bounded.

An empty list with `dropped: 0` is silence. An empty list with `dropped` above zero is lost
history. `browser_network` also reports `in_flight`, so an empty list is not mistaken for a page
that asked for nothing when it is still waiting.

### Why there is no JavaScript evaluation tool

An arbitrary-JavaScript tool would void most of the defenses in `docs/SECURITY.md` in a single
call: it reads and writes storage outside the isolated world that verifies the live origin, it
redefines `window.confirm` past the dialog policy, it clicks without any of the freshness gating
that `[ref]` and coordinate actions require, `browser_navigate` refuses `javascript:` URLs and this
would be the same thing through another door, and it can delete the AI CONTROL overlay that is the
user's only signal a session is driving the tab.

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

`browser_record_start` records the session's tab to a `.webm`; `browser_record_stop` ends it and
returns where it was saved. Video only -- no audio is captured.

The video never comes back through a tool reply. The bridge is one command, one reply, with hard
caps on the reply (16 MiB for a screenshot, 8 MiB for text), so a recording of any length could not
fit. Stop returns a path, the way `browser_download` does.

Beside the video it writes `<name>.timeline.json`: every command that ran while recording, with its
id, its name, its offset in milliseconds, and the DOM generation at that moment. That is the
machine-readable half -- what drove the page, lined up against the frames that show it.

Two rules, both refusals rather than silent substitutions:

- **A second start for a session is refused.** Restarting would discard the first recording with no
  way to tell it had happened.
- **Changing tabs is refused while recording.** A recording follows one tab, and ending it because
  the operator changed tabs would lose the video to an action they could have done in the other
  order. `browser_select_tab`, `browser_new_tab`, and `browser_window new`/`focus` all refuse;
  `browser_window close` does not, because it does not retarget the session.

If the session ends while recording -- the bridge drops, the tab closes, DevTools detaches -- the
recording is **discarded**, not finalized. The frames stop arriving and the encoded bytes cover only
part of what was asked for, so writing them out would hand back a file that looks complete and is
not.

Frames come from the DevTools protocol, not `chrome.tabCapture`; see
[SECURITY.md](SECURITY.md) for why, and for what the `offscreen` permission does and does not grant.

## Coordinates, display scale, zoom, and pinch

A screenshot is the visual viewport -- the part of the page on screen -- in device pixels. One CSS
pixel spans `devicePixelRatio × pinch scale` image pixels, where `devicePixelRatio` is the display's
scale (a Windows 125% setting, a Retina panel, a Linux fractional scale) times the browser's zoom,
and the image's origin is the visual viewport's.

- `browser_click_at` and `browser_drag`'s `from_x`/`from_y`/`to_x`/`to_y` are pixels of the most
  recent viewport screenshot. They are bound to that image: if the page scrolls, zooms, pinches,
  resizes, reloads, or navigates in between, the call is refused rather than converted against a
  render the pixel no longer names.
- `browser_box` reports the element's CSS geometry and `screenshot_center`, the same point in
  screenshot pixels -- ready for `browser_click_at` at any scale, zoom, or pinch.
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

`browser_extension_install` registers the per-user native messaging host and returns the folder to
load unpacked from `chrome://extensions`. Loading it is a one-time manual step for the person at
the keyboard, and no tool here can do it: branded Chrome 137 and later ignore `--load-extension`,
and policy installation requires a Web Store listing. An assistant should report the folder and the
clicks rather than search for a way around it. `browser_extension_uninstall` removes that host
registration; Chrome extension removal remains manual. No private key or packaged extension is
used.

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
time the client's command path changes.

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

Every tool advertises strict JSON Schema with `additionalProperties: false`. Exact descriptions,
argument types, enums, bounds, and defaults come from live `tools/list`; this avoids duplicating a
large schema that could drift from source.

## Read-only profile

`CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only` advertises only:

- `browser_box`
- `browser_console`
- `browser_extension_status`
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

`browser_update_apply` is absent by design: it replaces the program on disk, which is a mutation
whatever the browser profile says.

Server also refuses non-read-only calls if a client invokes hidden tool names directly.
