# Tool catalog

Full profile advertises 43 tools: 40 live browser tools and 3 extension lifecycle tools.

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
- `browser_media`
- `browser_js_click`

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

## Extension preparation

- `browser_extension_install`
- `browser_extension_uninstall`
- `browser_extension_status`

`browser_extension_install` registers the per-user native messaging host and returns the folder to
load unpacked from `chrome://extensions`. `browser_extension_uninstall` removes that host
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
