# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project
**Nestro** — VS Code extension (`src/extension.ts`) managing npm/pnpm/yarn/bun packages from the sidebar with update status and version switching. Built on the VS Code Extension API (`@types/vscode ^1.120.0`). Update detection uses `npm-check-updates` (dynamically imported in `src/utils/ncuClient.ts`).

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
3. `checkUpdates()` calls `fetchAllLatestVersions()` (ncuClient → `npm-check-updates`) → enriches each entry with `latest` + `updateType`.
4. `getChildren()` delegates to `buildTree()` (`src/providers/treeBuilder.ts`) which returns `[FilterBarItem, ...GroupItem[]]` — groups split into Dependencies / Dev Dependencies.
5. Commands mutate provider state via `markPackageUpdating()` / `markPackageUpdated()` / `resetUpdateData()`, then fire `_onDidChangeTreeData`.

### Key patterns

**Write suppression** — When a command writes to `package.json` (e.g. updating a version), it calls `provider.withWriteSuppressed(fn)`. The file watcher checks `provider.suppressingWrites` and skips the debounced reload to prevent a feedback loop.

**Package manager detection** — `detectPackageManager()` in `src/utils/packageManager.ts` reads `packageManager` field from `package.json` first, then falls back to lockfile detection (pnpm-lock.yaml → yarn.lock → bun.lock → package-lock.json), then defaults to `npm`.

**Deferred install mode** — When `nestro.deferInstallAfterUpdate` is enabled, commands write version changes directly to `package.json` (via `updateWorkspaceDependencyVersions`) without running a package manager install. The user then runs `nestro.runInstall` separately.

**Context variables** — `emitTreeChanged()` sets two VS Code context keys used by `when` clauses in `package.json` menus:
- `nestro.canUpdateVisiblePackages` — true when filtered list has outdated packages (controls "Update All" button)
- `nestro.noWorkspace` — true when no packages found (shows welcome content)

`PackageItem.contextValue` is set to `"outdated"` when a package has updates; used by `viewItem == outdated` in `view/item/context` menu to show the inline update button.

### Providers (`src/providers/`)
- `PackagesProvider.ts` — `TreeDataProvider` + `Disposable`; owns `allEntries` state and all async operations
- `FilterManager.ts` — manages active `FilterType` (`all` | `hasUpdates` | `patch` | `minor` | `breaking`), fires `onDidChange`, provides QuickPick UI
- `treeBuilder.ts` — pure functions `buildTree()`, `getFilteredEntries()`, `getFilterCounts()`; no VS Code state
- `PackageItem.ts`, `GroupItem.ts`, `FilterBarItem.ts`, `LoadingItem.ts`, `MessageItem.ts` — tree item classes

### Commands (`src/commands/`)
- `installUpdate.ts` — `installUpdateCommand`, `runInstallCommand`, `updateAllVisibleCommand`; all run package manager via VS Code shell tasks (`vscode.tasks.executeTask`) and listen to `onDidEndTaskProcess` for exit code
- `helloWorld.ts` — minimal stub command

### Utils (`src/utils/`)
- `ncuClient.ts` — thin wrapper around `npm-check-updates` (dynamic `import('npm-check-updates')` to avoid bundling issues); returns `Map<name, latestVersion>`
- `packageReader.ts` — reads workspace `package.json` dependencies
- `packageManager.ts` — detects package manager, builds install/update CLI commands
- `versionUtils.ts` — `getUpdateType()` classifies semver diff as `patch` | `minor` | `breaking` | `none`
- `logger.ts` — `Logger` singleton writing to VS Code output channel; use instead of `console.log`
- `notify.ts` — `showError()` helper

### Manifest (`package.json`)
- Command IDs must match exactly between `contributes.commands` and `vscode.commands.registerCommand`
- `activationEvents: []` — activates on any command invocation
- `main: ./out/extension.cjs` — must stay in sync with tsdown output extension

### Build
`tsdown` bundles `src/extension.ts` → `out/extension.cjs`; `vscode` is never bundled (external). Integration tests compiled separately via `tsc -p tsconfig.test.json` → `out/test/`. `tsconfig.json` uses `"module": "esnext"` + `"moduleResolution": "bundler"` for tsdown; `tsconfig.test.json` uses `"module": "Node16"`.

## Conventions
- Command IDs: `nestro.<camelCase>` — declare in `package.json` `contributes.commands` **and** register in `activate()`
- TypeScript: strict mode — no `any`, explicit return types on exported functions
- Disposables: always `context.subscriptions.push(...)` — never leak event listeners or providers
- Imports: `import * as vscode from 'vscode'` (namespace import, not default)
- `CHANGELOG.md` updated for every user-facing change following Keep a Changelog format

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
  2. Run: `caliber refresh && git add CALIBER_LEARNINGS.md CLAUDE.md .claude/ AGENTS.md .agents/ 2>/dev/null`
  3. After it completes, briefly tell the user what Caliber updated. Then proceed with the commit.

**Valid `caliber refresh` options:** `--quiet` (suppress output) and `--dry-run` (preview without writing). Do not pass any other flags — options like `--auto-approve`, `--debug`, or `--force` do not exist and will cause errors.

**`caliber config`** takes no flags — it runs an interactive provider setup. Do not pass `--provider`, `--api-key`, or `--endpoint`.

If `caliber` is not found, tell the user: "This project uses Caliber for agent config sync. Run /setup-caliber to get set up."
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
If the pre-commit hook is not set up, run `/setup-caliber` to configure everything automatically.
<!-- /caliber:managed:sync -->
