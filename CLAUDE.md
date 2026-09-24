# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project
**Nestro** — VS Code extension (`src/extension.ts`) managing npm/pnpm/yarn/bun packages from the sidebar with update status and version switching. Built on the VS Code Extension API (`@types/vscode 1.125.0`). Update detection uses `npm-check-updates` (dynamically imported in `src/utils/ncuClient.ts`).

## Commands
Core dev/test loop; the full script table (all scripts, non-mutating gate flags) is the single
source of truth in **[CONTRIBUTING.md](CONTRIBUTING.md)** → Commands.

```bash
pnpm run build            # tsdown → out/extension.cjs
pnpm run dev              # tsdown --watch
pnpm run lint             # eslint src --max-warnings=0 — non-mutating validation gate
pnpm run lint:fix         # eslint --fix src — the mutating pass, never run automatically
pnpm run typecheck        # tsc --noEmit
pnpm run test:compile     # tsc -p tsconfig.test.json → out/test/
pnpm run test:minimum     # vscode-test --label minimum — Extension Host on VS Code 1.125.0
pnpm run test:stable      # vscode-test --label stable — Extension Host on the stable channel
pnpm run test:unit        # vitest run — *.unit.test.ts without VS Code
pnpm run test:unit:watch  # vitest (watch mode)
```

Integration tests: `.vscode-test.mjs` runs the `minimum` and `stable` channels against every
`out/test/**/*.test.js`; no single-file isolation, and the two channels must not run concurrently
against the same checkout — each resets its own channel directories on load.
Unit tests: Vitest, `vscode` mocked via `src/test/__mocks__/vscode.ts`.
Manual testing: **F5** → Run Extension (`.vscode/launch.json`) → Extension Development Host window.

## Architecture

### Data flow
1. `activate()` creates `FilterManager` and `PackagesProvider`, then calls `provider.loadPackages()`.
2. `loadPackages()` delegates to `PackageLoadingService.load()` (`src/providers/packageLoadingService.ts`), which reads workspace `package.json` files via `readAllWorkspaceDependencies()` (`src/utils/packageReader.ts`, backed by `packageRepository.ts` file I/O and `packageTransforms.ts` parsing) and resolves each file's canonical location (`src/providers/packageIdentity.ts`) → populates `allEntries: PackageTreeEntry[]`.
3. `checkUpdates()` delegates to `UpdateOrchestrationService.check()` (`src/providers/updateOrchestrationService.ts`), which calls `fetchAllLatestVersions()` (ncuClient → `npm-check-updates`) and the metadata registry → enriches each entry with the accepted version, `updateType`, and release-age state (`accepted`, `held-back`, or `unknown`), preserving any live `installing` state set by `markPackageUpdating()`. Update results are cached to avoid redundant network calls.
4. `getChildren()` delegates to `buildTree()` (`src/providers/treeBuilder.ts`) which returns `GroupItem[]` (or `WorkspaceFolderItem[]` when the workspace has more than one `package.json`) — groups split into Dependencies / Dev Dependencies. The active filter/search state renders as `treeView.description` (`formatViewDescription()`), not as tree rows.
5. Commands mutate provider state via `markPackageUpdating()` / `markPackageUpdated()` / `resetUpdateData()` / `invalidateUpdateCache()`, then fire `_onDidChangeTreeData`. The state-only `markPackageUpdating()` / `markPackageUpdated()` methods take an exact `PackageStateIdentity` tuple `(packageName, packageFilePath, section)`; package-row commands use provider-issued `ResolvedPackageItem` capabilities through `markPackageUpdatingForCapability()` / `markPackageUpdatedForCapability()`, which reject stale capabilities.

### Key patterns

**Write suppression** — When a command writes to `package.json` (e.g. updating a version), it calls `provider.withWriteSuppressed(fn)`. The file watcher checks `provider.suppressingWrites` and skips the debounced reload to prevent a feedback loop. Suppression is reference-counted (`writeSuppressionDepth`) so nested/overlapping calls don't clear it early; pending timers are tracked and cleared on `dispose()`.

**Workspace folder watcher** — `registerWorkspaceFoldersWatcher()` (`src/extension.ts`) listens to `vscode.workspace.onDidChangeWorkspaceFolders`; on change it refreshes the package.json watcher and calls `provider.loadPackages()` so packages stay in sync when workspace folders are added or removed.

**Package manager detection** — `detectPackageManager()` in `src/utils/packageManager.ts` delegates to `ClientManager.detectPackageManager()` (`src/clients/ClientManager.ts`). Given a `cwd` (monorepo package root), it walks up ancestor directories to the workspace folder, checking the `packageManager` field then lockfile detection (pnpm-lock.yaml → yarn.lock → bun.lock → package-lock.json) at each level; without a `cwd` it checks the given directory only. Defaults to `npm` if nothing is found.

**Deferred install mode** — When `nestro.deferInstallAfterUpdate` is enabled, commands write version changes directly to `package.json` (via `updateWorkspaceDependencyVersions`) without running a package manager install. The user then runs `nestro.runInstall` separately.

**Per-click debounce** — `checkUpdates()` enforces a debounce via `nestro.checkUpdatesDebounce` (seconds), but only when the update cache is still valid for the current `updateTarget` / `includePreReleases` / package-file set; a config or package-set change bypasses the debounce. Set `nestro.checkUpdatesForceAlways` to `true` to bypass the debounce and always run immediately. `invalidateUpdateCache()` clears both the cache and the last-check timestamp. `checkUpdates()` also no-ops if a check is already `running`, preventing concurrent update checks from overlapping. `runAudit()` follows the same pattern, no-oping if `auditState` is already `running`. Applying a fetched result is gated separately by a content fingerprint over every dependency's canonical path, section, name and on-disk spec plus the update policy: the fingerprint is recomputed from disk immediately before the cache write, and a mismatch discards the whole fetch instead of caching it.

**Context variables** — `emitTreeChanged()` publishes every key in `VIEW_CONTEXT_KEYS` (`src/providers/viewProjectionService.ts`) for `when`/`enablement` clauses in `package.json`; the non-obvious ones:
- `nestro.canUpdateVisiblePackages` — true when filtered list has outdated packages (controls "Update All" button)
- `nestro.noWorkspace` — true only after loading settles with no discovered package files and no package-file read failures (shows welcome content; an empty manifest still counts as a workspace)
- `nestro.hasSearchQuery` — true when the active search query is non-empty (controls the Clear Search Query overflow entry); reset to `false` on `dispose()`

`PackageItem.contextValue` starts with `package` or `outdated`, or `installing-<operation>`, and may append `pinnable` / `pin-unsupported` and `vulnerable-<severity>` tokens. The inline update menu uses `viewItem =~ /(^|-)outdated($|-)/` to match the outdated token despite suffixes; other row actions use base-prefix or capability-token regexes.

### Providers (`src/providers/`)
- `PackagesProvider.ts` — `TreeDataProvider` + `Disposable`; owns `allEntries`, accepted/held-back/unknown release-age state, and the async lifecycle (snapshot generations, cancellation, debounce and state gates) around the loading/update/audit services it delegates the work to
- `FilterManager.ts` — manages active `FilterType` (`all` | `hasUpdates` | `patch` | `minor` | `breaking`), fires `onDidChange`, provides QuickPick UI
- `treeBuilder.ts` — pure functions `buildTree()`, `projectPackageTree()`, `getFilteredEntries()`, `getFilterCounts()`, `formatViewDescription()`, `truncateSearchQuery()`, `toRelativeLabel()`, `resolvePackageOwnerLabel()`, `resolvePackageFileLabels()`, `comparePackageOwnerLabels()`, `resolveWorkspaceFolderDisplayNames()`, `findOwningWorkspaceFolder()`, `toWorkspaceFolderDescriptors()`; no VS Code state. Multi-root package rows are grouped and sorted by owning workspace folder (its stable `WorkspaceFolder.index`), root before subpaths within each folder, alphabetical beyond that — never a flat sort mixing roots. Every row label is `<workspace display name> — <relative path>` (root: `<workspace display name> — (root)`); when two folders share a `WorkspaceFolder.name`, the display name falls back to the shortest unique normalized path suffix, then to a stable `#<index>` suffix on a full collision. `getFilterCounts()` excludes packages currently installing. `formatViewDescription()` renders the active filter/search state for `treeView.description`, returning `undefined` when the filter is `all` and the search is empty
- `auditOrchestrationService.ts` — `AuditOrchestrationService.run()` resolves audit projects via `clients` (`resolveAuditProjects()`), runs each project's package-manager audit, and aggregates the per-project `AuditProjectSummary` / `AuditProjectFailure` results `runAudit()` publishes; for npm audit report v2, whose advisories carry no version field, `enrichNpmV2AdvisoryVersions()` resolves the installed version from an advisory's single direct `node_modules/<name>` node (`parseDirectNodeModulesNode()`) through a bounded reader (`readNodePackageJsonVersion()`) gated by a realpath-inside-project-root check, leaving anything ambiguous report-only; a row takes the highest severity among its attributed advisories
- `packageLoadingService.ts` — `PackageLoadingService.load()` reads workspace `package.json` files and resolves each one's canonical on-disk location into a `PackageLoadingSnapshot` (entries, package file paths, read failures) that `loadPackages()` applies to `allEntries`
- `updateOrchestrationService.ts` — `UpdateOrchestrationService.check()` runs the per-root update check behind `checkUpdates()`'s debounce/force/cache-fingerprint policy; exports `computeUpdateFingerprint()` for the content-fingerprint gate described in Key patterns
- `viewProjectionService.ts` — `computeViewProjection()` owns the context-key map, badge, `treeView.description`, status-row specs, and the filtered `PackageTreeProjection` in one pass over a plain state snapshot; `diffViewContexts()` reduces two context maps to only the changed keys. Pure: no VS Code events, `setContext` calls, or `TreeItem` construction — the provider computes one projection per `emitTreeChanged()`, recomputes status rows on each tree read, and converts the result to `StatusItem`s and published contexts. `projectStatusRows()` appends `Filter: …` and `Search: …` rows while a filter or search is active — shown because VS Code hides the view's description header while Nestro is the only view in its container — each bound through `TreeItem.command` to `nestro.showFilterPicker`/`nestro.searchPackages`, neither of which carries `enablement`; `StatusItem.ts` takes an optional `command` for these two rows
- `packageIdentity.ts` — canonical row identity shared by the loading, update, and audit services: `resolveCanonicalPackageLocation()`, `packageIdentityKey()` / `packageIdentityFromValues()`, and the `PackageIdentityTuple` / `CanonicalPackageLocation` types that key a row by exact `(name, packageFilePath, section)`
- `PackageItem.ts`, `PackageDetailItem.ts`, `GroupItem.ts`, `StatusItem.ts`, `LoadingItem.ts`, `MessageItem.ts`, `WorkspaceFolderItem.ts` — tree item classes
- `index.ts` — barrel exports for providers

### Clients (`src/clients/`)
- `Client.ts` — abstract base for package manager clients; `buildUpdateCommand()` / `buildInstallCommand()` / `buildRemoveCommand()` return a `ShellTaskCommand` (`src/utils/shellTask.ts`) rather than a raw string; `formatPackageTargets()` / `formatPackageNames()` validate each package name (and, for targets, its version) via `operandValidation.ts` before shell-quoting it as a `vscode.ShellQuotedString` (`ShellQuoting.Strong`) — an invalid operand throws before a task is ever built
- `operandValidation.ts` — `validatePackageName()` / `validatePackageVersionSpec()`; rejects only what makes an operand option-like or unresolvable (leading hyphen, empty name, malformed scope, URL-unsafe characters) — mixed case and length past 214 pass as real legacy registry names, leading `.`/`_` pass only because they're inert operands, not real ones
- `ClientManager.ts` — instantiates the correct client based on detected package manager; `detectPackageManager()` walks ancestor directories up to the workspace folder when given a `cwd`
- `NpmClient.ts`, `YarnClient.ts`, `PnpmClient.ts`, `BunClient.ts` — concrete client implementations; each puts package operands after a `--` separator, with the section flag (`--save-dev` / `--dev`) before it, so a package name can never be parsed as a CLI option
- `projectResolver.ts` — `resolveAuditProjects()` groups discovered `package.json` files into canonical audit projects by real project root and owning workspace folder, merging manifests that share one lock-file graph and rejecting workspace escapes/collisions; `resolveMutationCoordinatorKey()` derives the same canonical root as the `OperationCoordinator` lock key
- `index.ts` — barrel exports for clients

### Commands (`src/commands/`)
- `copyPackageName.ts` — `copyPackageNameCommand`; copies the row's package name to the clipboard via `vscode.env.clipboard.writeText()`; guarded by `isPackageItem()`, logs and no-ops on an invalid argument
- `installUpdate.ts` — `installUpdateCommand`, `runInstallCommand`, `updateAllVisibleCommand`; package-manager runs use VS Code shell tasks through `runShellTaskAndWait()` (`src/utils/shellTask.ts`) to await the exit code; successful exits invalidate the update cache, and non-zero or missing exit codes show `formatShellTaskFailureMessage()`; bulk update confirms before proceeding. Per-package update flows mark progress/results through the capability-based provider methods; `runInstallCommand` marks manifest rows by exact `PackageStateIdentity`; deferred-install writes use each resolved capability's explicit dependency `section`. `resolvePackageFileLabels()` (`src/providers/treeBuilder.ts`) supplies the same owner-qualified labels and ordering as the tree, avoiding false prefix matches between similarly named workspace folders (e.g. `app` vs `app-mobile`)
- `openAuditReport.ts` — `openAuditReportCommand`; renders the latest audit snapshot (`provider.getAuditReport()`) through `formatAuditReport()` into the shared output channel and shows it
- `openOnNpm.ts` — `openOnNpmCommand`; opens `https://www.npmjs.com/package/<name>` via `vscode.env.openExternal()`; guarded by `isPackageItem()`
- `openStatusReport.ts` — `openStatusReportCommand`; renders `provider.getStatusReport()` through `formatStatusReport()` into the shared output channel and shows it
- `pickVersion.ts` — `pickVersionCommand`; shows QuickPick for selecting a specific package version; disposes the QuickPick and its listeners on hide so a version fetch resolving after the user cancels does not act on a stale picker
- `pinAllVersions.ts` — `pinAllVersionsCommand`; pins all workspace dependency versions through the shared atomic multi-file write/rollback in `packageReader.ts` (preflights every file before the first write; a manifest that fails to parse is skipped and named in the result message rather than aborting the whole run); invalidates the update cache and reloads packages on failure too, since a rolled-back write may still have touched disk, but skips the reload when nothing needed pinning
- `pinVersion.ts` — `pinVersionCommand`; toggles supported concrete dependency specs between exact and caret versions in the selected dependency section, preserving the `workspace:` protocol
- `removePackage.ts` — `removePackageCommand`; runs the package manager remove command via `runShellTaskAndWait()`; invalidates the update cache and reloads packages on success, or marks the item not-updating, shows an error via `formatShellTaskFailureMessage()`, and reloads packages on failure
- `switchDepType.ts` — `switchDepTypeCommand`; moves a dependency between `dependencies` and `devDependencies`
- `packageIdentity.ts` — shared command-side identity resolution: `resolveCommandPackageItem()` / `revalidateCommandPackageItem()` re-check a row against the provider immediately before a write or task; `resolveUnambiguousManifestEntry()` reads the manifest and rejects a same-name duplicate in the other dependency section, while `resolvePinManifestEntry()` validates the selected section and allows that duplicate; not re-exported through `index.ts` — commands import it directly as a subsystem sibling

### Utils (`src/utils/`)
- `ncuClient.ts` — thin wrapper around `npm-check-updates` (dynamic `import('npm-check-updates')` to avoid bundling issues); caches the imported `run()` function and returns `Map<name, latestVersion>`; `UpdateOrchestrationService` owns the update-result cache
- `metadataRunner.ts` — runs bounded HTTPS metadata requests with typed schema, transport, timeout, cancellation, truncation, and overflow outcomes; enforces a 15s timeout and 5MiB response limit
- `metadataRegistry.ts` — resolves package-manager-aware metadata adapters in tier order (native CLI, config-aware HTTPS, public npm), exposes a credential-free resolved-registry key for bounded deduplication, and uses native CLI for npm/pnpm and both Yarn family commands before the config-aware HTTPS fallback
- `releaseAge.ts` — validates the minimum release-age setting and classifies versions using absolute UTC publish instants
- `nativeMetadataClient.ts` — runs bounded `npm view` / `pnpm view` requests from the package root, validates the full metadata document, and maps process outcomes to the metadata taxonomy
- `yarnMetadataClient.ts` — runs bounded Yarn Classic and Modern metadata commands after `resolveYarnFamily()` selects the matching command shape, validates each JSON document, and maps process outcomes to the metadata taxonomy
- `yarnFamily.ts` — `resolveYarnFamily()` picks Yarn Classic vs Modern for one project root: explicit `packageManager` metadata first, then same-root markers, then a bounded `yarn --version` probe as last resort; nothing defaults to Classic
- `bunConfig.ts` — parses the supported `bunfig.toml` registry and scope forms, expanding environment references and normalizing URL-embedded credentials
- `registryClient.ts` — implements the config-aware HTTPS metadata adapter; resolves nested project-to-user `.npmrc`, `bunfig.toml`, Yarn Classic `.yarnrc`, Yarn Modern `.yarnrc.yml`, and `npm_config_*` overrides for scoped registries, host-bound auth, TLS, proxies, and bounded redirects, then parses versions, dist-tags, and optional publish times
- `auditClient.ts` — runs `npm audit` to detect package vulnerabilities, parsing the output into an `AuditResult`'s advisories; row attribution onto `PackageItem` badges happens in `auditOrchestrationService.ts`, not here. Also the shared audit primitives (`AuditResult`, outcome parsing, severity merge, the process timeout/buffer constants) `bunAuditClient.ts` and `yarnAuditClient.ts` build on
- `auditReport.ts` — shared audit advisory model: `createAuditAdvisory()` / `mergeAuditAdvisories()`, direct/transitive/unknown attribution merging, and text sanitization used by every audit client and the report formatter
- `auditReportFormatter.ts` — `formatAuditReport()` renders the `openAuditReport` output-channel text from `AuditProjectSummary` / `AuditProjectFailure`; `validateAdvisoryUrl()` guards advisory links before they're shown
- `bunAuditClient.ts` — `runBunAudit()` runs Bun's raw-registry bulk-advisory JSON audit contract (schema `bun-bulk-advisory`) and folds the result through `auditClient.ts`'s shared parsing
- `yarnAuditClient.ts` — `runYarnAudit()` selects the Yarn Classic or Modern command with `resolveYarnFamily()` and normalizes each family's schema into the shared `AuditResult`; Classic requires exactly one final `auditSummary`, matching severity counts, and an exit code equal to its severity mask, while Modern validates its npm-audit tree output and expected exit code
- `processRunner.ts` — `runBoundedProcess()` spawns a child process with a timeout and per-stream buffer cap, classifying outcomes as `exit`, `timeout`, `overflow`, `aborted`, or `spawn-error`, and escalates from a graceful termination signal to a forceful kill after `killGracePeriodMs`; shared by the native/Yarn/Bun metadata and audit runners
- `shellTask.ts` — `runShellTaskAndWait()` runs a `vscode.Task` via `vscode.tasks.executeTask()` using a `ShellTaskCommand` (`{ command, args }`, each shell-quoted via `vscode.ShellQuotedString`) and resolves with the process exit code once `onDidEndTaskProcess` fires (or `undefined` if `onDidEndTask` fires first without a process event); shared by `installUpdate.ts` and `removePackage.ts` to avoid duplicating task-execution/listener-cleanup logic; `formatShellTaskCommandForLog()` renders a `ShellTaskCommand` back to a string for log messages; `formatShellTaskFailureMessage()` builds a user-facing error string for a non-zero or missing exit code
- `packageReader.ts` — reads workspace `package.json` dependencies; `updateDependencyVersionsInFile()` takes an explicit `DependencySection` (`dependencies` | `devDependencies`) per update rather than inferring it; preserves the original indentation style (spaces or tabs) when rewriting `package.json`
- `packageRepository.ts` — file I/O for workspace `package.json` files: `findWorkspacePackageJsonFiles()`, `readPackageFile()`, and the atomic `writePreparedPackageFile()` / `writeManyPreparedPackageFilesAtomically()` writers `packageReader.ts` builds on
- `packageTransforms.ts` — pure `package.json` document transforms: `parsePackageJson()` / `serializePackageJson()` and the `prepare*()` / `transform*()` functions that compute a dependency-type switch, version pin, or bulk pin-all-versions edit without touching disk
- `dependencySpec.ts` — parses a dependency's version spec into range (`exact` / `caret` / `tilde`) and protocol (`plain` / `workspace`), flagging specs the pin toggle must leave untouched with a user-facing reason
- `packageManager.ts` — detects package manager, builds install/update CLI commands
- `packageManagerKind.ts` — the `PackageManager` type (`'npm' | 'pnpm' | 'yarn' | 'bun'`) shared by `utils` and `clients` without a cross-barrel value import
- `operationCoordinator.ts` — `OperationCoordinator` serializes mutations by canonical project-root key, running different keys concurrently up to a `concurrencyCap`; acquires multi-key locks in sorted order to stay deadlock-free
- `rootOperation.ts` — `startRootOperations()` / `runRootOperations()` run bounded per-root work over an `OperationCoordinator`, separating prompt cancellation from actual settlement so a cancelled operation still releases its coordinator slot
- `statusReport.ts` — `formatStatusReport()` renders the `openStatusReport` output-channel text from a `StatusReportSnapshot` (read/update/audit failures, file labels), sanitizing file URIs, absolute paths, and credential-shaped text out of the output
- `localization.ts` — `vscode.l10n.t()`-backed label formatters (`formatUpdateTypeLabel()`, `formatAuditSeverityLabel()`, `formatDependencySectionLabel()`, package-count/advisory-row phrasing) shared by the tree, status report, and audit report; also the `Intl`-backed `formatHeldBackDate()`, used by the version picker to render a held-back release's eligibility instant as a localized date
- `versionUtils.ts` — `getUpdateType()` classifies semver diff as `patch` | `minor` | `breaking` | `none`
- `logger.ts` — `Logger` singleton writing to VS Code output channel; use instead of `console.log`
- `notify.ts` — `showError()` helper
- `index.ts` — barrel exports for utils

### Tools (`src/tools/`)
Release/CI/VSIX tooling, isolated from `providers`/`utils`/`clients`/`commands` (enforced by `src/test/importContract.unit.test.ts`) and never bundled into the extension. Each CLI entry point runs as compiled JS from a `package.json` script that runs `test:compile` first — `node out/tools/<Name>Cli.js`.
- **VSIX packaging** — `vsixArchive.ts`, `vsixManifest.ts`, `vsixPolicy.ts` parse a packaged `.vsix` and evaluate it against the size/file-count/secret-pattern budget; `verifyVsix.ts` / `verifyVsixCli.ts` drive `pnpm run check:vsce`; `publishedArtifact.ts` exports `comparePublishedVsix()` to diff a locally built VSIX against one already published, with no dedicated script or CLI wrapper
- **Release** — `releaseAnalyzer.ts` computes the next semantic-release version and changelog entry from commit history for `releasePrepare.ts` / `releasePrepareCli.ts` below; `releaseCandidate.ts` / `releaseCandidateCli.ts` and `releasePrepare.ts` / `releasePrepareCli.ts` build and validate the evidence `pnpm run release:candidate` / `release:prepare` produce; `releaseWorkflowPolicy.ts` evaluates the GitHub Actions release workflows against policy
- **CI / supply-chain evidence** — `ciEvidence.ts` / `ciEvidenceCli.ts` record `pnpm run ci:evidence` output; `ciPolicy.ts` / `ciPolicyCli.ts` validate the repository's CI workflow, CODEOWNERS, and Dependabot configuration for `pnpm run ci:policy`; `auditSignatures.ts` / `auditSignaturesCli.ts` verify pnpm package signatures for `pnpm run audit:signatures`; `artifactProvenance.ts` / `artifactProvenanceCli.ts` build the SBOM/provenance evidence for `pnpm run release:provenance`
- `index.ts` — barrel exports for tools

### Manifest (`package.json`)
- Command IDs must match exactly between `contributes.commands` and `vscode.commands.registerCommand`
- Internal commands not meant for the palette (e.g. `nestro.setFilter`, `nestro.showFilterPicker`) are still declared in `contributes.commands` for keybinding metadata, then hidden via `contributes.menus.commandPalette` entries with `"when": "false"`
- `activationEvents: ["workspaceContains:package.json"]` — explicitly activates when the opened workspace contains a `package.json`; on the supported VS Code versions, contributed commands also activate when invoked and contributed views activate when opened
- `main: ./out/extension.cjs` — must stay in sync with tsdown output extension

### Build
`tsdown` bundles `src/extension.ts` → `out/extension.cjs`; `vscode` is never bundled (external). Integration tests compiled separately via `tsc -p tsconfig.test.json` → `out/test/`. `tsconfig.json` uses `"module": "esnext"` + `"moduleResolution": "bundler"` for tsdown; `tsconfig.test.json` uses `"module": "Node16"`.

## Conventions
- Command IDs: `nestro.<camelCase>` — declare in `package.json` `contributes.commands` **and** register in `activate()`
- TypeScript: strict mode — no `any`, explicit return types on exported functions
- Code comments: one line by default, three at most; English, present tense; they say what the code is, not how it came to be. No task/audit ids (`AUD-09`, `ARC-01`), no benchmark tables, no rationale essays — that context belongs in the commit message. Rules and examples: **[CODESTYLE.md](CODESTYLE.md)** → Code Comments
- Disposables: always `context.subscriptions.push(...)` — never leak event listeners or providers
- Imports: `import * as vscode from 'vscode'` (namespace import, not default)
- Import another subsystem only through its barrel `index.ts`, never through its implementation files; siblings inside one subsystem import each other directly. Barrels use selective named exports on subsystem boundaries, not `export *`; the enforceable layer order and its allowlisted exceptions are in **[CODESTYLE.md](CODESTYLE.md)** → Module Structure & Barrels, checked by `src/test/importContract.unit.test.ts`
- `CHANGELOG.md` is generated by `@semantic-release/changelog` from commit messages — do not hand-edit release sections
- Full codestyle reference: **[CODESTYLE.md](CODESTYLE.md)**
- Accumulated project gotchas (tsdown, tsconfig, Vitest): **[LEARNINGS.md](LEARNINGS.md)**
- Release runbook (verified SHA and artifact identity, audits, environment approval, post-publish comparison): **[RELEASING.md](RELEASING.md)**
- README screenshots: **[images/SCREENSHOTS.md](images/SCREENSHOTS.md)** documents how the sidebar frames are captured and reproduced; `scripts/screenshots/` (`pnpm run screenshots`) automates the capture

## Commit Message Format

`conventionalcommits` preset — drives `semantic-release` and `CHANGELOG.md`. Format: `<type>(<scope>): <subject>`

| Type | Meaning | Bump | Release notes section |
|------|---------|:----:|---|
| `feat` | New user-facing feature | minor | Features |
| `fix` | Bug fix | patch | Bug Fixes |
| `part` | Partial fix / partial feature | patch | Bug Fixes |
| `perf` | Performance improvement | patch | Performance |
| `revert` | Revert of a previous commit | patch | Reverts |
| `refactor` | Refactoring, no behavior change | patch | Maintenance |
| `refactoring` | Refactoring, no behavior change | patch | Maintenance |
| `service` | Service / infrastructure change | patch | Maintenance |
| `style` | Visual / UI-only change | patch | Maintenance |
| `chore` | Tooling, deps, config | patch | Maintenance |
| `spark` | Small self-contained change | patch | Small changes |
| `docs` | Documentation only | — | — |
| `test` | Tests only | — | — |
| `ci` | CI / workflow only | — | — |
| `ghost` | Internal change, no release | — | — |

Every type in this table is active and may be used in new commits. Types with no bump produce no release and no changelog entry — never mark a `docs`, `test`, `ci` or `ghost` commit as changelog-bearing.

Scope examples: `toolbar`, `audit`, `picker`, `provider`, `deps`.

Agent configuration synchronization is managed manually by the user; AI must not run synchronization commands before commits.
