# AGENTS.md

## Project
**Nestro** — VS Code extension (`src/extension.ts`) managing npm/pnpm/yarn/bun packages from the sidebar with update status and version switching. Built on the VS Code Extension API (`@types/vscode 1.125.0`). Update detection uses `npm-check-updates` (dynamically imported in `src/utils/ncuClient.ts`).

## Commands
```bash
pnpm run build          # tsdown → out/extension.cjs
pnpm run dev            # tsdown --watch
pnpm run lint           # run-s lint:eslint lint:stylelint (eslint + stylelint, both --fix)
pnpm run typecheck      # tsc --noEmit
pnpm run test           # pretest (tsc -p tsconfig.test.json + lint) + vscode-test (Electron)
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
3. `checkUpdates()` calls `fetchAllLatestVersions()` (ncuClient → `npm-check-updates`) → enriches each entry with `latest` + `updateType`, preserving any live `installing` state set by `markPackageUpdating()`. Update results are cached to avoid redundant network calls.
4. `getChildren()` delegates to `buildTree()` (`src/providers/treeBuilder.ts`) which returns `[FilterBarItem, ...GroupItem[]]` — groups split into Dependencies / Dev Dependencies.
5. Commands mutate provider state via `markPackageUpdating()` / `markPackageUpdated()` / `resetUpdateData()` / `invalidateUpdateCache()`, then fire `_onDidChangeTreeData`. `markPackageUpdating()` / `markPackageUpdated()` take a required `packageFilePath` and match entries by exact path (no name-only fallback), since monorepos can have the same package name across multiple `package.json` files.

### Key patterns

**Write suppression** — When a command writes to `package.json` (e.g. updating a version), it calls `provider.withWriteSuppressed(fn)`. The file watcher checks `provider.suppressingWrites` and skips the debounced reload to prevent a feedback loop. Suppression is reference-counted (`writeSuppressionDepth`) so nested/overlapping calls don't clear it early; pending timers are tracked and cleared on `dispose()`.

**Workspace folder watcher** — `registerWorkspaceFoldersWatcher()` (`src/extension.ts`) listens to `vscode.workspace.onDidChangeWorkspaceFolders`; on change it refreshes the package.json watcher and calls `provider.loadPackages()` so packages stay in sync when workspace folders are added or removed.

**Package manager detection** — `detectPackageManager()` in `src/utils/packageManager.ts` delegates to `ClientManager.detectPackageManager()` (`src/clients/ClientManager.ts`). Given a `cwd` (monorepo package root), it walks up ancestor directories to the workspace folder, checking the `packageManager` field then lockfile detection (pnpm-lock.yaml → yarn.lock → bun.lock → package-lock.json) at each level; without a `cwd` it checks the given directory only. Defaults to `npm` if nothing is found.

**Deferred install mode** — When `nestro.deferInstallAfterUpdate` is enabled, commands write version changes directly to `package.json` (via `updateWorkspaceDependencyVersions`) without running a package manager install. The user then runs `nestro.runInstall` separately.

**Per-click debounce** — `checkUpdates()` enforces a debounce via `nestro.checkUpdatesDebounce` (seconds), but only when the update cache is still valid for the current `updateTarget` / `includePreReleases` / package-file set; a config or package-set change bypasses the debounce. Set `nestro.checkUpdatesForceAlways` to `true` to bypass the debounce and always run immediately. `invalidateUpdateCache()` clears both the cache and the last-check timestamp. `checkUpdates()` also no-ops if a check is already `running`, preventing concurrent update checks from overlapping. `runAudit()` follows the same pattern, no-oping if `auditState` is already `running`.

**Context variables** — `emitTreeChanged()` sets two VS Code context keys used by `when` clauses in `package.json` menus:
- `nestro.canUpdateVisiblePackages` — true when filtered list has outdated packages (controls "Update All" button)
- `nestro.noWorkspace` — true when no packages found (shows welcome content)

`PackageItem.contextValue` is set to `"outdated"` when a package has updates; used by `viewItem == outdated` in `view/item/context` menu to show the inline update button.

### Providers (`src/providers/`)
- `PackagesProvider.ts` — `TreeDataProvider` + `Disposable`; owns `allEntries` state and all async operations
- `FilterManager.ts` — manages active `FilterType` (`all` | `hasUpdates` | `patch` | `minor` | `breaking`), fires `onDidChange`, provides QuickPick UI
- `treeBuilder.ts` — pure functions `buildTree()`, `getFilteredEntries()`, `getFilterCounts()`, `toRelativeLabel()`; no VS Code state; workspace folders sorted `(root)` first then alphabetically; `getFilterCounts()` excludes packages currently installing
- `PackageItem.ts`, `GroupItem.ts`, `FilterBarItem.ts`, `LoadingItem.ts`, `MessageItem.ts`, `WorkspaceFolderItem.ts` — tree item classes

### Clients (`src/clients/`)
- `Client.ts` — abstract base for package manager clients; `buildUpdateCommand()` / `buildInstallCommand()` / `buildRemoveCommand()` return a `ShellTaskCommand` (`src/utils/shellTask.ts`) rather than a raw string; `formatPackageTargets()` / `formatPackageNames()` shell-quote each argument via `vscode.ShellQuotedString` (`ShellQuoting.Strong`) instead of interpolating into a string
- `ClientManager.ts` — instantiates the correct client based on detected package manager; `detectPackageManager()` walks ancestor directories up to the workspace folder when given a `cwd`
- `NpmClient.ts`, `YarnClient.ts`, `PnpmClient.ts`, `BunClient.ts` — concrete client implementations
- `index.ts` — barrel exports for clients

### Commands (`src/commands/`)
- `installUpdate.ts` — `installUpdateCommand`, `runInstallCommand`, `updateAllVisibleCommand`; all run package manager via VS Code shell tasks using `runShellTaskAndWait()` (`src/utils/shellTask.ts`) to await the exit code; calls `invalidateUpdateCache()` on successful exit; shows an error via `formatShellTaskFailureMessage()` on a non-zero or missing exit code; bulk update confirms before proceeding; deferred-install writes now pass an explicit `section` (`dependencies`/`devDependencies`) per package via `getPackageSection()`; calls `provider.markPackageUpdating()` / `provider.markPackageUpdated()` directly with each item's `packageFilePath`; `formatPackageFileLabel()` reuses `toRelativeLabel()` (`src/providers/treeBuilder.ts`) to derive sibling-folder labels, avoiding false prefix matches between similarly named workspace folders (e.g. `app` vs `app-mobile`)
- `removePackage.ts` — `removePackageCommand`; runs the package manager remove command via `runShellTaskAndWait()`; invalidates the update cache and reloads packages on success, or marks the item not-updating, shows an error via `formatShellTaskFailureMessage()`, and reloads packages on failure
- `pickVersion.ts` — `pickVersionCommand`; shows QuickPick for selecting a specific package version; disposes the QuickPick and its listeners on hide so a version fetch resolving after the user cancels does not act on a stale picker
- `pinAllVersions.ts` — `pinAllVersionsCommand`; pins all workspace dependency versions using `withWriteSuppressed`, then reloads packages
- `helloWorld.ts` — minimal stub command

### Utils (`src/utils/`)
- `ncuClient.ts` — thin wrapper around `npm-check-updates` (dynamic `import('npm-check-updates')` to avoid bundling issues); returns `Map<name, latestVersion>`; results cached across calls
- `registryClient.ts` — fetches package version lists directly from the npm registry over HTTPS for the version picker; resolves the registry URL from `.npmrc` (user home then workspace root, including scoped `@scope:registry` entries) before falling back to the default npm registry; `fetchPackageVersions()` rejects with a descriptive error on non-2xx HTTP responses, a 15s request timeout, or a response exceeding 5MB
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
- Disposables: always `context.subscriptions.push(...)` — never leak event listeners or providers

<!-- caliber:managed:pre-commit -->
## Before Committing

**IMPORTANT:** Before every git commit, you MUST ensure Caliber syncs agent configs with the latest code changes.

First, check if the pre-commit hook is already installed:
```bash
grep -q "caliber" .git/hooks/pre-commit 2>/dev/null && echo "hook-active" || echo "no-hook"
```

- If **hook-active**: the hook handles sync automatically — just commit normally. Tell the user: "Caliber will sync your agent configs automatically via the pre-commit hook."
- If **no-hook**: run Caliber manually before committing:
  1. Tell the user: "Caliber: Syncing agent configs with your latest changes..."
  2. Run: `caliber refresh && git add CALIBER_LEARNINGS.md AGENTS.md .agents/ 2>/dev/null`
  3. After it completes, briefly tell the user what Caliber updated. Then proceed with the commit.

**Valid `caliber refresh` options:** `--quiet` (suppress output) and `--dry-run` (preview without writing). Do not pass any other flags — options like `--auto-approve`, `--debug`, or `--force` do not exist and will cause errors.

**`caliber config`** takes no flags — it runs an interactive provider setup. Do not pass `--provider`, `--api-key`, or `--endpoint`.

If `caliber` is not found, read `.agents/skills/setup-caliber/SKILL.md` and follow its instructions to install Caliber.
<!-- /caliber:managed:pre-commit -->

<!-- caliber:managed:learnings -->
## Session Learnings

Read `CALIBER_LEARNINGS.md` for patterns and anti-patterns learned from previous sessions.
These are auto-extracted from real tool usage — treat them as project-specific rules.
<!-- /caliber:managed:learnings -->

<!-- caliber:managed:model-config -->
## Model Configuration

Recommended default: `claude-sonnet-4-6` with high effort (stronger reasoning; higher cost and latency than smaller models).
Smaller/faster models trade quality for speed and cost — pick what fits the task.
Pin your choice (`/model` in Claude Code, or `CALIBER_MODEL` when using Caliber with an API provider) so upstream default changes do not silently change behavior.

<!-- /caliber:managed:model-config -->

<!-- caliber:managed:sync -->
## Context Sync

This project uses [Caliber](https://github.com/caliber-ai-org/ai-setup) to keep AI agent configs in sync across Claude Code, Cursor, Copilot, and Codex.
Configs update automatically before each commit via `caliber refresh`.
If the pre-commit hook is not set up, read `.agents/skills/setup-caliber/SKILL.md` and follow the setup instructions.
<!-- /caliber:managed:sync -->
