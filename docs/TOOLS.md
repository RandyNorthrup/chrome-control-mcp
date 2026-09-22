# Tool catalog

Full profile advertises 44 tools: 41 live browser tools and 3 extension lifecycle tools.

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

## Browser state and advanced operations

- `browser_emulate`
- `browser_print`
- `browser_permission`
- `browser_storage`
- `browser_cookies`
- `browser_download`
- `browser_http_auth`

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
  actually moved (0 at an edge) -- a wheel scroll is animated and is still moving when the event is
  acknowledged.
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

Every tool advertises strict JSON Schema with `additionalProperties: false`. Exact descriptions,
argument types, enums, bounds, and defaults come from live `tools/list`; this avoids duplicating a
large schema that could drift from source.

## Read-only profile

`CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only` advertises only:

- `browser_box`
- `browser_extension_status`
- `browser_get_attribute`
- `browser_get_value`
- `browser_read`
- `browser_screenshot`
- `browser_snapshot`
- `browser_tabs`
- `browser_wait_for`
- `browser_windows`

Server also refuses non-read-only calls if a client invokes hidden tool names directly.
