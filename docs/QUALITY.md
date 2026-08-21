# Quality status

Measured retrofit record. Passing means command ran successfully; unavailable or scoped gates are
called out explicitly.

## Before and after

```text
BASELINE  build passed · tests 9/9 · ESLint 103 · PSScriptAnalyzer 66
AFTER     build passed · tests 9/9 · ESLint 0 · PSScriptAnalyzer 0
```

## Completed phases

### Phase 1 — formatting

- Formatted 34 C++ files plus JavaScript, JSON, Markdown, YAML, and PowerShell.
- Rebuilt and reran all 9 automated suites.
- Recorded formatting commit `420912d` in `.git-blame-ignore-revs`.

### Phase 2 — configuration and gates

- Added EditorConfig, Prettier, ESLint, PSScriptAnalyzer, clang-format, clang-tidy, pre-commit,
  Gitleaks, locked npm tools, and CI.
- Pinned PSScriptAnalyzer 1.24.0 because 1.25.0 has a reproduced nondeterministic null-reference
  crash when scanning this multi-file tree; no analyzer rule is disabled.
- Extended existing ignore/attribute configuration.
- Installed pre-commit hook in development checkout.

### Phase 3 — lint

- Applied machine-safe ESLint fixes, then resolved remaining findings manually.
- Preserved caught errors as JavaScript `Error.cause` and made E2E cleanup failures visible.
- ESLint: 103 → 0. PSScriptAnalyzer: 66 → 0.
- PSScriptAnalyzer runs on the Windows CI host and scans only tracked scripts in isolated worker
  processes. Isolation avoids its upstream shared-state null-reference without disabling any rules.

### Phase 4 — native types and portability

- Enabled C++20 strict builds with warnings-as-errors under MSVC, GCC, and Clang.
- Added platform-neutral native IPC handle and Unix-domain bridge implementations.
- Verified Windows, Linux, and macOS builds through the CI matrix.

### Phase 5 — dead code and static analysis

- Removed unused JSON-RPC client builders, obsolete helper-mode detector, and test-only duplicate
  native-host loop.
- Verified `cppcheck` dead-code detection using a deliberate unused probe before trusting clean run.
- `clang-tidy` and exhaustive production `cppcheck` pass.
- `cppcheck` unused-public-function reports are excluded because public/test inspection helpers are
  referenced from separate test translation units; repository-wide symbol search verified them.

### Phase 6 — literals

- Named framing, deadline, nonce, payload, depth, and protocol limits where names add meaning.
- Kept idiomatic indexes, empty values, and protocol literals inline.

### Phase 7 — security and sanitizers

- Full-history Gitleaks: 0 findings.
- npm audit: 0 vulnerabilities.
- ASan+UBSan: 9/9.
- TSan: 9/9 with exact third-party QtTest watchdog/logger suppressions only.
- Added fail-closed platform peer verification and owner-only Unix runtime state.

### Phase 8 — documentation

- Reconciled README, architecture, security, verification, tool, build, and lifecycle commands.
- Added changelog and plan.
- Preserved live overlay screenshots and credited UI Test Automation Playground with site and source
  links.

## Compliance checklist

| Gate                                        | Status | Evidence / boundary                                 |
| ------------------------------------------- | ------ | --------------------------------------------------- |
| Formatter clean, whole tree                 | Pass   | clang-format + Prettier + pre-commit                |
| Linter clean, warnings-as-errors            | Pass   | ESLint, PSScriptAnalyzer, MSVC/GCC/Clang            |
| Strict native analysis                      | Pass   | clang-tidy high-signal families                     |
| No dead code                                | Pass   | verified cppcheck + repository reference audit      |
| No unused dependencies                      | Pass   | npm audit/install graph                             |
| No unjustified magic literals               | Pass   | module review; idiomatic literals retained          |
| No commented-out legacy code                | Pass   | source review                                       |
| No silent production fallbacks/placeholders | Pass   | fail-closed transport and schema paths              |
| No unjustified ignores/suppressions         | Pass   | one analyzer path note + exact QtTest TSan boundary |
| Secret scan clean over full history         | Pass   | Gitleaks 8.30.1                                     |
| Dependency audit clean                      | Pass   | npm audit                                           |
| ASan+UBSan and TSan wired separately        | Pass   | CI + local Linux 9/9 each                           |
| Tests pass                                  | Pass   | Windows/Linux/macOS 9/9                             |
| Build succeeds                              | Pass   | MSVC, GCC, Clang                                    |
| Pre-commit installed                        | Pass   | local checkout                                      |
| CI mirrors local gates                      | Pass   | quality + 3-OS builds + sanitizers                  |
| README commands verified                    | Pass   | build, smoke, lifecycle, live E2E                   |
| CHANGELOG updated                           | Pass   | `CHANGELOG.md`                                      |

## Local commands

```shell
npm ci
npm run quality
npm run build
npm run smoke
npm run smoke:read-only
python -m pre_commit run --all-files
```

See [VERIFICATION.md](VERIFICATION.md) for platform-specific and live-browser evidence.
