---
name: package-contribution
description: Adds a contribution point (commands, views/viewsContainers, configuration, menus) to package.json `contributes` with correct VS Code schema and matching runtime wiring in src/extension.ts. Use when the user says 'add setting', 'add menu item', 'contribute to package.json', 'expose command', 'add sidebar view', or modifies the extension manifest. Do NOT use for runtime behavior changes that don't touch package.json, or for implementing command logic beyond the stub registration.
paths:
  - package.json
  - src/extension.ts
---
# package-contribution

Adds contribution points to `package.json` `contributes` and wires the matching runtime registration in `src/extension.ts`.

## Critical

- Command IDs **must** follow `nestro.<camelCase>` — any mismatch between `package.json` and `registerCommand` silently breaks the command palette.
- Every contribution that has a runtime counterpart (commands, tree views) **must** be registered in `activate()` and the disposable pushed to `context.subscriptions`. Leaking a disposable is a bug.
- `engines.vscode` is `^1.120.0` — do not use any VS Code API introduced after that version without bumping the engine field.
- Update `CHANGELOG.md` under `## [Unreleased]` for every user-facing addition (Keep a Changelog format).
- Run `pnpm run compile && pnpm run lint` after every edit; the extension will not load if TypeScript errors exist.

## Instructions

### Step 1 — Decide the contribution type

Identify which `contributes` key is needed:

| User intent | `contributes` key(s) |
|---|---|
| Expose a command to palette | `commands` |
| Add sidebar panel | `viewsContainers` + `views` |
| Add setting | `configuration` |
| Add right-click / inline button | `menus` (+ `commands` for the action) |

Verify the key you need is not already declared in `package.json` `contributes` before adding a duplicate.

### Step 2 — Edit `package.json` `contributes`

Open `package.json`. All additions go inside the existing `"contributes": { … }` object.

**Command:**
```jsonc
// contributes.commands array
{
  "command": "nestro.<camelCaseId>",
  "title": "Human Readable Title",
  "category": "Nestro"          // optional but recommended
}
```

**Sidebar view** (requires both keys):
```jsonc
// contributes.viewsContainers.activitybar array
{
  "id": "nestro-sidebar",
  "title": "Nestro",
  "icon": "media/icon.svg"
}

// contributes.views object — key matches the container id above
"nestro-sidebar": [
  {
    "id": "nestro.<camelCaseViewId>",
    "name": "View Label"
  }
]
```

**Configuration:**
```jsonc
// contributes.configuration object
{
  "title": "Nestro",
  "properties": {
    "nestro.<camelCaseSetting>": {
      "type": "string",           // string | boolean | number | array
      "default": "pnpm",
      "enum": ["npm", "pnpm", "yarn"],  // omit if not an enum
      "description": "..."
    }
  }
}
```

**Menu item** (the `command` value must already exist in `contributes.commands`):
```jsonc
// contributes.menus object
"view/item/context": [
  {
    "command": "nestro.<camelCaseId>",
    "when": "viewItem == packageItem",
    "group": "inline"           // or "navigation", "1_actions", etc.
  }
]
```

Verify: `pnpm run compile` must complete without errors before Step 3.

### Step 3 — Wire runtime registration in `src/extension.ts`

All wiring goes inside `activate(context: vscode.ExtensionContext)`.

**Command registration** (mirrors the existing `nestro.helloWorld` pattern):
```typescript
const disposable = vscode.commands.registerCommand('nestro.<camelCaseId>', () => {
  // implementation
});
context.subscriptions.push(disposable);
```

**Tree view / sidebar** (when a `views` entry was added in Step 2):
```typescript
const provider = new MyTreeDataProvider();
const treeView = vscode.window.createTreeView('nestro.<camelCaseViewId>', {
  treeDataProvider: provider,
});
context.subscriptions.push(treeView);
```

**Configuration read** (no registration needed — read on demand):
```typescript
const cfg = vscode.workspace.getConfiguration('nestro');
const value = cfg.get<string>('<camelCaseSetting>', 'pnpm');
```

Verify: `pnpm run lint` passes with no new warnings before Step 4.

### Step 4 — Update `CHANGELOG.md`

Add one bullet under `## [Unreleased]`:
```markdown
- Added `nestro.<camelCaseId>` command / `nestro.<camelCaseSetting>` setting / … 
```

### Step 5 — Validate end-to-end

```bash
pnpm run compile   # must exit 0
pnpm run lint      # must exit 0
```

For manual smoke-test: press **F5** in VS Code → Extension Development Host → open Command Palette (`Cmd+Shift+P`) → confirm the new command appears with its declared title.

## Examples

### Adding a command + inline menu button

**User says:** "Add an 'Update Package' command that appears as an inline button on each package item in the tree view."

**`package.json` changes:**
```jsonc
"contributes": {
  "commands": [
    { "command": "nestro.helloWorld", "title": "Hello World" },
    {
      "command": "nestro.updatePackage",
      "title": "Update Package",
      "category": "Nestro",
      "icon": "$(arrow-up)"
    }
  ],
  "menus": {
    "view/item/context": [
      {
        "command": "nestro.updatePackage",
        "when": "viewItem == packageItem",
        "group": "inline"
      }
    ]
  }
}
```

**`src/extension.ts` addition inside `activate()`:**
```typescript
const updateCmd = vscode.commands.registerCommand('nestro.updatePackage', (item: PackageItem) => {
  vscode.window.showInformationMessage(`Updating ${item.label}…`);
});
context.subscriptions.push(updateCmd);
```

**Result:** command appears in palette as "Nestro: Update Package" and as an inline icon on package tree items.

## Common Issues

**"command 'nestro.X' not found" at runtime**
The ID in `package.json` `contributes.commands` does not match the first argument of `registerCommand`. They must be byte-for-byte identical including case. Check both files side-by-side.

**Command appears in palette but does nothing / throws on activation**
The `registerCommand` call is outside `activate()` or the disposable was not pushed to `context.subscriptions`. Verify the call is inside `activate` and ends with `context.subscriptions.push(disposable)`.

**Sidebar view container shows but is empty**
The `id` in `contributes.views["nestro-sidebar"]` does not match the first argument of `createTreeView`. Or `treeDataProvider` was not provided. Check both values match exactly.

**`pnpm run compile` fails with `Module '"vscode"' has no exported member 'X'`**
The API used was introduced after VS Code `1.120.0`. Either use an older API or bump `engines.vscode` in `package.json` (and update the README minimum version requirement accordingly).

**ESLint `semi` or `eqeqeq` warning after adding a new file**
The linter enforces semicolons and `===`. Fix before committing — `pnpm run test` runs lint as a pre-step and will fail the test run.