# AGENTS.md

## Project
**Nestro** — VS Code extension (`src/extension.ts`) managing npm/pnpm/yarn packages from the sidebar with update status and version switching. Built on the VS Code Extension API (`@types/vscode ^1.120.0`).

## Commands
```bash
pnpm run build        # tsdown → out/extension.cjs
pnpm run dev          # tsdown --watch
pnpm run lint         # eslint src/ via eslint.config.mjs
pnpm run typecheck    # tsc --noEmit (type-check without emit)
pnpm run test         # pretest (tsc + lint) + vscode-test (Electron instance)
pnpm run test:unit    # vitest run — runs *.unit.test.ts without VS Code
```

## Key Files
- `src/extension.ts` — entry: `activate(context)` + `deactivate()`
- `package.json` — manifest: `contributes.commands`, `activationEvents`, `main: ./out/extension.cjs`, `engines.vscode ^1.120.0`
- `out/extension.cjs` — compiled output VS Code loads
- `tsdown.config.mts` — bundler config; `tsconfig.json` — TypeScript config; `tsconfig.test.json` — test compilation
- `src/test/extension.test.ts` — Mocha tests: `suite()` / `test()` + `assert.strictEqual`
- `src/test/*.unit.test.ts` — Vitest unit tests (no Electron)
- `.vscode-test.mjs` — integration test config; `vitest.config.ts` — unit test config
- `src/providers/` — `PackagesProvider.ts`, `PackageItem.ts`, `GroupItem.ts`, `FilterBarItem.ts`, `LoadingItem.ts`, `index.ts`
- `src/utils/logger.ts` — Logger singleton; `src/utils/versionUtils.ts` — version utilities
- `eslint.config.mjs` — typescript-eslint, naming-convention, `eqeqeq`, `curly`, `semi`
- `.vscode/launch.json`, `.vscode/tasks.json`, `.vscode/settings.json` — VS Code workspace config

## Architecture

### Lifecycle
`src/extension.ts` exports:
- `activate(context: vscode.ExtensionContext)` — registers commands, providers, disposables on activation
- `deactivate()` — cleanup on shutdown
- All disposables → `context.subscriptions.push(disposable)`

### Manifest (`package.json`)
- `contributes.commands` IDs must exactly match `vscode.commands.registerCommand` IDs
- `activationEvents: []` — activates on any command
- `main: ./out/extension.cjs` — VS Code loads compiled output

### Build
`tsdown` bundles `src/extension.ts` → `out/extension.cjs` (config: `tsdown.config.mts`). `vscode` excluded from bundle. Integration tests compiled separately via `tsc -p tsconfig.test.json`.

### Providers (`src/providers/`)
- `PackagesProvider.ts` — `TreeDataProvider` implementation
- `PackageItem.ts`, `GroupItem.ts`, `FilterBarItem.ts`, `LoadingItem.ts` — tree item classes
- `index.ts` — barrel exports

### Testing
Two test modes:
- **Integration** (`pnpm run test`): Mocha + `@vscode/test-cli` + `@vscode/test-electron` — real VS Code Electron. Config: `.vscode-test.mjs`. Files: `src/test/extension.test.ts`.
- **Unit** (`pnpm run test:unit`): Vitest — no Electron. `vscode` mocked via `src/test/__mocks__/vscode.ts`. Config: `vitest.config.ts`. Files: `src/test/*.unit.test.ts`.

## Conventions
- Command IDs: `nestro.<camelCase>` in `package.json` `contributes.commands` **and** `registerCommand`
- TypeScript: strict mode — no `any`, explicit return types
- Disposables: `context.subscriptions.push(...)` — no leaks
- Imports: `import * as vscode from 'vscode'` (namespace import)
- ESLint: `eqeqeq`, `curly`, `no-throw-literal`, `semi` warnings enforced
- `CHANGELOG.md` updated for every user-facing change

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
