# Security

## Profiles

Unset `CHROME_CONTROL_MCP_SECURITY_PROFILE` means full access: navigation, input, tabs, cookies,
permissions, downloads, storage mutation, printing, HTTP auth, uploads, recording, and extension
lifecycle.

The MCP client owns human approval. Use read-only unless the client reliably confirms mutating
tools:

```text
CHROME_CONTROL_MCP_SECURITY_PROFILE=read_only
CHROME_CONTROL_MCP_REDACT_SENSITIVE_OUTPUT=true
```

Exact `read_only` enables the restricted profile ([TOOLS.md](TOOLS.md#read-only-profile) lists its
14 tools). Any other non-empty profile token fails closed to read-only. Redaction accepts exact
`true` or `false`; other non-empty values fail closed to redaction.

Redaction is best-effort text masking. Screenshots and unmodeled secret shapes remain outside its
guarantee.

## Extension permissions

The extension asks for exactly what it uses, and the set is chosen rather than accumulated. From
`browser/extension/manifest.json`:

| Permission                   | What it is for                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `nativeMessaging`            | the bridge to the MCP server                                                                                                                  |
| `debugger`                   | every page action, over the DevTools protocol                                                                                                 |
| `tabs`                       | resolving and listing tabs                                                                                                                    |
| `tabGroups`                  | the per-agent tab groups that show which tabs are under control                                                                               |
| `contentSettings`            | `browser_permission`                                                                                                                          |
| `cookies`                    | `browser_cookies`                                                                                                                             |
| `downloads`                  | `browser_download`, and landing a recording as a file                                                                                         |
| `offscreen`                  | a hidden document to run the video encoder in                                                                                                 |
| `alarms`                     | re-arming the bridge after the service worker is retired, and standing idle sessions down                                                     |
| `storage`                    | the pause switch, the reconnect backoff, the once-per-protocol reload, which tabs each session holds across a restart, and the profile's name |
| `scripting`                  | taking the control frame off a page whose debugger attachment has already ended                                                               |
| `webNavigation`              | knowing which tab a link or script opened a new tab from, so an agent's popup is the agent's and the user's new tab is not                    |
| `identity`, `identity.email` | naming a Chrome profile by its signed-in account's email, so agents can choose a profile (1.10.0)                                             |
| `<all_urls>`                 | (host permission) the assistant can be asked to drive any page the user can open                                                              |

Together these amount to full control of the browser. Use trusted builds only.

`scripting` runs one fixed function -- remove the overlay's own elements (frame, badge, cursor, and
their stylesheet) by id -- and nothing else. It is the only way to clear the frame from a page after
the user cancels Chrome's debugging bar or opens DevTools, when the debugger can no longer reach
it. `webNavigation` is used only for `onCreatedNavigationTarget`, which names the tab a new tab was
opened from; the handler ignores, and records nothing about, any new tab that was not opened from a
tab the assistant holds.

`activeTab` and `tabCapture` are not requested; the next section says why.

### Recording is not an escalation

`browser_record_start` records one held tab by taking frames from the DevTools protocol
(`Page.startScreencast`) -- the same channel already used for every click, every snapshot and every
screenshot. It captures video only; there is no audio.

It deliberately does NOT use `chrome.tabCapture`, which would be the obvious API for it. Chrome
requires the `activeTab` grant for tab capture, and that grant comes only from a user invoking the
extension on that specific tab -- a toolbar click, a context menu, a keyboard shortcut. An
agent-driven start has no such invocation, so tabCapture could not work here without asking the
user to click something before every recording. `activeTab` is therefore not requested either.

The only permission recording adds is `offscreen`, which creates a hidden extension page. It grants
no access to the user's browsing; `MediaRecorder` needs a DOM and the service worker has none.

`debugger` is already held and is strictly more powerful than `tabCapture` would be: anything that
can read the page and synthesize input can already reconstruct what a recording would show. Chrome
displays its own indicator while a tab is being debugged, so the user can see that a session is
attached.

Recordings are written through `chrome.downloads` to a relative path under the user's downloads
folder, validated the same way `browser_download` validates a filename: no absolute path, no `..`.
The video never travels back through the bridge -- a reply is capped far below the size of any real
recording -- so `browser_record_stop` returns a path.

## Chrome profiles

Each Chrome profile the extension is loaded in is reachable by agents through one server; a profile
without the extension is not, which is how to keep a profile out of reach. A profile is named, by
default, by its signed-in account's email (`chrome.identity.getProfileUserInfo`), and that email
appears in `browser_tabs`, `browser_extension_status` and version notes -- so it reaches agents and
the AI service behind them. Naming the profile on the extension's options page keeps the email out
of every listing; the server still sees it, and status still reports it. Names and emails come from
the extension and are cleaned on the server as untrusted text (printable only, bounded, an email
that is not one dropped). The server admits at most eight relays, and none from a second Chrome
while one is served.

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

File pickers are caught only on a tab the session holds, only while one of its own input or
navigation commands is running and for 2 s after, and only to be answered with files the agent
names through `browser_upload`. The user's own clicks on an upload button, even in a held tab, get
the ordinary dialog. A `showOpenFilePicker` call is answered with a read-only handle: the page can
read the file, and is offered no way to write back to it.

## Clipboards

The system clipboard is shared by the user and every program they run, and holds whatever they
copied last -- often a password, a message, a code. Agents never touch it:

- **Nothing an agent does reads or writes it.** An agent's copy, cut and paste keys are answered
  from that agent's own clipboard and never sent to Chrome as keys. A page in a tab an agent holds
  gets a stand-in for `navigator.clipboard` and `document.execCommand('copy' | 'cut')` that answers
  from the same place. Before 1.9.0 a page's copy button clicked by an agent wrote the system
  clipboard: agent tabs run under focus emulation, so a background page believed it was focused,
  and Chrome lets a focused page write. The extension declares no clipboard permission.
- **No agent reaches another's.** A clipboard belongs to one agent of one session, keyed like its
  tab group. Another agent on the same server, an agent on another server, and a page in another
  agent's tab cannot read or write it.
- **A page is not given it freely.** The stand-in answers a page only while one of the agent's own
  input commands on that tab is running and for 2 s after -- the window a person's click would give
  a real page -- and only from that tab's agent's clipboard. Outside it the page is refused, as a
  page without clipboard permission is. The binding the stand-in uses is visible to the page, so a
  page can ask whenever it likes; it is the worker, not the page, that decides, and a page's write
  is bounded and validated like every other.
- **Only in memory, and not for long.** A clipboard is held by the extension's service worker,
  never written to `chrome.storage` or disk, bounded (2 MiB of text, 2 MiB of HTML, 10 files within
  the upload ceiling), and cleared when its agent lets go of its last tab, when its session ends,
  and when the user pauses the bridge.
- **Markup is not injected.** Pasted HTML is only offered to the page's own paste handler, which
  sanitizes it as it would a real paste; the fallback types text only.
- **Files follow the upload rules.** `browser_clipboard write` reads files exactly as
  `browser_upload` does: absolute paths, `CHROME_CONTROL_MCP_UPLOAD_ROOTS`, 16 MiB each, sent in
  pieces, and no path reaches the browser. The tool is absent from the read-only profile.

What this does not cover: a page that deliberately reaches around the stand-in (it is installed on
the prototypes, in every document and same-origin frame of a held tab, but a determined page is
outside the threat model); a frame from another site inside a held tab, which the stand-in cannot
reach; a shell command the agent runs itself outside the browser; and, on Linux, the primary
selection Chrome sets for every text selection.

## Defenses

Transport and identity:

- The native host accepts only the pinned extension origin.
- The Windows named pipe has a current-user DACL and a Medium-integrity no-write-up label.
- The Linux/macOS runtime directory and socket are owner-only; peer credentials verify UID and PID.
- The relay verifies the recorded server process and that it runs the same executable image; the
  server verifies the relay's identity the same way.
- The server requires a Chrome process among the relay's ancestors. That gate is on in production
  and relaxed only by the unit tests.
- The endpoint name contains a random nonce; the private rendezvous is project-scoped.
- A token plus protocol handshake authenticates each connection, and a protocol mismatch refuses
  every command rather than guessing at a frame shape.
- Native frames, JSON-RPC lines, screenshots, text, and other major payloads are bounded.
- One outstanding command per server prevents reply mispairing.

Sessions and tabs:

- A tab one session holds is refused to every other session, naming the holder. Chrome's
  one-debugger-client-per-tab rule backs this for the DevTools protocol; the lease covers tabs,
  windows, cookies and downloads.
- A tab counts as the assistant's only if it opened it, its own command's page opened it, it was
  given it, or the user dragged it into its group. The user's own new tabs -- Ctrl+T, the new-tab
  button, a middle-click -- stay the user's, and a popup the agent's page brings to the front is put
  back behind the tab the user had in front.
- Release never closes a tab the session borrowed, the tab the user is looking at, or the browser's
  last tab.
- Agent and client names reach the tab strip only as short printable text, and the page only as a
  string assigned to `textContent`, never as markup or code.

Page actions:

- A new relay generation invalidates old refs.
- A ref acts only on the tab its snapshot came from, and fails once that tab's page changes. Ref
  names are never reused, so a stale ref is refused rather than naming a new element.
- Coordinate clicks require a fresh viewport screenshot fingerprint of the same tab.
- Screenshots hide control presence unless the caller explicitly sets
  `include_control_overlay: true`.
- Storage operations use an isolated world, verify the live origin, and call pristine Storage
  methods.
- Dialog defaults reject confirm/prompt; an explicit response is one-shot.
- Download URL and relative filename validation fail closed.
- Recording filenames are validated the same way, and a recording is refused a second start or a
  change of current tab rather than silently replacing or ending the first.
- A recording whose tab or session ends discards the encoder and the partial bytes rather than
  writing a truncated file that would read as a finished one.
- Console, exception, and network records are bounded rings of bounded entries: every field in
  them is page-controlled, and what the ring discards is counted rather than silently forgotten.
- No tool evaluates caller-supplied JavaScript. An eval would bypass the isolated-world storage
  checks, the dialog policy, the freshness gating on ref and coordinate actions, and the refusal
  of `javascript:` URLs, and could remove the control overlay that shows a session is driving.
- Strict schemas reject unknown arguments and wrong types.

Build:

- Compiler warnings are errors. Static analysis, secret scan, dependency audit, and sanitizers run
  in CI on every push; [QUALITY.md](QUALITY.md) lists the gates and their current state.

## Browser identity

- Extension ID: `iojehhmnaigcejfcpmilpclmeljhlkaa`
- Native host: `com.chromecontrolmcp.browser`
- Windows pipe prefix: `ChromeControlMCP_BrowserBridge`
- Unix runtime namespace: `chrome-control-mcp-<uid>`

The manifest's public identity field pins the unpacked extension ID. It is not secret and cannot
sign a package. The project creates, stores, and requires no private extension key.

## What setup writes

Preparation writes only the current-user native-host registration and the generated host manifest.
Uninstall removes only this project's registration and manifest. Loading and removing the unpacked
extension remain explicit user actions in `chrome://extensions`.

## Reporting vulnerabilities

Do not publish credential material or working exploit details in a public issue. Use the repository
owner's private GitHub security-reporting channel when available.
