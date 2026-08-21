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

## Remaining proof and release work

- [ ] Run live Chrome E2E on physical Linux and macOS desktops; automated native tests cover both
      backends, but current live-browser certification evidence is Windows-only.
- [ ] Publish unsigned per-platform release archives once release version is tagged. Code signing is
      intentionally out of scope; users build or inspect artifacts directly.
- [ ] Add ARM64 build matrix when ARM64 Qt runners are available and verified.

These items do not block source release. They limit claims about prebuilt artifacts and live Chrome
behavior on every operating system.
