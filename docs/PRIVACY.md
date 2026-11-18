# Privacy policy

Chrome Control MCP, the Chrome extension and the MCP server it works with. Effective 2026-11-17.

## In short

The extension lets AI agents you run on your own computer use your Chrome. What it reads from a page
goes to the program on the same computer that asked for it -- the Chrome Control MCP server, and
from there to the agent you connected to it; or S.A.K. Utility, the developer's technician toolkit,
when an administrator has turned its connection on -- and to nothing else. Nothing is sent to the
developer: there is no account, no analytics, no telemetry and no server of ours. The extension
sends nothing anywhere on its own: the pages it opens and the files it downloads are the ones an
agent asked for.

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
  local Chrome Control MCP server only -- never to S.A.K. Utility, in any field -- and you can
  replace the name on the extension's options page.

The extension stores, in Chrome's own extension storage on your computer: the profile name you
choose, which tabs each agent holds, and its own update and pause state. It reads one setting an
administrator can give it through Chrome's policy, `sakHostEnabled`, which says whether it may
connect to S.A.K. Utility.

## Where it goes

1. **To the program that asked, on the same computer.** Chrome passes the extension's messages
   through native messaging, a channel between processes on one machine, to the Chrome Control MCP
   server -- or to S.A.K. Utility, when its connection is on (item 3). The native-messaging
   registration names this extension's IDs and no other, and neither program opens a network
   listener for it. Each program gets only what its own agent asked for.
2. **To the agent you connected.** The server answers the MCP client that started it: Claude Code,
   VS Code, Cursor or any other. What that client does with a page it was given -- for example,
   sending it to an AI model -- is governed by that client's and that model provider's terms, which
   you chose when you connected them.
3. **To S.A.K. Utility, only when an administrator has turned it on, on the same computer.** The
   extension also works for S.A.K. Utility, a separate program by the same developer, through its
   own native-messaging host (`com.sak.browsercontrol`). It connects to that host only while
   Chrome's policy for this extension sets `sakHostEnabled`, which only an administrator of the
   computer can set: S.A.K. Utility sets it when you turn its Browser Control on and removes it
   when you turn it off. A program that registers a host of that name without it gets nothing.
   What S.A.K.'s assistant asks for goes to S.A.K. on this computer, in the same way, and is
   handled under S.A.K. Utility's own terms. The two programs never see each other's tabs, windows
   or messages, and your profile's account email is never given to S.A.K. Utility. Without that
   policy, nothing goes to it.
4. **To files on your computer.** Recordings, PDFs and downloads are saved where the agent's call
   or Chrome's download settings say. A screenshot goes back to the agent in the reply, except
   one taken for presentation, which is saved as a file instead.

The server checks GitHub for a newer release when asked (`browser_update_check`) and downloads it
when asked (`browser_update_apply`); that request carries no page content and nothing about you.

## What the two programs share

Both programs drive the same Chrome profile, so what belongs to the profile rather than to a tab is
shared between them, as it is between you and either of them: your sign-ins, cookies and site
settings (permissions such as camera or notifications), the profile's download folder, and the
pages either one can open. Neither program can see the other's tabs, but each can open a page of
its own on a site where you, or the other program, are signed in, and act there as you. While one
program is working in a tab on a site, the extension refuses the other's requests to read or change
that site's cookies or its site settings (`browser_cookies`, `browser_permission`); at any other
time they are the profile's, open to both.

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
