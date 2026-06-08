## [Unreleased]

- Fix version picker ordering so it shows the full registry list in descending semver order and respects `nestro.includePreReleases`.
- Add a package removal action to the package tree context menu.
- Add package name search to the sidebar tree.
- Keep dependency sections alphabetized when moving packages between `dependencies` and `devDependencies`.

## [0.1.1](https://github.com/GreenTech-Solutions/nestro/compare/v0.1.0...v0.1.1) (2026-05-29)

# [0.1.0](https://github.com/GreenTech-Solutions/nestro/compare/v0.0.1...v0.1.0) (2026-05-29)


### Bug Fixes

* correct typecheck script name in release workflow ([c73846b](https://github.com/GreenTech-Solutions/nestro/commit/c73846b43d9be4317be3e57a24e0f996b04e1982))
* don't show update arrow when latest equals current version ([b832977](https://github.com/GreenTech-Solutions/nestro/commit/b83297785b5a8ac82e6a848f110c3c2ebc290c51))
* surface load/update errors via showError instead of silencing ([77380b7](https://github.com/GreenTech-Solutions/nestro/commit/77380b7d3de1949ac1378fa93a43c30884bd52ad))


### Features

* add "Has Updates" filter to package filter bar ([99c005e](https://github.com/GreenTech-Solutions/nestro/commit/99c005edfe34a93b7ff037d00f2830a320122415))
* add check-updates command, settings, and startup config ([fd9801a](https://github.com/GreenTech-Solutions/nestro/commit/fd9801af81684078f91d2945b2f15fb92ce5b664))
* add default filter setting and update PackagesProvider to use it ([ad97a15](https://github.com/GreenTech-Solutions/nestro/commit/ad97a154483668d575e9282dae37a8052dae7cc1))
* add Nestro output channel for extension diagnostics ([6314500](https://github.com/GreenTech-Solutions/nestro/commit/6314500dc1d1a885e2b865362020699f85786254))
* add npm audit indicators ([b526f05](https://github.com/GreenTech-Solutions/nestro/commit/b526f0577cb3d339d7918ea9b250a99cef7921e1))
* add npm package context actions ([0ea3720](https://github.com/GreenTech-Solutions/nestro/commit/0ea3720a77e027fe113e6fc0dd4514f680b80cb6))
* add package update progress indication and spinner during installation ([ec0e61b](https://github.com/GreenTech-Solutions/nestro/commit/ec0e61b9a9b5379913c71006d197e6c26e0081e9))
* add package version picker ([4fd727b](https://github.com/GreenTech-Solutions/nestro/commit/4fd727b53884772ff58da6fd5734e8142d1fb42f))
* add packages tree view with refresh and update commands ([1e376a3](https://github.com/GreenTech-Solutions/nestro/commit/1e376a3b33d405f2a04b3544dcb8c7c9f0458e8b))
* add skills for package contribution, save learning, setup Caliber, and VS Code tree provider ([bf7d0b2](https://github.com/GreenTech-Solutions/nestro/commit/bf7d0b241614c0c102aabdfd14ffb734635561ee))
* cache package update checks ([e20ff4a](https://github.com/GreenTech-Solutions/nestro/commit/e20ff4a7bc82dfc65ddc56cd0d8bb327197dfa22))
* check updates client changed for NCU ([842ba40](https://github.com/GreenTech-Solutions/nestro/commit/842ba403d0c4aa1cfde315cd6f11e03f3c67e6ef))
* confirm bulk package updates ([7280e9b](https://github.com/GreenTech-Solutions/nestro/commit/7280e9be407bc678e8f337890719cebe70b643ae))
* enhance package management features ([6564836](https://github.com/GreenTech-Solutions/nestro/commit/656483655d396a6e1601ba5eb742952aea0a289a))
* group packages by dependencies and dev dependencies ([1ff9e80](https://github.com/GreenTech-Solutions/nestro/commit/1ff9e80c4807bac02ff518b1a62675f8da9a6fa7))
* implement custom yarn audit parser and support legacy npm audit JSON formats with improved logger methods. ([cba3459](https://github.com/GreenTech-Solutions/nestro/commit/cba3459b6b7c09b0e03619aafad8093b35cdf538))
* implement deferred package updates and new commands for installation ([4814341](https://github.com/GreenTech-Solutions/nestro/commit/4814341c4956ea4c2f357254f2342f3ddc120d5f))
* Implement native TreeView controls and filter management ([4eeb9af](https://github.com/GreenTech-Solutions/nestro/commit/4eeb9afec2d948ed4060df04792af49284f633cc))
* publish initial 0.0.1 release, update README documentation with screenshots, and add extension category ([0382add](https://github.com/GreenTech-Solutions/nestro/commit/0382adda7d31537378522c71537785dee9805bea))
* refine package update filters ([6a9ccb2](https://github.com/GreenTech-Solutions/nestro/commit/6a9ccb2bbd0672265fa092a9d2e88301028a0f1e))
* refresh package row after update and show empty-state messages ([d426788](https://github.com/GreenTech-Solutions/nestro/commit/d4267885f835adb84eeb42ac8d00f2aa95beed36))
* support monorepo package files ([f397ab1](https://github.com/GreenTech-Solutions/nestro/commit/f397ab1ad97c155aa38f5a5eb02161cf1b3605b1))
* update Caliber command paths and enhance documentation ([056de87](https://github.com/GreenTech-Solutions/nestro/commit/056de87074127ed6401ef50b70cac023189f0b15))
* update documentation to include WorkspaceFolderItem and client structure ([622f0ce](https://github.com/GreenTech-Solutions/nestro/commit/622f0ce57e60412d240b483a5941f0ec3605d71a))

# Change Log

All notable changes to the "nestro" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.1] - 2026-05-28

- Initial release
- Clean up release packaging to exclude internal tooling, config, and agent metadata.
- Fix broken documentation asset reference in README.
- Add inline package actions for opening npmjs.com, picking versions, switching dependency type, and toggling version pinning.
- Add expandable package detail rows showing dependency type, current version, latest version, and package file path.
- Add monorepo package discovery with folder grouping and per-package-file update commands.
- Add package manager client classes for npm, pnpm, yarn, and bun command generation and audits.
- Add `nestro.pickVersion` to install or roll back a package from a version picker.
- Add `nestro.switchDepType` and `nestro.pinVersion` commands for editing package.json dependency metadata.
- Add `npm audit` support with vulnerability severity indicators in the package tree.
- Cache package update checks for five minutes and invalidate the cache when package data changes.
- Add confirmation before updating all visible packages, configurable with `nestro.confirmBulkUpdate`.
- Add package context actions to open npmjs.com pages and copy package names.
- Refresh packages automatically when workspace `package.json` changes.
- Apply `nestro.defaultFilter`, `nestro.updateTarget`, and `nestro.includePreReleases` changes without restarting the extension.
- Preserve dependency version prefixes such as `^`, `~`, and `>=` during deferred package updates.
- Use native TreeView controls, welcome state, and package update badges in the sidebar.
- Add the `nestro.defaultFilter` setting for the initial package sidebar filter.
- Add deferred package updates with `nestro.deferInstallAfterUpdate`, `Run Install`, and `Update All` sidebar actions.
- Batch package update checks through npm-check-updates and add the `nestro.updateTarget` setting.
- Fix update detection so older registry versions are not offered as downgrades.
- Add pre-release version parsing for update checks, controlled by the enabled-by-default `nestro.includePreReleases` setting.
- Detect the workspace package manager and use it for package update commands.
- Refresh a package row automatically after a successful update command.
- Show loading and empty-filter messages in the packages sidebar instead of blank states.
- Show package filters as a single compact row and hide them when no packages are loaded.
- Use colored upward arrows for package update indicators.
- Show a spinner on the package row while its update command is running.
- Add a Nestro Output channel for extension diagnostics.
- Initial release
