# AGENTS.md

## Project
**Nestro** — VS Code extension (`src/extension.ts`) managing npm/pnpm/yarn/bun packages from the sidebar with update status and version switching. Built on the VS Code Extension API (`@types/vscode 1.125.0`). Update detection uses `npm-check-updates` (dynamically imported in `src/utils/ncuClient.ts`).

## Commands
```bash
pnpm run build          # tsdown → out/extension.cjs
pnpm run dev            # tsdown --watch
pnpm run lint           # eslint src --max-warnings=0 — non-mutating validation gate
pnpm run lint:fix       # eslint --fix src — the mutating pass, never run automatically
pnpm run typecheck      # tsc --noEmit
pnpm run test:compile   # tsc -p tsconfig.test.json → out/test/
pnpm run check:vsce     # vsce ls --no-dependencies
pnpm run test           # pretest (test:compile + lint) + vscode-test (Electron)
pnpm run test:unit      # vitest run — *.unit.test.ts without VS Code
pnpm run test:unit:watch  # vitest (watch mode)
```

Integration tests: `.vscode-test.mjs` picks up all `out/test/**/*.test.js`; no single-file isolation.
Unit tests: Vitest, `vscode` mocked via `src/test/__mocks__/vscode.ts`.
Manual testing: **F5** → Run Extension (`.vscode/launch.json`) → Extension Development Host window.

## Architecture

### Data flow
1. `activate()` creates `FilterManager` and `PackagesProvider`, then calls `provider.loadPackages()`.
2. `loadPackages()` reads `package.json` via `readWorkspaceDependencies()` (`src/utils/packageReader.ts`) → populates `allEntries: PackageTreeEntry[]`.
3. `checkUpdates()` calls `fetchAllLatestVersions()` (ncuClient → `npm-check-updates`) and the metadata registry → enriches each entry with the accepted version, `updateType`, and release-age state (`accepted`, `held-back`, or `unknown`), preserving any live `installing` state set by `markPackageUpdating()`. Update results are cached to avoid redundant network calls.
4. `getChildren()` delegates to `buildTree()` (`src/providers/treeBuilder.ts`) which returns `GroupItem[]` (or `WorkspaceFolderItem[]` when the workspace has more than one `package.json`) — groups split into Dependencies / Dev Dependencies. The active filter/search state renders as `treeView.description` (`formatViewDescription()`), not as tree rows.
5. Commands mutate provider state via `markPackageUpdating()` / `markPackageUpdated()` / `resetUpdateData()` / `invalidateUpdateCache()`, then fire `_onDidChangeTreeData`. `markPackageUpdating()` / `markPackageUpdated()` take a required `packageFilePath` and match entries by exact path (no name-only fallback), since monorepos can have the same package name across multiple `package.json` files.

### Key patterns

**Write suppression** — When a command writes to `package.json` (e.g. updating a version), it calls `provider.withWriteSuppressed(fn)`. The file watcher checks `provider.suppressingWrites` and skips the debounced reload to prevent a feedback loop. Suppression is reference-counted (`writeSuppressionDepth`) so nested/overlapping calls don't clear it early; pending timers are tracked and cleared on `dispose()`.

**Workspace folder watcher** — `registerWorkspaceFoldersWatcher()` (`src/extension.ts`) listens to `vscode.workspace.onDidChangeWorkspaceFolders`; on change it refreshes the package.json watcher and calls `provider.loadPackages()` so packages stay in sync when workspace folders are added or removed.

**Package manager detection** — `detectPackageManager()` in `src/utils/packageManager.ts` delegates to `ClientManager.detectPackageManager()` (`src/clients/ClientManager.ts`). Given a `cwd` (monorepo package root), it walks up ancestor directories to the workspace folder, checking the `packageManager` field then lockfile detection (pnpm-lock.yaml → yarn.lock → bun.lock → package-lock.json) at each level; without a `cwd` it checks the given directory only. Defaults to `npm` if nothing is found.

**Deferred install mode** — When `nestro.deferInstallAfterUpdate` is enabled, commands write version changes directly to `package.json` (via `updateWorkspaceDependencyVersions`) without running a package manager install. The user then runs `nestro.runInstall` separately.

**Per-click debounce** — `checkUpdates()` enforces a debounce via `nestro.checkUpdatesDebounce` (seconds), but only when the update cache is still valid for the current `updateTarget` / `includePreReleases` / package-file set; a config or package-set change bypasses the debounce. Set `nestro.checkUpdatesForceAlways` to `true` to bypass the debounce and always run immediately. `invalidateUpdateCache()` clears both the cache and the last-check timestamp. `checkUpdates()` also no-ops if a check is already `running`, preventing concurrent update checks from overlapping. `runAudit()` follows the same pattern, no-oping if `auditState` is already `running`. Applying a fetched result is gated separately by a content fingerprint over every dependency's canonical path, section, name and on-disk spec plus the update policy: the fingerprint is recomputed from disk immediately before the cache write, and a mismatch discards the whole fetch instead of caching it.

**Context variables** — `emitTreeChanged()` sets VS Code context keys used by `when` clauses in `package.json` menus:
- `nestro.canUpdateVisiblePackages` — true when filtered list has outdated packages (controls "Update All" button)
- `nestro.noWorkspace` — true when no packages found (shows welcome content)
- `nestro.hasSearchQuery` — true when the active search query is non-empty (controls the Clear Search Query overflow entry); reset to `false` on `dispose()`

`PackageItem.contextValue` is set to `"outdated"` when a package has updates; used by `viewItem == outdated` in `view/item/context` menu to show the inline update button.

### Providers (`src/providers/`)
- `PackagesProvider.ts` — `TreeDataProvider` + `Disposable`; owns `allEntries`, accepted/held-back/unknown release-age state, and all async operations
- `FilterManager.ts` — manages active `FilterType` (`all` | `hasUpdates` | `patch` | `minor` | `breaking`), fires `onDidChange`, provides QuickPick UI
- `treeBuilder.ts` — pure functions `buildTree()`, `getFilteredEntries()`, `getFilterCounts()`, `formatViewDescription()`, `toRelativeLabel()`, `resolvePackageOwnerLabel()`, `resolvePackageFileLabels()`, `comparePackageOwnerLabels()`, `resolveWorkspaceFolderDisplayNames()`, `findOwningWorkspaceFolder()`, `toWorkspaceFolderDescriptors()`; no VS Code state. Multi-root package rows are grouped and sorted by owning workspace folder (its stable `WorkspaceFolder.index`), root before subpaths within each folder, alphabetical beyond that — never a flat sort mixing roots. Every row label is `<workspace display name> — <relative path>` (root: `<workspace display name> — (root)`); when two folders share a `WorkspaceFolder.name`, the display name falls back to the shortest unique normalized path suffix, then to a stable `#<index>` suffix on a full collision. `getFilterCounts()` excludes packages currently installing. `formatViewDescription()` renders the active filter/search state for `treeView.description`, returning `undefined` when the filter is `all` and the search is empty
- `viewProjectionService.ts` — `computeViewProjection()` owns the context-key map, badge, `treeView.description`, status-row specs, and the filtered `PackageTreeProjection` in one pass over a plain state snapshot; `diffViewContexts()` reduces two context maps to only the changed keys. Pure: no VS Code events, `setContext` calls, or `TreeItem` construction — the provider computes one projection per `emitTreeChanged()`, recomputes status rows on each tree read, and converts the result to `StatusItem`s and published contexts
- `PackageItem.ts`, `PackageDetailItem.ts`, `GroupItem.ts`, `StatusItem.ts`, `LoadingItem.ts`, `MessageItem.ts`, `WorkspaceFolderItem.ts` — tree item classes

### Clients (`src/clients/`)
- `Client.ts` — abstract base for package manager clients; `buildUpdateCommand()` / `buildInstallCommand()` / `buildRemoveCommand()` return a `ShellTaskCommand` (`src/utils/shellTask.ts`) rather than a raw string; `formatPackageTargets()` / `formatPackageNames()` validate each package name (and, for targets, its version) via `operandValidation.ts` before shell-quoting it as a `vscode.ShellQuotedString` (`ShellQuoting.Strong`) — an invalid operand throws before a task is ever built
- `operandValidation.ts` — `validatePackageName()` / `validatePackageVersionSpec()`; rejects only what makes an operand option-like or unresolvable (leading hyphen, empty name, malformed scope, URL-unsafe characters) — mixed case and length past 214 pass as real legacy registry names, leading `.`/`_` pass only because they're inert operands, not real ones
- `ClientManager.ts` — instantiates the correct client based on detected package manager; `detectPackageManager()` walks ancestor directories up to the workspace folder when given a `cwd`
- `NpmClient.ts`, `YarnClient.ts`, `PnpmClient.ts`, `BunClient.ts` — concrete client implementations; each puts package operands after a `--` separator, with the section flag (`--save-dev` / `--dev`) before it, so a package name can never be parsed as a CLI option
- `index.ts` — barrel exports for clients

### Commands (`src/commands/`)
- `installUpdate.ts` — `installUpdateCommand`, `runInstallCommand`, `updateAllVisibleCommand`; all run package manager via VS Code shell tasks using `runShellTaskAndWait()` (`src/utils/shellTask.ts`) to await the exit code; calls `invalidateUpdateCache()` on successful exit; shows an error via `formatShellTaskFailureMessage()` on a non-zero or missing exit code; bulk update confirms before proceeding; deferred-install writes now pass an explicit `section` (`dependencies`/`devDependencies`) per package via `getPackageSection()`; calls `provider.markPackageUpdating()` / `provider.markPackageUpdated()` directly with each item's `packageFilePath`; `resolvePackageFileLabels()` (`src/providers/treeBuilder.ts`) supplies the same owner-qualified labels and ordering as the tree, avoiding false prefix matches between similarly named workspace folders (e.g. `app` vs `app-mobile`)
- `removePackage.ts` — `removePackageCommand`; runs the package manager remove command via `runShellTaskAndWait()`; invalidates the update cache and reloads packages on success, or marks the item not-updating, shows an error via `formatShellTaskFailureMessage()`, and reloads packages on failure
- `pickVersion.ts` — `pickVersionCommand`; shows QuickPick for selecting a specific package version; disposes the QuickPick and its listeners on hide so a version fetch resolving after the user cancels does not act on a stale picker
- `pinAllVersions.ts` — `pinAllVersionsCommand`; pins all workspace dependency versions through the shared atomic multi-file write/rollback in `packageReader.ts` (preflights every file before the first write; a manifest that fails to parse is skipped and named in the result message rather than aborting the whole run); invalidates the update cache and reloads packages on failure too, since a rolled-back write may still have touched disk, but skips the reload when nothing needed pinning
- `pinVersion.ts` — `pinVersionCommand`; pins a single row's dependency to its currently resolved concrete version
- `switchDepType.ts` — `switchDepTypeCommand`; moves a dependency between `dependencies` and `devDependencies`

### Utils (`src/utils/`)
- `ncuClient.ts` — thin wrapper around `npm-check-updates` (dynamic `import('npm-check-updates')` to avoid bundling issues); returns `Map<name, latestVersion>`; results cached across calls
- `metadataRunner.ts` — runs bounded HTTPS metadata requests with typed schema, transport, timeout, cancellation, truncation, and overflow outcomes; enforces a 15s timeout and 5MiB response limit
- `metadataRegistry.ts` — resolves package-manager-aware metadata adapters in tier order (native CLI, config-aware HTTPS, public npm), exposes a credential-free resolved-registry key for bounded deduplication, and uses native CLI for npm/pnpm and both Yarn family commands before the config-aware HTTPS fallback
- `releaseAge.ts` — validates the minimum release-age setting and classifies versions using absolute UTC publish instants
- `nativeMetadataClient.ts` — runs bounded `npm view` / `pnpm view` requests from the package root, validates the full metadata document, and maps process outcomes to the metadata taxonomy
- `yarnMetadataClient.ts` — runs bounded Yarn Classic and Modern metadata commands after `resolveYarnFamily()` selects the matching command shape, validates each JSON document, and maps process outcomes to the metadata taxonomy
- `bunConfig.ts` — parses the supported `bunfig.toml` registry and scope forms, expanding environment references and normalizing URL-embedded credentials
- `registryClient.ts` — implements the config-aware HTTPS metadata adapter; resolves nested project-to-user `.npmrc`, `bunfig.toml`, Yarn Classic `.yarnrc`, Yarn Modern `.yarnrc.yml`, and `npm_config_*` overrides for scoped registries, host-bound auth, TLS, proxies, and bounded redirects, then parses versions, dist-tags, and optional publish times
- `auditClient.ts` — runs `npm audit` to detect package vulnerabilities; populates audit badge indicators on `PackageItem`
- `shellTask.ts` — `runShellTaskAndWait()` runs a `vscode.Task` via `vscode.tasks.executeTask()` using a `ShellTaskCommand` (`{ command, args }`, each shell-quoted via `vscode.ShellQuotedString`) and resolves with the process exit code once `onDidEndTaskProcess` fires (or `undefined` if `onDidEndTask` fires first without a process event); shared by `installUpdate.ts` and `removePackage.ts` to avoid duplicating task-execution/listener-cleanup logic; `formatShellTaskCommandForLog()` renders a `ShellTaskCommand` back to a string for log messages; `formatShellTaskFailureMessage()` builds a user-facing error string for a non-zero or missing exit code
- `packageReader.ts` — reads workspace `package.json` dependencies; `updateDependencyVersionsInFile()` takes an explicit `DependencySection` (`dependencies` | `devDependencies`) per update rather than inferring it; preserves the original indentation style (spaces or tabs) when rewriting `package.json`
- `packageManager.ts` — detects package manager, builds install/update CLI commands
- `versionUtils.ts` — `getUpdateType()` classifies semver diff as `patch` | `minor` | `breaking` | `none`
- `logger.ts` — `Logger` singleton writing to VS Code output channel; use instead of `console.log`
- `notify.ts` — `showError()` helper
- `index.ts` — barrel exports for utils

### Manifest (`package.json`)
- Command IDs must match exactly between `contributes.commands` and `vscode.commands.registerCommand`
- Internal commands not meant for the palette (e.g. `nestro.setFilter`, `nestro.showFilterPicker`) are still declared in `contributes.commands` for keybinding metadata, then hidden via `contributes.menus.commandPalette` entries with `"when": "false"`
- `activationEvents: []` — activates on any command invocation
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
- Accumulated project gotchas (tsdown, tsconfig, Vitest): **[LEARNINGS.md](LEARNINGS.md)**
- Full codestyle reference, including the canonical commit type table: **[CODESTYLE.md](CODESTYLE.md)**
- Orchestrated workflow: the active plan is `workflow/audit/plan.md` (local, gitignored, never committed). Keep `workflow/**` as local bookkeeping, use one code commit per task card, and run implementation and review through separate subagents before committing. `workflow/archived/ai-execution-plan.md` is historical and not normative.

Agent configuration synchronization is managed manually by the user; AI must not run synchronization commands before commits.
