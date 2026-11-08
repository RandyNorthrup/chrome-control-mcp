# Readiness review: Chrome Web Store distribution

Reviewed 2026-11-07 against [the plan](../../chrome-web-store.md), the rules file
[docs/QUALITY.md](../../../QUALITY.md) (revision `81556cecb9c4`), and the current source: the
installer's `hostManifestBytes` and `manifestMatches`, `isOurExtensionOrigin` in `mcp_entry.h`,
`browserExtensionStatus`, the instructions in `mcp_dispatch.cpp`, the extension manifest, the
staging target and install rule in `CMakeLists.txt`, the release workflow, and the live harness's
extension loading (`isolated_chrome.mjs`, `devtools.mjs`).

## What the source establishes

- One constant, `kBrowserExtensionId`, feeds the registration's `allowed_origins`, the check that
  decides a registration is current, the relay's origin test and the status reply; the legacy
  PowerShell registration script and the template JSON spell it out separately.
- `manifestMatches` asks only that the expected origin be among the listed ones, so a
  registration with one origin counts as current today. A two-origin rule needs both to be
  required, or no update would rewrite a 1.12.0 registration.
- The staging target and the install rule copy the whole extension folder, so new icon files reach
  every build and archive with no list to update.
- The live harness reads the extension's ID in two places (the worker's URL in `devtools.mjs` and
  in `isolated_chrome.mjs`), both hard-coded to the unpacked ID; a run under the store's key must
  derive the ID from the key it loads.
- The store's public key, read from the dashboard, derives `mbkacllnbffbadcajpkkpelifdkfgcbd` by
  Chrome's rule (the first 128 bits of the key's SHA-256, as letters a to p).

## Findings

1. **A registration with one origin must not count as current.** Resolved in the plan: both are
   required, so every update rewrites a 1.12.0 registration.
2. **The store package must not carry `key`.** The store refused nothing else in the first upload
   but documents that `key` is not allowed; the builder removes it and refuses a manifest that would
   break the store's rules (description over 132 characters, a missing icon).
3. **The API cannot create an item or edit the listing.** Resolved: the item was created by hand on
   2026-11-07, and the listing stays in the dashboard; the release uploads and submits only. A
   publish before the listing is complete is refused by the API; the job reports Google's message.
4. **The service account's key is publisher-wide.** It can publish any item the publisher owns. It
   lives only in the repository secret; the local copy was deleted after it was stored.
5. **Two extensions in one profile.** A store install beside the unpacked copy is two extensions
   connecting from one profile. Accepted as documented guidance (keep one); the server's behaviour
   with two connections is the existing multi-connection behaviour.
6. **An older server and the store build.** A 1.12 server's registration lists one origin, so Chrome
   refuses the store build's native connection. Accepted: the listing names the minimum server
   version.
7. **Coverage.** Every requirement has criteria and an owning task; the privacy policy's criterion
   is manual with a stated reason; the live criterion runs the extension under the store's key.

No finding is left open.

## Addendum, 2026-11-07: scope revision 2

Reviewed again before any behaviour evidence, against the work as built.

1. **An update applied by a 1.12 server keeps the old registration.** Found while writing the
   changelog: `browser_update_apply` rewrites the registration only when it names another path, and
   on that update the code that runs is 1.12's, which writes one origin. A user who updated that
   way and then installed the store build would be refused. `--install` and the VS Code extension's
   start always rewrite it; the server now also does, as it starts, when the registration names
   that same executable and is not current. It never rewrites another copy's registration (that is
   `browser_extension_install`'s decision) and never creates one. AC-CWS-REGISTRATION gains the
   clause; the server task gains `src/mcp_entry.cpp`.
2. **The real dry run needs the secret.** The service account's key exists only as the repository
   secret, so the dry run AC-CWS-PUBLISH names runs in a workflow started by hand,
   `.github/workflows/store-check.yml` (dry run, or an upload without submitting); the publish task
   gains it.
3. **The live case runs in the release's live suites.** `.github/workflows/live.yml` gains the
   version suite under the store's key on all three platforms; the live task gains it.
4. **Paths.** `browser/store-public-key.txt` (read by the installer test, the live harness and the
   dry run) joins the server task; `docs/RELEASES.md` (what a release publishes) and
   `vscode/README.md` (it said the project has no store listing) join the documentation task.
   `docs/QUALITY.md`, the rules file, changed (suite counts, the live case, the publish order), so
   the rules revision is updated and the first readiness receipt is kept as stale history.

No finding is left open. Scope revision 2.

## Addendum, 2026-11-07: scope revision 3

The second evidence run's multi-agent live suite failed one check of 25: a tab opened for the agent
"研究" was listed by `browser_tabs`, straight after `browser_new_tab` replied, with no group. The
first run, the 1.12.0 evidence and CI had all passed it, and the only change between the two runs
was a rewrite of `isOurExtensionOrigin` that cppcheck asked for, which the relay's tests cover; so
the failure was read as a race, not retried. It is one, and it predates this work: holding a tab
queues its grouping (`queueGroupSync`) and `handleNewTab` replied once the page had loaded, which a
local page does in milliseconds, without waiting for that queue; `handleListTabs` did not wait for it
either. Chrome's tab-group calls take a few milliseconds each, so the reply usually lost the race
and occasionally won it.

The fix waits, bounded at two seconds, for the queued markings before `browser_new_tab` reads the
tab it reports and before `browser_tabs` lists. Unit cases make Chrome's `tabGroups.update` land
100 ms late and read the strip at the instant the reply is posted; each fails with its half of the
fix removed. The live check now reports the row it saw. A requirement that existing behaviour keeps
working covers it (REQ-CWS-COMPAT): new criterion AC-CWS-GROUPS, new task TASK-CWS-GROUPS, owning
`browser/extension/background.js`, `tests/test_browser_extension_tabs.mjs` and
`tests/e2e/multi_agent_e2e.mjs`. The changelog and release notes gain a Fixed entry. Every receipt is
taken after this change.

No finding is left open. Scope revision 3.

## Addendum, 2026-11-08: scope revision 4

1. **The first real dry run.** After the push, the Chrome Web Store check workflow's dry run (run 42430524883) signed in and read the item, then refused it: the key the store returned and
   `browser/store-public-key.txt` differed byte for byte, though the repository's key gives the
   item's ID. The comparison was the defect. The dry run now derives the ID from the key the store
   sends (PEM armour and whitespace removed), requires it to be the item's, and compares key bodies
   the same way; a unit case covers a PEM-wrapped key and a key that is not the recorded one. The
   second dry run (run 42430683011) passed. Both runs are evidence; the first is recorded as a
   failure.
2. **Where the Linux evidence runs.** At the owner's direction the Linux checks move from the WSL
   mirror to the owner's Ubuntu 26.04 laptop (GCC 15.2, Clang 21.1.8, Qt 6.10.2, Chrome for Testing
   153), with Node and Semgrep installed in the user's home and nothing installed system-wide. The
   live harness keeps every browser in a profile and native-messaging directory of its own, so the
   laptop's own Chrome and its registration are not touched. The declared environment changes
   accordingly, and `docs/QUALITY.md` (the rules file) now says local evidence runs on a Linux
   machine that mirrors the Linux jobs.
3. **Receipts.** Every earlier behaviour, red and manual receipt is kept as stale history: the
   publisher script, the environment and the rules revision all changed. Every check runs again.

No finding is left open. Scope revision 4.
