# README screenshots

How the four images in this directory were captured, so they can be reproduced whenever the
sidebar changes. Only `*.png` files here ship in the VSIX; this document stays in the repository.

## Environment

- VS Code 1.138.0 as an Extension Development Host started through `@vscode/test-electron`,
  loading the extension from a local build of `out/extension.cjs`; macOS on a 2x (Retina) display.
- Theme **Dark Modern**. Settings that keep the window quiet: `workbench.startupEditor: "none"`,
  `workbench.editor.showTabs: "none"`, `workbench.secondarySideBar.defaultVisibility: "hidden"`,
  `chat.commandCenter.enabled: false`, `window.commandCenter: false`,
  `workbench.tips.enabled: false`, `security.workspace.trust.enabled: false`,
  `telemetry.telemetryLevel: "off"`, `window.zoomLevel: 0`.
- Window 1440×900 points. At 1x the Activity Bar is 48 px and the sidebar 300 px wide.
- Nestro settings at their defaults (`updateTarget: "latest"`, `minimumReleaseAgeDays: 7`,
  `includePreReleases: false`, filter `all`, no search query).

## Fixture workspace

A throwaway folder named `demo-app` containing only public npm packages and no private paths,
registries, or credentials (dependency sections only; the real file also has a `description` and a
`scripts.start` entry):

```json
{
  "name": "demo-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "axios": "^0.21.1",
    "dayjs": "^1.11.0",
    "express": "^4.17.1",
    "lodash": "4.17.15",
    "react": "^17.0.2",
    "react-dom": "^17.0.2",
    "semver": "^7.5.0"
  },
  "devDependencies": {
    "eslint": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^0.34.0"
  }
}
```

`package-lock.json` came from `npm install --package-lock-only`; `node_modules` was installed with
`npm install --ignore-scripts` (npm 11). The "latest" versions shown in the frames are whatever
the public registry returned on the capture date (2026-09-18) and will drift.

## Frames

| File | Size (px) | What the frame shows | How the state was produced |
|---|---|---|---|
| `overview.png` | 348×346 | Sidebar after an update check: toolbar with Refresh, Check for Updates, Update All and the `…` overflow; the update-count badge on the Activity Bar icon; the "Last update check" status row; Dependencies and Dev Dependencies groups with the update type per row | **Check for Updates**, wait for the check to finish |
| `filters.png` | 1030×186 | The **Select Filter** QuickPick with All / Has Updates / Patch / Minor / Breaking and their live counts, Patch active; the tree behind it filtered to the single patch update | select the Patch filter, then open **Select Filter** again |
| `pick-version.png` | 1030×440 | The **Pick Version...** QuickPick for `express`: version list with the `latest` tag and a held-back entry; the focused row shows its two inline actions, Update Package and Pick Version | focus the `express` row, run **Pick Version...** for it |
| `audit.png` | 348×370 | Sidebar after **Run Security Audit**: the "Audit complete · 6 vulnerable packages" status row above the package groups | **Run Security Audit**, wait for the audit to finish |

Crops: Activity Bar plus sidebar for `overview.png` and `audit.png`; sidebar plus QuickPick for the
two picker frames; the title bar and status bar are excluded. Frames were captured at 2x with
`screencapture -l <window id>` and downscaled to 1x with `sips --resampleWidth`, so the sidebar
is 300 px wide in every file.

## Not shown in the frames

- The `…` overflow menu: Search Packages, Select Filter, Clear Search Query (only while a search
  query is active), Run Install, Run Security Audit, Pin All Versions, Settings.
- The row context menu: Open on npmjs.com, Copy Package Name, Switch to dev/dep, Toggle version
  pin (only for rows whose spec can be pinned), Remove Package.
- The active filter or search query as the *view description* — the compact text next to the view
  title. VS Code renders it only in the view's own pane header, and while Nestro is the only view
  in its container that header is merged into the sidebar title, so the description text does not
  appear in the frames.
- The "Filter: Patch · 1 of N" status row above the package groups, which is what actually
  communicates the filter/search state in the default layout. `filters.png` was captured before
  this row existed and predates it; it will appear in the frame after the next recapture.
- Row vulnerability badges. npm's audit report v2 (npm 7 and later) carries no resolved package
  versions, so with this fixture the audit outcome is the status row plus the **Nestro Security
  Audit** Output channel rather than per-row badges.

## Reproducing

1. Build the extension (`pnpm run build`) and open the fixture folder in an Extension Development
   Host (F5 → Run Extension) with the settings above.
2. Produce each state with the commands from the table (Command Palette, toolbar, or row actions).
   A script that drives the states instead must pass the tree's own row object to
   `nestro.pickVersion`; the command rejects any other argument as not current.
3. Capture the window, crop as described, downscale to 1x, and keep the file names unchanged —
   `README.md` links to them and the VSIX allowlist accepts only lowercase kebab-case `.png` files
   in this directory.
