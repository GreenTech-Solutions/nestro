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

Every subsystem directory (`providers/`, `utils/`, `clients/`, `commands/`, `tools/`) has an
`index.ts` barrel. Barrels re-export by name, never with `export *`:

```typescript
// src/utils/index.ts
export { logger } from './logger';
export { compareRawVersions, getUpdateType } from './versionUtils';
export type { UpdateType } from './versionUtils';
```

A barrel exports a symbol only if something outside the subsystem needs it (production code, or
a test that has no better place to get it). A symbol only its own subsystem uses is not exported
— siblings import it directly from the implementation file instead. This keeps the barrel a real
public-surface declaration, not a re-statement of every file in the directory.

### Layer order

```
tools        (isolated — imports nothing from providers/utils/clients/commands)
utils        (foundation)
clients      (above utils)
providers    (above utils and clients)
commands, extension.ts   (above everything)
```

**Production code outside a subsystem imports only that subsystem's barrel** — never one of its
implementation files — and only a subsystem below it in this order:

```typescript
// Correct — commands importing providers' and utils' barrels
import { isPackageItem, PackagesProvider } from '../providers';
import { logger } from '../utils';

// Wrong — bypasses the barrel
import { PackageItem } from '../providers/PackageItem';

// Wrong in general — utils is not allowed to import providers (wrong direction).
// One case of exactly this import is a named, justified exception — see below.
import type { AuditProjectSummary } from '../providers';
```

A module never imports its own subsystem's barrel, whether spelled `./index` or as the
directory path; it imports siblings directly (`import { X } from './Y'`).

### Exceptions

Two kinds of exception exist, both enforced by `src/test/importContract.unit.test.ts`:

1. **`clients` never imports the `utils` barrel.** `clients/*.ts` import `utils` implementation
   files directly (e.g. `../utils/logger`, `../utils/auditClient`) instead of `'../utils'`.
   Routing through the barrel would recreate a cycle: the barrel re-exports
   `packageManager.ts`, which imports `ClientManager` from `clients`. This is a standing,
   file-level exception, not a one-off.
2. **Two named back-edges**, each with a one-line reason recorded in the policy test's
   allowlist: `utils/packageManager.ts` imports the `ClientManager` value from `clients` (a
   single delegation-only module, documented and tested as part of `utils`; relocating it would
   ripple through every caller for no behavior change), and `utils/auditReportFormatter.ts`
   imports the `AuditProjectFailure`/`AuditProjectSummary` types from `providers` (type-only,
   erased at compile time; the types compose `clients`' `AuditProject` with `utils` audit
   primitives, so they can only be defined at the `providers` layer above both).

Any new cross-subsystem import that isn't an exact barrel import to a lower layer needs a new,
justified entry in that allowlist — the policy test fails closed on anything else, including a
stale allowlist entry whose import no longer exists.

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
├── registryClient.ts   → config-aware HTTPS registry metadata adapter
├── auditClient.ts      → vulnerability audit runner and parser
├── shellTask.ts        → VS Code shell task execution and exit codes
└── index.ts            → barrel re-exports
```

---

## Code Comments

A comment says **what this is**, not the story of how it got here. One line is the
default, three is the ceiling.

- **No task, audit, or issue identifiers.** `AUD-09`, `ARC-01`, `SEC-05`, ticket keys and
  PR links never appear in `src/**`. That context belongs to the commit message and the
  tracker; in code it goes stale and means nothing to a reader who cannot open them.
- **No narrative.** Benchmark tables, rejected alternatives, "before this change ..." and
  rationale essays belong in the commit message, not in the source.
- **Say what the signature cannot.** A comment restating the function name is noise —
  delete it.
- A non-obvious constant justifies its value in one clause, not a methodology write-up.
- English, present tense.
- A JSDoc block growing past three lines usually means the name is wrong or the unit does
  too much. Fix that instead of documenting around it.

```ts
// Good
/** Serializes package-project mutations by canonical project-root key. */

// Bad — task id
/** Serializes package-project mutations by canonical project-root key (`ARC-01`). */

// Bad — narrative; this belongs in the commit message
/**
 * Chosen by benchmark, not by convention: a synthetic 24-project-root fixture was
 * driven at caps 1..24 on the implementer's machine (Apple M5, 10 logical cores).
 * Throughput rose sharply through cap 4-6 and plateaued by cap 8 ...
 */
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

`conventionalcommits` preset — drives `semantic-release` version bumps and `CHANGELOG.md`:

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
| Import another subsystem's implementation file directly | Import that subsystem's barrel `index.ts` — siblings inside one subsystem import each other directly |
| `any` | Narrow with a proper type, generic, or `unknown` |
| Leaking event listeners / disposables | Always push to `context.subscriptions` |
| `async` function without try/finally when state is mutated | Reset flags in `finally` to avoid stuck loading state |
| `vscode.window.showErrorMessage(...)` directly | Use `showError()` from `src/utils/notify.ts` |
| Floating promise (unhandled async call) | Prefix with `void` or `await` |
| Mutating provider state from arbitrary places | Use `markPackage*()` / `invalidateUpdateCache()` methods, then fire `_onDidChangeTreeData` |
| Task / audit id in a code comment (`AUD-09`, `ARC-01`) | Drop it — that context lives in the commit message and the tracker |
| Multi-paragraph comment explaining rationale or benchmarks | One-line description; rationale goes in the commit message |
