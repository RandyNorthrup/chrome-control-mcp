# Chrome profiles, chosen per call

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them.

## Why

People keep work and personal accounts in separate Chrome profiles, and households share a Chrome
with a profile each. Chrome runs every profile of one user data directory in one browser process,
and gives each profile its own instance of this extension. Each instance reaches the server through
a relay of its own -- but the server took exactly one relay connection, so it bound to whichever
profile's extension reached it first, and the other profile's extension was refused and backed off
for up to half an hour. An agent could not choose a profile, and could not see which one it was in.

Decided by the user (2026-10-31):

- **Chosen per call**: one server connects to every profile at once; an agent names the profile
  when it opens a tab, and listings say which profile each tab is in.
- **Names**: a profile is called by its signed-in Google account's email by default, and can be
  renamed (work, personal) on the extension's options page. The email reaching agents is accepted.
- **No profile named, several connected**: the profile of the Chrome window the user last focused.

## Design

**Several relays per server.** The server accepts one connection per profile -- up to a bound --
each handshaken, verified and served on a thread of its own with the same silence budget, progress
beats, idle checks and cancel as the one connection before. A connection's arrival or departure
touches nothing of another's. Connections are told apart by an id the server gives each; the old
single-connection calls keep meaning "the connection" when there is one.

**One browser at a time.** Tab and window ids are unique only within one Chrome process, and every
profile of a user data directory shares one. A relay from a different Chrome process -- another
install, or another user data directory -- is refused while one is being served, as it effectively
was before (the single pipe was busy), now with a message saying so. Telling them apart uses the
Chrome process the server already finds above each relay when it verifies the peer. A Chrome that
has exited no longer counts: after a restart its relays can take half a second to be noticed gone,
and the new Chrome's relays are admitted at once rather than refused for that half second -- which
would have left the bridge down for minutes while the extension backed off.

**Names travel with the handshake.** The extension works out its profile's name -- the name the
user gave it, else the signed-in account's email (`chrome.identity.getProfileUserInfo`), else a
generated name kept in the profile -- and sends it with its email in `attach_session`; the relay
passes both to the server, which checks them as untrusted text. A rename on the options page takes
effect at once: the extension reports its current name in every listing and whenever asked.

**Routing.** Each call goes to one profile, or to all:

| Call                                                        | Goes to                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| any call naming a `tab_id`, or a `ref` (whose tab is known) | the profile holding that tab; one the server has not seen is looked for |
| `browser_new_tab`, `browser_window new`                     | `profile` if given; else the only profile; else the last-focused one    |
| `browser_window focus/close` with `window_id`               | the profile holding that window                                         |
| `browser_cookies`, `browser_permission`                     | `profile` if given; else the agent's current profile                    |
| `browser_tabs`, `browser_windows`                           | every profile, merged, each entry naming its profile                    |
| `browser_release` without `tab_id`                          | every profile                                                           |
| anything else naming no tab                                 | the agent's current profile: the one its last routed call went to       |

A `profile` matches a name or an email, ignoring case. One that matches nothing is refused with the
names that are connected. With one profile connected every call goes to it, exactly as before. When
no window has ever had focus -- a fresh start, a headless browser -- the oldest connection is the
last-focused one. A profile that fails to answer a listing is named in the reply; the others are
still listed.

**State per connection.** Refs stay bound to tabs; a connection that goes away drops the refs and
routing of its own tabs only, and a new connection drops nothing. Version notices are per
connection and name the profile when there are several. `browser_extension_status` lists each
connected profile with its name, email and versions.

**Last focused.** Each extension instance records when one of its profile's windows last took
focus; asked, it says that and whether one has focus now. The server asks every profile only when
it has to choose among several.

**Updating into the new permissions.** Naming by email needs the `identity` and `identity.email`
permissions, which the installed extension does not have. An unpacked extension that reloads into
files asking for more must come back enabled, or every user's extension would stop on the update
that brings this; the live suite reloads one into exactly that.

## Non-goals and limits

- Profiles in different Chrome processes at once (two installs, or two user data directories) are
  not served together; the second is refused with a reason.
- An agent's clipboard, tab group and colour belong to one profile's extension; copying in one
  profile and pasting in another is not offered.
- The extension has to be loaded in each profile that agents may use. A profile without it is
  invisible to agents, which is the user's way to keep one out of reach.
- An extension or relay older than this work sends no profile: its connection is called
  `unnamed`, and is never the last-focused one.
- Index-addressed calls (`browser_close_tab` by `index`, `browser_group_tabs`) act in the agent's
  current profile, whose listing those indices come from.

## Reuse

- The handshake already carries optional, validated fields (versions, 1.9.0); the profile name and
  email ride the same way.
- The per-connection serving loop is the existing one, run per connection instead of once.
- `BrowserBridgeSession` already keeps refs and staleness per tab; dropping a departed connection's
  tabs uses its existing per-tab removal.
- The live harness already loads the extension and drives a dedicated Chrome; it gains a headed
  mode under Xvfb and a second profile, which headless Chrome cannot open.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-PROFILES",
    "title": "Chrome profiles, chosen per call",
    "scope_revision": 1,
    "brief": null,
    "brief_reason": "Scoped feature in an existing product; README.md, docs/ARCHITECTURE.md and docs/MULTI_SESSION.md carry the product context, and the user's decisions are recorded in this plan's Why",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "049e76c6997c"
      }
    ],
    "inputs": [],
    "environment": {
      "platform": "windows",
      "tools": {
        "node": "v24.20.0",
        "cmake": "4.4.5",
        "python": "3.14.10",
        "chrome-for-testing": "153.0.8010.52",
        "wsl2-arch-node": "v26.9.0",
        "wsl2-arch-cmake": "4.4.3",
        "wsl2-arch-python": "3.12.16",
        "wsl2-arch-semgrep": "1.174.0"
      }
    }
  },
  "requirements": [
    {
      "id": "REQ-PROF-CONNECT",
      "statement": "One server serves the extension in every profile of the user's Chrome at once, each connection independent of the others, and refuses a relay from a different Chrome process with a reason",
      "priority": "critical",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-PROF-NAME",
      "statement": "Every profile has a name: the one the user gave it on the options page, else its signed-in account's email, else a generated name that stays the same",
      "priority": "critical",
      "acceptance": [
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-UPGRADE"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-PROF-ROUTE",
      "statement": "Each call reaches the right profile: the one named, the one holding its tab or window, the agent's current one, or the last-focused one when a new tab names none; listings and release cover every profile",
      "priority": "critical",
      "acceptance": [
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-PROF-VISIBLE",
      "statement": "Agents and users can see which profile each tab and connection is",
      "priority": "normal",
      "acceptance": [
        "AC-PROF-STATUS"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-PROF-COMPAT",
      "statement": "With one profile, and with an extension or relay older than this work, everything behaves as before",
      "priority": "critical",
      "acceptance": [
        "AC-PROF-SINGLE"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-PROF-SEVERAL",
      "requirement": "REQ-PROF-CONNECT",
      "given": "A running server and two relays of the same Chrome",
      "when": "both connect and the server sends each a command",
      "then": "both are admitted and stay connected together, each command is answered by the relay it was sent to, and a ninth connection is refused while the eight admitted ones keep working",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-INDEPENDENT",
      "requirement": "REQ-PROF-CONNECT",
      "given": "Two connected profiles, with refs taken and tabs known in both",
      "when": "one disconnects, reconnects, or a third connects",
      "then": "the other's refs, tab routing and in-flight-free calls are untouched; the departed connection's own refs are gone and its tabs are routed again only after it reconnects",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-OTHER-BROWSER",
      "requirement": "REQ-PROF-CONNECT",
      "given": "A connection from one Chrome process",
      "when": "a relay whose Chrome process is another arrives",
      "then": "it is refused, saying another Chrome is already being served, and the first keeps working; once the first Chrome process has exited a relay from the new one is admitted at once, before its old connections were noticed gone; with no Chrome process known (as in the unit tests) nothing is refused for it",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-NAME",
      "requirement": "REQ-PROF-NAME",
      "given": "A profile renamed, a signed-in profile not renamed, and a signed-out profile not renamed",
      "when": "the extension attaches and is asked its name",
      "then": "it reports the given name, the email, and a generated name that is the same on every start, respectively, with the email alongside when known; the server bounds and cleans what it is sent",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-OPTIONS",
      "requirement": "REQ-PROF-NAME",
      "given": "The extension's options page",
      "when": "the user opens it, saves a name, or clears it",
      "then": "it shows the profile's email and current name; a saved name is used from then on in listings and routing without reloading anything; clearing goes back to the email",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-NEW-TAB",
      "requirement": "REQ-PROF-ROUTE",
      "given": "Two connected profiles named work and personal, personal's window focused last",
      "when": "browser_new_tab is called with profile work, with no profile, with profile WORK, and with a name that matches neither",
      "then": "the tab opens in work, in personal, in work, and the last is refused listing both names; with no window ever focused the oldest connection is chosen; with one profile connected and no profile given it opens there, as before",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-BY-TAB",
      "requirement": "REQ-PROF-ROUTE",
      "given": "Tabs open in both profiles, one of them a tab the server has never seen",
      "when": "tab-scoped calls name a tab_id or a ref, and a call names no tab after the agent last worked in personal",
      "then": "each goes to the profile holding its tab, the unseen tab is found, an unknown tab is refused as before, and the call naming no tab goes to personal",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-ALL",
      "requirement": "REQ-PROF-ROUTE",
      "given": "Two connected profiles each with tabs and windows",
      "when": "browser_tabs, browser_windows and browser_release without tab_id are called",
      "then": "the listings hold every profile's entries, each naming its profile, and release lets go in both, reporting both; a profile that fails to answer is named in the reply and the others are still listed",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-STATUS",
      "requirement": "REQ-PROF-VISIBLE",
      "given": "Two connected profiles, one with an older extension",
      "when": "browser_extension_status is called and the first browser reply on each connection returns",
      "then": "the status lists both profiles with name, email and versions, and the version notice names the profile it is about",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-SINGLE",
      "requirement": "REQ-PROF-COMPAT",
      "given": "One profile, or an extension or relay that sends no profile",
      "when": "every existing unit, contract and live suite runs",
      "then": "they pass unchanged apart from listings gaining a profile field; a connection whose extension or relay sends no profile is called unnamed, and one whose extension does not know a profile command is treated as never focused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-PROF-UPGRADE",
      "requirement": "REQ-PROF-NAME",
      "given": "An extension loaded without the identity permissions this work adds, older than the installed copy",
      "when": "the installed files gain those permissions and the extension reloads itself into them",
      "then": "it comes back enabled, attaches, and reports its profile's name -- an update never leaves a user's extension disabled for a permission it now asks for",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    }
  ],
  "tasks": [
    {
      "id": "TASK-PROF-TRANSPORT",
      "purpose": "Several connections per server on both pipe backends, a bound, per-connection serving and state, the other-browser refusal, and the relay passing the profile on",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-SINGLE"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-PROF-CTEST",
        "EV-PROF-LINUX",
        "EV-PROF-LIVE-REGRESSION",
        "EV-PROF-LIVE-UPGRADE",
        "EV-PROF-RED-SEVERAL",
        "EV-PROF-RED-INDEPENDENT",
        "EV-PROF-RED-OTHER-BROWSER",
        "EV-PROF-RED-NO-WORK",
        "EV-PROF-RED-OLDER-RELAY",
        "EV-PROF-RED-NO-WORK-LIVE"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-PROF-EXTENSION",
      "purpose": "The profile's name and email, the options page, focus tracking, the profileState and findTab commands, and the profile in listings",
      "acceptance": [
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-SINGLE",
        "AC-PROF-UPGRADE"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        },
        {
          "path": "browser/extension/manifest.json",
          "action": "modify"
        },
        {
          "path": "browser/extension/options.html",
          "action": "create"
        },
        {
          "path": "browser/extension/options.js",
          "action": "create"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "action": "create"
        },
        {
          "path": "CMakeLists.txt",
          "action": "modify"
        },
        {
          "path": "package.json",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-PROF-UNIT-JS",
        "EV-PROF-CTEST",
        "EV-PROF-LIVE-UPGRADE",
        "EV-PROF-LIVE-TWO",
        "EV-PROF-RED-NAME-EXT",
        "EV-PROF-RED-OPTIONS",
        "EV-PROF-RED-NAME-RACE",
        "EV-PROF-RED-UPGRADE",
        "EV-PROF-RED-OPTIONS-LIVE",
        "EV-PROF-RED-SINGLE",
        "EV-PROF-RED-NAME-SERVER"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-PROF-ROUTING",
      "purpose": "Route, merge and fan out calls across connections; keep refs and notices per connection; the profile argument; the status listing; the instructions",
      "acceptance": [
        "AC-PROF-INDEPENDENT",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE"
      ],
      "depends_on": [
        "TASK-PROF-TRANSPORT"
      ],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "action": "modify"
        },
        {
          "path": "src/browser_control.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge.cpp",
          "action": "modify"
        },
        {
          "path": "src/browser_contract.cpp",
          "action": "modify"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-PROF-CTEST",
        "EV-PROF-LINUX",
        "EV-PROF-LIVE-TWO",
        "EV-PROF-LIVE-REGRESSION",
        "EV-PROF-RED-INDEPENDENT",
        "EV-PROF-RED-NEW-TAB",
        "EV-PROF-RED-BY-TAB",
        "EV-PROF-RED-ALL",
        "EV-PROF-RED-STATUS",
        "EV-PROF-RED-SINGLE"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-PROF-LIVE",
      "purpose": "A live suite with two profiles of one headed Chrome under Xvfb: names, routing, listings, release, independence, and the options page rename; run in CI on Linux",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-UPGRADE"
      ],
      "depends_on": [
        "TASK-PROF-TRANSPORT",
        "TASK-PROF-EXTENSION",
        "TASK-PROF-ROUTING"
      ],
      "changes": [
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "action": "create"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "action": "modify"
        },
        {
          "path": ".github/workflows/quality.yml",
          "action": "modify"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-PROF-LIVE-TWO",
        "EV-PROF-LIVE-UPGRADE",
        "EV-PROF-RED-OPTIONS-LIVE",
        "EV-PROF-RED-UPGRADE",
        "EV-PROF-RED-SEVERAL",
        "EV-PROF-RED-INDEPENDENT",
        "EV-PROF-RED-NAME-EXT",
        "EV-PROF-RED-NEW-TAB",
        "EV-PROF-RED-BY-TAB",
        "EV-PROF-RED-ALL",
        "EV-PROF-RED-STATUS"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-PROF-DOCS",
      "purpose": "Say how profiles are named, chosen and listed, and what the limits are, in the repo and on the release page; number the release 1.10.0",
      "acceptance": [
        "AC-PROF-NEW-TAB",
        "AC-PROF-STATUS"
      ],
      "depends_on": [
        "TASK-PROF-ROUTING",
        "TASK-PROF-EXTENSION"
      ],
      "changes": [
        {
          "path": "README.md",
          "action": "modify"
        },
        {
          "path": "CHANGELOG.md",
          "action": "modify"
        },
        {
          "path": "docs/TOOLS.md",
          "action": "modify"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "action": "modify"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "action": "modify"
        },
        {
          "path": "docs/SECURITY.md",
          "action": "modify"
        },
        {
          "path": "PLAN.md",
          "action": "modify"
        },
        {
          "path": "docs/releases/v1.10.0.md",
          "action": "create"
        },
        {
          "path": "docs/QUALITY.md",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "action": "modify"
        },
        {
          "path": "package-lock.json",
          "action": "modify"
        },
        {
          "path": "vscode/package.json",
          "action": "modify"
        },
        {
          "path": "vscode/package-lock.json",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-PROF-CTEST",
        "EV-PROF-LIVE-TWO",
        "EV-PROF-RED-NEW-TAB",
        "EV-PROF-RED-STATUS"
      ],
      "blocker": null,
      "superseded_by": null
    }
  ],
  "evidence": [
    {
      "id": "EV-PROF-READINESS-1",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE",
        "AC-PROF-UPGRADE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the plan, the rules file and the pipe, session, control, contract and extension source, plus a measured headed-Chrome two-profile probe: ten findings, four of which (restart read as another Chrome, the permission upgrade, a failing profile in a listing, ties with no focus) changed the criteria before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/profiles/readiness-review.md",
        "sha256": "8c0ac775157fe2f7a574929d4a30db0e9201aef315e072cfed34cf9be9f743bf"
      },
      "red": null,
      "reason": "Scope and rules changed: release paths added, an unchanged header dropped, docs/QUALITY.md counts updated",
      "scope_sha256": "a8040f4ee611712722041fe1f3dc2aa3f4cde518841a72f02734d44992c9c8af",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        }
      ]
    },
    {
      "id": "EV-PROF-READINESS-2",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE",
        "AC-PROF-UPGRADE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review after the first readiness receipt went stale: release paths added to TASK-PROF-DOCS and an unchanged header dropped from TASK-PROF-ROUTING, the rules file's counts and live list updated, two implementation facts (a refused relay's reason discarded on Windows, unheld tabs taken first in the live suite) and one terminology fix; no requirement or criterion changed meaning; recorded as an addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/profiles/readiness-review.md",
        "sha256": "ea3a684dc274ec6e82144b7a72213ae7d60baf708bce157a04f44fbc72871822"
      },
      "red": null,
      "reason": "Scope changed: display_matrix_e2e.mjs added to TASK-PROF-LIVE after the first evidence pass",
      "scope_sha256": "f8cc10a3983927be24fc0c065a512630297fe54c74894cf78a099c80d609ce23",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "52492bcba8a7e7141683408e50fa18b47e055a89df237b17074cc3d3d6ede99d"
        }
      ]
    },
    {
      "id": "EV-PROF-READINESS-3",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE",
        "AC-PROF-UPGRADE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review after the first evidence pass: a profile attaching before its name was read (fixed in the extension, with a unit test and drill), static-analysis findings in the new code fixed, and one unexplained display-matrix check that did not recur, whose check now names the tab in front (display_matrix_e2e.mjs added to TASK-PROF-LIVE); no requirement or criterion changed; recorded as a second addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/profiles/readiness-review.md",
        "sha256": "5f6e52ab597e3a23b373721fc341999d3a81c4560e88d94c18cb6d650d621e6f"
      },
      "red": null,
      "reason": "Rules changed: docs/QUALITY.md JavaScript count 216 to 217",
      "scope_sha256": "0e96f24bf5ac1f5102d66413fbaa171121ca118b5dd0ad5b75c74fbaa7b1ae12",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "52492bcba8a7e7141683408e50fa18b47e055a89df237b17074cc3d3d6ede99d"
        }
      ]
    },
    {
      "id": "EV-PROF-READINESS-4",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE",
        "AC-PROF-UPGRADE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review after the first evidence pass: a profile attaching before its name was read (fixed in the extension, with a unit test and drill), static-analysis findings in the new code fixed, and one unexplained display-matrix check that did not recur, whose check now names the tab in front (display_matrix_e2e.mjs added to TASK-PROF-LIVE); no requirement or criterion changed; the rules file's JavaScript count updated to 217 for the new test; recorded as a second addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/profiles/readiness-review.md",
        "sha256": "a1096e344c6002d2b94d20cd50685f0a4a70297c818869dd695c13f45e41903e"
      },
      "red": null,
      "reason": "Review artifact extended with a third addendum after the second evidence pass",
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        }
      ]
    },
    {
      "id": "EV-PROF-READINESS-5",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE",
        "AC-PROF-UPGRADE"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Re-review after the second evidence pass: a port with no server was connected by its relay to the newest server and served as a second connection of the same profile (the relay now connects it nowhere; older relays are served alone from their Chrome), and the upgrade case's kept-name check was made to wait for one connection after its drill passed; no requirement, criterion or path changed; recorded as a third addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/profiles/readiness-review.md",
        "sha256": "f7a3fe8567654839753816ff6d1a383773f22e4acbb6e0f18b768ff5506eaac0"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        }
      ]
    },
    {
      "id": "EV-PROF-CTEST",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "--output-on-failure"
      ],
      "method": "MSVC Release build, all 25 ctest suites: test_browser_bridge_pipe 31/31 (several relays served together, each answering its own commands; the ninth refused while the eight keep working; one leaving leaves the others; names cleaned as untrusted text; another running Chrome refused and an exited one not; a relay older than 1.10.0 served only alone from its Chrome), test_browser_bridge_relay 36/36 (a new tab in the profile named, by email, without regard to case, or the last focused; calls following their tab and ref; listings and release across profiles with a failing one named; one leaving keeps the other's refs; status and notices naming each profile; the oldest winning a tie and an older extension unnamed and never focused; a relay told no server connecting nowhere), test_browser_contract (profile on four tools, checked and kept on this side), test_browser_mcp_server (the instructions sentence), and test_browser_extension_profiles; the built server smoked, 53 tools full and 14 read-only (windows-smoke.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/windows-ctest.txt",
        "sha256": "956606d41d9370223342d63e9c8f7f654e52e6b4a54299f794b573fcfcc19452"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "810b52304e4d0048b277149d57d7a219c3ee3943b76844d6a9d83b2efc50fe1d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "PLAN.md",
          "sha256": "94ef33d047fdb45da298e10abd1efd40fc6f94c6b7525790d1e1603c6b844906"
        },
        {
          "path": "README.md",
          "sha256": "3f48fe6f730290b77a5e737e8513877396c401a9a346e4eb9add9a158193592e"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "843ea4153aafb8d92f979849c53f2137573650077cc894eabc8253044212e14a"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "743e8e0e42bc0e33befef7b89dc427ccff8748fb80fef019e859935b1115010c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "6fdea7818fa8474284c20787ad203c372066426e1785c1ae1d8032de6d51851b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "57f893bb18f55cc14bbdbc0730d58ea3ce992bebcbad3f652ab8a77811c28954"
        },
        {
          "path": "docs/releases/v1.10.0.md",
          "sha256": "295ccc3e91bf5f4e4a1ad635a4f2d4a4f02b908256c489bf5e5c0d7ee6858fc8"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "5f9bba04275e85f538943b49d6a3b69e28ff88ff1280240ffa4cf42ca1f8b6df"
        },
        {
          "path": "package-lock.json",
          "sha256": "a413d7c57f3bd35b148b8648edb6a332c669916395bfa9d9b7fecf2fa5894944"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "9b7d8162e8099a35831df9401d779bcde9d8453e36d5d8ea41824324f240cc2e"
        },
        {
          "path": "vscode/package.json",
          "sha256": "d2d290437a456d2e6e31bd2cb0770ad1aefa21bb624a2d44270bb2764c952ae9"
        }
      ]
    },
    {
      "id": "EV-PROF-UNIT-JS",
      "acceptance": [
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-SINGLE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "All 12 JavaScript files, 217/217: the extension names its profile by its account email, the user's name over it with a rename taking effect at once and cleaned, a generated name kept across workers, a port offered servers before the name is read attaching once it is, profileState and findTab, the options page cleaning, saving and clearing a name; every earlier extension suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/windows-test-js.txt",
        "sha256": "548a65bc3499f6b3165016e2f8f8a82163adc3684c39ea67861e6e083f49560b"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-LINUX",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-OTHER-BROWSER",
        "AC-PROF-NAME",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS",
        "AC-PROF-SINGLE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "--output-on-failure"
      ],
      "method": "WSL2 Arch, a fresh sync with every source touched: GCC 16 Release build with no warnings and ctest 24/24 (the POSIX socket backend serving several relays; linux-ctest.txt); clang 22 build, run-clang-tidy clean (clang-tidy.txt), exhaustive cppcheck clean (cppcheck.txt), Semgrep 1.174.0 221 rules on 54 files, 0 findings (semgrep.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/linux-summary.txt",
        "sha256": "e943e0e9f00f32aeed53b08acfb6b1e862652e89010cd4b90c6e05da28492665"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "810b52304e4d0048b277149d57d7a219c3ee3943b76844d6a9d83b2efc50fe1d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "PLAN.md",
          "sha256": "94ef33d047fdb45da298e10abd1efd40fc6f94c6b7525790d1e1603c6b844906"
        },
        {
          "path": "README.md",
          "sha256": "3f48fe6f730290b77a5e737e8513877396c401a9a346e4eb9add9a158193592e"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "843ea4153aafb8d92f979849c53f2137573650077cc894eabc8253044212e14a"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "743e8e0e42bc0e33befef7b89dc427ccff8748fb80fef019e859935b1115010c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "6fdea7818fa8474284c20787ad203c372066426e1785c1ae1d8032de6d51851b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "57f893bb18f55cc14bbdbc0730d58ea3ce992bebcbad3f652ab8a77811c28954"
        },
        {
          "path": "docs/releases/v1.10.0.md",
          "sha256": "295ccc3e91bf5f4e4a1ad635a4f2d4a4f02b908256c489bf5e5c0d7ee6858fc8"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "5f9bba04275e85f538943b49d6a3b69e28ff88ff1280240ffa4cf42ca1f8b6df"
        },
        {
          "path": "package-lock.json",
          "sha256": "a413d7c57f3bd35b148b8648edb6a332c669916395bfa9d9b7fecf2fa5894944"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "9b7d8162e8099a35831df9401d779bcde9d8453e36d5d8ea41824324f240cc2e"
        },
        {
          "path": "vscode/package.json",
          "sha256": "d2d290437a456d2e6e31bd2cb0770ad1aefa21bb624a2d44270bb2764c952ae9"
        }
      ]
    },
    {
      "id": "EV-PROF-LIVE-TWO",
      "acceptance": [
        "AC-PROF-SEVERAL",
        "AC-PROF-INDEPENDENT",
        "AC-PROF-NAME",
        "AC-PROF-OPTIONS",
        "AC-PROF-NEW-TAB",
        "AC-PROF-BY-TAB",
        "AC-PROF-ALL",
        "AC-PROF-STATUS"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "xvfb-run",
        "-a",
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--headed",
        "--second-profile=Profile 2",
        "tests/e2e/profiles_e2e.mjs"
      ],
      "method": "Two profiles of one headed Chrome for Testing 153 under Xvfb, one server, 14/14 (live-profiles-two.log): both served at once; each with its own generated name; each renamed on its own options page and called so at once with nothing reloaded; new tabs in the profile named, matched without regard to case; a profile not connected refused naming those that are; with none named, the profile whose window was last focused; calls following their tab, and a tab never seen found in its profile; browser_tabs and browser_windows naming each entry's profile; browser_release letting go in both; one profile reloading leaving the other's refs working; status listing the profiles still connected with versions",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/live-profiles-two.json",
        "sha256": "894f71c3defe1ec2ef37f55efc27ac7557eae02bfd602f4e746ca7ec9a58a2a5"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "810b52304e4d0048b277149d57d7a219c3ee3943b76844d6a9d83b2efc50fe1d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "PLAN.md",
          "sha256": "94ef33d047fdb45da298e10abd1efd40fc6f94c6b7525790d1e1603c6b844906"
        },
        {
          "path": "README.md",
          "sha256": "3f48fe6f730290b77a5e737e8513877396c401a9a346e4eb9add9a158193592e"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "843ea4153aafb8d92f979849c53f2137573650077cc894eabc8253044212e14a"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "743e8e0e42bc0e33befef7b89dc427ccff8748fb80fef019e859935b1115010c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "6fdea7818fa8474284c20787ad203c372066426e1785c1ae1d8032de6d51851b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "57f893bb18f55cc14bbdbc0730d58ea3ce992bebcbad3f652ab8a77811c28954"
        },
        {
          "path": "docs/releases/v1.10.0.md",
          "sha256": "295ccc3e91bf5f4e4a1ad635a4f2d4a4f02b908256c489bf5e5c0d7ee6858fc8"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "5f9bba04275e85f538943b49d6a3b69e28ff88ff1280240ffa4cf42ca1f8b6df"
        },
        {
          "path": "package-lock.json",
          "sha256": "a413d7c57f3bd35b148b8648edb6a332c669916395bfa9d9b7fecf2fa5894944"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "9b7d8162e8099a35831df9401d779bcde9d8453e36d5d8ea41824324f240cc2e"
        },
        {
          "path": "vscode/package.json",
          "sha256": "d2d290437a456d2e6e31bd2cb0770ad1aefa21bb624a2d44270bb2764c952ae9"
        }
      ]
    },
    {
      "id": "EV-PROF-LIVE-UPGRADE",
      "acceptance": [
        "AC-PROF-UPGRADE",
        "AC-PROF-SINGLE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--extension-version=1.0.0",
        "--extension-strip-permissions=identity,identity.email",
        "tests/e2e/profiles_e2e.mjs"
      ],
      "method": "One profile, the extension staged as 1.0.0 without the identity permissions, 4/4 (live-profiles-upgrade.log): it still names its profile; a forced probe for new servers, finding the one server held, never becomes a second connection; once the installed files ask for the permissions it reloads itself into them and comes back enabled; after the update it has chrome.identity and keeps its profile's name, read once the old connection is gone",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/live-profiles-upgrade.json",
        "sha256": "8926f56c6edded56caec8dfc8ed214e645a4601c006ba34055fb1345acd50407"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-LIVE-REGRESSION",
      "acceptance": [
        "AC-PROF-SINGLE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/multi_agent_e2e.mjs"
      ],
      "method": "Every live suite that existed before this work, one profile, Chrome for Testing 153 on Linux, from the same build (live-*.json and .log): display matrix 35 configurations, full browser suite 177 cases, user interference 10/10, multi-agent 25/25, clipboard 24/24, extension version same 6/6, older reloading itself 12/12, released 1.8.2 8/8",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/linux-summary.txt",
        "sha256": "e943e0e9f00f32aeed53b08acfb6b1e862652e89010cd4b90c6e05da28492665"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "f0b1226866dcb37a5992424334595af4b1f741d800f14836d1fcf243aa83e4e1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-SEVERAL",
      "acceptance": [
        "AC-PROF-SEVERAL"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_pipe$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: the server admits a ninth relay. Mutated, rebuilt, test_browser_bridge_pipe failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "the server admits a ninth relay",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "ninthRelay_isRefusedAndTheEightKeepWorking",
        "observed_diagnostic": "ninthRelay_isRefusedAndTheEightKeepWorking",
        "before": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "59daa2d58dbb5e106b2d98f613eb5ad8aab48e78ad411ef23bbf949096caa4eb"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-INDEPENDENT",
      "acceptance": [
        "AC-PROF-INDEPENDENT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a connection leaving forgets every profile's tabs. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a connection leaving forgets every profile's tabs",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profiles_oneLeavingKeepsTheOthersRefs",
        "observed_diagnostic": "profiles_oneLeavingKeepsTheOthersRefs",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "bb6058ee3fca833b166a43d72024ffcaa70b8e3c567e948de7a80f8bc01291d2"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-OTHER-BROWSER",
      "acceptance": [
        "AC-PROF-OTHER-BROWSER"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_pipe$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: an exited Chrome still counts as being served. Mutated, rebuilt, test_browser_bridge_pipe failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "an exited Chrome still counts as being served",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "otherBrowser_isRefusedOnlyWhileItsChromeRuns",
        "observed_diagnostic": "otherBrowser_isRefusedOnlyWhileItsChromeRuns",
        "before": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "aabad258b85763004b43819d9396b41c27d1ce7edb2f9165c1fe56107610f3f6"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "d32c6ac2ec7dab8e7580ee8d6b6d9df87772859e14a6ffaf5359fe63f12c7c88",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-NAME-SERVER",
      "acceptance": [
        "AC-PROF-NAME"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_pipe$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a profile name is bounded by the email's limit. Mutated, rebuilt, test_browser_bridge_pipe failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a profile name is bounded by the email's limit",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profile_isCleanedAsUntrustedText",
        "observed_diagnostic": "profile_isCleanedAsUntrustedText",
        "before": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "821a328458c4753cd8e46d92889f0bbf2fd37b3823c327419e44822ba58f3113"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-NEW-TAB",
      "acceptance": [
        "AC-PROF-NEW-TAB"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a window in front right now does not count. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a window in front right now does not count",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profiles_newTabGoesToTheOneNamedOrTheLastFocused",
        "observed_diagnostic": "profiles_newTabGoesToTheOneNamedOrTheLastFocused",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "42bdaf71aa0e101a1a5f729e4b961be32e2a575caeb35fbd8eba3d462dd315d3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "810b52304e4d0048b277149d57d7a219c3ee3943b76844d6a9d83b2efc50fe1d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "PLAN.md",
          "sha256": "94ef33d047fdb45da298e10abd1efd40fc6f94c6b7525790d1e1603c6b844906"
        },
        {
          "path": "README.md",
          "sha256": "3f48fe6f730290b77a5e737e8513877396c401a9a346e4eb9add9a158193592e"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "843ea4153aafb8d92f979849c53f2137573650077cc894eabc8253044212e14a"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "743e8e0e42bc0e33befef7b89dc427ccff8748fb80fef019e859935b1115010c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "6fdea7818fa8474284c20787ad203c372066426e1785c1ae1d8032de6d51851b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "57f893bb18f55cc14bbdbc0730d58ea3ce992bebcbad3f652ab8a77811c28954"
        },
        {
          "path": "docs/releases/v1.10.0.md",
          "sha256": "295ccc3e91bf5f4e4a1ad635a4f2d4a4f02b908256c489bf5e5c0d7ee6858fc8"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "5f9bba04275e85f538943b49d6a3b69e28ff88ff1280240ffa4cf42ca1f8b6df"
        },
        {
          "path": "package-lock.json",
          "sha256": "a413d7c57f3bd35b148b8648edb6a332c669916395bfa9d9b7fecf2fa5894944"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "9b7d8162e8099a35831df9401d779bcde9d8453e36d5d8ea41824324f240cc2e"
        },
        {
          "path": "vscode/package.json",
          "sha256": "d2d290437a456d2e6e31bd2cb0770ad1aefa21bb624a2d44270bb2764c952ae9"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-BY-TAB",
      "acceptance": [
        "AC-PROF-BY-TAB"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a call naming a tab goes to the current profile. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a call naming a tab goes to the current profile",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profiles_callsFollowTheirTab",
        "observed_diagnostic": "profiles_callsFollowTheirTab",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "7e8cf3a7a1488d1d99efa212520f48ebda6296b9b5dfd295d89e6165a1c371f7"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-ALL",
      "acceptance": [
        "AC-PROF-ALL"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: browser_tabs asks one profile only. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "browser_tabs asks one profile only",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profiles_listingsAndReleaseCoverEveryProfile",
        "observed_diagnostic": "profiles_listingsAndReleaseCoverEveryProfile",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "50247c49ab4acc2cbecd4242f0d3ce73eb4f974ec6dede8a7a0d37ff39e9f52f"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-STATUS",
      "acceptance": [
        "AC-PROF-STATUS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a version notice does not say which profile it is about. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a version notice does not say which profile it is about",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profiles_statusAndNoticesNameEachProfile",
        "observed_diagnostic": "profiles_statusAndNoticesNameEachProfile",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "852c4c93013aafe030b5ea35df280172d84f3163668d8718b84c7811c10207c7"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "ee17200d7a712fee02712120bd334ca5143afe0a32d342bd004c9335fb9dc128",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "810b52304e4d0048b277149d57d7a219c3ee3943b76844d6a9d83b2efc50fe1d"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "PLAN.md",
          "sha256": "94ef33d047fdb45da298e10abd1efd40fc6f94c6b7525790d1e1603c6b844906"
        },
        {
          "path": "README.md",
          "sha256": "3f48fe6f730290b77a5e737e8513877396c401a9a346e4eb9add9a158193592e"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "843ea4153aafb8d92f979849c53f2137573650077cc894eabc8253044212e14a"
        },
        {
          "path": "docs/MULTI_SESSION.md",
          "sha256": "743e8e0e42bc0e33befef7b89dc427ccff8748fb80fef019e859935b1115010c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "6fdea7818fa8474284c20787ad203c372066426e1785c1ae1d8032de6d51851b"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "57f893bb18f55cc14bbdbc0730d58ea3ce992bebcbad3f652ab8a77811c28954"
        },
        {
          "path": "docs/releases/v1.10.0.md",
          "sha256": "295ccc3e91bf5f4e4a1ad635a4f2d4a4f02b908256c489bf5e5c0d7ee6858fc8"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "5f9bba04275e85f538943b49d6a3b69e28ff88ff1280240ffa4cf42ca1f8b6df"
        },
        {
          "path": "package-lock.json",
          "sha256": "a413d7c57f3bd35b148b8648edb6a332c669916395bfa9d9b7fecf2fa5894944"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "9b7d8162e8099a35831df9401d779bcde9d8453e36d5d8ea41824324f240cc2e"
        },
        {
          "path": "vscode/package.json",
          "sha256": "d2d290437a456d2e6e31bd2cb0770ad1aefa21bb624a2d44270bb2764c952ae9"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-SINGLE",
      "acceptance": [
        "AC-PROF-SINGLE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: an extension older than profiles counts as focused. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "an extension older than profiles counts as focused",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "profiles_oldestWinsATieAndAnOlderExtensionIsUnnamed",
        "observed_diagnostic": "profiles_oldestWinsATieAndAnOlderExtensionIsUnnamed",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "c6d48604edc85cdabef79daca388183a6649fbb23c339bbed16a3f977fde5e22"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "f0b1226866dcb37a5992424334595af4b1f741d800f14836d1fcf243aa83e4e1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-NO-WORK",
      "acceptance": [
        "AC-PROF-SINGLE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_relay$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a relay told no server connects to the newest anyway. Mutated, rebuilt, test_browser_bridge_relay failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a relay told no server connects to the newest anyway",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "selectRecord_honoursTheSessionTheExtensionNamed",
        "observed_diagnostic": "selectRecord_honoursTheSessionTheExtensionNamed",
        "before": [
          {
            "path": "src/browser_bridge_relay_common.cpp",
            "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay_common.cpp",
            "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay_common.cpp",
            "sha256": "710642b655f4fdc79a038951a3a255e9b990e7d39421d906c6d444d410022f43"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "f0b1226866dcb37a5992424334595af4b1f741d800f14836d1fcf243aa83e4e1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-OLDER-RELAY",
      "acceptance": [
        "AC-PROF-SINGLE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-R",
        "^test_browser_bridge_pipe$",
        "-V"
      ],
      "method": "Drill in the WSL mirror: a 1.9.0 relay is served beside another connection of its Chrome. Mutated, rebuilt, test_browser_bridge_pipe failed as expected, restored byte for byte (mirror matched source), rebuilt and green (unit-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/unit-red-drills.txt",
        "sha256": "a58d9616d80199f861ffd5b00ddf7316fc96b3b9089ed5af73c00d8f1e05c9e1"
      },
      "red": {
        "mutation": "a 1.9.0 relay is served beside another connection of its Chrome",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "olderRelay_isServedOnlyAloneFromItsChrome",
        "observed_diagnostic": "olderRelay_isServedOnlyAloneFromItsChrome",
        "before": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_pipe_common.cpp",
            "sha256": "c3ff9e4440cc042295395dfb46ef2403084177acdceebb722c263afe7f7179e3"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "f0b1226866dcb37a5992424334595af4b1f741d800f14836d1fcf243aa83e4e1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-NO-WORK-LIVE",
      "acceptance": [
        "AC-PROF-SINGLE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--extension-version=1.0.0",
        "--extension-strip-permissions=identity,identity.email",
        "tests/e2e/profiles_e2e.mjs"
      ],
      "method": "Drill in the WSL mirror: a probe's port with no server becomes a second connection. Mutated, rebuilt, the upgrade live case failed as expected, restored byte for byte (mirror matched source), rebuilt and green (live-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/live-red-drills.txt",
        "sha256": "81ba445581806f44217345ffde8ab4aeef30243abf3810917253cbb409d5830b"
      },
      "red": {
        "mutation": "a probe's port with no server becomes a second connection",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "FAIL a port the extension has no server for never becomes a second connection",
        "observed_diagnostic": "FAIL a port the extension has no server for never becomes a second connection",
        "before": [
          {
            "path": "src/browser_bridge_relay_common.cpp",
            "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_relay_common.cpp",
            "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_relay_common.cpp",
            "sha256": "710642b655f4fdc79a038951a3a255e9b990e7d39421d906c6d444d410022f43"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "f0b1226866dcb37a5992424334595af4b1f741d800f14836d1fcf243aa83e4e1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-UPGRADE",
      "acceptance": [
        "AC-PROF-UPGRADE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--extension-version=1.0.0",
        "--extension-strip-permissions=identity,identity.email",
        "tests/e2e/profiles_e2e.mjs"
      ],
      "method": "Drill in the WSL mirror: a generated name is not kept, so a reload renames the profile. Mutated, rebuilt, the upgrade live case failed as expected, restored byte for byte (mirror matched source), rebuilt and green (live-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/live-red-drills.txt",
        "sha256": "81ba445581806f44217345ffde8ab4aeef30243abf3810917253cbb409d5830b"
      },
      "red": {
        "mutation": "a generated name is not kept, so a reload renames the profile",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "FAIL after the update it has the identity permission and keeps its profile's name",
        "observed_diagnostic": "FAIL after the update it has the identity permission and keeps its profile's name",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "e309bd6901521920a599879837e9c31dd44f5917bd7a8a24b7969144cf19d1ad"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-OPTIONS-LIVE",
      "acceptance": [
        "AC-PROF-OPTIONS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "xvfb-run",
        "-a",
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--headed",
        "--second-profile=Profile 2",
        "tests/e2e/profiles_e2e.mjs"
      ],
      "method": "Drill in the WSL mirror: a name saved on the options page is not picked up until a reload. Mutated, rebuilt, the two live case failed as expected, restored byte for byte (mirror matched source), rebuilt and green (live-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/live-red-drills.txt",
        "sha256": "81ba445581806f44217345ffde8ab4aeef30243abf3810917253cbb409d5830b"
      },
      "red": {
        "mutation": "a name saved on the options page is not picked up until a reload",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "FAIL each profile renamed on its options page is called so at once",
        "observed_diagnostic": "FAIL each profile renamed on its options page is called so at once",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "acd82945d29272d1f3cac85c3b8ba54804d0b4e1423aa8e001c7b932046b67a9"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-NAME-EXT",
      "acceptance": [
        "AC-PROF-NAME"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_profiles.mjs"
      ],
      "method": "Drill on Windows: the email wins over the user's name for a profile. Mutated, the profiles suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/extension-red-drills.txt",
        "sha256": "d9914db0939ae06018f6f00aeb2a40960810a39792d7f8c6e70bef5a95931f6c"
      },
      "red": {
        "mutation": "the email wins over the user's name for a profile",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the user's name for a profile wins over its email",
        "observed_diagnostic": "the user's name for a profile wins over its email",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "189b400394d9af98ba70a9d16bfd77a463b1c960b2c1a18f168c6bf1dedc76df"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-OPTIONS",
      "acceptance": [
        "AC-PROF-OPTIONS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_profiles.mjs"
      ],
      "method": "Drill on Windows: the options page saves the name as typed, uncleaned. Mutated, the profiles suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/extension-red-drills.txt",
        "sha256": "d9914db0939ae06018f6f00aeb2a40960810a39792d7f8c6e70bef5a95931f6c"
      },
      "red": {
        "mutation": "the options page saves the name as typed, uncleaned",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the options page cleans a name the way the worker reads it",
        "observed_diagnostic": "the options page cleans a name the way the worker reads it",
        "before": [
          {
            "path": "browser/extension/options.js",
            "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
          }
        ],
        "after": [
          {
            "path": "browser/extension/options.js",
            "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/options.js",
            "sha256": "ace6c70b418ad17fff7c1c602c48b37f4ae29d9a68b0765b6e9c27b3fb5df494"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    },
    {
      "id": "EV-PROF-RED-NAME-RACE",
      "acceptance": [
        "AC-PROF-NAME"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_profiles.mjs"
      ],
      "method": "Drill on Windows: a port attaches before the profile's name has been read. Mutated, the profiles suite failed that test, restored byte for byte and green (extension-red-drills.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/profiles/extension-red-drills.txt",
        "sha256": "d9914db0939ae06018f6f00aeb2a40960810a39792d7f8c6e70bef5a95931f6c"
      },
      "red": {
        "mutation": "a port attaches before the profile's name has been read",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a port offered servers before the profile's name is read attaches once it is, named",
        "observed_diagnostic": "a port offered servers before the profile's name is read attaches once it is, named",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9cd86a534266b7880bcd4bc28ec561a6105951cf18ac3bb8b9ead665daa89ebd"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "95fccfb49f2bd9b39f9b1f78ed37f4f4631ee6518735d0847505ded39b360936",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.3",
          "wsl2-arch-node": "v26.9.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/quality.yml",
          "sha256": "90f995aacad75304f7a668e6f18074d2c0f3d86239c5e55527db52e1c14fd3da"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "2696ab21703bd264c412bc3c1428da43dd538f49fcfab5240a0c107bda0c4b4c"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "f07e86a5ab761628ce2e9f351e6eecb0008f9342ee0dd03f14ca10b9b6e79413"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "8ea2c5d25938d7693f02a10ec8cef0028794fdeb0705bb0db11f2c905c64741b"
        },
        {
          "path": "browser/extension/options.html",
          "sha256": "c2660afb9f594b0a869d7ff5100f064138bae9a02597e4c4ec875aa7ce9fb56d"
        },
        {
          "path": "browser/extension/options.js",
          "sha256": "b623989419f2423f594dfa643d005aa53dcb2a7d3f28d7e2a4103435a7eaf8b7"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "dff6cffb36b1604d9825a302605d7ae57083d1f0472cb34267a3bdd3b871b32d"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge.h",
          "sha256": "0bac48b2d3395e7de88aa4a74d0d3dba2262351a7dedc2e4ea29b415c0d6b25b"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "a618ca576f5519e19a997165c4511136b22a257b54c2bdd8e251bf8ab59c9a3e"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "171137826f8ac32ef7effe456bc751d94363ad8a45f2b47526dfd35213f20296"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "7af897e43b29f9027675a4fa4708e71c6cd1803293efa2db90973053fa45f03c"
        },
        {
          "path": "package.json",
          "sha256": "8668af43c71337a65423ba860f923af954c376879a23ac1795768bfd8da053a2"
        },
        {
          "path": "src/browser_bridge.cpp",
          "sha256": "25342937619669c14ef0ddbf388ebc341bc165f280a871f00774dc201dac34e6"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "a3515f5671509abe0ff78c194bcc59cfa69aa0ed327add58ce6fce722635fa1e"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "3554a3b6eacdf721ce820a4987d844c098d23943f6b658bbf6bcf606b6ddb0d3"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "a708b884640fc998195e6a0c6f8adf6863449ea22cacb51879b4eee23d0bb4fc"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "ed725583b63f386aceabdfd7617938807bde36125693db71634f80ae2e9f5140"
        },
        {
          "path": "src/browser_contract.cpp",
          "sha256": "38cfad1b2ddb4cd0939dadfeb850715c9a1493a538e4b03cdd5fc92aa5a80344"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "69f4e6baed95e9e40231dbd1fb11d2401111e04bf87a0428e9c12dfc175ca639"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "2e1ccf482a96bcb7dd4f0d1788abc10dcf6dbbc89fdf7fce100d891859b85add"
        },
        {
          "path": "tests/e2e/display_matrix_e2e.mjs",
          "sha256": "79094f93c8f56e0941ce47f949864813e1d7500e8424e2331b90a2f511e233a9"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "02bb4dc59adb70843c40b562af97c04375fa8c1b36ab5faf28d8e4a5e7ea1e62"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ee460859c95a7319590228af68675549b88cad3fdf2c98ad94f90368b876fa25"
        },
        {
          "path": "tests/e2e/profiles_e2e.mjs",
          "sha256": "35ee093bcf003dda39d7929d2155e9b4129f2b151fff4344a7b57a09c0c4a1a3"
        },
        {
          "path": "tests/test_browser_bridge_pipe.cpp",
          "sha256": "62b3ecb917e5ef685b71c2ce97b04935d0b24d9ab9394d1204d5976a614cd08e"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "ebf42f5cb76fb42e76b464f091cbf29ff5a0a33e6bf9e6b69fb562c7bb732159"
        },
        {
          "path": "tests/test_browser_contract.cpp",
          "sha256": "50f63ae74ffe3962a6e1d06d14ef365eebf054ffefe472ade4274f53b0090046"
        },
        {
          "path": "tests/test_browser_extension_profiles.mjs",
          "sha256": "2f38c882f33066e71062ad8212a1f235601f432f247e2176cdb7ea48891b50ef"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "e0dd5d73614078b3af6d46d194acf0400abf3bb8eabdce42930084ea622ee204"
        }
      ]
    }
  ],
  "checkpoint": null
}
```
