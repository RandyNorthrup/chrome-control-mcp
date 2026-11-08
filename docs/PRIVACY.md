# Privacy policy

Chrome Control MCP, the Chrome extension and the MCP server it works with. Effective 2026-11-07.

## In short

The extension lets AI agents you run on your own computer use your Chrome. What it reads from a page
goes to the Chrome Control MCP server on the same computer, and from there to the agent you
connected to it. Nothing is sent to the developer: there is no account, no analytics, no telemetry
and no server of ours. The extension sends nothing anywhere on its own: the pages it opens and the
files it downloads are the ones an agent asked for.

## What the extension handles

Only when an agent connected to your local server asks for it:

- **Your open tabs' titles and addresses**, so an agent can list them and pick one to work in.

Everything below only in the tabs the agent opened or was handed, which are marked with a coloured
tab group and a frame:

- **Page content**: the page's text, its accessibility tree (roles and names of elements),
  screenshots, recordings of a tab, console messages and network requests, read through Chrome's
  debugger interface.
- **What the agent does**: the clicks, keys and text it sends to the page, files it uploads from
  paths on your computer, and the files it downloads.
- **Site data, when asked**: cookies, local and session storage, and content-setting permissions
  for the page the agent is on.
- **The agent's own clipboard**: text, HTML or images an agent copies or pastes. It is kept apart
  from your system clipboard and from other agents'.
- **Your profile's account email** (the `identity` and `identity.email` permissions): read to name
  each Chrome profile, so an agent can be told to work in "work" or "personal". It goes to your
  local server only, and you can replace the name on the extension's options page.

The extension stores, in Chrome's own extension storage on your computer: the profile name you
choose, which tabs each agent holds, and its own update and pause state.

## Where it goes

1. **To the server, on the same computer.** Chrome passes the extension's messages to the Chrome
   Control MCP server through native messaging, a channel between processes on one machine. The
   native-messaging registration names this extension's two IDs (the Chrome Web Store build and
   the unpacked build) and no other, and the server opens no network listener.
2. **To the agent you connected.** The server answers the MCP client that started it: Claude Code,
   VS Code, Cursor or any other. What that client does with a page it was given -- for example,
   sending it to an AI model -- is governed by that client's and that model provider's terms, which
   you chose when you connected them.
3. **To files on your computer.** Recordings, PDFs and downloads are saved where the agent's call
   or Chrome's download settings say. Screenshots go back to the agent in the reply.

The server checks GitHub for a newer release when asked (`browser_update_check`) and downloads it
when asked (`browser_update_apply`); that request carries no page content and nothing about you.

## What is never collected

The developer receives nothing: not the pages you or your agents visit, not what is typed, not the
account email, not usage counts. No data is sold, shared with third parties, used for advertising,
or used to decide creditworthiness or for lending.

## Your control

- An agent can work only in tabs it opened or was given, inside its marked tab group; your own tabs,
  mouse and keyboard stay yours.
- The extension's toolbar button pauses it, and pressing it again resumes it. Pausing, closing the
  MCP client, or removing the extension at `chrome://extensions` stops all of it at once.
- `browser_extension_uninstall` removes the native-messaging registration; removing the server's
  install folder removes everything it wrote.

## Contact

Questions and reports: [GitHub issues](https://github.com/RandyNorthrup/chrome-control-mcp/issues).
Security reports: see [SECURITY.md](SECURITY.md).
