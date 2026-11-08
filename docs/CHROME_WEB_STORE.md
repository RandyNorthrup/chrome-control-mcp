# Chrome Web Store

The extension is published in the Chrome Web Store as well as shipped unpacked in every release
archive. This page is the record of the store item: how a release reaches it, and the listing as it
is entered in the developer dashboard, kept here because the API has no call for the listing.

| Item           | Value                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| Store ID       | `mbkacllnbffbadcajpkkpelifdkfgcbd`                                              |
| Listing        | <https://chromewebstore.google.com/detail/mbkacllnbffbadcajpkkpelifdkfgcbd>     |
| Publisher      | Randy Northrup (`044c8e44-968f-4e22-9d7a-0aa172fb492d`), non-trader             |
| Store key      | [browser/store-public-key.txt](../browser/store-public-key.txt) (public half)   |
| Unpacked ID    | `iojehhmnaigcejfcpmilpclmeljhlkaa` (the manifest's `key`)                       |
| Minimum server | 1.13.0: an older server's native-host registration lets in the unpacked ID only |

## Two IDs, one server

The store signs its build with a private key of its own, so the store build's ID is not the
unpacked build's. The server answers to both: its native-messaging registration lists both origins,
and the relay accepts a launch from either and from no other extension. A registration written
before 1.13.0 lists one origin; the server counts it as out of date and rewrites it on the next
install or update.

Keep one of the two in a Chrome profile. Both loaded at once are two extensions, each connecting to
the server.

## How a release reaches the store

1. The release workflow's `chrome-web-store` job runs after the GitHub release is published. It
   builds the store package with `node scripts/store_package.mjs --version <tag>`: the extension
   folder, zipped, with the manifest's `key` removed. A manifest the store would refuse (a
   description over 132 characters, a missing icon, another version) stops it there.
2. `node scripts/cws_publish.mjs --package <zip>` signs in as the publisher's service account,
   uploads the package to the item through the Chrome Web Store API (v2), waits while the store
   processes it, and submits it for review. A refusal fails the job with Google's own message; the
   GitHub release is out either way.
3. Google reviews the version, which can take days. When it passes, the store updates every
   installed copy.

The service account (`chrome-web-store-publisher` in the Google Cloud project `chrome-control-mcp`)
is linked to the publisher in the dashboard's Account page. Its key is the repository secret
`CWS_SERVICE_ACCOUNT_JSON` and exists nowhere else. It can publish any item the publisher owns, so
it is rotated by making a new key in the Cloud console, replacing the secret, and deleting the old
key.

The **Chrome Web Store check** workflow, run by hand, uses the same secret: `dry-run` signs in and
reads the item's status (and checks the item's public key is the one above); `upload-only` puts the
current commit's package on the item's draft without submitting it. Without the secret, the release
job says so and skips.

## The listing

Entered in the dashboard (Store listing and Privacy tabs). The summary is the manifest's
description.

**Name**: Chrome Control MCP

**Summary** (132 characters at most): Lets AI agents drive your real Chrome over MCP, in tabs of their
own with a visible cursor. Your mouse and keyboard stay yours.

**Category**: Developer Tools. **Language**: English.

**Description**:

> Chrome Control MCP lets AI agents use your own Chrome -- with your sign-ins, your extensions and
> your profiles -- through the Model Context Protocol (MCP). Any MCP client works: Claude Code, VS
> Code, Cursor, Codex and others.
>
> This extension is half of it. The other half is the Chrome Control MCP server, a small program
> you install on your computer from GitHub (free, open source, MIT licence):
> https://github.com/RandyNorthrup/chrome-control-mcp
>
> What agents get:
>
> - Tabs of their own. Each agent opens its own tabs, grouped and framed in its own colour, and
>   cannot reach into another agent's tabs or yours unless you hand one over.
> - A visible cursor. You see where an agent clicks and types; your own mouse and keyboard stay
>   yours.
> - Fast, cheap observation: find an element by its text, read a page's text, take a screenshot or
>   an accessibility snapshot with references to click.
> - Real input: clicks, typing, keys, drag and drop, file uploads without a file dialog, downloads,
>   printing to PDF, recordings of a tab.
> - A clipboard per agent, kept apart from yours.
> - Several Chrome profiles, chosen per call ("work", "personal").
>
> Privacy: what the extension reads from a page goes only to the Chrome Control MCP server on your
> own computer, through Chrome's native messaging. There is no account, no analytics and no server
> of ours; nothing is sent to the developer. Policy:
> https://github.com/RandyNorthrup/chrome-control-mcp/blob/main/docs/PRIVACY.md
>
> Click the toolbar button to stop every agent at once; click it again to let them back.
>
> Requires Chrome Control MCP server 1.13.0 or later.

**Homepage**: <https://github.com/RandyNorthrup/chrome-control-mcp>. **Support**:
<https://github.com/RandyNorthrup/chrome-control-mcp/issues>.

**Images**: the 128 px icon from [browser/extension/icons](../browser/extension/icons/), five
1280x800 screenshots of the extension at work, and a 440x280 promotional tile.

## Privacy practices

**Single purpose**: Lets AI agents the user runs on their own computer, through the Chrome Control
MCP server, open, read and operate browser tabs on the user's behalf.

**Permission justifications**:

| Permission                   | Why                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nativeMessaging`            | The only channel to the Chrome Control MCP server on the user's computer; every command arrives and every answer leaves through it.                                                                                                                                                             |
| `debugger`                   | Reads pages (accessibility tree, screenshots, console, network) and sends real input to the tabs an agent works in, through the DevTools Protocol.                                                                                                                                              |
| `tabs`                       | Opens, lists, selects and closes the tabs agents work in.                                                                                                                                                                                                                                       |
| `tabGroups`                  | Puts each agent's tabs in a coloured group of its own, so the user sees which agent holds which tab.                                                                                                                                                                                            |
| `contentSettings`            | Answers an agent's request to allow or block a site permission (camera, notifications) for the page it works on.                                                                                                                                                                                |
| `cookies`                    | Reads and sets cookies for the page an agent works on, when the agent asks.                                                                                                                                                                                                                     |
| `downloads`                  | Saves files an agent downloads and reports where they went.                                                                                                                                                                                                                                     |
| `offscreen`                  | Encodes tab recordings to video in an offscreen document; the service worker has no DOM to do it in.                                                                                                                                                                                            |
| `alarms`                     | Reconnects to the server after Chrome stops the service worker.                                                                                                                                                                                                                                 |
| `storage`                    | Keeps the extension's own state: the profile's name, which tabs each agent holds, pause and update state.                                                                                                                                                                                       |
| `scripting`                  | Takes the agent's frame and clipboard hooks back off a page after the debugger has left it (for example when the user cancels Chrome's debugging bar).                                                                                                                                          |
| `webNavigation`              | Knows when a page in an agent's tab has finished loading or moved to another address.                                                                                                                                                                                                           |
| `identity`                   | Reads which account the Chrome profile is signed in to (chrome.identity.getProfileUserInfo) to name the profile, so an agent can be told which profile to work in. No sign-in or OAuth token is requested.                                                                                      |
| `identity.email`             | Lets getProfileUserInfo return the account's email, which becomes the profile's default name. It goes only to the local server, and the user can rename the profile on the extension's options page.                                                                                            |
| Host permission `<all_urls>` | Agents work on whatever site the user asks them to, so the sites cannot be listed in advance. The extension reads and drives only the tabs an agent opened or was handed, each marked with a coloured tab group and a frame, and only when the user's own MCP client on the same computer asks. |

**Remote code**: No. Every script is in the package.

**Data usage**: the form's categories that apply, all handled only to provide the single purpose and
sent only to the server on the user's own computer: personally identifiable information (the
profile's account email), authentication information (cookies, when an agent reads them), web
history (open tabs' titles and addresses), user activity (input the agent sends), and website
content. The three certifications are made: no sale or transfer to third parties outside the
approved uses, no use unrelated to the single purpose, and no use for creditworthiness or lending.

**Privacy policy**: <https://github.com/RandyNorthrup/chrome-control-mcp/blob/main/docs/PRIVACY.md>

## Test instructions for review

Entered in the dashboard's Test instructions page, whose field takes 500 characters:

```text
Needs the free local server. On Windows: download chrome-control-mcp-*-windows-x64.zip from github.com/RandyNorthrup/chrome-control-mcp/releases/latest, unzip it, run chrome_control_mcp.exe --install. Add it to an MCP client, e.g. Claude Code: claude mcp add chrome-control -- "%LOCALAPPDATA%\Programs\ChromeControlMCP\current\chrome_control_mcp.exe". Ask it: "Open example.com in a new tab and click its only link." The tab opens in an "AI" group with a frame and cursor. No sign-in needed.
```
