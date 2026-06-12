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

Barrel uses selective re-exports (not `export *`) to keep the public surface explicit:

```typescript
// src/utils/index.ts
export { getUpdateType, isVersionOutdated } from './versionUtils';
export { logger } from './logger';
export { showError } from './notify';
```

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
└── index.ts            → selective re-exports
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

Stylistic defaults: 2-space indent, single quotes, trailing semicolons.

---

## Commit Message Format

Angular preset — drives `semantic-release` version bumps and `CHANGELOG.md`:

```
<type>(<scope>): <subject>
```

| Type | Meaning | Version bump |
|------|---------|:---:|
| `feat` | New user-facing feature | minor |
| `fix` | Bug fix | patch |
| `part` | Partial fix or partial feature | patch |
| `refactor` | Code restructuring, no behavior change | patch |
| `style` | Visual / UI-only change | patch |
| `chore` | Tooling, deps, config, CI | patch |
| `ghost` | Internal change, no release | — |

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
