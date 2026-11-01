# Readiness review: large uploads

Reviewed 2026-11-01 against [large-uploads.md](../../large-uploads.md), the rules file
[QUALITY.md](../../../QUALITY.md), and the upload path as it stands: `browser_uploads.cpp`,
`BrowserControl::invokeWithFiles`, `BrowserBridgeSession::beginCommand`, and the extension's
`handleUploadChunk`, `assembleUpload`, `handleUpload`, `answerFilePicker`, `dispatchCommand` and
`runCommand`.

## What was measured first

Raw DevTools against Chrome for Testing 153 on Linux, staging the way the design proposes (an object
created by a function called on the input element, base64 pieces of 384 KiB appended and folded
into a `Blob` every 8 MiB, one `File` assigned at the end):

| File    | Staged in | Rate    | Page's file                 | SHA-256 |
| ------- | --------- | ------- | --------------------------- | ------- |
| 40 MiB  | 1.7 s     | 24 MB/s | `long.mp4`, 41943040 bytes  | match   |
| 400 MiB | 15.9 s    | 25 MB/s | `long.mp4`, 419430400 bytes | match   |

## Findings and resolutions

| #   | Finding                                                                                                                                                                         | Resolution                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every command's DevTools handles are released when it ends (`runCommand` → `releaseCdpObjects`), so a staged object made in one `uploadStage` would be gone by the next.        | Each upload's staged object gets an object group of its own, released when the upload completes or fails, on detach and on session end (AC-UPL-ABORT).                                                                                                                    |
| 2   | An object passed to `Runtime.callFunctionOn` must belong to the target's realm; an input in a frame lives in that frame's realm.                                                | The staged object is created by calling a function on the very element the final command targets, so both live in one realm; the server addresses pieces and the final command from one translated command. The reach is the existing one: the element's DevTools handle. |
| 3   | `uploadChunk` names no tab, and `beginCommand` reserves the single outstanding slot, so the final command cannot be built before the pieces are sent.                           | The server previews the translation (`buildExtensionCommand`, pure) for the tab and element, and builds the real final command after the pieces.                                                                                                                          |
| 4   | `dispatchCommand` drops an armed dialog response after any tabbed command that did not raise a dialog; a stage piece would cancel an arm meant for a later click.               | `uploadStage` is exempt from that scoping, arms no file picker and opens no clipboard window (not an opener or clipboard command).                                                                                                                                        |
| 5   | A staged upload belongs to one page: the existing rule that a half-delivered upload survives one tab's detach (the worker held it) cannot hold for bytes that live in the page. | Staged uploads are dropped when their tab detaches; worker-held clipboard pieces keep the old rule. The session test changes accordingly (AC-UPL-ABORT).                                                                                                                  |
| 6   | A page can patch `atob`, `Blob` or `Uint8Array` and so watch bytes arrive.                                                                                                      | The same is true today: the existing assignment decodes in the page's realm before it checks the target. The page receives the file anyway; no path reaches it. Unchanged exposure.                                                                                       |
| 7   | A file can change on disk between the size check and the last piece.                                                                                                            | The server stops on a short or long read and refuses, saying the file changed while it was being sent.                                                                                                                                                                    |
| 8   | A 2 GiB file takes about two minutes at the measured rate; some MCP clients time a call out sooner, and the server runs one call at a time.                                     | Stated as a limit in TOOLS.md; the cap is the operator's to lower. Not measured beyond 400 MiB here; the live suite runs 300 MiB on three platforms.                                                                                                                      |
| 9   | An extension older than 1.11.0 answers `uploadStage` with "Unknown command".                                                                                                    | The server reads the extension's version from the handshake and gives such an extension the old path and bound, with a refusal above it naming the reload (AC-UPL-COMPAT). A newer extension with an older server still gets `uploadChunk` and works as before.           |
| 10  | The clipboard must hold files until a paste, in the worker.                                                                                                                     | `browser_clipboard` keeps the old path and the 16 MiB bound; documented.                                                                                                                                                                                                  |
| 11  | A malformed `CHROME_CONTROL_MCP_UPLOAD_MAX_MB` must not silently become a large or unlimited cap.                                                                               | It fails closed to 16 MiB, and a refusal under it names the variable, matching how the security profile and redaction variables fail closed (AC-UPL-LIMIT).                                                                                                               |
| 12  | Requirement, acceptance and task coverage.                                                                                                                                      | Every requirement has acceptance; every criterion has an owning task; tasks depend only on tasks before them; each change path has one owner in this plan.                                                                                                                |

## Terminology

"Piece": one bridge message's worth of a file, 384 KiB of bytes as 512 KiB of base64. "Staged": held
in the page's realm, behind the extension's DevTools handle, before the file is assigned. "Cap":
the largest file `browser_upload` sends, the operator's to set.

Verdict: ready to implement.

## Addendum, after the first live runs

- **The relay ended itself mid-upload.** The first live run lost the 300 MiB file at piece 388 of
  800 with "the browser's relay closed the connection". A diagnostic upload of the same file then
  succeeded, so the drop was intermittent, and the relay's watcher was found racing its own pump:
  a probe running its exact check on a busy pipe called a live pipe closed 3494 times in 7,150,967
  looks, and never with three looks in a row required at its cadence. The fix and its unit test go
  to TASK-UPL-SERVER (`browser_bridge_relay.h`, `browser_bridge_relay_common.cpp`); a long upload
  not being cut short was always part of AC-UPL-LARGE-INPUT.
- **The rate is the extension debugger channel's.** Timed inside the worker, `chrome.debugger`
  takes 2.7 ms for an empty call, 53 ms for 512 KiB, 310 ms for 2 MiB and 600 ms for 4 MiB:
  per byte, so batching would not help. End to end 2 to 6 MB/s; the documents said 15 to 25 (the
  raw DevTools figure) and now say what was measured. Claude Code has no default tool-call timeout
  short of a day, and moves a call past two minutes to the background.
- **CI in tiers** was decided by the user mid-work: REQ-CI-TIERS with AC-CI-PUSH and
  AC-CI-RELEASE, owned by TASK-CI-TIERS, which takes over `quality.yml` from TASK-UPL-LIVE and adds
  `release.yml`, `live.yml` and `RELEASES.md`. Both criteria are manual, with the applicability
  reason recorded: workflow behaviour is observed on GitHub's runs, which no local command
  reproduces.
- **The live suite's own page** needed two pages: a drop zone gets files by drop only when no file
  input is in scope (the tool gives an input the files when there is one).

No requirement's meaning changed. Coverage holds: every requirement has acceptance, every criterion
an owning task, each change path one owner. Verdict: still ready.
