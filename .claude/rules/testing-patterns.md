---
paths:
  - src/test/**
---

# Testing Patterns

## Integration Tests (VS Code Electron)
- Files: `src/test/extension.test.ts` → `out/test/**/*.test.js`
- Runner: `@vscode/test-cli` + `@vscode/test-electron` — real Electron instance
- No single-file isolation — `.vscode-test.mjs` glob runs all via `pnpm run test`
- Structure: `suite('Name', () => { test('name', () => { ... }); })`
- Assertions: `assert.strictEqual(actual, expected)` from Node `assert`

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Feature Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('does something', () => {
        assert.strictEqual(actual, expected);
    });
});
```

## Unit Tests (Vitest — no Electron)
- Files: `src/**/*.unit.test.ts` — run with `pnpm run test:unit`
- Runner: Vitest — no VS Code Electron instance needed
- `vscode` aliased to `src/test/__mocks__/vscode.ts` via `vitest.config.ts`
- Compiled via `tsconfig.test.json` (excludes unit test files from vscode-test compile)

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature', () => {
    it('does something', () => {
        expect(actual).toBe(expected);
    });
});
```
