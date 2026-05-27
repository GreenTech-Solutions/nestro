---
name: vscode-tree-provider
description: Implements vscode.TreeDataProvider<T> for sidebar tree views in src/. Registers the provider via vscode.window.registerTreeDataProvider and adds contributes.views + contributes.viewsContainers to package.json. Use when user says 'add tree view', 'sidebar panel', 'package list', 'TreeDataProvider', or implements the core package management UI. Do NOT use for webview panels or output channels.
paths:
  - src/**/*.ts
  - package.json
---
# VS Code Tree Provider

## Critical

- **Never** use `any` — TypeScript strict mode is enforced. All methods must have explicit return types.
- **Never** leak disposables. Always `context.subscriptions.push(...)` every registration.
- Command IDs in `package.json` `contributes.commands` must exactly match the string passed to `vscode.commands.registerCommand`. View IDs in `contributes.views` must exactly match the string passed to `registerTreeDataProvider`.
- Import style is always `import * as vscode from 'vscode'` — no default or named imports from `'vscode'`.
- After any edit to `package.json`, run `pnpm run compile` to catch JSON parse errors before testing.

## Instructions

### Step 1 — Create the provider file

Create `src/<Name>Provider.ts` (e.g. `src/PackageProvider.ts`). The file must contain:
1. A `TreeItem` subclass that carries your domain data.
2. A `Provider` class that `implements vscode.TreeDataProvider<YourItem>`.

```typescript
import * as vscode from 'vscode';

export class PackageItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);
    this.tooltip = this.label;
    this.iconPath = new vscode.ThemeIcon('package');
  }
}

export class PackageProvider implements vscode.TreeDataProvider<PackageItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<PackageItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PackageItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PackageItem): vscode.ProviderResult<PackageItem[]> {
    if (element) {
      return [];
    }
    return this.getRootItems();
  }

  private getRootItems(): PackageItem[] {
    // TODO: replace with real data source
    return [
      new PackageItem('react', vscode.TreeItemCollapsibleState.None),
    ];
  }
}
```

Verify: `pnpm run compile` reports zero errors before proceeding.

### Step 2 — Register the provider in `src/extension.ts`

In `activate(context: vscode.ExtensionContext)`, import your provider and register it. Push the return value of `registerTreeDataProvider` into `context.subscriptions`.

```typescript
import * as vscode from 'vscode';
import { PackageProvider } from './PackageProvider';

export function activate(context: vscode.ExtensionContext): void {
  const packageProvider = new PackageProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('nestro.packageList', packageProvider),
  );

  // Optional: expose a refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('nestro.refreshPackages', () => {
      packageProvider.refresh();
    }),
  );
}

export function deactivate(): void {}
```

Verify: the view ID string `'nestro.packageList'` matches exactly what you will add to `package.json` in Step 3.

### Step 3 — Declare the view in `package.json`

Add `viewsContainers` (the sidebar icon) and `views` (the panel inside it) under `contributes`. If a container for `nestro` already exists, append only the view entry.

```jsonc
"contributes": {
  "viewsContainers": {
    "activitybar": [
      {
        "id": "nestro-sidebar",
        "title": "Nestro",
        "icon": "$(package)"
      }
    ]
  },
  "views": {
    "nestro-sidebar": [
      {
        "id": "nestro.packageList",
        "name": "Packages"
      }
    ]
  },
  "commands": [
    { "command": "nestro.helloWorld", "title": "Hello World" },
    { "command": "nestro.refreshPackages", "title": "Refresh Packages", "icon": "$(refresh)" }
  ]
}
```

Verify: `"id": "nestro.packageList"` in `views` matches the first argument of `registerTreeDataProvider` in Step 2.

### Step 4 — Add a toolbar button (optional)

To wire a command button into the view's title bar, add a `menus` entry:

```jsonc
"menus": {
  "view/title": [
    {
      "command": "nestro.refreshPackages",
      "when": "view == nestro.packageList",
      "group": "navigation"
    }
  ]
}
```

Verify: the `when` clause view ID matches exactly.

### Step 5 — Compile and test manually

```bash
pnpm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host. The Nestro icon should appear in the Activity Bar. Click it — your tree view must render. Open the Output panel and check for activation errors.

Verify before shipping: tree renders without errors, refresh command fires without throwing, `pnpm run lint` is clean.

## Examples

**User says:** "Add a sidebar panel that lists npm packages"

**Actions taken:**
1. Create `src/PackageProvider.ts` with `PackageItem extends vscode.TreeItem` and `PackageProvider implements vscode.TreeDataProvider<PackageItem>`.
2. In `src/extension.ts`, import `PackageProvider`, call `vscode.window.registerTreeDataProvider('nestro.packageList', packageProvider)`, push the return value into `context.subscriptions`.
3. In `package.json`, add `viewsContainers.activitybar` entry with `id: "nestro-sidebar"` and `views["nestro-sidebar"]` entry with `id: "nestro.packageList"`, `name: "Packages"`.
4. Run `pnpm run compile`, press F5, verify the panel appears and renders items.

**Result:** A sidebar panel titled "Packages" appears in the VS Code Activity Bar, showing tree items from `PackageProvider.getChildren()`.

## Common Issues

**Tree view does not appear in Activity Bar after F5**
- Check that `"id": "nestro.packageList"` inside `views["nestro-sidebar"]` in `package.json` is spelled exactly as passed to `registerTreeDataProvider`. Any mismatch silently hides the view.
- Verify `activationEvents` in `package.json` is `[]` (activates on any command) or explicitly lists `"onView:nestro.packageList"`.

**Error: `Property 'onDidChangeTreeData' has no initializer and is not definitely assigned`**
- Declare with `readonly` and initialize inline: `readonly onDidChangeTreeData = this._onDidChangeTreeData.event;` on the same line as `_onDidChangeTreeData`.

**Error: `Type 'void' is not assignable to type 'ProviderResult<PackageItem[]>'`**
- `getChildren` must return `PackageItem[]`, `Promise<PackageItem[]>`, or `undefined`/`null`. Never return `void`. Return `[]` for leaf nodes.

**Refresh does not re-render the tree**
- Ensure `refresh()` calls `this._onDidChangeTreeData.fire()` with no argument (or `undefined`) to signal a full refresh, not just a single node.

**`pnpm run lint` fails with `no-throw-literal` or `eqeqeq`**
- Use `===` for comparisons. Never `throw 'string'`; always `throw new Error('message')`.

**Tree view appears but shows "No data" / empty**
- `getChildren(element?: PackageItem)` is called with `element === undefined` for root items. Make sure the root path (`if (!element)`) returns a non-empty array.