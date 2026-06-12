---
paths:
  - src/**
---

# Extension Patterns

## Command Registration
Declare in `package.json` `contributes.commands` AND register in `activate()`:

```typescript
// package.json contributes.commands: { "command": "nestro.myCmd", "title": "My Command" }
const disposable = vscode.commands.registerCommand('nestro.myCmd', () => {
    vscode.window.showInformationMessage('Hello');
});
context.subscriptions.push(disposable);
```

## Disposable Rule
Push all resources to `context.subscriptions`:
- `vscode.commands.registerCommand(...)`
- `vscode.window.registerTreeDataProvider(...)`
- `vscode.workspace.onDidChangeTextDocument(...)`

## TypeScript
- `import * as vscode from 'vscode'` — namespace import, not default
- No `any` — strict mode enforced via `tsconfig.json`
- ESLint: `eqeqeq`, `curly`, `semi` warnings active (`eslint.config.mjs`)
- `interface` for object shapes; `type` for unions and derived types
- `const enum` for internal enums that don't need runtime iteration
- Explicit return types on all exported functions
- Floating promises must be `await`ed or prefixed with `void` (ESLint `no-floating-promises`)

## Imports & Barrels
- Always import from barrel `index.ts`, never from implementation files directly
- `import { Foo } from '../providers'` — not `from '../providers/Foo'`
- Barrel files use selective re-exports (not `export *`) for an explicit public surface

## Providers
- Tree item classes live in `src/providers/` (e.g., `PackageItem.ts`, `GroupItem.ts`)
- Export via `src/providers/index.ts` barrel
- Logger: use `logger` singleton from `src/utils/logger.ts` — do not use `console.log`
- Errors: use `showError()` from `src/utils/notify.ts` — do not call `vscode.window.showErrorMessage` directly
- State mutations go through `markPackage*()` / `invalidateUpdateCache()` on `PackagesProvider`, then fire `_onDidChangeTreeData`
