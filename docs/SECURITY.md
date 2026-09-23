# Security

## Profiles

Unset `CHROME_CONTROL_MCP_SECURITY_PROFILE` means full access: navigation, input, tabs, cookies,
permissions, downloads, storage mutation, printing, HTTP auth, and extension lifecycle.

MCP client owns human approval. Use read-only unless client reliably confirms mutating tools:

```text
CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only
CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT=true
```

Exact `read_only` enables restricted profile. Any other non-empty profile token fails closed to
read-only. Redaction accepts exact `true` or `false`; other non-empty values fail closed to
redaction.

Redaction is best-effort text masking. Screenshots and unmodeled secret shapes remain outside its
guarantee.

## Extension permissions

The extension asks for exactly what it uses, and the set is chosen rather than accumulated:

| Permission        | What it is for                                                 |
| ----------------- | -------------------------------------------------------------- |
| `nativeMessaging` | the bridge to the MCP server                                   |
| `debugger`        | every page action, over the DevTools protocol                  |
| `tabs`            | resolving and listing tabs                                     |
| `tabGroups`       | the tab-strip mark that shows which tab is under control       |
| `contentSettings` | `browser_permission`                                           |
| `cookies`         | `browser_cookies`                                              |
| `downloads`       | `browser_download`, and landing a recording as a file          |
| `offscreen`       | a hidden document to run the video encoder in                  |
| `alarms`          | re-arming the bridge after the service worker is retired       |
| `<all_urls>`      | the assistant can be asked to drive any page the user can open |

### Recording is not an escalation

`browser_record_start` records the session's tab by taking frames from the DevTools protocol
(`Page.startScreencast`) — the same channel already used for every click, every snapshot and every
screenshot. It captures video only; there is no audio.

It deliberately does NOT use `chrome.tabCapture`, which would be the obvious API for it. Chrome
requires the `activeTab` grant for tab capture, and that grant comes only from a user invoking the
extension on that specific tab — a toolbar click, a context menu, a keyboard shortcut. An
agent-driven start has no such invocation, so tabCapture could not work here without asking the
user to click something before every recording. `activeTab` is therefore not requested either.

The only permission recording adds is `offscreen`, which creates a hidden extension page. It grants
no access to the user's browsing; `MediaRecorder` needs a DOM and the service worker has none.

`debugger` is already held and is strictly more powerful than `tabCapture` would be: anything that
can read the page and synthesize input can already reconstruct what a recording would show. Chrome
displays its own indicator while a tab is being debugged, so the user can see that the session is
attached.

Recordings are written through `chrome.downloads` to a relative path under the user's downloads
folder, validated the same way `browser_download` validates a filename: no absolute path, no `..`.
The video never travels back through the bridge — a reply is capped far below the size of any real
recording — so `browser_record_stop` returns a path.

## Uploads

`browser_upload` is the one tool that reads the user's disk, so it is also the one tool that can
carry a local file onto a web page. It is absent from the read-only profile. Where the assistant
should reach only part of the disk, name the directories it may read:

```text
CHROME_CONTROL_MCP_UPLOAD_ROOTS=C:\Users\you\Uploads;C:\Work\attachments
```

Paths are made canonical before the test, so a symlink or a `..` cannot point inside a root and
read outside it, and a sibling directory whose name merely starts with a root's name is not inside
it. A path must be absolute and name a real file; a file is read once, bounded at 16 MiB, and sent
as bridge-sized pieces that the extension holds only until the file is assigned and drops whenever
the session ends. No path reaches the extension or the page: the page receives the file's name,
type, and bytes, exactly as the user's own file chooser would have given them.

Unset, the variable means no restriction, and an assistant with this tool can attach any file the
user can read. That is the same reach the user has in their own browser, which is the model this
project works to, but it is worth choosing deliberately.

## Defenses

- Native host accepts only pinned extension origin.
- Windows named pipe has current-user DACL and Medium-integrity no-write-up label.
- Linux/macOS runtime directory and socket are owner-only; peer credentials verify UID and PID.
- Relay verifies recorded server process and same executable image.
- Optional production gate requires Chrome in relay process ancestry.
- Endpoint name contains random nonce; private rendezvous is project-scoped.
- Token + protocol handshake authenticates each connection.
- Native frames, JSON-RPC lines, screenshots, text, and other major payloads are bounded.
- One outstanding command prevents reply mispairing.
- New relay generation invalidates old refs.
- Ref actions fail when page or session changed.
- Coordinate clicks require fresh viewport screenshot fingerprint.
- Screenshots hide control presence unless caller explicitly sets `include_control_overlay: true`.
- Storage operations use isolated world, verify live origin, and call pristine Storage methods.
- Dialog defaults reject confirm/prompt; explicit response is one-shot.
- Download URL and relative filename validation fail closed.
- Recording filenames are validated the same way, and a recording is refused a second
  start or a tab change rather than silently replacing or ending the first.
- A session that ends mid-recording discards the encoder and the partial bytes rather than
  writing a truncated file that would read as a finished one.
- Strict schemas reject unknown arguments and wrong types.
- Compiler warnings are errors; static analysis, secret scan, dependency audit, and sanitizers run as
  release gates.

## Browser identity

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Windows pipe prefix: `ChromeControlMCP_BrowserBridge`
- Unix runtime namespace: `chrome-control-mcp-<uid>`

Manifest public identity field pins unpacked extension ID. It is not secret and cannot sign a
package. Project creates, stores, and requires no private extension key.

## Chrome privileges

Extension requests `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `contentSettings`,
`cookies`, `downloads`, and `<all_urls>`. Full browser control needs these privileges. Use trusted
builds only.

Preparation writes only current-user native-host registration and generated host manifest.
Uninstall removes only this project's registration and manifest. Loading and removing unpacked
extension remain explicit user actions in `chrome://extensions`.

## Reporting vulnerabilities

Do not publish credential material or working exploit details in a public issue. Use repository
owner's private GitHub security-reporting channel when available.
