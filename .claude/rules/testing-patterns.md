---
paths:
  - src/test/**
---

# Testing Patterns

## Unit Tests (Vitest — no Electron)
- Files: `src/**/*.unit.test.ts` — run with `pnpm run test:unit`
- Runner: Vitest, no VS Code Extension Host; `vscode` aliased to `src/test/__mocks__/vscode.ts` via `vitest.config.ts`
- Excluded from the Extension Host compile (`tsconfig.test.json`)
- `pnpm run test:unit:coverage` enforces `perFile: true` thresholds in `vitest.config.ts`: a global statements/branches/functions/lines floor checked independently on every included file, plus per-file floors for specific files/globs that can be stricter than the global one

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature', () => {
    it('does something', () => {
        expect(actual).toBe(expected);
    });
});
```

## Extension Host Tests (VS Code Electron)
- Files: non-unit `src/test/*.test.ts`, compiled by `pnpm run test:compile` (`tsconfig.test.json`) into `out/test/**/*.test.js`
- Runner: `@vscode/test-cli` + `@vscode/test-electron`, Mocha's TDD interface (`suite`/`test`)
- Two channels, each with its own isolated `.vscode-test/<label>/` cache/extensions/user-data dirs:
  - `pnpm run test:minimum` — VS Code `1.125.0`, the minimum supported version
  - `pnpm run test:stable` — the stable VS Code channel
  - `pnpm run test` runs both; never run `test:minimum` and `test:stable` concurrently against the same checkout — each resets its channel directories on load
- No single-file isolation — the `.vscode-test.mjs` glob (`out/test/**/*.test.js`) runs every compiled test
- Fixtures: `src/test/fixtures/` builds isolated temporary single- and multi-root workspaces; the repository itself is never opened as the test workspace

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Feature Test Suite', () => {
    test('does something', () => {
        assert.strictEqual(actual, expected);
    });
});
```

## Packaged Smoke Test
- `pnpm run test:packaged` compiles, then runs `out/test/packagedSmokeCli.js` against a built VSIX (`--artifact-dir <dir> --expected-sha <sha> --channel <minimum|stable>`)

## Policy Tests
Plain Vitest unit tests that assert repository-wide invariants rather than one module's behavior:
- `trackedFileHygiene.unit.test.ts` — forbids tracker identifiers (the `AUD`/`ARC`/`SEC`/`SUP`/`UX`/`DOC`/`CI` prefixes followed by a number) in shipped files except the rule-definition documents (`CODESTYLE.md`, `AGENTS.md`, `CLAUDE.md`). Separately, it forbids local bookkeeping directory path references in shipped Markdown, includes `CODESTYLE.md` in that scan, and ignores lines containing URLs; source tests may name the excluded path because the path check is Markdown-only.
- `importContract.unit.test.ts` — enforces the barrel/layer-order import contract from `CODESTYLE.md` → Module Structure & Barrels
- Manifest tests (`rowActionsManifest`, `toolbarActionsManifest`, `configurationManifest`, `pinningManifest`) assert `package.json` contributions match the code that implements them

## Validation Gates
- `pnpm run lint` — non-mutating ESLint gate; `pnpm run lint:fix` applies fixes and is never run automatically
- `pnpm run typecheck` — `tsc --noEmit`
