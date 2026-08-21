# Changelog

All notable changes are documented here. Project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-08-20

### Added

- Initial standalone MIT-licensed Chrome Control MCP release.
- 43 MCP tools, unpacked MV3 extension, visible control presence, and full live Chrome E2E coverage.
- Linux and macOS Unix-domain bridge backends with owner-only runtime state and peer credentials.
- Cross-platform Chrome native-host manifest lifecycle.
- Windows, Linux, and macOS build/test matrix.
- Unsigned Windows x64, Linux x64, macOS ARM64, and macOS x64 release archives with checksums.
- Separate AddressSanitizer + UndefinedBehaviorSanitizer and ThreadSanitizer gates.
- Cross-platform Node build, MCP smoke, and extension lifecycle commands.
- Modern README with verified overlay screenshots and UI Test Automation Playground credit.

### Changed

- Native API and documentation now use platform-neutral names.
- C++ warnings are errors under MSVC, GCC, and Clang.
- MCP/relay logs use standalone project identity.
- Quality gates now include strict lint, static analysis, full-history secret scanning, and locked
  dependency audit.

### Removed

- Unused JSON-RPC client payload helpers and obsolete test-only native-host loop.
- Redundant quality branch; development and delivery now happen directly on `main`.
