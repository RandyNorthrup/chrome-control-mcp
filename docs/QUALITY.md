# Quality status

The gates this project holds itself to, where each one runs, and what it last reported. Passing
means the command ran and succeeded; a gate that did not run, or runs only in part, says so. The
2026-08-20 retrofit that introduced most of these gates is kept at the end as a record.

## Gates

| Gate                  | Tool and configuration                                                                                                                                                                   | Runs in                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Formatting            | clang-format 19.1.7 (`--dry-run --Werror`); Prettier 3.9.6 over JavaScript, JSON, Markdown and YAML; pre-commit hygiene hooks                                                            | pre-commit, CI quality job                      |
| JavaScript lint       | ESLint 10.8.1, `--max-warnings=0`                                                                                                                                                        | pre-commit, CI quality job                      |
| VS Code extension     | TypeScript under strict compiler settings, type-checked (`npm run lint --prefix vscode`)                                                                                                 | CI quality job                                  |
| PowerShell            | PSScriptAnalyzer 1.24.0, `PSScriptAnalyzerSettings.psd1`, one worker process per tracked script                                                                                          | CI on Windows; `npm run lint:powershell`        |
| Native compile        | C++20; MSVC `/W4 /WX /permissive-`; GCC and Clang `-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Werror`                                                                      | every build                                     |
| Native analysis       | clang-tidy (analyzer, bugprone, CERT, concurrency, core-guidelines, misc, performance, portability; warnings as errors); cppcheck `--enable=all --inconclusive --check-level=exhaustive` | CI static-analysis job                          |
| Semantic analysis     | Semgrep 1.174.0, `--config auto --error`                                                                                                                                                 | CI static-analysis job                          |
| Secret scan           | Gitleaks 8.30.1 over the full history                                                                                                                                                    | pre-commit, CI quality job                      |
| Dependency audit      | `npm audit --audit-level=low`, root and `vscode/`                                                                                                                                        | CI quality job                                  |
| Unit and integration  | ctest: 23 suites on Windows, 22 elsewhere, every JavaScript suite among them; `npm run test:js`: the 10 JavaScript files that need no built server                                       | ctest in CI on three platforms; `test:js` local |
| Sanitizers            | ASan + UBSan and TSan, separate Linux GCC Debug builds, no suppressions                                                                                                                  | CI                                              |
| Packaged-server smoke | `scripts/mcp_smoke.mjs`, full and read-only profiles, tool counts pinned                                                                                                                 | CI after every native build; release workflow   |
| Live browser          | display matrix, full browser E2E, user interference, multi-agent, per-agent clipboard, in Chrome for Testing 153.0.8010.52                                                               | CI on three platforms                           |

The Quality workflow runs on every push. The release workflow, on a version tag, builds the four
archives, runs ctest and the smoke test on each, and refuses a tag whose version does not match the
project's ([RELEASES.md](RELEASES.md)).

## Status, 2026-10-31

| Gate                               | Status | Evidence                                                                                      |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Formatting, lint, secret scan      | Pass   | CI quality job on `fce2acb`                                                                   |
| Dependency audit                   | Pass   | CI quality job on `fce2acb`                                                                   |
| PowerShell analysis                | Pass   | CI on `fce2acb`                                                                               |
| Native compile, warnings as errors | Pass   | MSVC, GCC and Clang, locally and in CI                                                        |
| clang-tidy, exhaustive cppcheck    | Pass   | CI on `fce2acb`                                                                               |
| Semgrep                            | Pass   | CI on `fce2acb`: 221 rules, 53 files, 0 findings under Python 3.12; crashed under 3.15 before |
| ctest                              | Pass   | 23/23 Windows, 22/22 Linux, locally                                                           |
| JavaScript suites                  | Pass   | 199/199 under `npm run test:js`; every one of them also runs in ctest                         |
| Sanitizers                         | Pass   | ASan + UBSan and TSan, 21/21 each, in CI on `fce2acb`                                         |
| Live browser suites                | Pass   | CI on three platforms on `fce2acb`; Chrome for Testing 153 on Linux locally                   |
| CHANGELOG updated                  | Pass   | `CHANGELOG.md` `[1.9.0]`                                                                      |

Not covered by this table: Chrome for Testing intermittently stalls in one Windows display-matrix
configuration, met once in CI and once in six local runs; see
[VERIFICATION.md](VERIFICATION.md#open-a-chrome-stall-in-one-display-configuration).

## Exclusions and suppressions

Each gate runs its configured rule set in full, apart from these:

- **ESLint** runs `@eslint/js` recommended plus stricter rules (`curly`, `eqeqeq`, `no-shadow`,
  `no-var`, `prefer-const`, and others in `eslint.config.mjs`). It ignores build output,
  `node_modules`, and the downloaded test browser; lets a name that begins with `_` go unused; and
  in the extension allows `console.error`, `info` and `warn`, which are its diagnostics in
  `chrome://extensions`.
- **clang-tidy** turns off `bugprone-easily-swappable-parameters`, `cert-err58-cpp`,
  `cppcoreguidelines-avoid-c-arrays`, `cppcoreguidelines-avoid-magic-numbers`,
  `cppcoreguidelines-owning-memory`, `cppcoreguidelines-pro-bounds-array-to-pointer-decay`,
  `cppcoreguidelines-pro-bounds-pointer-arithmetic`, `cppcoreguidelines-pro-type-reinterpret-cast`,
  `misc-include-cleaner`, and `misc-use-internal-linkage` (`.clang-tidy`).
- **cppcheck** suppresses `missingIncludeSystem` and `unusedFunction`. Public and test inspection
  helpers are referenced from separate test translation units, which a per-project unused-function
  pass cannot see.
- **PSScriptAnalyzer** excludes `PSUseShouldProcessForStateChangingFunctions` and
  `PSAvoidUsingWriteHost`, and turns off `PSAlignAssignmentStatement`, which conflicts with the
  stricter single-space operator rule. It is pinned at 1.24.0 and run one file per process, with
  retries, because 1.25.0 throws an internal null-reference on a cold module import; no rule is
  disabled to work around that.
- **Gitleaks** allowlists exactly one string: the public extension identity key in
  `browser/extension/manifest.json`, which pins the unpacked extension ID and is not a secret.
- **Prettier** ignores build output, `node_modules`, lockfiles, the clang configuration files, and
  `docs/assets/`.

## Local commands

```shell
npm ci
npm run quality            # Prettier check, ESLint, PSScriptAnalyzer, and the JavaScript suites
npm run build              # configure, build, and run ctest
npm run smoke
npm run smoke:read-only
python -m pre_commit run --all-files
```

See [VERIFICATION.md](VERIFICATION.md) for platform-specific and live-browser evidence.

## Retrofit record (2026-08-20)

_Historical._ The pass that brought the codebase under these gates. Suite counts are those of the
time (nine suites); later releases added suites, the live browser jobs, and the static-analysis job.

```text
BASELINE  build passed · tests 9/9 · ESLint 103 · PSScriptAnalyzer 66
AFTER     build passed · tests 9/9 · ESLint 0 · PSScriptAnalyzer 0
```

### Phase 1 -- formatting

- Formatted 34 C++ files plus JavaScript, JSON, Markdown, YAML, and PowerShell.
- Rebuilt and reran all 9 automated suites.
- Recorded formatting commit `420912d` in `.git-blame-ignore-revs`.

### Phase 2 -- configuration and gates

- Added EditorConfig, Prettier, ESLint, PSScriptAnalyzer, clang-format, clang-tidy, pre-commit,
  Gitleaks, locked npm tools, and CI.
- Pinned PSScriptAnalyzer 1.24.0 because 1.25.0 has a reproduced nondeterministic null-reference
  crash when scanning this multi-file tree; no analyzer rule was disabled to work around it.
- Extended existing ignore/attribute configuration.
- Installed the pre-commit hook in the development checkout.

### Phase 3 -- lint

- Applied machine-safe ESLint fixes, then resolved the remaining findings manually.
- Preserved caught errors as JavaScript `Error.cause` and made E2E cleanup failures visible.
- ESLint: 103 → 0. PSScriptAnalyzer: 66 → 0.
- PSScriptAnalyzer runs on the Windows CI host and scans only tracked scripts in isolated worker
  processes. Isolation avoids its upstream shared-state null-reference without disabling any rules.

### Phase 4 -- native types and portability

- Enabled C++20 strict builds with warnings as errors under MSVC, GCC, and Clang.
- Added the platform-neutral native IPC handle and Unix-domain bridge implementations.
- Verified Windows, Linux, and macOS builds through the CI matrix.

### Phase 5 -- dead code and static analysis

- Removed unused JSON-RPC client builders, an obsolete helper-mode detector, and a test-only
  duplicate native-host loop.
- Verified `cppcheck` dead-code detection using a deliberate unused probe before trusting a clean
  run.
- `clang-tidy` and exhaustive production `cppcheck` passed.
- `cppcheck` unused-public-function reports were excluded because public/test inspection helpers are
  referenced from separate test translation units; a repository-wide symbol search verified them.

### Phase 6 -- literals

- Named framing, deadline, nonce, payload, depth, and protocol limits where names add meaning.
- Kept idiomatic indexes, empty values, and protocol literals inline.

### Phase 7 -- security and sanitizers

- Full-history Gitleaks: 0 findings.
- npm audit: 0 vulnerabilities.
- ASan+UBSan: 9/9.
- TSan: 9/9, with a suppression file for QtTest's watchdog and logger. That file was audited on
  2026-09-22, found to suppress nothing, and deleted; TSan has run with no suppressions since.
- Added fail-closed platform peer verification and owner-only Unix runtime state.

### Phase 8 -- documentation

- Reconciled README, architecture, security, verification, tool, build, and lifecycle commands.
- Added the changelog and plan.
- Preserved live overlay screenshots and credited UI Test Automation Playground with site and source
  links.
