# Verification

What has been checked, on what, and when. The first section is the current release. Everything
after [Earlier evidence](#earlier-evidence) is a dated record of the build it names: its tool counts,
suite counts and versions were true of that build and are not current. A result is recorded here
only when a command actually produced it.

## Current: 1.13.0 (2026-11-07)

1.13.0 publishes the Chrome extension to the Chrome Web Store as `mbkacllnbffbadcajpkkpelifdkfgcbd`
beside the unpacked build, makes the server answer to both builds and no other, builds and submits
the store package from the release workflow, gives agents an order for looking at a page, adds a
privacy policy, and fixes `browser_new_tab` and `browser_tabs` answering before a just-held tab was
in its agent's group. The plan, criteria and ledger are
[plans/chrome-web-store.md](plans/chrome-web-store.md), with the raw outputs in
[plans/evidence/cws/](plans/evidence/cws/). Every suite that existed before this work ran again
against the 1.13.0 build (AC-CWS-COMPAT). From this release the local Linux evidence runs on an
Ubuntu laptop rather than the WSL mirror.

### 1.13.0: suites

| Where                                                       | Result                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11, local (MSVC, Qt 6.10.3): ctest                  | 28/28, among them `test_store_publish`                                                                                                   |
| Local: `npm run test:js`                                    | 255/255                                                                                                                                  |
| Windows, local: MCP smoke, full and read-only               | 54 and 15 tools                                                                                                                          |
| Windows, local: `register_native_host.ps1` on a test key    | both origins written and read back; a bad ID refused; unregistered                                                                       |
| Linux, Ubuntu 26.04.1 laptop (GCC 15.2.0, Qt 6.10.2): build | 0 warnings; ctest 27/27                                                                                                                  |
| Linux, laptop: clang-tidy 21.1.8, cppcheck 2.19.0, Semgrep  | 0 findings each (221 rules, 58 files)                                                                                                    |
| Linux, Chrome for Testing 153: extension version, store key | 9/9: ID `mbkacllnbffbadcajpkkpelifdkfgcbd`, a tab, a find and a click                                                                    |
| Linux, Chrome for Testing 153: extension version, unpacked  | current 9/9, older 12/12, released 1.11.1 12/12                                                                                          |
| Linux, Chrome for Testing 153: full browser, display matrix | ok: 49 tools, 202 live cases; ok                                                                                                         |
| Linux, Chrome for Testing 153: interference, multi-agent    | 10/10; 25/25 three times in a row                                                                                                        |
| Linux, Chrome for Testing 153: clipboard, large upload      | 24/24, 7/7                                                                                                                               |
| Linux, Chrome for Testing 153: profiles, upgrade            | 14/14, 4/4                                                                                                                               |
| Chrome Web Store API, the store check's dry run             | signed in; the item's key gives its ID ([run 42430683011](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42430683011)) |

The laptop's live suites run the dedicated test browser with `--no-sandbox`, as CI's Linux runner
does: Ubuntu 23.10 and later restrict unprivileged user namespaces with AppArmor, and Chrome finds no
usable sandbox. The first attempt, without it, stopped every suite before a check ran
(`linux-live-attempt-1.txt`).

### 1.13.0: red drills

Each check was red-drilled: the defect planted in a disposable copy, the check seen to fail for that
reason, then restored byte for byte and green again (`unit-red-drills.txt`, `js-red-drills.txt`,
`extension-red-drills.txt`, `live-red-drills.txt`).

- _A registration with our two origins and one more counts as current:_
  `foreignOriginRegistrationIsNotCurrent` fails.
- _The server answers to the unpacked build only:_ five installer cases fail, among them
  `extensionOriginAcceptsBothBuilds`; against real Chrome under the store's key, the extension never
  attaches (the live drill).
- _The unpacked build, every existing install, is no longer let in:_
  `prepareRegistersValidatedNativeHost` and three more fail.
- _An origin that only begins with one of our IDs selects the relay:_
  `extensionOriginAcceptsBothBuilds` fails.
- _A starting server rewrites another copy's registration:_
  `refreshRewritesOnlyItsOwnStaleRegistration` fails.
- _The instructions no longer keep a whole snapshot for last:_
  `initializeCarriesClientAgnosticInstructions` fails.
- _Status reports the unpacked ID as the store's:_ `installerStatusReturnsMcpContent` fails.
- _The store package keeps the manifest's key, or lets a 133-character description through:_ the
  package cases fail.
- _The assertion names the wrong audience; a refused upload is not reported; Google's message is not
  read; the publisher stops waiting while the store is still processing:_ the publish cases fail.
- _`browser_new_tab` or `browser_tabs` stops waiting for the tab's group:_ its tab case fails.

### 1.13.0: CI and the release

The release commit, `97840fa`: its Quality run was cancelled by the next push, by design. `c5fbfcb`
([Quality run 42430678558](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42430678558)) carries the whole release: builds, tests, analysis and
both sanitizers passed on all three platforms. `77091b4`, the evidence and the closed plan
([run 42433774509](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42433774509), documents only): passed.

The first real dry run ([run 42430524883](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42430524883)) signed in and read the item, then refused
it on a byte-for-byte comparison of the item's key with the repository's; `c5fbfcb` made it check
the ID the key gives, and the second ([run 42430683011](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42430683011)) passed.

The v1.13.0 tag ([release run 42433869110](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42433869110)): the four archives built and tested, and
the live browser suites passed on Linux and macOS, the store-key case included. On Windows the
display matrix failed one configuration, `1.75x-1097x617-zoom175-overlay` (pinch 3), on a
screenshot: "the browser's relay closed the connection 328 ms into screenshot, before replying
(connection reset); the browser did not answer DevTools (fetch failed); the page did not answer
DevTools (fetch failed)" -- Chrome itself exiting, as in
[the open item below](#open-a-chrome-stall-in-one-display-configuration), on a path 1.13.0 does not
touch. Nothing was published. The failed job was run again and passed; the GitHub release published
at 02:06:21 UTC, the VS Code Marketplace job published, and the Chrome Web Store job uploaded
1.13.0 and submitted it. Google's API answered the submission without a state, and its status read
still showed nothing submitted a minute later; the developer dashboard showed the item pending
review. The store warned that the `<all_urls>` host permission may need an in-depth review.

### 1.13.0: found on the way

- **A grouping race, found by the live suites.** One multi-agent run in several listed a tab opened
  for the agent "研究" with no group: `browser_new_tab` replied once the page loaded, which a local
  page does in milliseconds, without waiting for the queued group sync, and `browser_tabs` did not
  wait for it either. Both now wait, bounded at two seconds. The check now prints the row it saw.
- **An update applied by a 1.12 server keeps the old registration.** That update runs 1.12's code,
  which writes one origin. The server now rewrites a registration that names it and is not current
  as it starts, and leaves another copy's alone.
- **cppcheck's `useStlAlgorithm`** flagged the origin loop; it is `std::any_of`.
- **The dry run's key check** compared bytes; see above.

### 1.12.0 (2026-11-07)

1.12.0 adds `browser_find`, options to scope, filter and cap `browser_snapshot`, slimmer outlines,
paged and scoped `browser_read`, a smaller catalog, and a meter of what each tool costs. The plan,
criteria and ledger are [plans/lean-observations.md](plans/lean-observations.md), with the raw outputs
in [plans/evidence/lean/](plans/evidence/lean/); the research behind it is
[research/browser-mcp-speed-and-token-efficiency.md](research/browser-mcp-speed-and-token-efficiency.md).
Every suite that existed before this work ran again against the 1.12.0 build (AC-LEAN-COMPAT).

### 1.12.0: suites

| Where                                                      | Result                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Windows 11, local (MSVC, Qt 6.10.3): ctest                 | 27/27, among them the new `test_browser_views`                                             |
| Local: `npm run test:js`                                   | 231/231                                                                                    |
| Windows, local: MCP smoke, full and read-only              | 54 and 15 tools                                                                            |
| Linux, WSL Arch (GCC 16.2.1, Qt 6.12.0): build and ctest   | 0 warnings; 26/26                                                                          |
| Linux, local: clang-tidy 23.1.4, cppcheck 2.22.0, Semgrep  | 0 findings each (221 rules, 55 files)                                                      |
| Linux, Chrome for Testing 153: full browser                | ok: 49 tools, 202 live cases (find, options, reads)                                        |
| Linux, Chrome for Testing 153: display matrix              | ok                                                                                         |
| Linux, Chrome for Testing 153: interference, multi-agent   | 10/10, 25/25                                                                               |
| Linux, Chrome for Testing 153: clipboard, large upload     | 24/24, 7/7                                                                                 |
| Linux, Chrome for Testing 153: extension version           | current 6/6, older 12/12, released 1.11.1 12/12                                            |
| Linux, Chrome for Testing 153: profiles, upgrade           | 14/14, 4/4                                                                                 |
| Linux, Chrome for Testing 153: the meter, 1.11.1 extension | find, slimming, the cap and reads answer; viewport filter refused with a note to reload it |

### 1.12.0: what the tools cost

The meter (`tests/e2e/meter_e2e.mjs`), on the 1.11.1 build before any change and on the 1.12.0 build,
with Chrome for Testing 153 at its default window, logged out. Bytes of each reply.

| Page                             | Snapshot, 1.11.1 | Snapshot, 1.12.0 | `interactive` | `viewport` | `browser_find` |
| -------------------------------- | ---------------: | ---------------: | ------------: | ---------: | -------------: |
| Fixture home                     |            7,449 |            3,929 |         2,700 |      2,319 |            320 |
| Wikipedia, "Web browser"         |          113,157 |           38,164 |        15,479 |      8,677 |          1,255 |
| Hacker News                      |           70,800 |           18,580 |         8,919 |     10,563 |            676 |
| GitHub, microsoft/playwright-mcp |          137,582 |           48,036 |        13,564 |      8,717 |          1,429 |

The tool catalog: 44,965 bytes for 53 tools on 1.11.1, 42,951 for 54 on 1.12.0, the same bytes in
every process (`meter-baseline.json`, `meter-after.json`).

### 1.12.0: red drills

Each check was red-drilled: the defect planted in a disposable copy, the check seen to fail for that
reason, then the copy restored byte for byte and the check green again (`unit-red-drills.txt`,
`extension-red-drills.txt`, `live-red-drills.txt`).

- _Find lists matches worst first:_ `find_exactMatchFirstWithItsContainers` fails.
- _A phrase's role words read as plain words:_ `find_queryRoleWordFiltersByRole` fails (two matches,
  not one).
- _A snapshot by ref shows the whole page:_ `outline_refShowsOneSubtreeWithTheSameRefs` fails.
- _Repeated text kept:_ `slim_dropsTextThatRepeatsItsParent` fails, and live, find on the find page
  returns six matches where two belong, the text lines beside the button.
- _The cap collapses nothing:_ `outline_elidesRegionsNotTheTail` fails -- the footer past the feed is
  cut.
- _An older extension's read paged from its start:_ `read_pagesAnOlderExtensionsWholeReply` fails.
- _The long tab_id description back:_ `catalog_tabIdOnExactlyTheTabScopedTools` fails.
- _A scoped read an older extension ignored, passed on:_
  `read_refusesAScopedReadAnOlderExtensionIgnored` fails.
- _In the extension:_ a read from the start whatever the offset, the page read's window, and elements
  below the viewport left unmarked each fail their test in `test_browser_extension_pure.mjs`.

### 1.12.0: CI and the release

The release commit, `0aa270f` ([Quality run 42408886381](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42408886381)):
builds, tests, analysis and both sanitizers passed on all three platforms; the format, lint and
secret scan job refused four new evidence files (trailing spaces, a final newline, one report
Prettier had not formatted), which the local hook run had not seen because it ran before they were
staged. `e55cd13` formatted them and recorded the one affected drill log's receipts again
([run 42409585251](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42409585251),
documents only: passed).

The v1.12.0 tag ([release run 42409723921](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42409723921)):
the four archives built and tested, and the live browser suites passed on Linux, macOS and Windows at
the first attempt. The GitHub release published at 20:28:09 and 1.12.0 reached the Marketplace for all
four targets; the tag's Quality run passed.

### 1.12.0: found on the way

- **Chrome's inline text runs.** The first live run showed find returning `inlinetextbox` lines:
  Chrome splits each text node into one run per laid-out line, each repeating part of it. Snapshots
  had always carried them. The repetition rule now drops them, and compares the page's own names
  rather than the capped ones the outline prints -- a 40,000-character paragraph had left about 400
  runs, with no position, counting as on screen.
- **The fixture template's `<main>`.** The shared page template wraps everything in one `<main>`, so
  a footer inside it is not the page's contentinfo landmark; the find page is a document of its own.
- **A harness race, measured.** One full-suite run in eight failed at its third case, "closed the
  user's tab". With the failing check made to say which tab it had taken, the next occurrence named
  it: the harness's own `chrome://extensions` tab, which turns on Developer mode and is closed
  before the suite starts -- gone from DevTools' target list, still listed active to the extension.
  The suite's baseline now waits it out; six runs in a row passed after.
- **clang-tidy 23's container check.** Its new
  `cppcoreguidelines-pro-bounds-avoid-unchecked-container-access` flagged 97 subscripts in the new
  code; it uses checked access (`at`, `replace`) like the rest of the source.

### 1.11.1 (2026-11-07)

1.11.1 stops the false registration-mismatch note on managed installs (pull request #5, with the
Windows junction resolved through the filesystem), builds with GCC 16 and Qt 6.12, passes the
checks clang-tidy 23 adds, and refuses invisible bidirectional characters in tracked text. The
extension is unchanged apart from its version. Everything else is 1.11.0, whose evidence follows
and still stands. Every result below is from the release tree.

### 1.11.1: suites

| Where                                                       | Result                          |
| ----------------------------------------------------------- | ------------------------------- |
| Windows 11, local (MSVC, Qt 6.10.3): Release build          | 0 warnings                      |
| Windows, local: ctest                                       | 26/26                           |
| Local: `npm run test:js`                                    | 227/227                         |
| Windows, local: MCP smoke, full and read-only               | 53 and 14 tools                 |
| Linux, WSL Arch (GCC 16.2.1, Qt 6.12.0): Release build      | 0 warnings                      |
| Linux, local: ctest                                         | 25/25                           |
| Linux, local: clang-tidy 23.1.4, warnings as errors         | 0 findings                      |
| Linux, local: cppcheck 2.22.0, exhaustive                   | 0 findings                      |
| Linux, local: Semgrep, `--config auto`                      | 221 rules, 55 files, 0 findings |
| Linux, Chrome for Testing 153: full browser                 | ok: 48 tools, 177 live cases    |
| Linux, Chrome for Testing 153: user interference            | 10/10                           |
| Linux, Chrome for Testing 153: multi-agent                  | 25/25                           |
| Linux, Chrome for Testing 153: per-agent clipboard          | 24/24                           |
| Linux, Chrome for Testing 153: large upload                 | 7/7                             |
| Linux, Chrome for Testing 153: extension version, current   | 6/6                             |
| Linux, Chrome for Testing 153: extension version, older     | 12/12                           |
| Linux, Chrome for Testing 153: two profiles                 | 14/14                           |
| Local: pre-commit `no-bidirectional-characters`, every file | passes                          |

The first local clang-tidy 23 run found 21 errors in the tree as first prepared -- signed bitwise tests
of `poll()` results, `fcntl()` flags and the PNG shifts, three copies that could be moves, and
const-able pointees -- and a second pass found one more (`runMcpProcess`'s `argv`) once its
callees took `char *const *`. CI's analysis job runs Ubuntu's older clang-tidy, which has none of
these checks. The poll and relay paths those fixes touch ran again under every live suite above.

### 1.11.1: red drills

Each check was red-drilled: the fix reverted in a disposable copy, the check seen to fail for that
reason, then the committed source restored byte for byte and the check green again.

- _The registration note compared as text (Linux):_ `registrationNote_followsLinksToTheSameFile`
  fails -- the `current` symbolic link and its version directory are reported as different
  servers -- 10 of 11 pass; restored, 11 of 11.
- _The note through Qt's `canonicalFilePath()` (Windows):_ the same test fails, because Qt does
  not follow the directory junction a managed install uses -- the pull request as first filed;
  restored, 11 of 11.
- _The PNG header read with its low bytes swapped (Linux):_
  `screenshotReply_populatesImageChannelWithDimsFromPngHeader` fails (no `1280x720`); restored,
  42 of 42.
- _The bidirectional-character hook:_ each of the 11 controls it refuses (U+200E, U+200F,
  U+202A-U+202E, U+2066-U+2069), planted in a scratch file, fails the hook; ordinary non-ASCII
  text (an em dash, accents, an emoji, a line separator, a no-break space) passes it.

### 1.11.1: CI and the release

The release commit, `42bce8b`
([Quality run 42395721470](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42395721470)):
all nine jobs passed. Pull request #5's own branch passed all nine on `3f3b52a` before it was
merged as `afcbccd`.

The v1.11.1 tag ([release run 42396410061](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/42396410061)):
the four archives built and tested, and the live suites passed on Linux and macOS. On Windows the
display matrix failed two configurations, `1x-3840x2160-zoom100-classic` and
`1.5x-2560x1440-zoom100-overlay` -- both pinch 1.5, both capturing 3840x2160 device pixels -- each
on a screenshot: "the browser's relay closed the connection 390 ms into screenshot, before replying
(connection reset); the browser did not answer DevTools (fetch failed); the page did not answer
DevTools (fetch failed)". That is Chrome itself exiting, as recorded under
[the open item below](#open-a-chrome-stall-in-one-display-configuration), on a path 1.11.1 does not
touch: the capture never returned, so the server's PNG reader never ran. Nothing was published. The
failed job was run again and passed; the GitHub release published at 18:13:30 and 1.11.1 reached the
Marketplace for all four targets.

### 1.11.0 (2026-11-01)

1.11.0 lets `browser_upload` carry files up to 2 GiB (or what `CHROME_CONTROL_MCP_UPLOAD_MAX_MB` sets),
read a piece at a time and staged in the page that uses them; fixes the relay ending itself under
steady traffic on Linux and macOS; and runs CI in tiers. Everything else is 1.10.0 and earlier,
whose evidence follows and still stands. The plan, criteria and ledger are
[plans/large-uploads.md](plans/large-uploads.md), with the raw outputs in
[plans/evidence/uploads/](plans/evidence/uploads/). Every suite that existed before this work ran
again against the 1.11.0 build (AC-UPL-COMPAT).

### 1.11.0: suites

| Where                                                | Result                                                 |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Windows, local: ctest                                | 26/26 (uploads 12/12, relay 38/38, pipe 31/31)         |
| Linux (WSL2), local: ctest                           | 25/25                                                  |
| Local: `npm run test:js`                             | 227/227 across 13 files                                |
| Linux, local: GCC 16, clang 22                       | no warnings                                            |
| Linux, local: run-clang-tidy, exhaustive cppcheck    | clean                                                  |
| Linux, local: Semgrep 1.174.0, Python 3.12           | 221 rules, 54 files, 0 findings                        |
| Built server, both security profiles                 | 53 tools full, 14 read-only                            |
| Linux, Chrome for Testing 153: large uploads         | 7/7                                                    |
| Linux, Chrome for Testing 153: display matrix        | 35 configurations, 3335 checks                         |
| Linux, Chrome for Testing 153: full suite            | ok: 177 live cases                                     |
| Linux, Chrome for Testing 153: earlier suites        | interference 10/10, multi-agent 25/25, clipboard 24/24 |
| Linux, Chrome for Testing 153: versions and profiles | 6/6, 12/12, 8/8; two profiles 14/14, the update 4/4    |

`large_upload_e2e.mjs` hashes, in the page, every 8 MiB slice of what each way in received and the
digest of those digests, against the same of the file on disk: a 300 MiB file of random bytes by
ref to a file input; 40 MiB files through an input picker the page opened, onto a drop zone by ref
(on a page with no file input in scope), and as a `showOpenFilePicker` answer; a page reloaded 1.5 s
into a 300 MiB delivery, which was given nothing and said so, then took the next upload; a second
server with `CHROME_CONTROL_MCP_UPLOAD_MAX_MB=64` refusing the 300 MiB file before any of it was
sent; and the worker holding no upload at the end.

**Rate.** 300 MiB took 30 s in the final pass (9.9 MiB/s); the runs here measured from 2.3 to
9.9 MiB/s. The documents quote 2 to 6 MB/s, the slower runs. The limit is `chrome.debugger`, timed
from inside the worker: 2.7 ms for an empty call, 53 ms for 512 KiB, 310 ms for 2 MiB, 600 ms for
4 MiB -- about 7 MB/s of base64 whatever the size of the call. The same 512 KiB over a raw DevTools
socket takes about 15 ms.

### 1.11.0: red drills

Eleven mutations, each seen to fail its own test for that reason, then restored byte for byte and
green: the server reading the rest of a file in one piece; a malformed cap falling back to 2 GiB;
pieces not addressed to the ref's element; an extension older than 1.11.0 sent `uploadStage`; the
relay ending on one closed look; the page dropping what it gathered when it folds (live: the
300 MiB hash no longer matched); the worker keeping each piece; a piece out of order taken; a staged
file outliving its tab's attachment; a picker's file not staged in its window; an upload's pieces
cancelling an armed dialog answer (`unit-red-drills.txt`, `live-red-drills.txt`,
`extension-red-drills.txt`).

### 1.11.0: the relay ending itself

The first live upload lost its file at piece 388 of 800 to "the browser's relay closed the
connection". On Linux and macOS the relay's watcher asks whether Chrome's end of stdin is readable
and then how many bytes wait; its pump thread can read them all in between, and "readable with
nothing waiting" is how a closed pipe looks. A probe running that check on a busy pipe called it
closed 3494 times in 7,150,967 looks, and never when three looks in a row were required at the
watcher's cadence (`browser_bridge_relay.h`, `BrowserExitConfirmation`). This was the cause of the
open "relay closed between two commands" failures recorded for
[1.9.0](#190-one-unexplained-failure) and for [the 1.10.0 tag](#1100-the-v1100-tag-and-release),
both on Linux; the Windows check uses `PeekNamedPipe` and had no such race.

### 1.11.0: CI and the release

The first push under the tiers, `cc01a68`
([Quality run 41331871943](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41331871943)):
nine jobs -- what changed, formatting, lint and secret scan, PowerShell and native analysis, builds
and tests on Windows, Linux and macOS, both sanitizers -- all passed, with no live browser job, in
6 minutes 20 seconds from start to finish. The two pushes before the tiers took 19 and 20 minutes,
and one of them (`2535b19`) changed nothing but this file.

The v1.11.0 tag ([release run 41332519441](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41332519441)):
the four archives built and tested, and the live browser suites ran on all three platforms through
`live.yml` -- Linux in 13.8 minutes, macOS 14.8, Windows 21.5. The GitHub release published at
18:00:16, three seconds after the last live job finished, and 1.11.0 reached the Marketplace for all
four targets. The large-upload suite passed 7/7 on each platform: 300 MiB at 11.5 MiB/s on Linux,
8.8 on macOS, 5.9 on Windows (`ci-large-upload-*.json`). The tag's own Quality run passed all nine
jobs. Raw run records: `ci-push-code.json`, `ci-release.json`.

### 1.10.0 (2026-11-01)

1.10.0 lets one server serve every Chrome profile the extension is loaded in, with agents choosing a
profile per call, naming profiles (account email, a name given on the new options page, or a
generated one), and listing every profile's tabs. Everything else is 1.9.0 and earlier, whose
evidence follows and still stands. The plan, its acceptance criteria and its evidence ledger are
[plans/chrome-profiles.md](plans/chrome-profiles.md), with the raw outputs in
[plans/evidence/profiles/](plans/evidence/profiles/). Every suite that existed before this work ran
again against the 1.10.0 build as its regression proof (AC-PROF-SINGLE); the earlier plans' own
ledgers are closed records of their releases and were not re-stamped.

### 1.10.0: suites

| Where                                                  | Result                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| Windows, local: ctest                                  | 25/25 (pipe 31/31, relay 36/36, contract 71/71)                     |
| Linux (WSL2), local: ctest                             | 24/24                                                               |
| Local: `npm run test:js`                               | 217/217 across 12 files                                             |
| Local: pre-commit, all files                           | every hook passes, Gitleaks included                                |
| Linux, local: GCC 16, clang 22                         | no warnings                                                         |
| Linux, local: run-clang-tidy, exhaustive cppcheck      | clean                                                               |
| Linux, local: Semgrep 1.174.0, Python 3.12             | 221 rules, 54 files, 0 findings                                     |
| Built server, both security profiles                   | 53 tools full, 14 read-only                                         |
| Linux, Chrome for Testing 153: two profiles, headed    | 14/14                                                               |
| Linux, Chrome for Testing 153: the update, one profile | 4/4                                                                 |
| Linux, Chrome for Testing 153: display matrix          | 35 configurations, 3335 checks                                      |
| Linux, Chrome for Testing 153: full suite              | ok: 48 tools, 177 live cases                                        |
| Linux, Chrome for Testing 153: earlier suites          | interference 10/10, multi-agent 25/25, clipboard 24/24              |
| Linux, Chrome for Testing 153: versions                | same version 6/6; older, reloading itself 12/12; released 1.8.2 8/8 |

`profiles_e2e.mjs` runs two ways. With two profiles of one headed Chrome under Xvfb (headless Chrome
opens no second profile) and one server, it checks: both served at once; each with its own
generated name (the test Chrome is signed out); each renamed through its own options page and
called so at once, nothing reloaded; new tabs in the profile named, without regard to case; an
unknown profile refused, naming those connected; with none named, the profile whose window was last
focused; calls following their tab, including a tab the server had never seen; `browser_tabs` and
`browser_windows` naming each entry's profile; `browser_release` letting go in both; one profile
reloading while the other's refs keep working; status listing those still connected. With one
profile, staged as 1.0.0 without the `identity` permissions, it checks that the extension still
names its profile, that a probe for new servers finding every server held never becomes a second
connection, and that the extension reloads itself into files asking for the permissions, comes back
enabled, and keeps its name.

### 1.10.0: red drills

Seventeen mutations, each reverting one behaviour. Each was seen to fail its own test for that
reason, then restored byte for byte and green again. Server and live drills ran in the WSL mirror
(`unit-red-drills.txt`, `live-red-drills.txt`), extension drills on Windows
(`extension-red-drills.txt`):

- **Transport:** a ninth relay admitted; an exited Chrome still counted as served; a name bounded by
  the email's limit; a relay told "no server" connecting to the newest anyway; a 1.9.0 relay served
  beside another connection of its Chrome.
- **Routing:** a connection leaving forgetting every profile's tabs; a window in front not counting
  as focused; a call naming a tab going to the current profile; `browser_tabs` asking one profile;
  a version note not naming its profile; an extension older than profiles counting as focused.
- **Extension:** the email winning over the user's name; the options page saving a name uncleaned;
  a port attaching before the profile's name was read.
- **Live:** a probe's port becoming a second connection; a generated name not kept across the
  update's reload; a rename on the options page not picked up until a reload.

### 1.10.0: found on the way

The evidence passes found three defects before release, each now covered by a test that failed
without its fix:

- **A port with no server became a second "profile".** When every server already has one of its
  ports -- the extension probing for new servers, or a surplus port at startup -- the extension
  answers the relay's offer with no session. The relay connected that port to the newest server
  anyway. A server of one connection had turned it away; the new server admitted it as a second
  connection of the same profile, which answered for real tabs and closed. The display matrix saw
  `the browser's relay closed the connection 1054 ms into click`. The relay now connects such a port
  nowhere. A relay older than 1.10.0 still connects it, so the server serves one only alone from its
  Chrome.
- **A profile could attach nameless.** A port opened as the worker starts can be offered servers
  before the profile's name is read from storage; the two-profile case once listed a profile as
  `unnamed`. Attaching now waits for the read, at most two seconds.
- **The harness handed a suite its own closing tab.** The live harness turns Developer mode on in a
  `chrome://extensions` tab, and closing a tab over DevTools answers before the tab is gone. A suite
  reading the active tab at once could get that tab: the display matrix's "the browser's own tab
  stayed in front throughout" failed in two of four full runs, one configuration each, once the
  failure was made to say which tab was in front (`chrome://extensions/`). The harness, as it has
  been since 1.9.0, now waits for the tab to go.

### 1.10.0: CI on `87dcdf7`

[Quality run 41291633571](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41291633571):
the builds and tests on Windows, Linux and macOS, both sanitizers, and the live browser suites on
all three platforms passed -- the two-profile case on Linux and the update into the new permissions
on every platform among them. Two jobs failed, neither on product behaviour. Two raw evidence files
had trailing whitespace and no final newline (the repository's hooks had not been run on files new
to the commit), and the CI image's cppcheck flagged a raw search loop in
`browser_bridge_pipe_common.cpp` that the local cppcheck 2.22 passes. The loop became a
`std::find_if`, and every suite, live suite and drill above was run again on that source before the
receipts were recorded.

### 1.10.0: CI on `1faf0fa`, the release commit

[Quality run 41295647728](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41295647728):
all 11 jobs passed -- lint and secret scan, PowerShell and native analysis (clang-tidy, cppcheck,
Semgrep), builds and tests on three platforms, both sanitizers, and the live suites on three
platforms, the two profiles cases among them.

### 1.10.0: the v1.10.0 tag and release

The [release run](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41297205683)
built the four archives, ran ctest and the smoke test on each, published the
[release page](https://github.com/RandyNorthrup/chrome-control-mcp/releases/tag/v1.10.0) with its
eight downloads and `SHA256SUMS.txt`, and published 1.10.0 to the VS Code Marketplace for all four
platforms (confirmed with `vsce show`).

The tag's own [Quality run](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41297205679)
passed every job but the Linux live suites, where one display configuration
(2x-1440x900-zoom100-overlay) stopped about a second into its Chrome on
`the browser's relay closed the connection 3 ms into read, before replying (connection reset)`.
The same source had passed every job twice. The relay ended on Chrome's side of the bridge, between
two commands, and the server sent the next one before its 250 ms idle check would have noticed. This
is the class of [1.9.0's one unexplained failure](#190-one-unexplained-failure), now named by the
server. What was checked: no early reconnect in ten launches watched for four seconds each; every
connection's socket closed once, by its own thread, the only one doing I/O on it; refs dropped and
the wait for a reattaching relay exactly as 1.9.0 has them. The failed job's re-run (attempt 2)
passed. Open: why a relay closes in mid-suite; the next occurrence needs the extension's own record
of why its port closed.

### 1.9.0 (2026-10-31)

1.9.0 adds per-agent clipboards (extension, `browser_clipboard`, the MCP `instructions`), has the
server, the relay and the extension exchange versions so the agent is told when Chrome is running
an older or newer extension and the extension reloads itself for a newer install, checks a
file-carrying call's arguments before sending its files, and names why a broken exchange ended.
Everything else is 1.8.2 and 1.8.1, whose evidence follows and still stands. Each feature has its
plan, acceptance criteria and evidence ledger --
[plans/per-agent-clipboard.md](plans/per-agent-clipboard.md) and
[plans/extension-version.md](plans/extension-version.md) -- with the raw outputs in
[plans/evidence/clipboard/](plans/evidence/clipboard/) and
[plans/evidence/extension-version/](plans/evidence/extension-version/). Both were re-verified
together after the version work, which changed files the clipboard evidence was bound to.

### 1.9.0: suites

| Where                                       | Result                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Windows, local: ctest                       | 24/24                                                                       |
| Linux, local: ctest                         | 23/23                                                                       |
| Local: `npm run test:js`                    | 210/210 across 11 files                                                     |
| Local: pre-commit, all files                | 15 hooks pass                                                               |
| Linux, local: clang-tidy on the changed C++ | clean                                                                       |
| Linux, local: Semgrep 1.174.0, Python 3.12  | 221 rules, 52 files, 0 findings                                             |
| Built server, both profiles                 | 53 tools full, 14 read-only                                                 |
| Linux, Chrome for Testing 153: clipboard    | 24/24 (33 consecutive passes before the version work)                       |
| Linux, Chrome for Testing 153: versions     | same version 6/6; older, reloading itself 12/12; released 1.8.2 8/8         |
| Linux, Chrome for Testing 153: multi-agent  | 25/25                                                                       |
| Linux, Chrome for Testing 153: interference | 10/10                                                                       |
| Linux, Chrome for Testing 153: full suite   | ok: 48 tools, 177 live cases (`browser_clipboard` is the clipboard suite's) |

`clipboard_e2e.mjs` runs two servers and three agents. A sentinel is put on the browser's own
clipboard by a page the "user" opened, through DevTools, before any agent runs. The suite then
checks, among its 24:

- a write of text, HTML and an image;
- pastes into an editor that reads the paste event, one that reads `beforeinput insertFromPaste`, a
  bare editable region, an editor in a same-origin frame (files included) and a field in a frame from
  another site (typed);
- Control+C, X and V in a text field;
- copy buttons built with `execCommand` and with `navigator.clipboard`, a paste button, and a page
  reading the clipboard on its own (refused);
- isolation from a second agent and from an agent on a second server;
- a copy button in a page loaded after the agent took its tab;
- the browser's own clipboard functions back after a tab is handed back, and the clipboard cleared
  when its agent lets go;
- the sentinel still on the browser's clipboard at the end, and never in an agent's page.

### 1.9.0: red drills

Each mutation reverted one behaviour, the check was seen to fail for that reason, and the source was
restored and green again.

- **Live, staged into the extension the browser loads** (log: `live-red-drills.txt`):
  - _Copy, cut and paste sent to Chrome as keys again:_ the agent pasted the sentinel -- the user's
    own clipboard -- into the rich editor.
  - _No page stand-in at all:_ the page's copy buttons overwrote the user's clipboard (the sentinel
    became `exec-copied-text`), and the page's own timed read got it.
  - _No stand-in for documents loaded after the tab was taken:_ the copy button on the navigated page
    wrote the user's clipboard.
  - _No command window:_ the page's timed read succeeded.
  - _No restore on handback:_ the page kept the stand-in.
  - _One clipboard per agent name across every server:_ the second server's agent named `beta`
    read the first server's `beta`'s clipboard.
- **Unit** (`unit-red-drills.txt`): chord interception, per-agent keying, the command window,
  clearing on release, and Shift+Enter (not Enter) between typed lines -- each fails its test.
- **Contract** (`contract-red-drill.txt`): with `browser_clipboard`'s per-action checks removed,
  both clipboard contract tests fail.
- **Pipe** (`pipe-cause-red-drill.txt`): with every ending reported as silence again, the test of a
  relay that closes mid-command fails.

The two "no stand-in" drills are what the clipboard isolation exists for. They show that, without
it, an agent's click on a page's copy button writes the user's clipboard, as 1.8 does.

### 1.9.0: real editors, live

An agent pasted a marker from its own clipboard with Control+V and copied it back with Control+A,
Control+C. This ran in the dedicated Chrome for Testing, on Linux, with no accounts and nothing
submitted (`real-sites*.json`). It passed on:

- ProseMirror, Lexical, Slate (through `beforeinput`), Quill, Draft.js, CKEditor 5 and CodeMirror 6;
- a plain form field on httpbin.org.

TinyMCE could not be tried: its editor frame appears in the snapshot with no ref, so it is reachable
only by screenshot coordinates. The same-origin frame path it would exercise is covered by the
fixture instead. A snapshot ref for iframe elements is on [PLAN.md](../PLAN.md).

### 1.9.0: CI on `d736c8c`

[Quality run 41252800794](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41252800794):
every job passed except the macOS live browser suites, where the clipboard suite failed 4 of its 24
checks: Control+C, Control+X and Control+V in a text field, and "each agent pastes its own". All
four began with the suite pressing Control+A to select the field, which on macOS moves the caret to
the start of the paragraph -- for a person as for an agent -- so there was nothing selected to copy.
The suite had only ever run on Linux before CI. It now selects with Command+A on macOS, as the full
suite already did; the product is unchanged. The other 20 checks, the sentinel ones included,
passed on macOS.

### 1.9.0: versions exchanged

`extension_version_e2e.mjs` runs one suite three ways, chosen by how the browser loads the
extension, and works out which from `browser_extension_status` -- a native tool, so watching the
extension go quiet never disturbs that quiet:

- **Same version:** no notice in `browser_extension_status` or on the first reply, and no reload in
  15 s.
- **This build under an older manifest version** (`--extension-version=1.0.0`): the first reply on
  the connection carries the notice as a block of its own after its JSON, the second does not; left
  idle, the extension reloaded itself no sooner than its 10 s quiet period, came back still saying
  1.0.0 with the version it reloaded for remembered, and the new connection was told again; watched
  for 40 s more, it did not reload again; tabs open and release after it.
- **The released 1.8.2 extension**, downloaded from its GitHub release: works beside this server,
  is named older than 1.9.0 with `browser_clipboard` among what is missing, `browser_clipboard`
  fails saying why and how to reload, the rest -- new tab, snapshot, release -- works as it did, and
  it does not reload itself.

Two things the live runs found that no unit test could:

- **The harness hid every self-reload.** Chrome disabled the extension on its own
  `chrome.runtime.reload()` -- chrome://extensions reported `unsupportedDeveloperExtension` --
  because the test profile never had Developer mode on, which `Load unpacked` requires and so
  every real install has, and `--load-extension` skips only at launch. The harness profile now has
  it on. The protocol self-reload had the same blind spot.
- **A call in the half second after a reload meets the old relay**, before it (250 ms poll of its
  input) or the server (250 ms idle check) has noticed Chrome closed it, and fails "the browser's
  relay closed the connection 1 ms into listTabs (connection reset)". It cannot have run: the port
  it would reach was closed. Accepted, since a reload follows at least 10 s with no command and no
  held tab, and a retry reaches the new connection; `browser_extension_status` now counts
  `connections`, so a caller can see the new one arrive.

Red drills, each failing its check and restored to green (logs in
[plans/evidence/extension-version/](plans/evidence/extension-version/)):

- **Live** (`live-red-drills.txt`, `live-red-drills-2.txt`), each against the case that meets it:
  the reload remembering nothing (it reloaded again: "no loop" failed), `bridge_ready`'s version
  ignored (no reload), the server telling nothing (both notice checks failed),
  `browser_extension_status` without the notice, an unknown command passed on bare (the released
  extension's `browser_clipboard` check failed), and a hello that says no extension version refused
  (the released 1.8.2 extension never attached) -- which is what an older extension would meet if
  the new fields were required.
- **Unit** (`unit-red-drills.txt`, `server-red-drills.txt`): seven in the extension -- no version
  in `attach_session`, held tabs ignored, no quiet period, no once-per-version memory, no re-check
  after storage answers, an equal version counted as newer, and a version taken unchecked -- and
  five in the server -- the relay dropping the extension's version, versions taken unchecked, the
  notice told on every call, an unknown command passed on bare, and `browser_extension_status`
  without the notice.

The drills found one fault of their own: a drill that leaves a helper unused fails to build under
warnings-as-errors, and the suite then ran the previous binary and passed. The harness reported it
as not seen rather than as a pass; the mutation now keeps the helper in use. And restoring a file
with `rsync -a` gives it back its old timestamp, older than the objects the mutated copy was built
into, so the build kept the mutation; drilled files are now made newer after every restore.

### 1.9.0: CI on `010b234`

[Quality run 41255263314](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41255263314):
the macOS live suites passed with the clipboard suite's Command+A fix. The Linux live job never
reached a suite: it spent its whole 45-minute budget inside the Qt install step and was cancelled
there. Every other job passed.

### 1.9.0: CI on `2c458fc`

[Quality run 41263082585](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41263082585):
Linux live suites passed, the three extension-version cases included. Two failures:

- **macOS, the older-extension case:** the extension reloaded itself and never came back. The
  harness had turned Developer mode on by writing it into the profile's Preferences, which works on
  Linux; Windows and macOS protect that preference and reset an edited one at startup, so on the
  macOS runner the reload disabled the extension exactly as before. The harness now turns it on the
  way the toggle at chrome://extensions does, through that page's own `developerPrivate` API, on
  every platform.
- **Windows, the display matrix:** the known stall at 3840x2160 device pixels, now placed in Chrome
  itself (see [Open: a Chrome stall](#open-a-chrome-stall-in-one-display-configuration)). Every
  suite after it in the job was skipped, so Windows ran neither the clipboard nor the version
  suites. Each live suite in CI now runs whatever the ones before it did, as long as the browser was
  installed; the job still fails if any of them does.

### 1.9.0: CI on `8650610`, the release commit

- [Quality run 41266324042](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41266324042):
  every job passed on Linux and macOS, the three extension-version cases included, and on Windows
  every suite but the display matrix passed, now that one cannot hide the others: clipboard, all
  three version cases, full, multi-agent and interference. The matrix met the Chrome stall once more
  (`1.75x-2194x1234-zoom100-classic`, 3840x2160 device pixels, Chrome's DevTools gone). Re-run to
  tell an intermittent Chrome fault from one this release made constant, the Windows job passed
  whole, the matrix included.
- [Quality run 41268653697](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41268653697)
  on the `v1.9.0` tag: every job passed on all three platforms.
- [Release run 41268653629](https://github.com/RandyNorthrup/chrome-control-mcp/actions/runs/41268653629):
  the release page check passed before the build, four archives and four VS Code packages built and
  published with checksums, the page built by `scripts/release_notes.mjs`, and the Marketplace
  serving 1.9.0 for win32-x64, linux-x64, darwin-arm64 and darwin-x64.

### 1.9.0: one unexplained failure

In the final pass, one run of the clipboard suite stopped on a `browser_click` that answered
`browser did not reply within 30000 ms (connection reset)`, on Linux, at 1x, with no large capture
involved. It did not recur in the 33 runs that followed. That message was also what the server
said when the relay closed the connection, so the failure could have been either. Since 1.9.0 the
server names which. See [Open: a Chrome stall](#open-a-chrome-stall-in-one-display-configuration).

### 1.8.2: release

| Where                                       | Result                                              |
| ------------------------------------------- | --------------------------------------------------- |
| Windows, local: ctest                       | 22/22                                               |
| Local: `npm run test:js`                    | 192/192                                             |
| Linux, local: ctest                         | 21/21                                               |
| Linux, Chrome for Testing 153: multi-agent  | 25/25                                               |
| Linux, Chrome for Testing 153: interference | 10/10                                               |
| Linux, Chrome for Testing 153: full suite   | ok: 48 tools, 177 live cases, Chrome state restored |

Each new check was red-drilled (the fix reverted, the check seen to fail for that reason, then
restored and green again):

- _Release scope, unit:_ with release by `tab_id` put back to the one tab, the test of an agent's
  popups, its popup's popup and its other named tab fails.
- _Release scope, live:_ with the same reversion staged into the extension the browser loads, the
  multi-agent suite's new check fails exactly as reported from daily use -- the release reply closed
  one tab and said `tabs_still_held: 2`, the popup left open behind it.
- _A refused close:_ with the close put back to one unchecked attempt, the test of a tab Chrome
  never lets close fails: it is reported closed and left in the AI group.

### 1.8.1

1.8.1 changes the extension (upload replies, agent names in any script, colour order), the MCP
`instructions` text, the CI analysis job and which suites ctest runs. The bridge protocol and every
other native path are as in [1.8.0](#180-2026-10-31), whose evidence below still stands for them.

### Native and unit suites

| Where          | Toolchain                         | Result                          |
| -------------- | --------------------------------- | ------------------------------- |
| Windows, local | MSVC, warnings as errors          | 22/22 ctest suites              |
| Linux, local   | GCC                               | 21/21 ctest suites              |
| Local          | Node, `npm run test:js`           | 190/190 tests across 9 files    |
| Linux, local   | Semgrep 1.174.0 under Python 3.12 | 221 rules, 51 files: 0 findings |

The Windows count is one higher because `test_windows_process_identity` builds only on Windows.
ctest runs the twelve C++ suites (eleven off Windows) and all ten JavaScript suites; `npm run
test:js` is the nine of those that need no built server. Until 1.8.1 two of them,
`test_browser_extension_tabs` and `test_release_versions`, ran only under `test:js`, which CI never
calls.

New in these counts, each red-drilled (the fix reverted, the test seen to fail, then restored):

- Agent names in any script: two unit tests fail against the old ASCII-only strip, and so does the
  live check below, whose tab then lands in the session's shared group.
- The relay's progress-beat test with its wider margin fails, naming the server's reason ("browser
  did not reply within 1000 ms"), when the relay stops forwarding beats.

### CI on `fce2acb`

Every job of the Quality run on `fce2acb`, the 1.8.1 change set, passed:

| Job                                       | Result                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Format, lint, and secret scan             | passed                                                                                                  |
| PowerShell static analysis                | passed                                                                                                  |
| Windows, Linux, macOS build and tests     | ctest 22/22 on Windows, 21/21 on Linux and macOS; the built server smoked in both profiles              |
| ASan + UBSan, TSan                        | 21/21 each                                                                                              |
| Native and semantic static analysis       | clang-tidy and exhaustive cppcheck clean; Semgrep under Python 3.12.15: 221 rules, 53 files, 0 findings |
| Windows, Linux, macOS live browser suites | passed, each with the display matrix at 35/35 configurations and 3,335 checks                           |

The live browser jobs run against Chrome for Testing 153.0.8010.52, pinned in the workflow: the
display-scale, zoom and pinch matrix, the user interference suite, and the multi-agent suite (with
its new checks for an agent named `研究` and for `page_cleared_input`) on all three platforms, and the
full browser suite, 48 tools exercised, on Windows and macOS. The Linux runner's Chrome never answers
a screenshot under an emulated fractional device scale, so the full suite does not run there; the
workflow records why.

### Semgrep

The analysis job's Semgrep step had crashed before scanning since Python 3.15 reached the runners.
The Qt install action set up the newest Python for itself, and the job then ran Semgrep under it
instead of under the 3.12 it pins; `semgrep-core` segfaults at start-up under 3.15 ("failed to create
domain backup thread"). Reproduced locally: the same scan crashes the same way under 3.15.2 and is
clean under 3.12.16. The job now tells the Qt action to leave Python alone.

### Live browser, isolated Chrome for Testing 153 (Linux, 2026-10-31)

| Suite                       | Result                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `full_browser_e2e.mjs`      | ok: 48 of the 52 tools exercised, 177 live cases, Chrome state restored |
| `multi_agent_e2e.mjs`       | 24/24                                                                   |
| `user_interference_e2e.mjs` | 10/10                                                                   |

The four tools the full suite does not drive are `browser_update_check`, `browser_update_status`
and `browser_update_apply`, covered by `test_updater` and the update-path evidence below, and
`browser_release`, which `multi_agent_e2e.mjs` drives.

`multi_agent_e2e.mjs` runs two servers with two agents behind one of them in one live browser:
separate tabs by `tab_id`, refs bound to their tabs, a group per agent -- one of them named `研究`,
whose group must carry that name -- refusal of another server's tab, uploads through a
script-created input (whose reply must name the file and say the page emptied the input), a drop
zone and `showOpenFilePicker` with no dialog, a `target=_blank` popup claimed while the user's front
tab stays in front, and cleanup on `browser_release` and on server exit.

No new run in a real Chrome profile was made for 1.8.1; the [1.8.0](#180-2026-10-31) run stands.

### Open: a Chrome stall in one display configuration

On the `v1.8.0` tag's Quality run, the Windows display matrix's `1.75x-2194x1234-zoom100-classic`
configuration (pinch 3) stopped at 58 of its checks: a full-page `browser_screenshot` failed with
`browser did not reply within 30000 ms (connection reset)`. Every command beats every 5 s while it
runs, from a timer started before the handler's first `await`, so 30 s of silence means nothing
from the extension reached the server at all -- not a slow capture.

Run six times locally on Windows (headless Chrome for Testing 153, that configuration alone), it
passed five times; the sixth stopped on `DevTools Input.synthesizePinchGesture timed out`, the
suite's own DevTools call to Chrome, which does not pass through the server, the relay or the
extension. Runs of the same configuration took between 37 and 93 s. The configuration passed in all
four other Windows CI runs on record and on Linux and macOS.

So Chrome itself stalls, intermittently, in this configuration, and that stall is what the CI
screenshot met. Why Chrome stalls is not established, and this stays open in
[PLAN.md](../PLAN.md).

Since then, the `v1.8.1` tag's Quality run met the same failure twice more on Windows, in
`1x-3840x2160-zoom67-classic` (on its first screenshot) and `1x-3840x2160-zoom500-classic`. All three
failures are captures of 3840x2160 device pixels, all on Windows, and all on tag-push runs -- the
moment the release workflow's jobs start beside the Quality run's -- while every main-branch run's
live suites passed, and the `v1.8.2` tag run passed whole. The error text says only that nothing
arrived for 30 s; from 1.9.0 a failed screenshot in the matrix also reports whether Chrome still
answers its own DevTools (the browser process and the page), which says on the next occurrence
whether Chrome stalled or only the path through the extension.

The next occurrence answered it. On the main-branch run of `2c458fc`, Windows
`2x-1920x1080-zoom100-classic` (pinch 3; 3840x2160 device pixels again) failed its screenshot with
"the browser's relay closed the connection 329 ms into screenshot, before replying (connection
reset); the browser did not answer DevTools (fetch failed); the page did not answer DevTools (fetch
failed)". Chrome's own DevTools endpoint was gone, browser and page alike: Chrome itself stopped, and
the relay -- a child of Chrome -- went with it. The extension and the bridge were the messengers,
not the fault. It is also the first occurrence on a main-branch push rather than a tag. Why Chrome
for Testing stops capturing 3840x2160 pixels on the GPU-less Windows runner is still not
established.

The `v1.11.1` tag met it twice in one run, now that the live suites gate publishing:
`1x-3840x2160-zoom100-classic` and `1.5x-2560x1440-zoom100-overlay`, both pinch 1.5 and 3840x2160
device pixels, both with Chrome's DevTools endpoint gone. Linux and macOS passed the same
configurations, and the job passed when run again. A capture of fewer device pixels is the likely
way round it whatever Chrome's cause; screenshots scaled to CSS pixels and capped are planned for a
coming release.

The `v1.13.0` tag met it once, in `1.75x-1097x617-zoom175-overlay` (pinch 3): the same message, Chrome's DevTools endpoint gone, Linux and macOS passing the same configuration, and the job passing when run again. It is the first occurrence outside a 3840x2160 configuration.

### Chrome's file chooser, measured on Chrome 153

- A file chooser opened in a tab that is not the active tab of its window is cancelled; the page
  gets `cancel`.
- In the active tab of an unfocused window, a native dialog opens over whatever the user is doing.
- `Page.setInterceptFileChooserDialog` works from `chrome.debugger` in a background tab.

These are why file pickers are caught rather than shown
([MULTI_SESSION.md](MULTI_SESSION.md#file-pickers)).

### Identity and counts

- MCP initialize: protocol `2024-11-05`, server `chrome-control-mcp`, with client-agnostic
  `instructions`.
- Full profile: 53 tools, 47 browser and 6 native. Read-only profile: 14 tools, 11 browser and 3
  native. Pinned by `test_browser_mcp_server`, by `test_browser_contract` (47 browser tools), and by
  `scripts/mcp_smoke.mjs`, which CI runs against every server it builds.
- Bridge protocol: 2 (`kBrowserBridgeProtocol`, `BRIDGE_PROTOCOL`).
- Extension version 1.11.0, ID `iojehhmnaigcejfcpmilpclmeljhlkaa`, native host
  `com.chromecontrolmcp.browser`, minimum Chrome 116. Delivered as an unpacked directory; no private
  key, packaged browser artifact, store account, or enterprise policy.

### Test suites

| Suite                                 | Runs in        | Coverage                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_browser_contract`               | ctest          | 47 browser-tool schemas, command translation, `tab_id`, `agent` and clipboard validation, refs bound to tabs                                                                                                                               |
| `test_native_messaging`               | ctest          | native frame codec and host handshake                                                                                                                                                                                                      |
| `test_browser_bridge`                 | ctest          | reply correlation, per-tab snapshots and staleness, refs dropped for released tabs, client name                                                                                                                                            |
| `test_browser_extension_installer`    | ctest          | public identity and isolated native-host lifecycle                                                                                                                                                                                         |
| `test_browser_uploads`                | ctest          | upload path rules, roots confinement, the cap and its variable, pieces read one at a time, a file changing under them                                                                                                                      |
| `test_browser_bridge_security`        | ctest          | ACL/permissions, nonce, per-pid rendezvous records, runtime-directory override                                                                                                                                                             |
| `test_browser_bridge_pipe`            | ctest          | IPC handshake, peer verification, deadlines and beats, idle-peer departure, why an exchange ended, reconnect, sweep, several relays at once, the ninth refused, another Chrome refused, an older relay served alone, profile names cleaned |
| `test_browser_bridge_relay`           | ctest          | relay/bridge/session end to end, offers of running servers only, `bridge_servers`, progress, versions, routing across profiles                                                                                                             |
| `test_install_layout`                 | ctest          | version-directory safety, link swap under an open file, pruning, install lock                                                                                                                                                              |
| `test_updater`                        | ctest          | asset naming, checksums, version order, staged install, an older build leaving a newer current                                                                                                                                             |
| `test_browser_mcp_server`             | ctest          | identity, `instructions`, 53 tools, profiles, envelopes, schemas, MCP content                                                                                                                                                              |
| `test_windows_process_identity`       | ctest, Windows | identity across a junction, from a child launched through one                                                                                                                                                                              |
| `test_browser_extension_pure`         | both           | service-worker security, storage, geometry, and decision functions                                                                                                                                                                         |
| `test_browser_extension_transport`    | both           | reconnect backoff and pause, offers, readiness handshake, protocol mismatch, refused commands                                                                                                                                              |
| `test_browser_extension_session`      | both           | what a tab stops believing when its debugger attachment ends                                                                                                                                                                               |
| `test_browser_extension_multisession` | both           | one port per server, and the leases that keep sessions apart                                                                                                                                                                               |
| `test_browser_extension_recording`    | both           | recording refusals, the timeline, and discard when the tab or session ends                                                                                                                                                                 |
| `test_browser_extension_offscreen`    | both           | the recorder host loaded for real, against a captureStream-less OffscreenCanvas                                                                                                                                                            |
| `test_vscode_payload`                 | both           | VSIX payload rules, with red drills for a link that survives pruning                                                                                                                                                                       |
| `test_extension_install_cycle`        | ctest          | install, status and uninstall tools driven through the built server against a real registration                                                                                                                                            |
| `test_browser_extension_tabs`         | both           | whose tab it is, popups, per-agent groups and names, release, parking, idle, file choosers                                                                                                                                                 |
| `test_browser_extension_clipboard`    | both           | chords never sent as keys, one agent never reaching another's, the page command window, clearing                                                                                                                                           |
| `test_browser_extension_versions`     | both           | the versions the extension reports, and reloading itself once into a newer install                                                                                                                                                         |
| `test_browser_extension_uploads`      | both           | a file staged in the page piece by piece, assigned by handle, bounds, the page changing, detach, the dialog arm                                                                                                                            |
| `test_browser_extension_profiles`     | both           | a profile's name, email and generated name, renames, focus, `profileState`, `findTab`, the options page                                                                                                                                    |
| `test_release_versions`               | both           | one version everywhere, with its changelog entry and release note                                                                                                                                                                          |

"Both" means ctest and `npm run test:js`; CI runs ctest on Windows, Linux and macOS.

### Reproducing

```shell
npm ci
npm run build              # configure, build, and run ctest
npm run test:js            # the JavaScript suites
npm run smoke
npm run smoke:read-only
npm run extension -- status
```

Equivalent native commands:

```shell
cmake -S . -B build -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
```

The Windows generator may add `-A x64`; multi-config builds place the executable under
`build/Release`.

The live suites, in a dedicated Chrome for Testing that never touches your own profile:

```shell
node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> tests/e2e/full_browser_e2e.mjs
node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> tests/e2e/multi_agent_e2e.mjs
node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=2 --executable=<server>
xvfb-run -a node tests/e2e/isolated_run.mjs --chrome=<CfT> --executable=<server> --headed \
  --second-profile="Profile 2" tests/e2e/profiles_e2e.mjs
node tools/backoff_probe.mjs <chrome> <unpacked extension dir> [seconds]
```

### Claim boundary

Verified for 1.11.0: source build and automated suites on Windows and Linux locally; strict native
analysis and a clean Semgrep scan; the live suites, large uploads and two profiles included, in
Chrome for Testing on Linux locally; and, for everything 1.11.0 leaves unchanged, the 1.10.0 and
earlier evidence that follows, including a real-world run in a real Chrome profile on Windows. Not verified: a signed-in
profile named by its account email in a live Chrome (the test Chrome is signed out; the email path is
unit-tested against a stand-in for Chrome's identity API); two profiles at once on Windows or macOS
(the two-profile case needs a headed Chrome and runs on Linux under Xvfb); a file larger than
300 MiB, or a large upload on Windows or macOS, outside the release's own live run; a real Chrome
profile on macOS or Linux; why Chrome stalls in the one display configuration above. No Linux machine has ever
installed a release through `browser_update_apply`. This is strong software evidence, not a claim
about every website, Chrome release, desktop environment, or machine configuration.

## Earlier evidence

Each section below records the build it names. Tool totals and suite counts in them are those of
that build.

### 1.8.0 (2026-10-31)

Tag `v1.8.0`, commit `ef9ae34`; CI results are for `0ebfbfc`, the next commit, which changed only
JavaScript dependency pins.

- **Native and unit suites, local:** Windows/MSVC 20/20 ctest suites; Linux/GCC 19/19; Linux/Clang
  clang-tidy and exhaustive cppcheck clean; 188/188 JavaScript tests under `npm run test:js`, two
  of whose files ctest did not yet run.
- **CI on `0ebfbfc`:** format, lint and secret scan, PowerShell analysis, Windows, Linux and macOS
  build and tests (with the built server smoked in both profiles), ASan + UBSan, TSan, and the live
  browser suites on all three platforms passed. clang-tidy and cppcheck passed; the Semgrep step
  crashed before scanning, so no Semgrep result exists for 1.8.0 (cause and fix under 1.8.1).
- **Release workflow for `v1.8.0`:** all four archives built, ran ctest and were smoked as staged;
  the GitHub release and the VS Code Marketplace publish succeeded.
- **The tag's own Quality run** also failed `npm audit` (fixed by `0ebfbfc`'s pins); one macOS
  relay test, `relay_forwardsProgressBeatsAndStillDeliversTheReply`, on a timing margin of about
  125 ms, widened in 1.8.1; and one Windows display-matrix configuration, a Chrome stall recorded
  as open under 1.8.1.
- **Live browser, isolated Chrome for Testing 153 on Linux:** `full_browser_e2e.mjs` ok, 48 of 52
  tools and 177 live cases; `multi_agent_e2e.mjs` 22/22; `user_interference_e2e.mjs` 10/10.
- **Real Chrome, the maintainer's own Windows profile:** an ad hoc run (not a committed suite)
  passed 23/23 real-world checks -- two servers posing as two different clients, three agents, live
  sites: Wikipedia; the-internet.herokuapp.com (a login, a real file upload through the page's own
  input with no dialog shown, a `target=_blank` popup); YouTube, a Trusted Types page, where the
  highlight drew without an error -- and uploads to local fixtures. Exit cleanup and a `keep_open`
  hand-over behaved as documented, and each server kept one relay process throughout. Checked by
  hand: Ctrl+T from an AI tab opened a tab that stayed out of the AI group, and the agent stayed on
  its own tab.
- **Reconnect cadence** with no server running, measured with `tools/backoff_probe.mjs`: 6 attempts
  in 75 s, unchanged from 1.7.0.

### 1.5.2, live Chrome (2026-09-23)

Windows 11 Pro 26200, Chrome with the unpacked extension loaded from the managed install. Every
line below is a real call against a real browser; each of the four faults was found this way and
none of them was visible to the suites before it.

| Checked                                   | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Bridge attaches after an extension reload | Attached with no intervention                                           |
| `browser_navigate`, https                 | `https://example.org/` loaded                                           |
| `browser_navigate`, http                  | `http://uitestingplayground.com/textinput` loaded                       |
| Snapshot / type / click                   | 11 refs; 14 characters typed; click landed at (458, 462)                |
| `browser_record_start` / `_stop`          | 886,899-byte `.webm`, EBML magic `1a45dfa3`, 6 commands in the timeline |
| Recording timeline tracks the DOM         | `dom_epoch` 0 -> 1 -> 2 across two navigations                          |
| Orphaned relay after an extension reload  | The relay exited on its own; the bridge recovered with nothing killed   |
| Two servers at once                       | Both rendezvous records present; neither swept the other                |
| Second session opens its own tab          | Opened, snapshotted and closed its own tab while the first held another |
| A tab held elsewhere                      | Listed and flagged `controlled_by_other_session`, not hidden            |
| Lease refusal                             | Named the holding server by pid                                         |

The recording figure is what made `browser_record_start` and `browser_record_stop` verified at
all: they shipped in 1.5.0 and failed on their first real start, because the file that encodes the
video was the one shipped file no test loaded.

### Suites, analysis, and smoke, as of 1.4.0-1.5.x (2026-09-22 to 2026-09-23)

| Platform | Toolchain                                | Result                                   |
| -------- | ---------------------------------------- | ---------------------------------------- |
| Windows  | MSVC 19.50, CMake 3.31, Qt 6.10, Node 24 | Build + 19/19 suites + live Chrome pass  |
| Linux    | GCC 16 and Clang 22, Qt 6.11, Node 24    | Both builds + 17/17 suites + live Chrome |
| macOS    | Clang + Qt 6.10 GitHub Actions runner    | Build + 17/17 suites                     |

The suite totals were then 19/19 under Windows/MSVC and 18/18 under Linux/GCC, Linux/Clang, and
macOS/Clang; `test_install_layout` and `test_updater` were newer than the local Linux and macOS
desktop runs in the table and had passed on all three platforms in GitHub Actions, which is where
the 17/17 figures came from. The extension version was 1.4.0.

`test_windows_process_identity` re-launches the test binary through a real directory junction and
has that child decide whether the parent is the same program -- the position the relay is in, and
the only position from which the bug it guards is visible. Its teardown removes the junction as a
link and never recursively, because the first version of the test used `QTemporaryDir`, whose
recursive cleanup followed the junction and deleted the build directory it pointed at.

The update path was exercised end to end on Windows and on macOS 15.7.4, where a published archive
installs and `browser_update_check` reaches the release host over HTTPS through the bundled TLS
backend.

Strict analysis then:

- MSVC, GCC, and Clang compiled with warnings as errors.
- `clang-tidy` production analysis passed with the analyzer, bugprone, CERT, concurrency,
  core-guidelines, misc, performance, and portability families.
- Exhaustive `cppcheck` production analysis passed. A deliberate unused-function probe first proved
  the dead-code checker fails correctly; the probe was then removed.
- ESLint reported 0 errors; PSScriptAnalyzer 0 findings.
- PSScriptAnalyzer throws `Object reference not set to an instance of an object` on a cold module
  import, which is why the worker retries. Measured against 1.25.0, the newest release: three
  passes over the eight tracked scripts produced one such failure on the first invocation and none
  afterwards, so the retry mitigates a defect that is still upstream rather than one this project
  introduced.
- Full-history Gitleaks scan: 0 leaks.
- `npm audit --audit-level=low`, for both the root and the extension package: 0 vulnerabilities.

Sanitizers then:

| Gate       | Result | Where                                           |
| ---------- | ------ | ----------------------------------------------- |
| ASan+UBSan | 17/17  | GitHub Actions, and locally on Arch, GCC 16.2.1 |
| TSan       | 17/17  | GitHub Actions (Qt 6.10.0)                      |

ASan+UBSan was re-run locally on Arch with GCC 16.2.1 and Qt 6.11.2: thirteen suites passed and
neither sanitizer reported anything, including the bridge pipe, relay, and security suites, which
are the ones that actually run threads.

TSan runs with no suppressions. It carried a suppression file naming two Qt symbols until that file
was audited with `print_suppressions=1`: neither entry ever matched, and the job reported no race
with or without them. One named the wrong function and the other used `thread:`, which suppresses
thread-leak reports rather than data races, so neither could have matched. The file is gone, and any
race this gate sees now fails it.

Qt 6.11.2 does carry a race in `QPlainTestLogger::stopLogging`, between QtTest's watchdog thread and
main's stack during teardown, which is visible when these suites are built against it. It has no
project frame in either stack and appears even in `test_install_layout`, which starts no thread of
this project's own. The Qt this workflow pins, 6.10.0, does not exhibit it.

Smoke then: initialize protocol `2024-11-05`, server `chrome-control-mcp`; full profile 49 tools;
read-only profile 12 tools; staged extension present with pinned ID; Linux isolated install →
status → uninstall lifecycle passed with a generated mode-`0600` manifest.

### Windows live Chrome (2026-09-22)

Windows 11 Pro 26200, MSVC 19.50, Qt 6.10.0, CMake 4.4.3, Node 24.13.0, Chrome for Testing
153.0.8010.52.

```shell
node tests/e2e/full_browser_e2e.mjs build/Release/chrome_control_mcp.exe
node tests/e2e/isolated_run.mjs --chrome=<CfT> --chrome-arg=--headless=new tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=2
```

- Full E2E, every call in a background tab: **44/44 tools, 153 reversible live cases**, the
  extension attaching in 2.1 s, Chrome state restored. The upload case writes a temporary file,
  attaches it to the fixture's file input, and asserts what the PAGE read back: the name, the
  size, and the file's own bytes.
- User interference, in a dedicated browser: **10/10 checks**. A tab and then a window opened as
  the user; the session's tab kept every snapshot, keystroke, screenshot, and listing.
- Display matrix, in dedicated browsers: **35/35 configurations, 3335/3335 checks** across display
  scales 1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x, 3x; windows from 390x844 to 3840x2160; every Chrome zoom
  step from 25% to 500%; pinch at 1.5x, 2x, and 3x; and both scrollbar kinds.

#### The capture hang this platform found

A dedicated browser on Windows hides a background tab, where macOS's did not, and that is what
exposed it: `Page.captureScreenshot` returns only once the tab produces a compositor frame, and a
tab nobody is looking at produces none. The capture never answered, the app waited out its whole
30 s transport deadline, and the reset that followed detached the extension -- one screenshot ended
the session. Reproduced on the E2E fixture in a background tab, then fixed by capturing with a
one-pixel screencast running, which makes Chrome composite the tab:

| Capture of the fixture in a background tab | Before                         | After |
| ------------------------------------------ | ------------------------------ | ----- |
| First capture                              | no reply in 30 s, bridge reset | 1.8 s |
| Second capture                             | extension no longer attached   | 1.3 s |

The forced path returns the same image, not a different one: at 2x, foreground plain capture and
background screencast-forced capture were byte-identical, 114,526 bytes for the viewport and
178,520 for the full page.

### macOS live Chrome (2026-09-19)

macOS 15.7.4 (Intel), Chrome 153.0.8010.48, Chrome for Testing 153.0.8010.52, Qt 6.11.1, Node
26.5.0, CMake 4.4.0.

```shell
node tests/e2e/full_browser_e2e.mjs build/chrome_control_mcp            # the user's own Chrome
node tests/e2e/isolated_run.mjs --chrome=<CfT> tests/e2e/user_interference_e2e.mjs
node tests/e2e/display_matrix_e2e.mjs --chrome=<CfT> --parallel=3
```

- Full E2E on the user's own Chrome, every call in a background tab: **43/43 tools, 151 reversible
  live cases**, 12.5 s of tool time, the extension attaching in 0.8 s. The user's tab was asserted
  to still be the one in front after every single call, and the machine's front application (their
  editor) was unchanged before and after.
- User interference, in a dedicated browser: **10/10 checks**. A tab and then a window opened as the
  user; snapshots, typing, screenshots, scrolling, and clicking stayed on the session's tab, the
  user's tab stayed in front throughout, and the session opened no windows of its own.
- Display matrix, in dedicated browsers: **35/35 configurations, 3335/3335 checks** across display
  scales 1×, 1.25×, 1.5×, 1.75×, 2×, 2.5×, 3×; windows from 390×844 to 3840×2160; every one of
  Chrome's zoom steps from 25% to 500%; trackpad pinch at 1.5×, 2×, and 3×; and both a scrollbar
  drawn over the page and one that takes layout space. Every coordinate is proven by where its click
  landed on the fixture, and every screenshot by the pixels of its solid-colour targets measured
  against the page's own `getBoundingClientRect`. Eight configurations end in a refusal instead of a
  click -- a target flush with the page's edge under a pinch at 67% zoom or less, where the pinched
  page's scrollbar covers all of it -- and each refusal is accepted only because the browser's own
  hit test agrees no point of the target is on top.

#### What a background tab costs, measured

Chrome answers a tab nobody is looking at differently, and the numbers drove several fixes. Per
call, on the user's own Chrome, before and after:

| Call                                               | Before    | After    |
| -------------------------------------------------- | --------- | -------- |
| `browser_drag` (12 interpolated moves)             | 8,883 ms  | 103 ms   |
| `browser_scroll` 300 px                            | 10,133 ms | 52 ms    |
| `browser_hover` with `duration_ms: 100`            | 6,255 ms  | 155 ms   |
| `browser_drag` with `hold_ms: 150`                 | 10,221 ms | 206 ms   |
| `browser_wait_for`, 1.5 s timeout, never satisfied | 10,273 ms | 1,553 ms |
| `browser_window` `new`                             | 10,904 ms | 286 ms   |

Two causes, both measured rather than assumed. Chrome coalesces a background extension service
worker's timers into seconds, while the same page's own timers keep time to the millisecond there
(50 ms → 86, 100 → 101, 250 → 281, 1000 → 1003): every wait about the page is now timed by the
page. And Chrome answers _continuous_ input -- mouse moves, wheels -- at a frame, which a hidden tab
is drawn at rarely: the interpolated moves of a drag are now sent in order and awaited together, as
Chrome coalesces a real mouse anyway. Reads, snapshots, screenshots, clicks, and keystrokes were
never affected (26-129 ms).

### Linux live Chrome (2026-09-18)

Arch Linux, Hyprland (Wayland), 1920×1080 panel at 150% scale, Chrome 146 (native Wayland), GCC
16.2, Qt 6.11.2, Node 24.

```shell
node tests/e2e/full_browser_e2e.mjs build/chrome_control_mcp
node tests/e2e/user_interference_e2e.mjs build/chrome_control_mcp
```

- Full E2E: **43/43 tools, 146 reversible live cases**, Chrome state restored.
- Coordinate clicks land from `screenshot_center` at real 150% scale and emulated 1×, 1.25×, 1.5×,
  2×, and 3× across 1280×800 to 360×640 viewports; PNG width checked as viewport × scale.
- OS focus unchanged after tab selection and window retarget. Hyprland focuses every newly mapped
  window despite `focused: false`; the tool reported it as `took_os_focus` and the E2E recorded it.
- User interference: **7/7 checks**. The user opened a foreground tab and then a new window from
  outside Chrome; snapshots, typing, screenshots, and tab listing stayed on the session's tab.
- Red drills: a box's CSS centre fed to `browser_click_at` missed at 150% scale; an integer-only
  `device_scale_factor` refused 1.25×; restoring last-focused-window targeting made the
  interference E2E read the user's page. Each failed as intended and passed after restoration.

### Initial release (2026-08-20)

Commands ran against the repository checkout, not a mocked transport. Live Windows browser: Chrome
151.0.7922.138.

Live Chrome workflow against [UI Test Automation Playground](http://uitestingplayground.com/) with
the unpacked extension loaded:

```powershell
./scripts/live_browser_verify.ps1 -Site http://uitestingplayground.com/
```

Result: success. It opened a dedicated temporary tab, navigated through a semantic element ref,
captured a live accessibility/DOM snapshot, typed probe text and read the exact value back, clicked
the update button and observed the changed text, captured an `image/png` screenshot with opt-in
control presence, and closed the temporary tab. The user confirmed the visible pink frame, the
`AI CONTROL` badge, and the agent cursor -- the single marking of that release, before groups and
frames took a per-agent colour. Verified screenshot:
[`docs/assets/chrome-control-overlay-playground.png`](assets/chrome-control-overlay-playground.png).

Full live tool E2E:

```powershell
$env:CHROME_CONTROL_MCP_SHOWCASE_DIR = "$PWD/docs/assets"
node tests/e2e/full_browser_e2e.mjs dist/chrome_control_mcp.exe
```

Result: **43/43 advertised MCP tools across 97 reversible live cases**, through the real MCP
process, native host, extension, and Chrome: navigation, capture, input, tabs, windows, inspection,
state, advanced operations, and extension lifecycle. Storage, cookies, permissions, download bytes,
PDF header, and HTTP auth were verified; the test download and PDF were deleted, fixture state
cleared, fixture tabs and windows closed, and the original active tab restored. The responsive
overlay screenshot was captured and visually inspected.
