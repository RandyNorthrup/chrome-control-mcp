# Plan

## Release target

Ship standalone, MIT-licensed Chrome Control MCP from `main` with same browser tool surface on
Windows, Linux, and macOS.

## Completed

- [x] Standalone project identity with no legacy product references
- [x] 43 strict-schema MCP tools and reversible full Chrome E2E harness
- [x] Visible, non-intercepting, accessibility-hidden control presence
- [x] Windows protected named-pipe bridge
- [x] Linux/macOS protected Unix-domain socket bridge
- [x] Current-user Chrome native-host lifecycle on all three platforms
- [x] Warnings-as-errors, lint, static analysis, secret scan, dependency audit, and sanitizers
- [x] Windows/Linux/macOS CI build and test matrix
- [x] MIT license, modern README, screenshots, and public test-site credit
- [x] Unsigned Windows x64, Linux x64, macOS ARM64, and macOS x64 release archives with SHA-256
      checksums
- [x] In-place updates: versioned install directories behind a stable link, so a running
      executable is never the file being replaced and no registration is invalidated by an upgrade
- [x] Published to the VS Code Marketplace as four platform-specific extensions that install the
      server and register it with the editor

## Remaining proof and release work

- [x] Run live Chrome E2E on physical Linux desktop (Arch, Hyprland/Wayland, 150% scale)
- [ ] Run live Chrome E2E on physical macOS desktop; automated native tests cover its backend, but
      live-browser certification evidence is Windows and Linux only.
- [ ] Add Windows and Linux ARM64 build matrices when their Qt runner combinations are verified;
      macOS ARM64 builds and packages on a standard GitHub-hosted runner.
- [ ] Move marketplace publishing off a personal access token before 2026-12-21, when the one in
      `VSCE_PAT` expires. Azure DevOps retires globally-scoped tokens on 2026-12-01, so the
      replacement is either another organization-scoped token or Microsoft Entra
      (`vsce publish --azure-credential`).

These items do not block source release. They limit claims about prebuilt artifacts and live Chrome
behavior on every operating system.
