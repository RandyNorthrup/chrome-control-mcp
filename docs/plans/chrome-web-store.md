# Chrome Web Store distribution

Linked from [PLAN.md](../../PLAN.md). The ledger at the end owns the structured requirements,
acceptance criteria, tasks and evidence for this work; this prose explains them.

## Why

Installing the extension is the one step no installer can do for a user: they turn on Developer
mode at chrome://extensions, choose Load unpacked and pick a folder. A Chrome Web Store listing
makes it one click, updates it automatically, and lets an organisation install it by policy. The
owner registered the publisher on 2026-11-07, and the item exists as a draft:
`mbkacllnbffbadcajpkkpelifdkfgcbd`. The store assigns that ID at the first upload; the unpacked
build's ID, `iojehhmnaigcejfcpmilpclmeljhlkaa`, cannot be carried over because no private key for
it exists. A service account in the owner's Google Cloud project (`chrome-control-mcp`) is linked
to the publisher, and its key is the repository secret `CWS_SERVICE_ACCOUNT_JSON`.

## Design

**Two extension IDs, one server.** The native-messaging registration lists both origins, and the
relay accepts a launch from either and from nothing else. The unpacked build keeps its ID, so
existing installs, development and CI are unchanged. A registration that names only one origin
no longer counts as current, so it is rewritten with both by `--install` (which the VS Code
extension runs at every start), by `browser_extension_install`, and by the server itself as it
starts when the registration names that same executable -- the case of an update applied by a
1.12 server, whose own code writes one origin. `browser_extension_status` reports the store ID
beside the unpacked one.

**One package, two forms.** The extension gains its icon (16, 32, 48 and 128 px) and a description
within the store's 132-character limit. The unpacked folder keeps its manifest `key`; the store
package is the same files with `key` removed, built by `scripts/store_package.mjs`.

**Published by the release.** After the archives and live suites pass, the release workflow builds
the store package for the tagged version, signs a JSON Web Token with the service account's key,
exchanges it for an access token with the `chromewebstore` scope, uploads the package to the item
through the Chrome Web Store API (v2), waits for the upload to finish, and submits it for review.
Without the secret the job says so and skips. `--dry-run` signs in and reads the item's status
only, which is how the credentials are checked before a real release. The listing itself --
description, screenshots, privacy answers -- is kept in the developer dashboard; the API has no
call for it.

**Cheaper ways to look, in the instructions.** The server's instructions name the order an agent
should reach for: `browser_find` for an element it can name, `browser_screenshot` to see a page's
layout (about a thousand image tokens), and a whole `browser_snapshot` only for the full structure.
Found on 2026-11-07: an agent working through the Google Cloud console took six whole snapshots of
12 to 20 thousand tokens each to find buttons a screenshot would have shown.

**A privacy policy.** `docs/PRIVACY.md` says what the extension handles and where it goes: pages and
input stay between the extension and the server on the same machine; nothing reaches the
developer.

## Non-goals and limits

- The listing's text and images are entered in the dashboard; they are kept in this repository for
  reference (`docs/CHROME_WEB_STORE.md`) but not uploaded by the release.
- An extension installed from the store and the unpacked copy loaded together are two extensions;
  the documentation says to keep one.
- Review by Google is outside this work's control and can take days.

## Compatibility

- The unpacked ID, the native host's name and every tool are unchanged.
- An older server refuses the store-installed extension (its registration lists one origin); the
  store build therefore needs this release or later, which the listing says.

```quality-ledger
{
  "schema_version": 1,
  "work": {
    "id": "WORK-CWS",
    "title": "Chrome Web Store distribution",
    "scope_revision": 3,
    "brief": null,
    "brief_reason": "Scoped change in an existing product; README.md, docs/SECURITY.md and the owner's decision of 2026-11-07 to publish in the Chrome Web Store carry the context",
    "rules": [
      {
        "path": "docs/QUALITY.md",
        "revision": "498359aded9a"
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
        "wsl2-arch-node": "v26.13.0",
        "wsl2-arch-cmake": "4.4.5",
        "wsl2-arch-python": "3.12.16",
        "wsl2-arch-semgrep": "1.174.0"
      }
    }
  },
  "requirements": [
    {
      "id": "REQ-CWS-IDS",
      "statement": "The server and its native-messaging registration accept the Chrome Web Store build and the unpacked build of the extension, and no other extension",
      "priority": "critical",
      "acceptance": [
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-LIVE"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CWS-PACKAGE",
      "statement": "Each release builds the store package and uploads and submits it through the Chrome Web Store API with the publisher's service account",
      "priority": "critical",
      "acceptance": [
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CWS-GUIDANCE",
      "statement": "The server's instructions point agents to the cheapest way to look at a page, and a privacy policy says what the extension handles",
      "priority": "normal",
      "acceptance": [
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-PRIVACY"
      ],
      "superseded_by": null
    },
    {
      "id": "REQ-CWS-COMPAT",
      "statement": "Existing installs, every MCP client and every existing suite keep working",
      "priority": "critical",
      "acceptance": [
        "AC-CWS-COMPAT",
        "AC-CWS-GROUPS"
      ],
      "superseded_by": null
    }
  ],
  "acceptance": [
    {
      "id": "AC-CWS-REGISTRATION",
      "requirement": "REQ-CWS-IDS",
      "given": "A fresh profile; one registered by 1.12.0 with only the unpacked origin; and a server starting with a one-origin registration that names it, or names another copy",
      "when": "the installer prepares the native host",
      "then": "the registration lists exactly the two origins, store and unpacked; the 1.12.0 registration is reported as not current and rewritten; a starting server rewrites its own out-of-date registration and leaves a current, missing or other copy's registration untouched",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-ORIGIN",
      "requirement": "REQ-CWS-IDS",
      "given": "Launch arguments naming each extension origin, another extension's, a lookalike that extends one of the IDs, and none",
      "when": "the executable decides whether to run as the relay",
      "then": "only the two origins (bare or with a path) select the relay",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-LIVE",
      "requirement": "REQ-CWS-IDS",
      "given": "Chrome for Testing with the extension loaded under the store's public key (ID mbkacllnbffbadcajpkkpelifdkfgcbd)",
      "when": "a client opens a tab, finds an element and clicks it through the server",
      "then": "it works end to end, and the same run with the unpacked key works as before",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-PACKAGE",
      "requirement": "REQ-CWS-PACKAGE",
      "given": "The extension folder at a release",
      "when": "the store package is built",
      "then": "it holds every file of the folder, the manifest without key, with the release's version, the four icons and a description of at most 132 characters; a manifest that breaks one of those rules is refused",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-PUBLISH",
      "requirement": "REQ-CWS-PACKAGE",
      "given": "A service-account key and the item and publisher IDs",
      "when": "the publish script runs, against a recorded API and against the real one with --dry-run",
      "then": "it signs an RS256 token for the chromewebstore scope, exchanges it, uploads the package, waits out an upload in progress and submits; an API refusal is reported with Google's own message; the real dry run reads the item's status",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-INSTRUCTIONS",
      "requirement": "REQ-CWS-GUIDANCE",
      "given": "The server's initialize reply",
      "when": "a client reads the instructions",
      "then": "they name browser_find for a known element, browser_screenshot to see a layout and a whole browser_snapshot last, and stay within 4,096 characters",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-PRIVACY",
      "requirement": "REQ-CWS-GUIDANCE",
      "given": "docs/PRIVACY.md",
      "when": "it is read against the extension's permissions and the bridge's design",
      "then": "it states what is handled, that it stays on the machine between the extension and the server, that nothing reaches the developer, and what the identity permission reads",
      "checks": [
        "manual"
      ],
      "manual_reason": "A policy is a statement checked by reading it against the code and docs, not a behaviour a test can execute"
    },
    {
      "id": "AC-CWS-COMPAT",
      "requirement": "REQ-CWS-COMPAT",
      "given": "The 1.13.0 build and every suite that existed before this work",
      "when": "they run",
      "then": "every suite passes; the unpacked ID, the host's name and the tool catalog are unchanged",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    },
    {
      "id": "AC-CWS-GROUPS",
      "requirement": "REQ-CWS-COMPAT",
      "given": "Chrome names a tab group a while after it is asked to, and a page that loads in milliseconds",
      "when": "an agent opens a tab with browser_new_tab, or any path holds a tab, and browser_tabs is called straight after",
      "then": "the browser_new_tab reply goes out only once the tab is in its agent's group under the group's name, and the listing shows that group; the wait is bounded, so a call Chrome never answers cannot hold a reply",
      "checks": [
        "behavior",
        "red"
      ],
      "manual_reason": null
    }
  ],
  "tasks": [
    {
      "id": "TASK-CWS-SERVER",
      "purpose": "Both origins in the registration and the relay check, a starting server's repair of its own out-of-date registration, the store ID in extension status and the install reply, the instructions' order of looking, and their tests",
      "acceptance": [
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-COMPAT"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "action": "modify"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "action": "modify"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
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
          "path": "tests/test_browser_extension_installer.cpp",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "action": "modify"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "action": "modify"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "action": "modify"
        },
        {
          "path": "src/mcp_entry.cpp",
          "action": "modify"
        },
        {
          "path": "browser/store-public-key.txt",
          "action": "create"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CWS-CTEST",
        "EV-CWS-LINUX",
        "EV-CWS-REGISTER-SCRIPT",
        "EV-CWS-SMOKE",
        "EV-CWS-LIVE-REGRESSION",
        "EV-CWS-RED-EXACT",
        "EV-CWS-RED-REFRESH",
        "EV-CWS-RED-STORE-DROPPED",
        "EV-CWS-RED-LOOKALIKE",
        "EV-CWS-RED-INSTRUCTIONS",
        "EV-CWS-RED-STATUS",
        "EV-CWS-RED-UNPACKED"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CWS-EXTENSION",
      "purpose": "The icon in four sizes and a description within the store's limit",
      "acceptance": [
        "AC-CWS-PACKAGE",
        "AC-CWS-COMPAT"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/manifest.json",
          "action": "modify"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "action": "create"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "action": "create"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "action": "create"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "action": "create"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "action": "create"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CWS-UNIT-JS",
        "EV-CWS-CTEST",
        "EV-CWS-LIVE-UNPACKED",
        "EV-CWS-LIVE-REGRESSION",
        "EV-CWS-RED-PACKAGE-KEY",
        "EV-CWS-RED-PACKAGE-DESC",
        "EV-CWS-RED-UNPACKED"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CWS-PUBLISH",
      "purpose": "The store package builder, the API publisher and their tests, and the release job that runs them",
      "acceptance": [
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH"
      ],
      "depends_on": [
        "TASK-CWS-EXTENSION"
      ],
      "changes": [
        {
          "path": "scripts/store_package.mjs",
          "action": "create"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "action": "create"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "action": "create"
        },
        {
          "path": "package.json",
          "action": "modify"
        },
        {
          "path": ".github/workflows/release.yml",
          "action": "modify"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "action": "create"
        }
      ],
      "status": "implemented",
      "evidence": [
        "EV-CWS-UNIT-JS",
        "EV-CWS-CTEST",
        "EV-CWS-RED-PACKAGE-KEY",
        "EV-CWS-RED-PACKAGE-DESC",
        "EV-CWS-RED-AUDIENCE",
        "EV-CWS-RED-FAILED-UPLOAD",
        "EV-CWS-RED-WORDS",
        "EV-CWS-RED-POLL"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CWS-LIVE",
      "purpose": "Load the extension under the store's key in the live harness, and a live case that drives a tab through it",
      "acceptance": [
        "AC-CWS-LIVE",
        "AC-CWS-COMPAT"
      ],
      "depends_on": [
        "TASK-CWS-SERVER",
        "TASK-CWS-EXTENSION"
      ],
      "changes": [
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "action": "modify"
        },
        {
          "path": ".github/workflows/live.yml",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CWS-LIVE-STORE",
        "EV-CWS-LIVE-UNPACKED",
        "EV-CWS-LIVE-REGRESSION",
        "EV-CWS-RED-LIVE-STORE",
        "EV-CWS-RED-UNPACKED"
      ],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CWS-DOCS",
      "purpose": "Version 1.13.0, the privacy policy, the listing text, README, security, tools, quality counts, changelog, release page and plan index",
      "acceptance": [
        "AC-CWS-PRIVACY",
        "AC-CWS-COMPAT"
      ],
      "depends_on": [
        "TASK-CWS-SERVER",
        "TASK-CWS-EXTENSION",
        "TASK-CWS-PUBLISH",
        "TASK-CWS-LIVE"
      ],
      "changes": [
        {
          "path": "CMakeLists.txt",
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
        },
        {
          "path": "README.md",
          "action": "modify"
        },
        {
          "path": "CHANGELOG.md",
          "action": "modify"
        },
        {
          "path": "PLAN.md",
          "action": "modify"
        },
        {
          "path": "docs/PRIVACY.md",
          "action": "create"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "action": "create"
        },
        {
          "path": "docs/SECURITY.md",
          "action": "modify"
        },
        {
          "path": "docs/TOOLS.md",
          "action": "modify"
        },
        {
          "path": "docs/QUALITY.md",
          "action": "modify"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "action": "create"
        },
        {
          "path": "docs/RELEASES.md",
          "action": "modify"
        },
        {
          "path": "vscode/README.md",
          "action": "modify"
        }
      ],
      "status": "planned",
      "evidence": [],
      "blocker": null,
      "superseded_by": null
    },
    {
      "id": "TASK-CWS-GROUPS",
      "purpose": "browser_new_tab and browser_tabs wait, bounded, for the queued group sync, with unit cases that make Chrome's labelling late, and a live check that reports the row it saw",
      "acceptance": [
        "AC-CWS-GROUPS",
        "AC-CWS-COMPAT"
      ],
      "depends_on": [],
      "changes": [
        {
          "path": "browser/extension/background.js",
          "action": "modify"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "action": "modify"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "action": "modify"
        }
      ],
      "status": "verified",
      "evidence": [
        "EV-CWS-GROUPS-UNIT",
        "EV-CWS-GROUPS-LIVE",
        "EV-CWS-UNIT-JS",
        "EV-CWS-RED-GROUPS-NEWTAB",
        "EV-CWS-RED-GROUPS-LIST",
        "EV-CWS-LIVE-REGRESSION",
        "EV-CWS-RED-UNPACKED"
      ],
      "blocker": null,
      "superseded_by": null
    }
  ],
  "evidence": [
    {
      "id": "EV-CWS-READINESS-1",
      "acceptance": [
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-LIVE",
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH",
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-PRIVACY",
        "AC-CWS-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Requirements reviewed against the plan, the rules file and the installer, relay-origin, status, instructions, staging, release-workflow and live-harness source, and the store's public key checked against the item ID: seven findings, two of which (both origins required for a registration to count as current; the store package without key and refused when it breaks the store's rules) shaped the design before any code; recorded in readiness-review.md",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/cws/readiness-review.md",
        "sha256": "811e32b35d0172847bf8808bf1d7a9860aeb54c6f08e1a55ab196bdf1e87dc6b"
      },
      "red": null,
      "reason": "Scope revision 2 added a criterion clause and paths, and the rules file changed; the review was redone as EV-CWS-READINESS-2",
      "scope_sha256": "c31c6330c01cb6f4654bc3f3333d4eae0917f6d6fed2230b63c8ef583138ebe7",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "b4e3dbb2c08c0732aeb0cac90875bb8d06df149618946ede1d82ea6172bb88d7"
        }
      ]
    },
    {
      "id": "EV-CWS-READINESS-2",
      "acceptance": [
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-LIVE",
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH",
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-PRIVACY",
        "AC-CWS-COMPAT"
      ],
      "kind": "readiness",
      "status": "stale",
      "command": [],
      "method": "Scope revision 2 reviewed against the work as built: the update path that keeps a one-origin registration (fixed by the server's repair of its own registration as it starts, now in AC-CWS-REGISTRATION), the dry run's need for the repository secret (a workflow run by hand), the live case's place in the release's live suites, the paths the work touched, and the rules file's new revision; recorded in the readiness review's addendum",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/cws/readiness-review.md",
        "sha256": "06a394d015fde028e053db158196a5191252222bde53613beaefe8458e90f3bb"
      },
      "red": null,
      "reason": "Scope revision 3 added AC-CWS-GROUPS and TASK-CWS-GROUPS; the review was redone as EV-CWS-READINESS-3",
      "scope_sha256": "732e2b2036d195756da497e79a13eb4bad4cf7af7c849f719eadda3c25e8da14",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        }
      ]
    },
    {
      "id": "EV-CWS-READINESS-3",
      "acceptance": [
        "AC-CWS-GROUPS",
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-LIVE",
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH",
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-PRIVACY",
        "AC-CWS-COMPAT"
      ],
      "kind": "readiness",
      "status": "pass",
      "command": [],
      "method": "Scope revision 3 reviewed: the grouping race the multi-agent live suite found, read as a race rather than retried, traced to browser_new_tab and browser_tabs not waiting for the queued group sync, and covered by a new criterion (AC-CWS-GROUPS) and task (TASK-CWS-GROUPS) under the compatibility requirement; recorded in the readiness review's addendum",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/cws/readiness-review.md",
        "sha256": "abec7ad2692364410ff73e865015585f6bbd8ef48d6534a3958d69a9225fbefc"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        }
      ]
    },
    {
      "id": "EV-CWS-CTEST",
      "acceptance": [
        "AC-CWS-GROUPS",
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH",
        "AC-CWS-COMPAT"
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
      "method": "Windows 11, MSVC with Qt 6.10.3, the 1.13.0 tree: all 28 suites pass, among them test_browser_extension_installer (exactly the two origins registered; a one-origin 1.12.0 registration not current and rewritten; extra or swapped origins not current; a starting server's repair of its own registration only; the store key derives mbkacllnbffbadcajpkkpelifdkfgcbd; both origins accepted bare and with a path, lookalikes and others refused; the install reply names the store listing), test_browser_mcp_server (find, then screenshot, then a whole snapshot in the instructions, within 4,096 characters; status reports store_extension_id) and test_store_publish",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/windows-ctest.txt",
        "sha256": "505cf99effd4e906b1cb9ee318d49b5ac5a0e9dcde72ba68e5021fc84a3be54c"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-GATES",
      "acceptance": [
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "lint"
      ],
      "method": "ESLint and PSScriptAnalyzer clean over the tree, the new scripts and the legacy registration script included; Prettier flags no file that is committed (the seven it lists are the untracked research notes, reports/ and research_notes/, which are not part of this change)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/windows-gates.txt",
        "sha256": "d4bbac2db515ec7dae0217a26176746dea17034c2f845fcb28232a13783abd06"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-GROUPS-LIVE",
      "acceptance": [
        "AC-CWS-GROUPS",
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/multi_agent_e2e.mjs"
      ],
      "method": "The multi-agent suite three times in a row against Chrome for Testing, each 25/25: the tab browser_new_tab opens for the agent \"研究\" is listed by an immediate browser_tabs in its own group under its whole name, in every run",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/linux-summary.txt",
        "sha256": "117d07796dbade8ccea58631e0e9582ac2d0366791651562b60dbe776f2f0cc5"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-GROUPS-UNIT",
      "acceptance": [
        "AC-CWS-GROUPS"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "In the browser model with Chrome's tabGroups.update landing 100 ms late: the tab strip read the instant browser_new_tab's reply is posted shows the tab in the group named for its agent, and browser_tabs asked for straight after a tab is held lists it in that group; every earlier tab and group case unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/windows-test-js.txt",
        "sha256": "0c42a303cef51088eedd00642cfa6aafdc8a0a8a8ef768605b5f2fe594d91569"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "aa06559afe4f970db17758b1d90bbba47ec1625d4398b043bb5f5dc2f5f9fdb3",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        }
      ]
    },
    {
      "id": "EV-CWS-LINUX",
      "acceptance": [
        "AC-CWS-GROUPS",
        "AC-CWS-REGISTRATION",
        "AC-CWS-ORIGIN",
        "AC-CWS-INSTRUCTIONS",
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH",
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "bash",
        "/tmp/wsl_evidence.sh",
        "docs/plans/evidence/cws/",
        "static"
      ],
      "method": "WSL Arch (GCC 16.2.1, Qt 6.12.0): the 1.13.0 build with no warnings, ctest 27/27, clang-tidy 23.1.4 and exhaustive cppcheck clean, Semgrep with no findings",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/linux-summary.txt",
        "sha256": "117d07796dbade8ccea58631e0e9582ac2d0366791651562b60dbe776f2f0cc5"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-LIVE-REGRESSION",
      "acceptance": [
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "bash",
        "/tmp/wsl_evidence.sh",
        "docs/plans/evidence/cws/",
        "live"
      ],
      "method": "Every live suite that existed before this work, on the 1.13.0 build: display matrix, full browser, user interference, multi-agent, per-agent clipboard, large upload, extension version older and the released 1.11.1 extension, two profiles and the profiles upgrade (the closed-history rule: earlier plans are not re-stamped)",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/linux-summary.txt",
        "sha256": "117d07796dbade8ccea58631e0e9582ac2d0366791651562b60dbe776f2f0cc5"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-LIVE-STORE",
      "acceptance": [
        "AC-CWS-LIVE"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--store-key",
        "tests/e2e/extension_version_e2e.mjs"
      ],
      "method": "Chrome for Testing 153 with the extension loaded under the Chrome Web Store's public key: the browser gives it mbkacllnbffbadcajpkkpelifdkfgcbd, the native host registered by the 1.13.0 installer lets it in, and through the server a tab opens, browser_find finds the button and a click on its ref reaches the page; 9/9",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/live-extension-version-store.json",
        "sha256": "09a6e72df534e0904b7c1f353ee224fd642c9226792f9c254983c89757b51fbb"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "9ce11e932bb235547869472b4a6755043694e17a8ce67ba3af0d1ab3d6a355dc",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-LIVE-UNPACKED",
      "acceptance": [
        "AC-CWS-LIVE",
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "tests/e2e/extension_version_e2e.mjs"
      ],
      "method": "The same run with the unpacked key: iojehhmnaigcejfcpmilpclmeljhlkaa, 9/9, the find and the click included",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/live-extension-version-current.json",
        "sha256": "95d39a4c603f870190b9d5356a943356737cbc961179c47189f6bef64cf9cd9b"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-PRIVACY",
      "acceptance": [
        "AC-CWS-PRIVACY"
      ],
      "kind": "manual",
      "status": "pass",
      "command": [],
      "method": "docs/PRIVACY.md read claim by claim against the manifest, the extension's code, the bridge and the updater; every claim holds, recorded with the source each was checked against",
      "exit_code": null,
      "artifact": {
        "path": "docs/plans/evidence/cws/privacy-review.md",
        "sha256": "ed16ecb56df2178378380314382a4990205a29199f614e3e1c88b4f601cf8d4b"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "ab96c9ea051efb45acabdb879e063b0c1d7fb6fbee42cc5980fae5aaaa00896c",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-AUDIENCE",
      "acceptance": [
        "AC-CWS-PUBLISH"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_store_publish.mjs"
      ],
      "method": "Drill (publish-audience): the assertion names the wrong audience. Planted, the suite failed in a release signs in, uploads, waits out processing and submits; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/js-red-drills.txt",
        "sha256": "64c4e2b383ac0a335ec7656d14c80ecd10e43f44a2675ea6ae41ef76a967e49c"
      },
      "red": {
        "mutation": "the assertion names the wrong audience",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a release signs in, uploads, waits out processing and submits",
        "observed_diagnostic": "a release signs in, uploads, waits out processing and submits",
        "before": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "after": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "mutated": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "094f2d32983335c0632310e805926aa25faf0cfe2625609fe12dd2b42bb26011"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7c0c42bc48eefb486c0cb53dc99eaa2749801cadbe924f3d09acbea4a2e27c77",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-EXACT",
      "acceptance": [
        "AC-CWS-REGISTRATION"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_extension_installer"
      ],
      "method": "Drill (registration-exact): a registration listing our two origins and one more counts as current. Planted, the suite failed in foreignOriginRegistrationIsNotCurrent; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "a registration listing our two origins and one more counts as current",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "foreignOriginRegistrationIsNotCurrent",
        "observed_diagnostic": "foreignOriginRegistrationIsNotCurrent",
        "before": [
          {
            "path": "src/browser_extension_installer.cpp",
            "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
          }
        ],
        "after": [
          {
            "path": "src/browser_extension_installer.cpp",
            "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_extension_installer.cpp",
            "sha256": "82896e51a7581c8c2ebb07ccc0c5c9be1e49f7f5af577871a227bfead72d3597"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "60b862e09efc94d3493a544a638a78c127d5ea8881dd684b185403a305b56a9d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-FAILED-UPLOAD",
      "acceptance": [
        "AC-CWS-PUBLISH"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_store_publish.mjs"
      ],
      "method": "Drill (publish-failed-upload): an upload the store refused is not reported as refused. Planted, the suite failed in ✖ the upload; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/js-red-drills.txt",
        "sha256": "64c4e2b383ac0a335ec7656d14c80ecd10e43f44a2675ea6ae41ef76a967e49c"
      },
      "red": {
        "mutation": "an upload the store refused is not reported as refused",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "✖ the upload",
        "observed_diagnostic": "✖ the upload",
        "before": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "after": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "mutated": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "caa2fe4fc67cf60125863310ab731ba3ed7e028b8d2b945882b1339ed6a56f3f"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7c0c42bc48eefb486c0cb53dc99eaa2749801cadbe924f3d09acbea4a2e27c77",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-GROUPS-LIST",
      "acceptance": [
        "AC-CWS-GROUPS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (group-settle-list-tabs): browser_tabs lists without waiting for a just-held tab's group. Planted, the suite failed in browser_tabs lists a just-held tab in its named group; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/extension-red-drills.txt",
        "sha256": "b0f9690f7095220cd3452ada97f9897a4f0a261713186e1f1e68504033ea4cb0"
      },
      "red": {
        "mutation": "browser_tabs lists without waiting for a just-held tab's group",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "browser_tabs lists a just-held tab in its named group",
        "observed_diagnostic": "browser_tabs lists a just-held tab in its named group",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "288af55cbe306162730d622208a9e9f31a0332325e3896238aab959fdd0d8ab6"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "aa06559afe4f970db17758b1d90bbba47ec1625d4398b043bb5f5dc2f5f9fdb3",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-GROUPS-NEWTAB",
      "acceptance": [
        "AC-CWS-GROUPS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_browser_extension_tabs.mjs"
      ],
      "method": "Drill (group-settle-new-tab): browser_new_tab replies without waiting for the tab's group. Planted, the suite failed in a new tab is in its agent's named group when browser_new_tab replies; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/extension-red-drills.txt",
        "sha256": "b0f9690f7095220cd3452ada97f9897a4f0a261713186e1f1e68504033ea4cb0"
      },
      "red": {
        "mutation": "browser_new_tab replies without waiting for the tab's group",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a new tab is in its agent's named group when browser_new_tab replies",
        "observed_diagnostic": "a new tab is in its agent's named group when browser_new_tab replies",
        "before": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
          }
        ],
        "after": [
          {
            "path": "browser/extension/background.js",
            "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
          }
        ],
        "mutated": [
          {
            "path": "browser/extension/background.js",
            "sha256": "65c6f06e2beae9c1b8bf751e0627c82521ea7dcce7d46fa75e389af3ad039a34"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "aa06559afe4f970db17758b1d90bbba47ec1625d4398b043bb5f5dc2f5f9fdb3",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-INSTRUCTIONS",
      "acceptance": [
        "AC-CWS-INSTRUCTIONS"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_mcp_server"
      ],
      "method": "Drill (instructions-order): the instructions no longer keep a whole snapshot for last. Planted, the suite failed in initializeCarriesClientAgnosticInstructions; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "the instructions no longer keep a whole snapshot for last",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "initializeCarriesClientAgnosticInstructions",
        "observed_diagnostic": "initializeCarriesClientAgnosticInstructions",
        "before": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
          }
        ],
        "after": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
          }
        ],
        "mutated": [
          {
            "path": "src/mcp_dispatch.cpp",
            "sha256": "ec1d7ea563b0d04302e61ed2874ce1e64d8c4b1cf1a2fe6d22450657f72f6cba"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "60b862e09efc94d3493a544a638a78c127d5ea8881dd684b185403a305b56a9d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-LIVE-STORE",
      "acceptance": [
        "AC-CWS-LIVE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "tests/e2e/isolated_run.mjs",
        "--chrome=.chrome-for-testing/chrome/linux-153.0.8010.52/chrome-linux64/chrome",
        "--executable=build/chrome_control_mcp",
        "--store-key",
        "tests/e2e/extension_version_e2e.mjs"
      ],
      "method": "Drill (store-origin-dropped): a server that answers to the unpacked build only, against the store build in real Chrome. Planted, the suite failed in did not attach; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/live-red-drills.txt",
        "sha256": "69265069a395c548e6c1a159d233a1315f52ab575b3eb145d2fa17567302a33d"
      },
      "red": {
        "mutation": "a server that answers to the unpacked build only, against the store build in real Chrome",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "did not attach",
        "observed_diagnostic": "did not attach",
        "before": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
          }
        ],
        "after": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
          }
        ],
        "mutated": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "6e24340d37f8a1cbf1007f97e9ebe640a1a991bfd6a45f3dac4685e10ae90041"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "9ce11e932bb235547869472b4a6755043694e17a8ce67ba3af0d1ab3d6a355dc",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-LOOKALIKE",
      "acceptance": [
        "AC-CWS-ORIGIN"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_extension_installer"
      ],
      "method": "Drill (origin-lookalike): an origin that only begins with one of our IDs selects the relay. Planted, the suite failed in extensionOriginAcceptsBothBuilds; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "an origin that only begins with one of our IDs selects the relay",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "extensionOriginAcceptsBothBuilds",
        "observed_diagnostic": "extensionOriginAcceptsBothBuilds",
        "before": [
          {
            "path": "include/chrome_control_mcp/mcp_entry.h",
            "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
          }
        ],
        "after": [
          {
            "path": "include/chrome_control_mcp/mcp_entry.h",
            "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
          }
        ],
        "mutated": [
          {
            "path": "include/chrome_control_mcp/mcp_entry.h",
            "sha256": "46d8ee36f3107e3f7da037c80c5f8a493db7bae3b3b8ee75d9db0485a414ee2d"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "60b862e09efc94d3493a544a638a78c127d5ea8881dd684b185403a305b56a9d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-PACKAGE-DESC",
      "acceptance": [
        "AC-CWS-PACKAGE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_store_publish.mjs"
      ],
      "method": "Drill (package-description): a 133-character description passes. Planted, the suite failed in a description over 132 characters; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/js-red-drills.txt",
        "sha256": "64c4e2b383ac0a335ec7656d14c80ecd10e43f44a2675ea6ae41ef76a967e49c"
      },
      "red": {
        "mutation": "a 133-character description passes",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a description over 132 characters",
        "observed_diagnostic": "a description over 132 characters",
        "before": [
          {
            "path": "scripts/store_package.mjs",
            "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
          }
        ],
        "after": [
          {
            "path": "scripts/store_package.mjs",
            "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
          }
        ],
        "mutated": [
          {
            "path": "scripts/store_package.mjs",
            "sha256": "c604068e9d25abfd088a6b04ed7518e07fc75d19f76a93dcf26ff3ac2f1dd854"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7c0c42bc48eefb486c0cb53dc99eaa2749801cadbe924f3d09acbea4a2e27c77",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-PACKAGE-KEY",
      "acceptance": [
        "AC-CWS-PACKAGE"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_store_publish.mjs"
      ],
      "method": "Drill (package-key): the store package keeps the manifest's key. Planted, the suite failed in the store package is the extension's files with the manifest's key removed; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/js-red-drills.txt",
        "sha256": "64c4e2b383ac0a335ec7656d14c80ecd10e43f44a2675ea6ae41ef76a967e49c"
      },
      "red": {
        "mutation": "the store package keeps the manifest's key",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "the store package is the extension's files with the manifest's key removed",
        "observed_diagnostic": "the store package is the extension's files with the manifest's key removed",
        "before": [
          {
            "path": "scripts/store_package.mjs",
            "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
          }
        ],
        "after": [
          {
            "path": "scripts/store_package.mjs",
            "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
          }
        ],
        "mutated": [
          {
            "path": "scripts/store_package.mjs",
            "sha256": "6810740d5836db91f5744733699bc5b422107c222c4ac02b88cc21d320e0d754"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7c0c42bc48eefb486c0cb53dc99eaa2749801cadbe924f3d09acbea4a2e27c77",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-POLL",
      "acceptance": [
        "AC-CWS-PUBLISH"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_store_publish.mjs"
      ],
      "method": "Drill (publish-poll): the publisher stops waiting while the store is still processing. Planted, the suite failed in a release signs in, uploads, waits out processing and submits; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/js-red-drills.txt",
        "sha256": "64c4e2b383ac0a335ec7656d14c80ecd10e43f44a2675ea6ae41ef76a967e49c"
      },
      "red": {
        "mutation": "the publisher stops waiting while the store is still processing",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "a release signs in, uploads, waits out processing and submits",
        "observed_diagnostic": "a release signs in, uploads, waits out processing and submits",
        "before": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "after": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "mutated": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "a8dad01213a3a922ea36208d4cef5e597642b77fd3783c32e8afa10c2b9f9955"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7c0c42bc48eefb486c0cb53dc99eaa2749801cadbe924f3d09acbea4a2e27c77",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-REFRESH",
      "acceptance": [
        "AC-CWS-REGISTRATION"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_extension_installer"
      ],
      "method": "Drill (refresh-foreign): a starting server rewrites another copy's registration. Planted, the suite failed in refreshRewritesOnlyItsOwnStaleRegistration; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "a starting server rewrites another copy's registration",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "refreshRewritesOnlyItsOwnStaleRegistration",
        "observed_diagnostic": "refreshRewritesOnlyItsOwnStaleRegistration",
        "before": [
          {
            "path": "src/browser_extension_installer.cpp",
            "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
          }
        ],
        "after": [
          {
            "path": "src/browser_extension_installer.cpp",
            "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_extension_installer.cpp",
            "sha256": "2ffd3beb6d2dad8dce85332afb1b2131cde57f2fb940996b7cfed1b4143e94fd"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "60b862e09efc94d3493a544a638a78c127d5ea8881dd684b185403a305b56a9d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-STATUS",
      "acceptance": [
        "AC-CWS-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_mcp_server"
      ],
      "method": "Drill (status-store-id): browser_extension_status reports the unpacked ID as the store's. Planted, the suite failed in installerStatusReturnsMcpContent; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "browser_extension_status reports the unpacked ID as the store's",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "installerStatusReturnsMcpContent",
        "observed_diagnostic": "installerStatusReturnsMcpContent",
        "before": [
          {
            "path": "src/browser_mcp_tools.cpp",
            "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
          }
        ],
        "after": [
          {
            "path": "src/browser_mcp_tools.cpp",
            "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
          }
        ],
        "mutated": [
          {
            "path": "src/browser_mcp_tools.cpp",
            "sha256": "bee65de8cb89abebfc32f5717b1c36e7a9a5fe0589ac0a9b4c7e8aee4a21c31b"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-STORE-DROPPED",
      "acceptance": [
        "AC-CWS-REGISTRATION"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_extension_installer"
      ],
      "method": "Drill (origin-store-dropped): the server answers to the unpacked build only. Planted, the suite failed in prepareRegistersValidatedNativeHost; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "the server answers to the unpacked build only",
        "baseline_exit": 0,
        "mutated_exit": 5,
        "restored_exit": 0,
        "expected_diagnostic": "prepareRegistersValidatedNativeHost",
        "observed_diagnostic": "prepareRegistersValidatedNativeHost",
        "before": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
          }
        ],
        "after": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
          }
        ],
        "mutated": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "6e24340d37f8a1cbf1007f97e9ebe640a1a991bfd6a45f3dac4685e10ae90041"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "60b862e09efc94d3493a544a638a78c127d5ea8881dd684b185403a305b56a9d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-UNPACKED",
      "acceptance": [
        "AC-CWS-COMPAT"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "./build/test_browser_extension_installer"
      ],
      "method": "Drill (compat-unpacked-dropped): the unpacked build, every existing install, is no longer let in. Planted, the suite failed in prepareRegistersValidatedNativeHost; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/unit-red-drills.txt",
        "sha256": "fda5963e45318a55621dd3a60c137f5ede410c2b7594ede5f38eaa259e8d01a6"
      },
      "red": {
        "mutation": "the unpacked build, every existing install, is no longer let in",
        "baseline_exit": 0,
        "mutated_exit": 4,
        "restored_exit": 0,
        "expected_diagnostic": "prepareRegistersValidatedNativeHost",
        "observed_diagnostic": "prepareRegistersValidatedNativeHost",
        "before": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
          }
        ],
        "after": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
          }
        ],
        "mutated": [
          {
            "path": "include/chrome_control_mcp/browser_extension_installer.h",
            "sha256": "85098ac267bef9b511e21279984c228e26d1c4a664f2d56d5c347ccea2630289"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-RED-WORDS",
      "acceptance": [
        "AC-CWS-PUBLISH"
      ],
      "kind": "red",
      "status": "pass",
      "command": [
        "node",
        "--test",
        "tests/test_store_publish.mjs"
      ],
      "method": "Drill (publish-google-words): Google's message is not read out of its error body. Planted, the suite failed in Google's error bodies are read in each of their shapes; restored byte for byte and green again",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/js-red-drills.txt",
        "sha256": "64c4e2b383ac0a335ec7656d14c80ecd10e43f44a2675ea6ae41ef76a967e49c"
      },
      "red": {
        "mutation": "Google's message is not read out of its error body",
        "baseline_exit": 0,
        "mutated_exit": 1,
        "restored_exit": 0,
        "expected_diagnostic": "Google's error bodies are read in each of their shapes",
        "observed_diagnostic": "Google's error bodies are read in each of their shapes",
        "before": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "after": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
          }
        ],
        "mutated": [
          {
            "path": "scripts/cws_publish.mjs",
            "sha256": "5a8556ae655e5d53f54ed3f399e97450234942d1505571938c12b74f6532f461"
          }
        ]
      },
      "reason": null,
      "scope_sha256": "7c0c42bc48eefb486c0cb53dc99eaa2749801cadbe924f3d09acbea4a2e27c77",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        }
      ]
    },
    {
      "id": "EV-CWS-REGISTER-SCRIPT",
      "acceptance": [
        "AC-CWS-REGISTRATION"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "powershell",
        "-File",
        "ps1_check.ps1"
      ],
      "method": "The legacy registration script, run from a copy against a test registry key: both origins written and read back, a malformed store ID refused, the same ID given twice written once, and the test key removed",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/windows-register-script.txt",
        "sha256": "1adf4b4c72c950ee0f47d9ac7b9356ebe1170dc1d750c0d2bc95dc34ea12dc05"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "60b862e09efc94d3493a544a638a78c127d5ea8881dd684b185403a305b56a9d",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        }
      ]
    },
    {
      "id": "EV-CWS-SMOKE",
      "acceptance": [
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "node",
        "scripts/mcp_smoke.mjs",
        "build/Release/chrome_control_mcp.exe"
      ],
      "method": "The built server's MCP smoke test in both profiles: 54 tools in full and 15 read-only, unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/windows-smoke.txt",
        "sha256": "8f381b739f67e15bf466ff810149c5497c1711371886a85518f0c59729e56927"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    },
    {
      "id": "EV-CWS-UNIT-JS",
      "acceptance": [
        "AC-CWS-PACKAGE",
        "AC-CWS-PUBLISH",
        "AC-CWS-COMPAT"
      ],
      "kind": "behavior",
      "status": "pass",
      "command": [
        "npm",
        "run",
        "test:js"
      ],
      "method": "The 14 JavaScript suites, 254 tests, test_store_publish and the two new group cases among them: the package holds every file with the manifest's key removed and the same bytes each time, Python's zipfile reads it, and a manifest the store would refuse is refused; against a recorded API the publisher signs an RS256 assertion the server verifies, uploads byte for byte, waits out processing, submits, reports Google's own words for refusals, and a dry run reads the status and checks the item's public key; every earlier suite unchanged",
      "exit_code": 0,
      "artifact": {
        "path": "docs/plans/evidence/cws/windows-test-js.txt",
        "sha256": "0c42a303cef51088eedd00642cfa6aafdc8a0a8a8ef768605b5f2fe594d91569"
      },
      "red": null,
      "reason": null,
      "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
      "environment": {
        "platform": "windows",
        "tools": {
          "chrome-for-testing": "153.0.8010.52",
          "cmake": "4.4.5",
          "node": "v24.20.0",
          "python": "3.14.10",
          "wsl2-arch-cmake": "4.4.5",
          "wsl2-arch-node": "v26.13.0",
          "wsl2-arch-python": "3.12.16",
          "wsl2-arch-semgrep": "1.174.0"
        }
      },
      "inputs": [
        {
          "path": ".github/workflows/live.yml",
          "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
        },
        {
          "path": ".github/workflows/release.yml",
          "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
        },
        {
          "path": ".github/workflows/store-check.yml",
          "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
        },
        {
          "path": "CHANGELOG.md",
          "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
        },
        {
          "path": "CMakeLists.txt",
          "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
        },
        {
          "path": "PLAN.md",
          "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
        },
        {
          "path": "README.md",
          "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
        },
        {
          "path": "browser/extension/background.js",
          "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
        },
        {
          "path": "browser/extension/icons/icon.svg",
          "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
        },
        {
          "path": "browser/extension/icons/icon128.png",
          "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
        },
        {
          "path": "browser/extension/icons/icon16.png",
          "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
        },
        {
          "path": "browser/extension/icons/icon32.png",
          "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
        },
        {
          "path": "browser/extension/icons/icon48.png",
          "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
        },
        {
          "path": "browser/extension/manifest.json",
          "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
        },
        {
          "path": "browser/native-host/com.chromecontrolmcp.browser.json",
          "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
        },
        {
          "path": "browser/native-host/register_native_host.ps1",
          "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
        },
        {
          "path": "browser/store-public-key.txt",
          "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
        },
        {
          "path": "docs/CHROME_WEB_STORE.md",
          "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
        },
        {
          "path": "docs/PRIVACY.md",
          "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
        },
        {
          "path": "docs/QUALITY.md",
          "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
        },
        {
          "path": "docs/RELEASES.md",
          "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
        },
        {
          "path": "docs/SECURITY.md",
          "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
        },
        {
          "path": "docs/TOOLS.md",
          "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
        },
        {
          "path": "docs/releases/v1.13.0.md",
          "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
        },
        {
          "path": "include/chrome_control_mcp/browser_extension_installer.h",
          "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
        },
        {
          "path": "include/chrome_control_mcp/mcp_entry.h",
          "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
        },
        {
          "path": "package-lock.json",
          "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
        },
        {
          "path": "package.json",
          "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
        },
        {
          "path": "scripts/cws_publish.mjs",
          "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
        },
        {
          "path": "scripts/store_package.mjs",
          "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
        },
        {
          "path": "src/browser_extension_installer.cpp",
          "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
        },
        {
          "path": "src/browser_mcp_tools.cpp",
          "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
        },
        {
          "path": "src/mcp_dispatch.cpp",
          "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
        },
        {
          "path": "src/mcp_entry.cpp",
          "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
        },
        {
          "path": "tests/e2e/devtools.mjs",
          "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
        },
        {
          "path": "tests/e2e/extension_version_e2e.mjs",
          "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
        },
        {
          "path": "tests/e2e/isolated_chrome.mjs",
          "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
        },
        {
          "path": "tests/e2e/isolated_run.mjs",
          "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
        },
        {
          "path": "tests/e2e/multi_agent_e2e.mjs",
          "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
        },
        {
          "path": "tests/test_browser_extension_installer.cpp",
          "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
        },
        {
          "path": "tests/test_browser_extension_tabs.mjs",
          "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
        },
        {
          "path": "tests/test_browser_mcp_server.cpp",
          "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
        },
        {
          "path": "tests/test_store_publish.mjs",
          "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
        },
        {
          "path": "vscode/README.md",
          "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
        },
        {
          "path": "vscode/package-lock.json",
          "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
        },
        {
          "path": "vscode/package.json",
          "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
        }
      ]
    }
  ],
  "checkpoint": {
    "scope_sha256": "6d90661bf08d2570c35a7c48ff0c7e8eb438329eebf4bbbc57796ce9c35966f1",
    "inputs": [
      {
        "path": ".github/workflows/live.yml",
        "sha256": "6a5d1a3231bbdb1a7218f35248e1c60fa090eb8588c78029b8951a108f5e6e29"
      },
      {
        "path": ".github/workflows/release.yml",
        "sha256": "b5cb97e7ed7611e383208223d7c023d03c7877c0629df05ca740132a733855f3"
      },
      {
        "path": ".github/workflows/store-check.yml",
        "sha256": "34a67bd73558ca839d732350300444e9e5b847b84df7a9b59e48c4f5af2e0dbe"
      },
      {
        "path": "CHANGELOG.md",
        "sha256": "890939b9cc7f57008729adb8d55b65aa5083ba2d69810e36d00a9d7e73ec0c02"
      },
      {
        "path": "CMakeLists.txt",
        "sha256": "7d9992d61053c1ec653d417d6b8150602f20cd61652197f6759ad9f25d46494a"
      },
      {
        "path": "PLAN.md",
        "sha256": "2f928851e1f531b02dbea03787541c65c0932b93cef1bc115b8ea1978fceb953"
      },
      {
        "path": "README.md",
        "sha256": "2e276826f509386945096a2dae2afe67ad5dd43b02c66067ad5c119ed41f998b"
      },
      {
        "path": "browser/extension/background.js",
        "sha256": "9a46ed0d5a930bbf0d1ead212425fffbb6083f99dbdf276b24407e18f6b1caed"
      },
      {
        "path": "browser/extension/icons/icon.svg",
        "sha256": "e66610a56eea06e37ff4737d0411bd5d4d8e5a8ec0018c4d9a84893e569cb065"
      },
      {
        "path": "browser/extension/icons/icon128.png",
        "sha256": "7b70af8972ae1cfaab9e2dac52edd7f2bc60ef01816d128b4506d0e7ec242027"
      },
      {
        "path": "browser/extension/icons/icon16.png",
        "sha256": "ac9949fb7dae7f7633d9a0549ab9aef91f25ba0e97f299b2ea09e6bf4d623c03"
      },
      {
        "path": "browser/extension/icons/icon32.png",
        "sha256": "094f5caf4044dd8de18d039efab9c3698d647f2f6dda74bd9d81aaafa6ea6d6a"
      },
      {
        "path": "browser/extension/icons/icon48.png",
        "sha256": "13c5ddfeaee7a4f3e6d8e5454299afd4b95a58c980ed143090a7041ff88da38d"
      },
      {
        "path": "browser/extension/manifest.json",
        "sha256": "c52c6d8f9d703c96cbea0ad31795971026728992b33a775bfa9069c406a5484c"
      },
      {
        "path": "browser/native-host/com.chromecontrolmcp.browser.json",
        "sha256": "b9c05b8b765a99a4c351080a74d475902fa696f20769f2ed41a3d0ffad4946b3"
      },
      {
        "path": "browser/native-host/register_native_host.ps1",
        "sha256": "ae519c0db2ecd7699fb741f3e2cb32f12c5639490bbe4d444feb4d7b74194d32"
      },
      {
        "path": "browser/store-public-key.txt",
        "sha256": "f64981ba2481d58abdd7b6c83adb571179b6d6e75973d6d1b01aa8d7372e6827"
      },
      {
        "path": "docs/CHROME_WEB_STORE.md",
        "sha256": "e31da9aa7e15ffab5c84e231ac0650a662c32da6cbf706915bb7f88c4e4f47c0"
      },
      {
        "path": "docs/PRIVACY.md",
        "sha256": "06ae406ac6059ab9cfb876669872f69d989407d019200ee06c3680db83a17ad9"
      },
      {
        "path": "docs/QUALITY.md",
        "sha256": "82e937a113b372cf4ea56642fd1cab781b333ec923ea2027a902611c560f61cc"
      },
      {
        "path": "docs/RELEASES.md",
        "sha256": "e88f9e941c1815bd549307d1d7c8b7ff64b015c93c9a8c208a82cc7f85c92acc"
      },
      {
        "path": "docs/SECURITY.md",
        "sha256": "5ff5d96ed58be78183dc8a9508fcf7f802d11b5083e355ef217b593742bc8804"
      },
      {
        "path": "docs/TOOLS.md",
        "sha256": "5f9a31517ae341355c3e396ce9e593508b8b2afa10849f9b8730153e7c5047c4"
      },
      {
        "path": "docs/releases/v1.13.0.md",
        "sha256": "118894f7e25fb8d263b3b4eed759dc6e96fa57ff0e8b44348e20b5f6a59ba0f4"
      },
      {
        "path": "include/chrome_control_mcp/browser_extension_installer.h",
        "sha256": "1a24e15adb6d320f0da2c9c28f97f568d91b55bb28e5f45acb904e536de1d829"
      },
      {
        "path": "include/chrome_control_mcp/mcp_entry.h",
        "sha256": "fe6bfe1ca92ccfdde92f7b9b9c052bc6b9f6dd557669277c0df8209eaca58fcb"
      },
      {
        "path": "package-lock.json",
        "sha256": "1cf2ff808ed3d02ea23d87b5b0b9a81851b55907b1f01a20681739dd85c9cfd5"
      },
      {
        "path": "package.json",
        "sha256": "efcb2d7cd197155912dd5a4064772d9f998d5c0c9edeeca26ef2e8606aa133e9"
      },
      {
        "path": "scripts/cws_publish.mjs",
        "sha256": "9580214d89a3421c0f61d03073f8ffd4f219fc6b7ab300d18f31e49d6faf900d"
      },
      {
        "path": "scripts/store_package.mjs",
        "sha256": "da7e447371a3d84a30ff9b13f7a27ac8c7de579e2f2dee3199010c33e68850eb"
      },
      {
        "path": "src/browser_extension_installer.cpp",
        "sha256": "6e4b45a1942b5c6ad272da62eaa2b7cb3263a1a3c56b0778bf723b51a4555cb1"
      },
      {
        "path": "src/browser_mcp_tools.cpp",
        "sha256": "cadf34f8d15643e64f4b12bd023e03bca19033baf2d1750710fecc073f840dfd"
      },
      {
        "path": "src/mcp_dispatch.cpp",
        "sha256": "b28853bc614878f9fb93b65f4829421f425d2bfeea3ef82837d69752e0386065"
      },
      {
        "path": "src/mcp_entry.cpp",
        "sha256": "e8c4b80d36589a65535ec3bae72f5a92e68abcc77a1de32289ff4ca2a6cc6a42"
      },
      {
        "path": "tests/e2e/devtools.mjs",
        "sha256": "6b9a9f6f8fe52f05a62e7f389b8b3a44036c344a5292a40248ab18add935a324"
      },
      {
        "path": "tests/e2e/extension_version_e2e.mjs",
        "sha256": "b9211e14a243b4f3e99abc8e21e25b908c6db10b4d2e2c8a50f18f7527080d95"
      },
      {
        "path": "tests/e2e/isolated_chrome.mjs",
        "sha256": "5b59019533a5917eaca784b95818999dbee1a36fa4eeee3ac0678e71b9685db0"
      },
      {
        "path": "tests/e2e/isolated_run.mjs",
        "sha256": "ce9f33c6414c694744da13373a348b0030b8dd0e2880b64e7cce0dd443a30685"
      },
      {
        "path": "tests/e2e/multi_agent_e2e.mjs",
        "sha256": "b012c11b431ef2ebcd0e8d6cf1ce54ad47be25cdc4a15c23948a882183cb462e"
      },
      {
        "path": "tests/test_browser_extension_installer.cpp",
        "sha256": "0cd573613239db7f766aec7ea6826ce056eea434720a42bc3bbd6209c83b4988"
      },
      {
        "path": "tests/test_browser_extension_tabs.mjs",
        "sha256": "02c124e0b309f8aa353467a0df94f914afb845bc1eb7d71b63b48c5ad2bc1a77"
      },
      {
        "path": "tests/test_browser_mcp_server.cpp",
        "sha256": "6aa679d1c3f33df1daf386b30780b394919db9419275b71e43f0a835938e2383"
      },
      {
        "path": "tests/test_store_publish.mjs",
        "sha256": "28d4e398e1b86f9b64ec7665cbc85d4fbc76f483e01dbe563a724e02cb2cf7d3"
      },
      {
        "path": "vscode/README.md",
        "sha256": "dd9c0bde060e4be456473256dbee13c0df6ae15c8cffc7afd1295cce1fc9e756"
      },
      {
        "path": "vscode/package-lock.json",
        "sha256": "214e3f81c1bc5180edd466733b1d9c951039788d9e66b848f5722632de452675"
      },
      {
        "path": "vscode/package.json",
        "sha256": "3fa8f06b07fb903f09370ac10d21f5375a2915873d9b3c7703c797f373b20b44"
      }
    ],
    "environment": {
      "platform": "windows",
      "tools": {
        "chrome-for-testing": "153.0.8010.52",
        "cmake": "4.4.5",
        "node": "v24.20.0",
        "python": "3.14.10",
        "wsl2-arch-cmake": "4.4.5",
        "wsl2-arch-node": "v26.13.0",
        "wsl2-arch-python": "3.12.16",
        "wsl2-arch-semgrep": "1.174.0"
      }
    },
    "verified_tasks": [
      "TASK-CWS-SERVER",
      "TASK-CWS-EXTENSION",
      "TASK-CWS-LIVE",
      "TASK-CWS-GROUPS"
    ],
    "pending_operations": [
      {
        "id": "OP-CWS-DRY-RUN",
        "description": "The real dry run of scripts/cws_publish.mjs against the Chrome Web Store (AC-CWS-PUBLISH). The service account's key exists only as the repository secret CWS_SERVICE_ACCOUNT_JSON, so it runs in the Chrome Web Store check workflow, which must be on main first.",
        "next_action": "Push this work, let CI pass, run the Chrome Web Store check workflow with mode dry-run, save its log as docs/plans/evidence/cws/store-dry-run.txt, record its receipt, then verify TASK-CWS-PUBLISH and TASK-CWS-DOCS and close."
      }
    ],
    "next_action": "Commit and push the 1.13.0 work; run the store check's dry run; record it; close the plan; tag v1.13.0.",
    "source_revision": "f42e021"
  }
}
```
