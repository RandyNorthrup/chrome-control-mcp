# Noticing an extension older or newer than its server

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them.

## Why

An update replaces the server and the extension's files on disk together, but Chrome does not
reload an unpacked extension when its files change, and an MCP client does not restart a server it
is already running. So after an update the three running pieces -- the server an agent talks to,
the relay Chrome starts, and the extension Chrome runs -- can be three different versions, and the
only thing they compared was the bridge protocol number. When that number did not change, which is
most releases, nothing anywhere said the extension was old:

- a 1.9.0 server beside a 1.8.x extension advertises `browser_clipboard`, which the extension
  answers with "Unknown command: clipboard", and the copy and paste keys an agent presses still
  reach the system clipboard -- which the server's own instructions tell agents they never do;
- the 1.8.2 fix that makes `browser_release` close an agent's popups lives in the extension, so a
  user who updated but did not reload kept the bug, and reported it;
- a server left running across an update keeps serving the old version, and nothing tells the
  agent, or the user through it, to restart it.

This is a public MCP server used from many clients, so the telling has to happen in the one place
every client shows: the tool reply.

## Design

**Versions travel with the handshake.** The extension already answers the relay's offer with
`attach_session`; that answer now carries the extension's manifest version. The relay passes it on
in its `hello` to the server, with its own version -- the relay is the program Chrome starts from
the installed copy, so its version is what is installed. The server's `welcome` carries the
server's version, and the relay's `bridge_ready` to the extension carries the installed version.
Every new field is optional on every hop and is validated as `major.minor.patch` (anything else
reads as "not said"). An older side ignores fields it does not know -- the server's hello check
and the extension's frame handlers already do -- and a missing field means the other side is older
than this change, which is itself the diagnosis: an extension that reports no version is older than
1.9.0.

**The server tells the agent, once per connection.** When a new relay connection's versions
disagree with the server's, the first browser tool reply on that connection carries one extra text
block -- after the reply's own content, so a reply that is JSON stays JSON -- naming the versions
and the one action that fixes it:

- an extension older than the server, or one that did not say: reload it at `chrome://extensions`
  (and, for one older than 1.9.0, what is missing until then: `browser_clipboard`, and copy and
  paste keys that would otherwise reach the system clipboard);
- a newer copy installed than the server running: restart the server in the MCP client;
- an extension newer than the server: restart or update the server;
- a server newer than the installed copy the extension comes from: install it.

`browser_extension_status` reports the running extension's version, the installed version, the
server's, and the same notice, whenever asked. A command the running extension does not know fails
with its own "Unknown command" error followed by why and what to do.

**The extension reloads itself, from 1.9.0 on, when nobody is using it.** When `bridge_ready`
reports an installed version newer than its own manifest, the files on disk were updated and Chrome
is running the old ones. The extension reloads once no session holds a tab, no command is running,
and none has run for 10 s -- checked 10 s after the report arrives, after each command, and on the
existing 30 s alarm. A command is never cut off mid-run: the check is repeated right before the
reload, and a command that starts in between makes it wait. The quiet period is what keeps an
agent that releases its last tab and at once opens another from landing in the second the reload
takes; a call that does land there fails before it starts, and the next one waits for the bridge
to come back, as calls already do after any extension reload. Once per installed version, remembered across the reload in
`chrome.storage.local`, like the protocol reload before it: an extension loaded from a folder that
was not updated comes back still old and does not reload again for that version. An installed
version equal to or older than its own never triggers it.

## Compatibility

| Running together                           | What happens                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| New server, new relay, extension < 1.9.0   | Works as before; the first reply says the extension is older than 1.9.0 and to reload |
| New server and relay, older running server | The older server ignores the new hello fields and works as before                     |
| New extension, relay < 1.9.0               | The relay ignores `version` in `attach_session`; no `bridge_ready` version, no reload |
| Everything the same version                | No notice, no reload; replies are byte-for-byte what they were                        |

The extension still speaks first only to answer the offer, and the reload starts no process: the
native port reconnects as it does after any extension reload, and servers wait for it as they
already do (`kRelayAttachGrace`).

## Non-goals and limits

- A 1.8.x extension cannot reload itself into 1.9.0: the code that would do it arrives with 1.9.0.
  That one update needs one manual reload, which the server's notice asks for.
- The server does not refuse copy and paste keys when the extension is too old to isolate them; it
  says so in the notice, and the extension's self-reload makes the state short-lived from 1.9.0 on.
- Versions are compared, not trusted for anything else: no capability is granted or withheld on
  the strength of a version a peer claims.

## Reuse

- The handshake frames and their tests (`relayHandshake`, `BrowserBridgePipeServer::handshake`,
  `test_browser_bridge_relay.cpp`'s `BrowserControl` round trips over a real pipe) carry the new
  fields; nothing new is opened or sent.
- The protocol self-reload (`reloadForNewerHost`, its once-per-value storage key) is the model for
  the version reload; the protocol one stays as it is.
- The existing reconnect alarm is the idle re-check; no new timer.
- `kBrowserExtensionVersion`, already held equal to the project version by
  `test_release_versions`, is the version the server and relay report.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-EXTVER",
    "title": "Notice an extension older or newer than its server",
    "scope_revision": 1,
    "brief": null,
    "brief_reason": "Scoped change in an existing product; README.md, docs/ARCHITECTURE.md and docs/RELEASES.md carry the product context, and docs/plans/per-agent-clipboard.md the 1.9.0 feature this protects",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "609d8c46043b"
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
      "id": "REQ-EXTVER-EXCHANGE",
      "statement": "On every connection the server learns the running extension's version and the installed version, and the extension learns the installed version, without any older server, relay or extension behaving differently",
      "priority": "critical",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-EXTVER-TELL",
      "statement": "When the running versions disagree, the agent is told through its own tool replies, in any MCP client, which versions are running and the one action that fixes it",
      "priority": "critical",
      "acceptance": [
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-EXTVER-RELOAD",
      "statement": "From 1.9.0 on the extension picks up newer installed files by reloading itself, only while no agent is using it, and never repeatedly for the same version",
      "priority": "critical",
      "acceptance": [
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-EXTVER-HANDSHAKE",
      "requirement": "REQ-EXTVER-EXCHANGE",
      "given": "An extension whose manifest says 1.8.9, a relay and a server of the current version",
      "when": "the extension answers the relay's offer and the relay completes its handshake with the server",
      "then": "attach_session carries 1.8.9, the server reports extension 1.8.9 and installed version equal to the relay's own, the welcome carries the server's version, and bridge_ready carries the installed version",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-COMPAT",
      "requirement": "REQ-EXTVER-EXCHANGE",
      "given": "A hello, attach_session or bridge_ready without the new fields, or with a version that is not major.minor.patch (empty, '1.9', markup, an over-long string)",
      "when": "the connection is made and commands run",
      "then": "the connection and every command behave exactly as before, and the missing or malformed version reads as not said",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-NOTICE",
      "requirement": "REQ-EXTVER-TELL",
      "given": "A connection whose extension is older than the server, did not report a version, or is newer; or whose installed version is newer than the server",
      "when": "the first browser tool call on that connection returns, success or error",
      "then": "its result carries one extra text block after its own content naming the versions and the action; later calls on the same connection carry none; a connection whose versions all match never carries one",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-STATUS",
      "requirement": "REQ-EXTVER-TELL",
      "given": "A server with or without a connected extension",
      "when": "browser_extension_status is called",
      "then": "it reports whether an extension is connected, how many times one has attached, and, when one is connected, its version (null when it did not say), the installed version, the server's version, and the notice for that connection (empty when they match)",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-UNKNOWN",
      "requirement": "REQ-EXTVER-TELL",
      "given": "An extension older than the server that answers a command with 'Unknown command: <cmd>'",
      "when": "the agent's call returns",
      "then": "the error keeps the extension's text and adds that the running extension is older than the server and how to reload it; the same error from an extension of the server's own version is passed through unchanged",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-RELOAD-IDLE",
      "requirement": "REQ-EXTVER-RELOAD",
      "given": "An extension that holds no tab and runs no command",
      "when": "bridge_ready reports an installed version newer than its manifest",
      "then": "it records that version and reloads once, and after the reload the bridge comes back and tool calls succeed",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-RELOAD-BUSY",
      "requirement": "REQ-EXTVER-RELOAD",
      "given": "A newer installed version reported while an agent holds a tab, or while a command is running",
      "when": "the agent keeps working, then releases its last tab",
      "then": "no reload happens while any tab is held, while any command runs, or within 10 s of the last command, and it happens once all three are over",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-EXTVER-RELOAD-ONCE",
      "requirement": "REQ-EXTVER-RELOAD",
      "given": "An extension that already reloaded for an installed version and came back still older (its folder was not updated), or an installed version equal to or older than its own",
      "when": "bridge_ready reports that version again, on any connection",
      "then": "it does not reload; a later, newer installed version reloads it once more",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    }
  ],
  "tasks": [
    {
      "id": "TASK-EXTVER-SERVER",
      "purpose": "Carry the versions through the relay and the server's handshake on both pipe backends, keep them per connection, build the notice, attach it to the first reply, report it from browser_extension_status, and explain an unknown command",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "action": "modify"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "action": "modify"
        },
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
          "path": "include/chrome_control_mcp/browser_control.h",
          "action": "modify"
        },
        {
          "path": "src/browser_control.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "action": "modify"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
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
          "path": "tests/test_browser_mcp_server.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-EXTVER-CTEST-2",
        "EV-EXTVER-LINUX-2",
        "EV-EXTVER-RED-SERVER-2",
        "EV-EXTVER-LIVE-2"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-EXTVER-EXTENSION",
      "purpose": "Report the manifest version in attach_session, read the installed version from bridge_ready, and reload once per newer installed version when no tab is held and no command runs",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "action": "create"
        },
        {
          "path": "CMakeLists.txt",
          "action": "modify"
        },
        {
          "path": "package.json",
          "action": "modify"
        },
        {
          "path": "tests/browser_model.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-EXTVER-UNIT-JS-2",
        "EV-EXTVER-CTEST-2",
        "EV-EXTVER-RED-UNIT-2",
        "EV-EXTVER-LIVE-2",
        "EV-EXTVER-RED-LIVE-2"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-EXTVER-LIVE",
      "purpose": "A live suite in Chrome for Testing: an extension reporting an older version reloads itself once, comes back, does not loop, and the first reply carries the notice; and the released 1.8.2 extension works beside the new server and is named older than 1.9.0. Run in CI",
      "acceptance": [
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-ONCE",
        "AC-EXTVER-COMPAT"
      ],
      "depends_on": [
        "TASK-EXTVER-SERVER",
        "TASK-EXTVER-EXTENSION"
      ],
      "changes": [
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "action": "create"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "action": "modify"
        },
        {
          "path": ".github/workflows/quality.yml",
          "action": "modify"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "action": "create"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-EXTVER-LIVE-2",
        "EV-EXTVER-RED-LIVE-2",
        "EV-EXTVER-RED-LIVE-MORE"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-EXTVER-DOCS",
      "purpose": "Say what is told, when the extension reloads itself, and what an update still needs from the user",
      "acceptance": [
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-RELOAD-IDLE"
      ],
      "depends_on": [
        "TASK-EXTVER-SERVER",
        "TASK-EXTVER-EXTENSION"
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
          "path": "docs/releases/v1.9.0.md",
          "action": "modify"
        },
        {
          "path": "docs/RELEASES.md",
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
          "path": "PLAN.md",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-EXTVER-CTEST-2",
        "EV-EXTVER-RED-SERVER-2",
        "EV-EXTVER-RED-UNIT-2"
      ],
      "blocker": null,
      "superseded_by": null
    }
  ],
  "evidence": [
    {
      "id": "EV-EXTVER-READINESS-1",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the plan, the rules file and the handshake, dispatch and extension source: nine findings, one of which (the reload racing an agent's next call) changed AC-EXTVER-RELOAD-BUSY and the design before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/readiness-review.md",
        "sha256": "1f4a0c1ffa4058ab8370502344f90d32e3733e8984e25ee40847b9065bb0ba42"
      },
      "red": null,
      "reason": "the plan changed during implementation: enabling paths and AC-EXTVER-STATUS's connection count",
      "scope_sha256": "651d39acd166fed0a1d817c4a8ca502d6caba56f2a5a9b712640c364391bb6e4",
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
          "sha256": "2aabc0eb85c01f86cf35632f6822fda9a436a918d504ad172e12a518a7928f9d"
        }
      ]
    },
    {
      "id": "EV-EXTVER-READINESS-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review after the first readiness receipt went stale: enabling paths added to three tasks, AC-EXTVER-STATUS gaining the connection count, the live harness found unfaithful (no Developer mode) and fixed, and finding 2 measured live; no requirement changed meaning; recorded as an addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/readiness-review.md",
        "sha256": "fc56752677cfa4201c313b5ab09a7891371da165683b59fecd356bbdaf93458c"
      },
      "red": null,
      "reason": "the rules file changed: docs/QUALITY.md's status table counts this work's suites",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "2aabc0eb85c01f86cf35632f6822fda9a436a918d504ad172e12a518a7928f9d"
        }
      ]
    },
    {
      "id": "EV-EXTVER-READINESS-3",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Re-review after the rules file's status table changed and the MCP instructions gained one sentence (pass a version note on to the user); no gate, requirement or criterion changed meaning; recorded as a second addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/readiness-review.md",
        "sha256": "95a1c8ed05829f4ec38c3af4219458a1abe8cf71f4acd668e9320fd8890e0a4d"
      },
      "red": null,
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
      "id": "EV-EXTVER-CTEST",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release"
      ],
      "method": "MSVC Release build, all 24 ctest suites: test_browser_bridge_relay's seven new tests (versions checked, the hello carrying both versions over a real pipe and the welcome the server's, an old hello unchanged, the notice for every combination, told once per connection and again on a new one, nothing told when versions match, an unknown command explained), test_browser_mcp_server (the notice as its own block, browser_extension_status's running versions, the instructions sentence), and test_browser_extension_versions; the built server smoked (windows-smoke.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/windows-ctest.txt",
        "sha256": "f701ed066c633671a966f47616c2aeefe26b92fab55d6b093794c3f457052d11"
      },
      "red": null,
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-UNIT-JS",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "All eleven JavaScript suites, 210/210, including test_browser_extension_versions.mjs (6 tests driving the worker through real frames against the browser model with runtime.reload, getManifest and storage observable): attach_session carries the manifest version; a newer install reloads an idle extension once, a quiet period after the report; never under a held tab, a running command or within the quiet period; a command starting while storage answers stops it and a later look still reloads; once per version with no loop; equal, older, malformed or absent versions never reload",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/windows-test-js.txt",
        "sha256": "687b4fc4e5902a99fb309ccbd30cb4caba6bc91d3ac8ad453dfdf14729fafa4a"
      },
      "red": null,
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-LINUX",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build"
      ],
      "method": "GCC Release build in WSL Arch, all 23 ctest suites: the same relay and dispatch tests over the POSIX socket backend, whose handshake carries the versions separately from Windows'; clang-tidy on the changed C++ clean (clang-tidy.txt) and Semgrep 1.174.0 0 findings (semgrep.txt)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/linux-ctest.txt",
        "sha256": "333869e7193ded5fa7228b85ed6d6199d2a273ee1631d8e56c3907051405d393"
      },
      "red": null,
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-LIVE",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "behavior",
      "status": "stale",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/extension_version_e2e.mjs"
      ],
      "method": "Live suite in headless Chrome for Testing 153 on Linux in three cases (live-current/older/released .json and .log): same version 6/6 (nothing said, no reload); --extension-version=1.0.0 12/12 (told once per connection, reloaded itself no sooner than its quiet period, came back still 1.0.0 with the version remembered, told again on the new connection, no second reload in 40 s, bridge working after); --extension=<released 1.8.2> 8/8 (named older than 1.9.0, browser_clipboard explained, everything else working, no reload). Same run: clipboard 24/24, multi-agent 25/25, interference 10/10, full suite 48 tools / 177 cases",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/live-summary.txt",
        "sha256": "f198ff06fffbfd7542b765474ff5fbbda9e27781c0972849b7f064f148cc7dc6"
      },
      "red": null,
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-UNIT",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "node",
        "drill.mjs",
        "browser/extension/background.js",
        "tests/test_browser_extension_versions.mjs"
      ],
      "method": "Six drills in the extension, each failing its named test and restored byte for byte with a green rerun: no version in attach_session, held tabs ignored, no quiet period, no once-per-version memory, no re-check after storage answers, an equal version counted as newer. Fingerprints are of the once-per-version drill",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/unit-red-drills.txt",
        "sha256": "0b74ad5b7a9637aaa22cddd5c5779419303708698bd0803f42f44be135091bb1"
      },
      "red": {
        "mutation": "the stored version is never consulted: it reloads again for a version it already reloaded for",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "once per version",
        "observed_diagnostic": "once per version",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "0ac16f62fdba3a9edc017db274832a389fcdd0be13534056dde64255dfc139d1"
          }
        ]
      },
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-SERVER",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge_relay$"
      ],
      "method": "Five drills in the server, each rebuilt into test_browser_bridge_relay, failing its named test, restored byte for byte, rebuilt and green: the relay's hello dropping the extension's version, versions taken unchecked, the notice told on every call, an unknown command passed on bare, browser_extension_status without the notice. Fingerprints are of the told-every-call drill",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/server-red-drills.txt",
        "sha256": "ff6879154681be4db96d76e6a7554a08d5fff9dec61b63ea74f13fb5bf1bf741"
      },
      "red": {
        "mutation": "the notice is never marked told, so every reply on a connection carries it",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "control_toldOncePerConnectionWhenVersionsDisagree",
        "observed_diagnostic": "control_toldOncePerConnectionWhenVersionsDisagree",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "7301fbb720126269af6fc0bd3f608b0b69559d0ceea5df6b80f034ce752fffad"
          }
        ]
      },
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-LIVE",
      "acceptance": [
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "red",
      "status": "stale",
      "command": [
        "bash",
        "wsl_phase.sh",
        "drills"
      ],
      "method": "Three mutations staged into the WSL mirror and its build, the older-extension live case run against each, then the mirror re-synced, its mutated files made newer than their objects so they rebuild, and the case run green: the reload remembering nothing (it reloaded again), bridge_ready's version ignored (no reload), the server telling nothing (both notice checks failed). Fingerprints are of the no-memory mutation",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/live-red-drills.txt",
        "sha256": "9ef2e5247faa6a73c7d55a1dc666c48059fafcd649a2a718043e95e1754ad4f6"
      },
      "red": {
        "mutation": "the stored version is never consulted, live: the extension reloads again for the same version",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "it does not reload again for that version: no loop",
        "observed_diagnostic": "FAIL it does not reload again for that version: no loop",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "0ac16f62fdba3a9edc017db274832a389fcdd0be13534056dde64255dfc139d1"
          }
        ]
      },
      "reason": "the plan's scope narrowed: docs/VERIFICATION.md left TASK-EXTVER-DOCS; re-run against the narrowed scope",
      "scope_sha256": "d1f73daf65e42475f790d1ec327088d7e0e4ee0cae70b5b4546b6e09d7c7e578",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/VERIFICATION.md",
          "sha256": "5fbf0fee9d9299c71132c83bd95af2faff58dfb763c1016ac1989795826ad5a5"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-READINESS-4",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Re-review after docs/VERIFICATION.md left TASK-EXTVER-DOCS (it records evidence; bound, every later CI result would stale the plan) and four drills were added for the criteria closure found without task red proof; no requirement or criterion changed; recorded as a third addendum to readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/readiness-review.md",
        "sha256": "1561c4cc250060423b4aa34f771e91ac64f97625ddd099e0d14dad4112a89221"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
      "id": "EV-EXTVER-CTEST-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release"
      ],
      "method": "MSVC Release build, all 24 ctest suites: test_browser_bridge_relay's seven new tests (versions checked, the hello carrying both versions over a real pipe and the welcome the server's, an old hello unchanged, the notice for every combination, told once per connection and again on a new one, nothing told when versions match, an unknown command explained), test_browser_mcp_server (the notice as its own block, browser_extension_status's running versions, the instructions sentence), and test_browser_extension_versions; the built server smoked (windows-smoke.txt) (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/windows-ctest.txt",
        "sha256": "fdd86887c53b0f908cf016f0b3ee0d9d8069095244e8bcc3e8eb3774086e2452"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-UNIT-JS-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "All eleven JavaScript suites, 210/210, including test_browser_extension_versions.mjs (6 tests driving the worker through real frames against the browser model with runtime.reload, getManifest and storage observable): attach_session carries the manifest version; a newer install reloads an idle extension once, a quiet period after the report; never under a held tab, a running command or within the quiet period; a command starting while storage answers stops it and a later look still reloads; once per version with no loop; equal, older, malformed or absent versions never reload (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/windows-test-js.txt",
        "sha256": "01933e3dc011f37669d54bb87b5d06d0352a50593bac85fb67e9805791dd51f4"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-LINUX-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build"
      ],
      "method": "GCC Release build in WSL Arch, all 23 ctest suites: the same relay and dispatch tests over the POSIX socket backend, whose handshake carries the versions separately from Windows'; clang-tidy on the changed C++ clean (clang-tidy.txt) and Semgrep 1.174.0 0 findings (semgrep.txt) (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/linux-ctest.txt",
        "sha256": "333869e7193ded5fa7228b85ed6d6199d2a273ee1631d8e56c3907051405d393"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-LIVE-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=~/ccmcp/.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/extension_version_e2e.mjs"
      ],
      "method": "Live suite in headless Chrome for Testing 153 on Linux in three cases (live-current/older/released .json and .log): same version 6/6 (nothing said, no reload); --extension-version=1.0.0 12/12 (told once per connection, reloaded itself no sooner than its quiet period, came back still 1.0.0 with the version remembered, told again on the new connection, no second reload in 40 s, bridge working after); --extension=<released 1.8.2> 8/8 (named older than 1.9.0, browser_clipboard explained, everything else working, no reload). Same run: clipboard 24/24, multi-agent 25/25, interference 10/10, full suite 48 tools / 177 cases (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/live-summary.txt",
        "sha256": "f198ff06fffbfd7542b765474ff5fbbda9e27781c0972849b7f064f148cc7dc6"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-SERVER-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "ctest",
        "--test-dir",
        "build",
        "-C",
        "Release",
        "-R",
        "^test_browser_bridge_relay$"
      ],
      "method": "Five drills in the server, each rebuilt into test_browser_bridge_relay, failing its named test, restored byte for byte, rebuilt and green: the relay's hello dropping the extension's version, versions taken unchecked, the notice told on every call, an unknown command passed on bare, browser_extension_status without the notice. Fingerprints are of the told-every-call drill (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/server-red-drills.txt",
        "sha256": "ff6879154681be4db96d76e6a7554a08d5fff9dec61b63ea74f13fb5bf1bf741"
      },
      "red": {
        "mutation": "the notice is never marked told, so every reply on a connection carries it",
        "baseline_exit": 0,
        "mutated_exit": 8,
        "restored_exit": 0,
        "expected_diagnostic": "control_toldOncePerConnectionWhenVersionsDisagree",
        "observed_diagnostic": "control_toldOncePerConnectionWhenVersionsDisagree",
        "before": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
          }
        ],
        "after": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_control.cpp",
            "sha256": "7301fbb720126269af6fc0bd3f608b0b69559d0ceea5df6b80f034ce752fffad"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-LIVE-2",
      "acceptance": [
        "AC-EXTVER-NOTICE",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "bash",
        "wsl_phase.sh",
        "drills"
      ],
      "method": "Three mutations staged into the WSL mirror and its build, the older-extension live case run against each, then the mirror re-synced, its mutated files made newer than their objects so they rebuild, and the case run green: the reload remembering nothing (it reloaded again), bridge_ready's version ignored (no reload), the server telling nothing (both notice checks failed). Fingerprints are of the no-memory mutation (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/live-red-drills.txt",
        "sha256": "49e46bba278c9f0bbdc3d9512a5d170cf36393b79c7383fd25ef5cedd5ce14d3"
      },
      "red": {
        "mutation": "the stored version is never consulted, live: the extension reloads again for the same version",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "it does not reload again for that version: no loop",
        "observed_diagnostic": "FAIL it does not reload again for that version: no loop",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "0ac16f62fdba3a9edc017db274832a389fcdd0be13534056dde64255dfc139d1"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-UNIT-2",
      "acceptance": [
        "AC-EXTVER-HANDSHAKE",
        "AC-EXTVER-COMPAT",
        "AC-EXTVER-RELOAD-IDLE",
        "AC-EXTVER-RELOAD-BUSY",
        "AC-EXTVER-RELOAD-ONCE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "drill.mjs",
        "browser/extension/background.js",
        "tests/test_browser_extension_versions.mjs"
      ],
      "method": "Seven drills in the extension, each failing its named test and restored byte for byte with a green rerun: no version in attach_session, held tabs ignored, no quiet period, no once-per-version memory, no re-check after storage answers, an equal version counted as newer, a version from bridge_ready taken unchecked. Fingerprints are of the once-per-version drill (rerun after the plan's scope narrowed)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/unit-red-drills.txt",
        "sha256": "18f3b6b0c13402e7ce6a1fcd95d59f1ba1cd4af6b744b397bff4d96a8209ff37"
      },
      "red": {
        "mutation": "the stored version is never consulted: it reloads again for a version it already reloaded for",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "once per version",
        "observed_diagnostic": "once per version",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "0ac16f62fdba3a9edc017db274832a389fcdd0be13534056dde64255dfc139d1"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    },
    {
      "id": "EV-EXTVER-RED-LIVE-MORE",
      "acceptance": [
        "AC-EXTVER-STATUS",
        "AC-EXTVER-UNKNOWN",
        "AC-EXTVER-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "bash",
        "wsl_drills_ev2.sh"
      ],
      "method": "Three more mutations staged into the WSL mirror and rebuilt, each with the live case that meets it: browser_extension_status without the notice (older case: its check failed), an unknown command passed on bare with the helper kept in use (released case: the browser_clipboard check failed), and a hello that says no extension version refused (released case: the released 1.8.2 extension never attached). The mirror was re-synced with the drilled files made newer than their objects, rebuilt, and both cases ran green. Fingerprints are of the compatibility mutation",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/extension-version/live-red-drills-2.txt",
        "sha256": "54a90ff5f41d4fcf77741574547e301c2b52595a88a90bfd02b8ed9b601aeaf7"
      },
      "red": {
        "mutation": "the server refuses a relay whose hello says no extension version, as an older extension's never does",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "did not attach within 180 s",
        "observed_diagnostic": "the extension did not attach within 180 s",
        "before": [
          {
            "path": "src/browser_bridge_pipe_posix.cpp",
            "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
          }
        ],
        "after": [
          {
            "path": "src/browser_bridge_pipe_posix.cpp",
            "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_bridge_pipe_posix.cpp",
            "sha256": "9568301138f542607fdfd09185156973b12f8314a169dccd4a6579db0692b21d"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "28bedbe66ca5fabc19951ba8f59fde2eb664a067dcad5f9315b63a74420dee0c",
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
          "sha256": "5f50ec2523f84afd7668e14b9a7d6ac77f48322551568c449cc6b3a1d336a385"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "c6764ea1a1dca91cd97cc374dd7955128f5d737539c9ce2712caf70a4f6ba3a2"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "ff2ab95b6e448268d16fa6f5bbc08f7e9dbc9ea0591deefe75d38db51a4c42dc"
        },
        {
          "path": "PLAN.md",
          "sha256": "4ac0e7d987cda9741a9d4fccf71a549b16e2f4f736c696da7437cb23355cc83c"
        },
        {
          "path": "README.md",
          "sha256": "03360e6d4eb2b088421d9210931e2ad3767450d6351dd5acf12bba3b56be2c7a"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "6ae6785bcd520a296e99b4447050fa98fb7e53d3c4caad26f948dabf01b59f80"
        },
        {
          "path": "docs/ARCHITECTURE.md",
          "sha256": "66d7e677e631fa2b695c515b3cc23e20c9caeb145c7bd06ec28603ed96e3a948"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "feffcf7c448a6523485632cf41bb167536a0b6b1cf5359efe4a59f5127bb74c1"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "209036a7c9533d40870e7b9da468f8025ce82553a51abade140a54e0309b55c0"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "9d13cee225f7b96332e74b09373f792aaa6f0b3dfb9ae9a64783703f8c06b045"
        },
        {
          "path": "docs/releases/v1.9.0.md",
          "sha256": "57914dc71c912a1056154b7fffec6e8039c41895f0551bca57836fb1b3824ca0"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_pipe.h",
          "sha256": "4dbd3db837ee13eff88a3bb9d16330de226e38db43a991b8815b974c11b83bf4"
        },
        {
          "path": "include/chrome_control_mcp/browser_bridge_relay.h",
          "sha256": "ed908a3e76a5cf6ac88a6096e4e4e4f4e7bef0d69b8e96e53289dcff341d5e5d"
        },
        {
          "path": "include/chrome_control_mcp/browser_control.h",
          "sha256": "19d24f3637c8cfc961dfa3900c734aabe25efcdf85df2e81fdc51db6b357dc85"
        },
        {
          "path": "include/chrome_control_mcp/mcp_dispatch.h",
          "sha256": "a20c451ea8435980a0d89455a153718e62010bcfb96c23d293614d337bcafe03"
        },
        {
          "path": "include/chrome_control_mcp/mcp_tools.h",
          "sha256": "2d24ab62532f2dfbf31f412d4479bd63c3d339c2d2f16e5e79cfddbf5a52111a"
        },
        {
          "path": "package.json",
          "sha256": "f720537172bc41690fa4e0a620c788dc1c388fdc52bb11b31ee5a504e4e91c61"
        },
        {
          "path": "src/browser_bridge_pipe.cpp",
          "sha256": "af4c8f67c9da82c95e90febb4b64180b7d9fe48b316ee05648f04b406853827b"
        },
        {
          "path": "src/browser_bridge_pipe_common.cpp",
          "sha256": "fd9518bdb8ee37e58f0a97e190ff15fe93fe367997bd8495bd7b6219afc732c6"
        },
        {
          "path": "src/browser_bridge_pipe_posix.cpp",
          "sha256": "d8b58d00bc68edc9a312c27a33e3e0b5344945cb9c1f9e1cc84aebee30689e76"
        },
        {
          "path": "src/browser_bridge_relay_common.cpp",
          "sha256": "c6aca81be17632a900451cf51b7a05e5d10002102b339cef9008ced09a9044b8"
        },
        {
          "path": "src/browser_control.cpp",
          "sha256": "da420500dbac842859745e2ba83b39fee7b0f21af5a5ff18f1e2e0b6ae3340af"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "faa5a6c1082fe19b909094fee2f9fbaa1e21e4a9200783db5dc93cb85516d61b"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "392d12714cfe4abf0b6e3b0aa10c18e98a27e0b3a9d25103902adf85a9e9b6fa"
        },
        {
          "path": "tests/browser_model.mjs",
          "sha256": "dee337baf259a465e743d40c38aa08edf9353f6ff856c7f8428488145ad92117"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "ec1b82d9ba1f31c021990ba0191e84294f4d8eaefced0e2f6f4de6b541f48684"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "3d206ee6418d3ac8133a49e3dafd50d820aa34ced5b562f300a580d943b9de9f"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "cbdf5707780fd9b3ba23e024b0662bf555fef45c9a885614543d3f4f2801f103"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "2ed68148ad1da16da56ec6fdf8ebfc1af4945c05f39e05724fc6113ca63b032d"
        },
        {
          "path": "tests/test_browser_bridge_relay.cpp",
          "sha256": "a76f4f3ff93fd991e7862bf173cca970d054925874b2b09ee367fe39a8e2ddf6"
        },
        {
          "path": "tests/test_browser_extension_versions.mjs",
          "sha256": "fa1dd67be1fd7bf327bd30c257db13ca985477d80324da25e153d88c5449525d"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "de6cbb056943ad5ef9ae9a6883104d8cb02f3839576e7622867c1f30b09bfc85"
        }
      ]
    }
  ],
  "checkpoint": null
}
```
