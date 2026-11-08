# Privacy policy review

AC-CWS-PRIVACY, reviewed 2026-11-07: [docs/PRIVACY.md](../../../PRIVACY.md) read against the
extension's manifest and code and the server's bridge and updater. A policy is a statement, so this
criterion is checked by reading, claim by claim.

| Claim in the policy                                                                          | Checked against                                                                                                                                                                                                                 | Holds |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| The extension sends nothing anywhere on its own                                              | `browser/extension/*.js`: the one `fetch` reads a `data:` URL in the recorder (`offscreen.js`); no `XMLHttpRequest`, `WebSocket` or `sendBeacon`; pages and downloads come from commands                                        | Yes   |
| What it reads goes to the server on the same computer, through native messaging              | `background.js`: `chrome.runtime.connectNative(HOST_NAME)`; the relay reaches the server over a Unix-domain socket (`AF_UNIX`, `browser_bridge_pipe_posix.cpp`) or a named pipe (`CreateNamedPipeW`, `browser_bridge_pipe.cpp`) | Yes   |
| The registration names the two IDs and no other; the server opens no network listener        | `hostManifestBytes` and `acceptedOrigins` in `browser_extension_installer.cpp`; `isOurExtensionOrigin` in `mcp_entry.h`; no TCP listener in `src/`                                                                              | Yes   |
| Tab titles and addresses on request; everything else only in the agent's tabs                | `browser_tabs` lists tabs; tab-scoped commands go through leases (`docs/MULTI_SESSION.md`), and a tab held by another session is refused                                                                                        | Yes   |
| The account email is read to name the profile, goes only to the server, renamable            | `chrome.identity.getProfileUserInfo` in `background.js` and `options.js`; no `getAuthToken`; the name is sent on the native port; `options.js` stores the user's own name                                                       | Yes   |
| What the extension stores                                                                    | `chrome.storage.local` and `.session` keys in `background.js` and `options.js`: pause, back-off, reload markers, profile name, focused profile, tab leases                                                                      | Yes   |
| Recordings, PDFs and downloads saved where the call or Chrome says; screenshots in the reply | `browser_record_*` and `browser_print` take a file name; `browser_download` uses Chrome's downloads; `browser_screenshot` has no path argument and returns an image block                                                       | Yes   |
| The update check carries nothing about the user                                              | `updater.cpp`: a GET of `api.github.com/repos/<repo>/releases/latest` with an `Accept` header only                                                                                                                              | Yes   |
| No account, analytics or telemetry                                                           | No such code in `src/`, `browser/extension/` or `vscode/src/`                                                                                                                                                                   | Yes   |

The permission list the policy describes is the manifest's: `nativeMessaging`, `debugger`, `tabs`,
`tabGroups`, `contentSettings`, `cookies`, `downloads`, `offscreen`, `alarms`, `storage`, `scripting`,
`webNavigation`, `identity`, `identity.email`, and the host permission `<all_urls>`. The dashboard's
data-use answers ([CHROME_WEB_STORE.md](../../../CHROME_WEB_STORE.md)) declare each kind of data the
policy names.
