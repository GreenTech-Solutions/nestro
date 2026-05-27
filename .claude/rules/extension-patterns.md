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

## Providers
- Tree item classes live in `src/providers/` (e.g., `PackageItem.ts`, `GroupItem.ts`)
- Export via `src/providers/index.ts` barrel
- Logger: use `logger` singleton from `src/utils/logger.ts` — do not use `console.log`
