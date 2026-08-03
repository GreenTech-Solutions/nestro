# Codestyle — TypeScript VS Code Extension

> Reference for contributors and AI agents. Rules here complement `CLAUDE.md`.

---

## TypeScript Conventions

### interface vs type

Use `interface` for object shapes (data contracts, state structures):

```typescript
export interface PackageEntry {
  name: string;
  version: string;
  section: DependencySection;
}
```

Use `type` for unions, intersections, and derived types:

```typescript
export type UpdateType = 'none' | 'patch' | 'minor' | 'breaking';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
```

### Enums

Use `const enum` for internal enums that don't need runtime iteration (compile-time inlining, zero bundle cost):

```typescript
const enum CacheState {
  Empty = 'empty',
  Fresh = 'fresh',
  Stale = 'stale',
}
```

Use regular `enum` only when you need `Object.values()` or runtime iteration.

### Return types

Always declare explicit return types on exported functions:

```typescript
export function getUpdateType(current: string, latest: string): UpdateType { ... }
export async function fetchAllLatestVersions(): Promise<Map<string, string>> { ... }
```

Private / module-internal functions may omit return types when they are obvious from context.

### Type predicates

Use type predicates for discriminated unions instead of casting:

```typescript
function isGroupItem(item: vscode.TreeItem): item is GroupItem {
  return item instanceof GroupItem;
}
```

---

## File Naming

| Content | Convention | Example |
|---------|-----------|---------|
| Class / Provider | PascalCase | `PackagesProvider.ts`, `PackageItem.ts` |
| Utility module | camelCase | `versionUtils.ts`, `packageManager.ts` |
| Client | PascalCase | `NpmClient.ts`, `ClientManager.ts` |
| Barrel | always `index.ts` | `src/providers/index.ts` |
| Unit test | `*.unit.test.ts` | `versionUtils.unit.test.ts` |
| Integration test | `*.test.ts` | `installUpdate.test.ts` |

---

## Module Structure & Barrels

Every directory that exports must have an `index.ts` barrel.

**Always import from the barrel, never the implementation file:**

```typescript
// Correct
import { PackageItem, GroupItem } from '../providers';
import { logger, getUpdateType } from '../utils';

// Wrong — breaks encapsulation, bypasses barrel
import { PackageItem } from '../providers/PackageItem';
import { logger } from '../utils/logger';
```

Barrels currently re-export with `export *`:

```typescript
// src/utils/index.ts
export * from './versionUtils';
export * from './logger';
export * from './notify';
```

Moving to selective named re-exports on subsystem boundaries is a planned change. Until it lands, describe the wildcard form as the present state and do not claim the selective contract is enforced.

---

## One-File-One-Function (utils)

Each util file exports one primary concern:

```
src/utils/
├── versionUtils.ts     → version comparison and classification
├── packageManager.ts   → PM detection + CLI command builders
├── packageReader.ts    → reading workspace package.json files
├── logger.ts           → Logger singleton
├── notify.ts           → showError() helper
├── ncuClient.ts        → npm-check-updates wrapper
├── registryClient.ts   → npm registry version metadata over HTTPS
├── auditClient.ts      → vulnerability audit runner and parser
├── shellTask.ts        → VS Code shell task execution and exit codes
└── index.ts            → barrel re-exports
```

---

## ESLint Rules (active)

| Rule | Level | Effect |
|------|-------|--------|
| `@typescript-eslint/no-floating-promises` | warn | All async calls must be `await`ed or prefixed with `void` |
| `require-await` | warn | No `async` function without `await` inside |
| `sort-imports` | warn | Named import members sorted alphabetically |
| `eqeqeq` | warn | Always `===`, never `==` |
| `curly` | warn | Always use braces for control flow |
| `@stylistic/semi` | warn | Semicolons required |
| `no-throw-literal` | warn | Throw `Error` instances, not literals |
| `@typescript-eslint/naming-convention` | warn | Import names in camelCase or PascalCase |

`eslint-plugin-sonarjs` recommended config is enabled on top of these, with a documented set of rules disabled in `eslint.config.mjs`. Its remaining rules — notably `sonarjs/parameterized-tests` — are errors, not warnings, and will fail a strict lint run.

Stylistic defaults: 2-space indent, single quotes, trailing semicolons.

---

## Commit Message Format

Angular preset — drives `semantic-release` version bumps and `CHANGELOG.md`:

```
<type>(<scope>): <subject>
```

| Type | Meaning | Version bump | Release notes section |
|------|---------|:---:|---|
| `feat` | New user-facing feature | minor | Features |
| `fix` | Bug fix | patch | Bug Fixes |
| `part` | Partial fix or partial feature | patch | Bug Fixes |
| `perf` | Performance improvement | patch | Performance |
| `revert` | Revert of a previous commit | patch | Reverts |
| `refactor` | Code restructuring, no behavior change | patch | Maintenance |
| `refactoring` | Code restructuring, no behavior change | patch | Maintenance |
| `service` | Service / infrastructure change | patch | Maintenance |
| `style` | Visual / UI-only change | patch | Maintenance |
| `chore` | Tooling, deps, config | patch | Maintenance |
| `spark` | Small self-contained change | patch | Small changes |
| `docs` | Documentation only | — | — |
| `test` | Tests only | — | — |
| `ci` | CI / workflow only | — | — |
| `ghost` | Internal change, no release | — | — |

This table is the single source of truth for commit types; `.releaserc.json` must stay aligned with it. Every listed type is active and may be used in new commits. Types with no bump produce no release and no changelog entry.

Scope is the feature area (`toolbar`, `audit`, `picker`, `provider`, `deps`, etc.).

Examples:

```
feat(toolbar): add Pin All Versions command to overflow menu
fix(audit): show correct severity badge for moderate vulnerabilities
refactor(provider): extract buildStatusItems into helper
chore(deps): bump npm-check-updates to 22.2.3
ghost(test): add unit tests for compareRawVersions
```

---

## Anti-Patterns

| Anti-pattern | Correct approach |
|---|---|
| `console.log(...)` | Use `logger` singleton from `src/utils/logger.ts` |
| Import from implementation file directly | Import from barrel `index.ts` |
| `any` | Narrow with a proper type, generic, or `unknown` |
| Leaking event listeners / disposables | Always push to `context.subscriptions` |
| `async` function without try/finally when state is mutated | Reset flags in `finally` to avoid stuck loading state |
| `vscode.window.showErrorMessage(...)` directly | Use `showError()` from `src/utils/notify.ts` |
| Floating promise (unhandled async call) | Prefix with `void` or `await` |
| Mutating provider state from arbitrary places | Use `markPackage*()` / `invalidateUpdateCache()` methods, then fire `_onDidChangeTreeData` |
