# Plan

## Release target

Ship standalone, MIT-licensed Chrome Control MCP from `main` with the same browser tool surface on
Windows, Linux, and macOS. Current release: 1.8.0 (2026-10-31).

## Completed

- [x] Standalone project identity with no legacy product references
- [x] 52 strict-schema MCP tools (46 browser, 6 native) and a reversible full Chrome E2E harness
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
- [ ] Find why headless Chrome for Testing 153 stalls in the `1.75x-2194x1234-zoom100-classic`
      pinch-3 display-matrix configuration on Windows: once in CI through a screenshot, and once in
      six local runs through the suite's own DevTools pinch, a call the extension takes no part in
      ([VERIFICATION.md](docs/VERIFICATION.md#open-a-chrome-stall-in-one-display-configuration))
- [x] Restore the Semgrep gate: the job keeps its pinned Python 3.12, since `semgrep-core` crashes
      under the 3.15 the Qt install step switched it to (1.8.1)
- [x] Run `test_browser_extension_tabs.mjs` and `test_release_versions.mjs` in ctest, and so in CI
      (1.8.1)
- [ ] Support folder uploads; a page that asks for a folder is refused today.
- [ ] Add Windows and Linux ARM64 build matrices when their Qt runner combinations are verified;
      macOS ARM64 builds and packages on a standard GitHub-hosted runner.
- [ ] Move marketplace publishing off a personal access token before 2026-12-21, when the one in
      `VSCE_PAT` expires. Azure DevOps retires globally-scoped tokens on 2026-12-01, so the
      replacement is either another organization-scoped token or Microsoft Entra
      (`vsce publish --azure-credential`).

These items do not block source release. They limit claims about prebuilt artifacts, the quality
gates, and live Chrome behaviour on every operating system.
