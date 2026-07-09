# Nestro — Package Manager for VS Code

[![Version](https://vsmarketplacebadges.dev/version-short/greentech-solutions.nestro.svg)](https://marketplace.visualstudio.com/items?itemName=greentech-solutions.nestro)
[![Open VSX](https://img.shields.io/open-vsx/v/greentech-solutions/nestro)](https://open-vsx.org/extension/greentech-solutions/nestro)
[![Installs](https://vsmarketplacebadges.dev/installs-short/greentech-solutions.nestro.svg)](https://marketplace.visualstudio.com/items?itemName=greentech-solutions.nestro)
![License](https://img.shields.io/badge/license-MIT-green)
![Build](https://img.shields.io/github/actions/workflow/status/GreenTech-Solutions/nestro/release.yml)

Nestro is a powerful VS Code extension that lets you seamlessly manage your npm, pnpm, yarn, and bun packages right from the sidebar. It provides real-time update status, version switching, and security audits to keep your dependencies healthy.

## Features

### 📦 Multi-Package Manager Support
Works out of the box with `npm`, `pnpm`, `yarn`, and `bun`. Nestro automatically detects your project's package manager and runs the appropriate commands.

### 🔍 Smart Update Detection
Easily spot outdated packages in your sidebar. Filter by update type (patch, minor, breaking) to quickly identify which dependencies need attention.

### 🛡️ Security Audits
Run package-manager audits directly from the UI to discover vulnerabilities across the detected package roots in your workspace and visualize them natively in the VS Code sidebar.

### 🔧 Version Management
Upgrade to the latest versions with a single click, pick specific versions from a dropdown, switch between `dependencies` and `devDependencies`, or pin versions to prevent accidental upgrades.

### 🏗️ Monorepo Support
Automatically discovers multiple `package.json` files across your workspace, organizes them by package root, refreshes watcher coverage when `nestro.monorepoGlob` changes, and lets `Run Install` target the package root you choose.

## Screenshots

### Package Overview
![Overview](images/overview.png)

### Filter by Update Type
![Filters](images/filters.png)

### Pick a Specific Version
![Pick Version](images/pick-version.png)

### Security Audit
![Audit](images/audit.png)

## Getting Started

1. Open a workspace containing at least one `package.json`.
2. Click on the **Nestro** icon in the Activity Bar to open the sidebar view.
3. You will see a list of all your packages. Nestro will automatically check for updates or you can run it manually.
4. Click on the update icon next to an outdated package or right-click to see more options like "Pick Version...", "Switch to dev/dep", or "Toggle version pin".
5. In monorepos with multiple package roots, `Run Install` asks which `package.json` should be used.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `nestro.checkUpdatesOnStartup` | boolean | `false` | Automatically check for package updates when the extension activates. |
| `nestro.checkUpdatesDebounce` | number | `60` | Minimum seconds between repeated update checks; set to `0` to disable. |
| `nestro.checkUpdatesForceAlways` | boolean | `false` | Always run Check for Updates immediately, ignoring the debounce interval. |
| `nestro.includePreReleases` | boolean | `true` | Include pre-release versions when checking for package updates. |
| `nestro.updateTarget` | string | `"latest"` | Version target strategy for update checks (`latest`, `greatest`, `minor`, `patch`). |
| `nestro.defaultFilter` | string | `"all"` | Default package sidebar filter (`all`, `hasUpdates`, `patch`, `minor`, `breaking`). |
| `nestro.deferInstallAfterUpdate` | boolean | `false` | Update `package.json` first and run dependency installation separately. |
| `nestro.confirmBulkUpdate` | boolean | `true` | Show confirmation dialog before updating all visible packages. |
| `nestro.runAuditOnStartup` | boolean | `false` | Run npm audit automatically when the extension activates. |
| `nestro.monorepoGlob` | string | `"**/package.json"` | Glob used to discover `package.json` files in the workspace. |

## Requirements

- VS Code `^1.125.0` or higher.
- `npm`, `pnpm`, `yarn`, or `bun` installed on your system.

## Limitations

Nestro relies on installed package managers for its operations. Make sure your package manager CLI (`npm`, `pnpm`, `yarn`, or `bun`) is available in your system PATH.

## Release Notes / Changelog

See the [CHANGELOG.md](CHANGELOG.md) for details about the latest updates and release history.
