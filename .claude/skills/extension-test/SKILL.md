---
name: extension-test
description: Adds a Mocha test in `src/test/extension.test.ts` using the `suite()` / `test()` + `assert.strictEqual` pattern. Compiles to `out/test/**/*.test.js` and runs in VS Code Electron via `pnpm run test`. Use when user says 'add test', 'write test', 'test this feature', or 'assert X'. Do NOT use for Jest, Node-only tests, or tests outside the VS Code Electron environment.
paths:
  - src/test/**/*.test.ts
---
# Extension Test

## Critical

- There is **no single-file isolation** — `pnpm run test` always runs every file matching `out/test/**/*.test.js`. Write tests that are side-effect-free and order-independent.
- Tests run inside a real VS Code Electron instance. The full `vscode` API is available; Node-only test runners (Jest, plain Mocha CLI) are **not** used here.
- Command IDs referenced in tests must match entries in `package.json` `contributes.commands` exactly (format: `nestro.<camelCase>`).
- `pretest` script runs `pnpm run compile && pnpm run lint` before the Electron instance launches. A TypeScript or lint error will abort the test run.

## Instructions

### 1. Open the test file

All tests live in `src/test/extension.test.ts`. There is no separate file per feature — add new `suite()` blocks to this single file.

```
src/test/extension.test.ts   ← edit this
```

Verify the file exists before proceeding.

### 2. Add required imports (if not already present)

The file must start with these two imports — no others are needed for most tests:

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
```

To test internal extension code, uncomment or add:

```typescript
import * as myExtension from '../../extension';
```

The path `../../extension` resolves correctly after compile because the test output is `out/test/extension.test.js` and the extension output is `out/extension.js`.

Verify no `import` uses a default import — always use the `import * as` namespace form.

### 3. Wrap tests in a `suite()` block

Use `suite()` to group related tests. Each suite gets a descriptive string label:

```typescript
suite('PackageTree Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('returns empty array when no workspace is open', () => {
        const result: string[] = [];
        assert.strictEqual(result.length, 0);
    });
});
```

- `suite()` is the outer grouping (like `describe()`).
- `test()` is each individual case.
- `vscode.window.showInformationMessage(...)` inside the suite body (not inside a `test()`) prints a banner in the Electron output — include it for discoverability.

Verify: every assertion uses `assert.strictEqual(actual, expected)` — not `assert.equal`, `===`, or `expect()`.

### 4. Testing VS Code commands

To assert that a registered command executes without throwing:

```typescript
test('helloWorld command executes without error', async () => {
    await vscode.commands.executeCommand('nestro.helloWorld');
    // If executeCommand rejects, the test fails automatically
});
```

For commands that return a value, capture and assert:

```typescript
test('command returns expected value', async () => {
    const result = await vscode.commands.executeCommand<string>('nestro.someCommand');
    assert.strictEqual(result, 'expected');
});
```

Verify the command ID exists in `package.json` `contributes.commands` before writing the test.

### 5. Compile and run

```bash
pnpm run test
```

This runs `pretest` (compile + lint) then launches the VS Code Electron test runner. Watch the terminal for:
- TypeScript errors → fix in `src/`, rerun
- Lint errors → fix in `src/`, rerun
- `X passing` / `X failing` — Mocha results

There is no watch mode for tests. Rerun `pnpm run test` after every edit.

## Examples

**User says:** "Add a test that verifies the `nestro.helloWorld` command registers and runs without throwing."

**Actions taken:**
1. Open `src/test/extension.test.ts`.
2. Confirm `import * as vscode from 'vscode'` and `import * as assert from 'assert'` are present.
3. Add a new `suite()` block:

```typescript
suite('HelloWorld Command Suite', () => {
    vscode.window.showInformationMessage('Start HelloWorld tests.');

    test('helloWorld command executes without error', async () => {
        await vscode.commands.executeCommand('nestro.helloWorld');
        assert.strictEqual(true, true); // Reaching here means no exception was thrown
    });
});
```

4. Run `pnpm run test` and confirm `1 passing`.

**Result:** `src/test/extension.test.ts` contains the new suite; `out/test/extension.test.js` is produced by compile.

## Common Issues

**`Error: command 'nestro.X' not found`**
The command ID is not registered. Check:
1. The ID appears in `package.json` under `contributes.commands`.
2. `vscode.commands.registerCommand('nestro.X', ...)` is called inside `activate()` in `src/extension.ts`.
3. The extension is active when the test runs — call `await vscode.commands.executeCommand('nestro.X')` which triggers activation if `activationEvents: []`.

**`TypeError: Cannot read properties of undefined`** when importing extension module
The import path `../../extension` must resolve to `out/extension.js`. Confirm `tsconfig.json` has `"outDir": "out"` and `"rootDir": "src"`. Run `pnpm run compile` and verify `out/extension.js` exists.

**`pnpm run test` exits with lint errors before tests run**
The `pretest` script runs ESLint. Common causes:
- Missing semicolons (`semi` rule)
- Using `==` instead of `===` (`eqeqeq` rule)
- `if` without braces (`curly` rule)
Fix in `src/`, then rerun.

**Tests from a different suite run and fail unexpectedly**
All `out/test/**/*.test.js` files are loaded by `.vscode-test.mjs`. A broken test in any file blocks the whole suite. Run `pnpm run compile` first and check the compile output for errors across all test files.

**`pnpm run test` hangs and never shows results**
The Electron instance failed to launch. Check that no other VS Code Electron test process is already running (`ps aux | grep Electron`). Kill stale processes and rerun.