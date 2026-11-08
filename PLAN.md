# Plan

## Release target

Ship standalone, MIT-licensed Chrome Control MCP from `main` with the same browser tool surface on
Windows, Linux, and macOS. Current release: 1.13.0 (2026-11-07).

## Completed

- [x] Standalone project identity with no legacy product references
- [x] 53 strict-schema MCP tools (47 browser, 6 native) and a reversible full Chrome E2E harness
- [x] Visible, non-intercepting, accessibility-hidden control presence, coloured and named per
      agent, drawn into every new document, and safe on pages that enforce Trusted Types
- [x] Windows protected named-pipe bridge
- [x] Linux/macOS protected Unix-domain socket bridge
- [x] Current-user Chrome native-host lifecycle on all three platforms
- [x] Warnings-as-errors, lint, static analysis, secret scan, dependency audit, and sanitizers
- [x] Windows/Linux/macOS CI build and test matrix, with live browser suites on all three
- [x] MIT license, modern README, screenshots, and public test-site credit
- [x] Unsigned Windows x64, Linux x64, macOS ARM64, and macOS x64 release archives with SHA-256
      checksums
- [x] In-place updates: versioned install directories behind a stable link, so a running
      executable is never the file being replaced and no registration is invalidated by an
      upgrade; an older build never moves the link back from a newer one (1.8.0)
- [x] Published to the VS Code Marketplace as four platform-specific extensions that install the
      server and register it with the editor
- [x] Several servers on one browser, kept apart by tab leases (1.5.0)
- [x] Several agents on one server: `tab_id` on every tab-scoped tool, refs bound to their tab,
      a coloured tab group per agent, and the user's own new tabs left alone (1.8.0)
- [x] Cleanup: `browser_release`, release when a server exits, and a ten-minute idle stand-down
      (1.8.0)
- [x] File pickers answered without a native dialog: script-created inputs, drop zones, and
      `showOpenFilePicker` (1.8.0)
- [x] `browser_release` by `tab_id` releases the agent's tabs -- popups and its other named tabs
      included -- and a tab Chrome will not close is never reported closed (1.8.2)
- [x] A clipboard per agent, never the system's: keys, `browser_clipboard`, and the page's own
      clipboard API in held tabs (1.9.0;
      [docs/plans/per-agent-clipboard.md](docs/plans/per-agent-clipboard.md))
- [x] Release pages say what each release does, the day it shipped, and which download is yours,
      for every release back to 1.0.0; the changelog and README list them, and a test keeps all
      four in step (1.9.0)
- [x] Live Chrome E2E on a physical Linux desktop (Arch, Hyprland/Wayland, 150% scale, 2026-09-18)
- [x] Live Chrome E2E on a physical macOS desktop (macOS 15.7.4 Intel, the user's own Chrome,
      2026-09-19), where the update path is also verified: install, managed layout, and an HTTPS
      release check through the bundled TLS backend

## Remaining proof and release work

- [ ] Run the update path end to end on Linux. It builds, tests, and packages, and the archive
      carries the Qt and ICU libraries it needs, but no Linux machine has installed a release
      through `browser_update_apply`.
- [ ] Run the 1.8 multi-agent checks in a real Chrome profile on macOS and Linux. Real-profile
      evidence for 1.8 is Windows only; CI covers all three platforms in Chrome for Testing.
- [x] Explain the macOS `relay_forwardsProgressBeatsAndStillDeliversTheReply` failure on the
      `v1.8.0` tag's Quality run: a timing margin of about 125 ms in the test, widened in 1.8.1
- [ ] Find why headless Chrome for Testing 153 stalls or exits on Windows in display-matrix
      configurations that capture 3840x2160 device pixels -- twice more on the v1.11.1 tag, where it
      held up publishing until the job ran again: three CI screenshots (all on tag-push runs), and once
      in six local runs through the suite's own DevTools pinch, a call the extension takes no part
      in. Since 1.9.0 a failed screenshot reports whether Chrome still answers DevTools
      ([VERIFICATION.md](docs/VERIFICATION.md#open-a-chrome-stall-in-one-display-configuration))
- [ ] The rest of the token and speed research
      ([docs/research](docs/research/browser-mcp-speed-and-token-efficiency.md)): action replies that
      say what changed, screenshots at CSS scale with a zoom (which would also capture fewer than
      3840x2160 device pixels), `browser_fill_form`, opt-in unchanged snapshots, the latency items
      (the scroll settle, the Linux click delay, the relay's 25 ms poll, per-command DevTools work),
      and a default snapshot cap once the meter shows it loses nothing
- [x] Restore the Semgrep gate: the job keeps its pinned Python 3.12, since `semgrep-core` crashes
      under the 3.15 the Qt install step switched it to (1.8.1)
- [x] Run `test_browser_extension_tabs.mjs` and `test_release_versions.mjs` in ctest, and so in CI
      (1.8.1)
- [x] Publish the extension to the Chrome Web Store: the server answers to the store build's ID
      and the unpacked one, each release uploads and submits the store package, and a privacy
      policy (1.13.0; [docs/plans/chrome-web-store.md](docs/plans/chrome-web-store.md))
- [x] Find elements without a whole snapshot (`browser_find`), scope, filter and cap snapshots,
      page reads, a smaller catalog, and a meter of what each tool costs (1.12.0;
      [docs/plans/lean-observations.md](docs/plans/lean-observations.md))
- [x] Upload files of any size an agent needs, not just documents: up to 2 GiB by default and
      `CHROME_CONTROL_MCP_UPLOAD_MAX_MB`, each file read a piece at a time and staged in the page
      that uses it (1.11.0; [docs/plans/large-uploads.md](docs/plans/large-uploads.md))
- [x] Support Chrome profiles (work, personal, other people), chosen per call: one server
      connected to every profile's extension at once, `profile` on `browser_new_tab`, and each
      tab's profile in `browser_tabs` (1.10.0;
      [docs/plans/chrome-profiles.md](docs/plans/chrome-profiles.md))
- [x] Notice a Chrome extension older than its server: versions exchanged on connect, the agent told
      once per connection in any client, and the extension reloading itself once per newer install
      while nobody uses it (1.9.0;
      [docs/plans/extension-version.md](docs/plans/extension-version.md))
- [ ] Give an iframe element a ref in the snapshot. An editor inside a frame (TinyMCE's) shows up as
      an `iframe` line with no ref, so an agent can reach it only by screenshot coordinates.
- [ ] Support folder uploads; a page that asks for a folder is refused today.
- [ ] Add Windows and Linux ARM64 build matrices when their Qt runner combinations are verified;
      macOS ARM64 builds and packages on a standard GitHub-hosted runner.
- [ ] Move marketplace publishing off a personal access token before 2026-12-21, when the one in
      `VSCE_PAT` expires. Azure DevOps retires globally-scoped tokens on 2026-12-01, so the
      replacement is either another organization-scoped token or Microsoft Entra
      (`vsce publish --azure-credential`).

These items do not block source release. They limit claims about prebuilt artifacts, the quality
gates, and live Chrome behaviour on every operating system.
