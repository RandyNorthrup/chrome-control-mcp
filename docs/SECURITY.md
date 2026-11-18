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
15 tools). Any other non-empty profile token fails closed to read-only. Redaction accepts exact
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
it. A path must be absolute and name a real file. A file is bounded at 2 GiB, or at what the
operator sets:

```text
CHROME_CONTROL_MCP_UPLOAD_MAX_MB=512
```

A whole number of MiB from 1 to 8192; any other value fails closed to 16 MiB, and a refusal under
it says the variable was not understood. A file over the bound is refused before any of it is sent.
The file is read a piece at a time as it is sent, and each piece goes straight into the page it is
for, into an object made in the realm of the input, drop zone or picker it will be given to and
reachable only through the extension's DevTools handle -- so neither the server nor the extension
holds it whole, and the extension refuses more than 8 GiB for one file whatever it is sent. When the
upload ends -- assigned, refused, or cut short by the page navigating, the tab being let go or the
session ending -- that object is released. Files for a clipboard, and every file for an extension
older than 1.11.0, are held whole by the extension until used, as before, and stay at 16 MiB. No
path reaches the extension or the page: the page receives the file's name, type, and bytes, exactly
as the user's own file chooser would have given them.

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

- Extension IDs: `iojehhmnaigcejfcpmilpclmeljhlkaa` (unpacked) and
  `mbkacllnbffbadcajpkkpelifdkfgcbd` (Chrome Web Store)
- Native host: `com.chromecontrolmcp.browser`; and S.A.K. Utility's, `com.sak.browsercontrol`,
  which the extension also connects to only while an administrator's policy turns it on (see
  below)
- Windows pipe prefix: `ChromeControlMCP_BrowserBridge`
- Unix runtime namespace: `chrome-control-mcp-<uid>`

The manifest's public identity field pins the unpacked extension ID. It is not secret and cannot
sign a package. The project creates, stores, and requires no private extension key: the Chrome Web
Store signs its build with a key of its own, which fixes that build's ID, and the public half is in
`browser/store-public-key.txt`. The native-host registration's `allowed_origins` lists exactly these
two IDs, and the relay checks the origin Chrome passes against the same two before it does
anything; a registration that lists anything else is rewritten.

Publishing to the store uses a Google Cloud service account whose key is only the repository
secret `CWS_SERVICE_ACCOUNT_JSON`, read by the release workflow's store job and nowhere else
([CHROME_WEB_STORE.md](CHROME_WEB_STORE.md)). The extension sends nothing to the developer; see
[PRIVACY.md](PRIVACY.md).

### A second application: S.A.K. Utility

The extension also serves S.A.K. Utility, through that program's own native host,
`com.sak.browsercontrol`, which S.A.K. registers and this project never writes.

**Off unless an administrator turns it on.** A native host's name belongs to whoever registers it,
and any program running as the user can register one under the user's own registry key
(`HKCU\Software\Google\Chrome\NativeMessagingHosts`) naming this extension in its
`allowed_origins`. On most computers `com.sak.browsercontrol` is registered by nobody, so a program
that claimed it would be handed the whole command set -- the debugger, cookies including HttpOnly
ones, downloads -- without anyone noticing. So the extension opens a port to S.A.K.'s host only
while Chrome's policy for this extension holds `sakHostEnabled: true` (`chrome.storage.managed`,
declared by `storage.managed_schema` in the manifest; `managed_schema.json`). On Windows that policy
lives under `Software\Policies\Google\Chrome\3rdparty\extensions\<id>\policy` (Edge:
`Software\Policies\Microsoft\Edge\...`) in HKCU or HKLM, and both `Software\Policies` keys are
writable by administrators and SYSTEM only: the user's own account has read access. Checked on a
Windows 11 25H2 test PC joined to no domain (2026-11-17): a process with the user's standard token
was refused creating the policy key under HKCU and HKLM, writing a value on HKCU's `Policies`,
taking ownership of it, changing its permissions, deleting it and renaming it. On the same PC Chrome
157, Edge 157 and Chrome for Testing 157 (which reads its own `Google\Chrome for Testing` key)
handed the value to the extension (`chrome://policy`: Platform, Current user, Mandatory, OK);
Chrome applied 3rdparty policy the same way to an extension it had force-installed from the Chrome
Web Store. Chrome reads the value when it starts, and a running Chrome when it rereads its policy
(on its own schedule, or from `chrome://policy`'s Reload): it then reaches the extension as a
`chrome.storage.onChanged` event, and the extension connects, or ends S.A.K.'s sessions, at once. S.A.K. Utility runs as an administrator and writes the value when its Browser Control
is turned on (also when it reuses a copy of the extension already installed), and removes it when
it is turned off. Without the value the host is never asked for -- not by a forced retry, not by
the toolbar button -- and a value of any other type than `true` counts as off. When the policy is
removed while the browser runs, every S.A.K. session ends at once and its tabs go back to the user.

What remains: once an administrator has turned it on, the host's registration is still the user's
to change, as every user-level native host's is; a program running as the user could point
`com.sak.browsercontrol` at itself. That is the same exposure Chrome Control MCP's own host has, and
a program with that much access to the account can already change the user's Chrome in other ways.

**Kept apart.** The two hosts are separate inside the extension: each has its own sessions, and a
session never sees the other host's sessions or the tabs they hold. Those tabs are left out of
every tab listing, its count and its numbering (a listing's indices are the tab's place among the
tabs the session may see, so no gap marks where the other's tab sits); a window holding only the
other host's tabs is not listed, and other windows' tab counts leave them out. A command naming
such a tab by id is refused in exactly the words used for an id that names no tab at all, so an id
cannot be probed for whether the other application holds it. No command reaches one: grouping or
ungrouping the active tab, focusing a window whose active tab it is, and closing a window that
holds one (or a tab another session of the same host holds) are refused. Every frame is answered on
the port it came in on, and nothing is relayed between hosts. Asked whether a tab id exists
(`findTab`, the server's question before it routes a call), the extension answers for the other
host's tab exactly as for no tab, field for field. The profile's identity (its account email) goes
to this project's host only: S.A.K. is told the name the user gave the profile, or a generated one,
never the account email in any field of the extension's own. A tab's title and page are the page's
content, not the profile's identity: a title that shows the email (a mail inbox's often does)
reaches whichever host lists or reads that tab, as any other page text does. A session that ends
while one of its commands is still running (the toolbar pause, or the policy removed) is marked
ended first, and that command can then hold no tab, group none and attach the debugger to none. A
reload the extension makes for a newer server waits until no
session of either host is using it. Which host a port reaches is Chrome's decision, made from the
host name and the registration's `allowed_origins`, so a page can no more choose the host than it
can choose the server. The toolbar switch pauses both.

**Shared, because it is the profile's.** Both hosts drive the same Chrome profile, so its cookies,
sign-ins, site settings and download folder are shared between them, as they are with the user.
While a session of one host holds a tab on a site, a `browser_cookies` or `browser_permission` call
from the other host for that site -- the tab's host name, a domain above it or one below it -- is
refused. The site is read from both the address the tab shows and the one it is loading, and a
host name's trailing dot (`mail.google.com.`) is taken off on both sides. A cookie of a domain above
that site is also sent to its neighbours, so a call for a sibling site (`accounts.google.com` beside
`mail.google.com`) is checked cookie by cookie: a get leaves out every cookie whose domain is the
other host's site or a domain above it, and says how many (`withheld`); a remove or set is refused
when a cookie of that name for the url is such a cookie. At any other time those calls reach the
profile's cookies and settings for any site, and either host can open a page of its own on a site
where the user is signed in. This is stated in [PRIVACY.md](PRIVACY.md).

**What a session can still infer.** Leaving the other host's tabs out cannot hide every trace of
them. When the other host holds a window's active tab, a listing of that window shows no active tab,
and a command that would take the active tab is refused as in use by another application connected
to the browser; when the front window holds only the other host's tabs, a listing has nothing in it
for that window. None of this says which application, which tab or what is in it.

When S.A.K.'s host is turned on but not installed (Chrome reports it missing, or cannot start the
program its registration names, as when a portable folder was deleted or moved with Browser
Control left on), the extension asks for it again only after ten minutes, doubling up to six hours,
without logging anything (turning the extension off and on again with its toolbar button, or
restarting Chrome, asks at once); no process is
started by asking. When it is installed but S.A.K. is not running, its relay starts, finds nothing
to attach to and exits; that is asked again on the usual doubling interval, but up to ten minutes
rather than two, and is not logged either.

## What setup writes

Preparation writes only the current-user native-host registration and the generated host manifest.
Uninstall removes only this project's registration and manifest. Adding the extension -- unpacked,
or from the Chrome Web Store -- and removing it remain explicit user actions in Chrome.

## Reporting vulnerabilities

Do not publish credential material or working exploit details in a public issue. Use the repository
owner's private GitHub security-reporting channel when available.
