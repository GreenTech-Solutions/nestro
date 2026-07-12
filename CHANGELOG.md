## [0.4.2](https://github.com/GreenTech-Solutions/nestro/compare/v0.4.1...v0.4.2) (2026-07-12)


### Bug Fixes

* **audit:** clarify incomplete audit status ([5311557](https://github.com/GreenTech-Solutions/nestro/commit/531155755cc3e82e92e89ed7dafdbc03029a91df))
* bound npm-check-updates runtime ([65ad990](https://github.com/GreenTech-Solutions/nestro/commit/65ad990f5c186e7644be023b8ee4523c23a3ba5b))
* **ci:** use portable package check ([0b33d8b](https://github.com/GreenTech-Solutions/nestro/commit/0b33d8b0075b558edfb1d1f421e8f1b1d9c6186e))
* **ci:** validate built extension package ([6916477](https://github.com/GreenTech-Solutions/nestro/commit/6916477507cffc6e70f852c0605009c7a42eea7e))
* keep partial multi-root audit results ([2765eef](https://github.com/GreenTech-Solutions/nestro/commit/2765eefd9a226fcf50fc9d36ccaea8299251f8f0))
* make deferred bulk updates atomic ([b1db636](https://github.com/GreenTech-Solutions/nestro/commit/b1db63636da1e9c79e61575e74034db4ed19c197))
* pin concrete workspace ranges ([afebddd](https://github.com/GreenTech-Solutions/nestro/commit/afebddd382ff5b20fae56af780d31cfaf0ef7773))
* preserve installing state across reloads ([e8aa93e](https://github.com/GreenTech-Solutions/nestro/commit/e8aa93ea2d831b369b667289eb9f715263a5d40d))
* **provider:** reconcile failed update state ([445b035](https://github.com/GreenTech-Solutions/nestro/commit/445b03590961a7fb87dc50e2ace987dbe5dbae41))
* report deferred rollback failures ([529b191](https://github.com/GreenTech-Solutions/nestro/commit/529b1917bfaa60407da5cba668ad07e661122c4a))
* surface package read failures ([7dc8498](https://github.com/GreenTech-Solutions/nestro/commit/7dc849813f15aba6ff15346fac7dade7eb5d6a05))
* update agent configuration synchronization instructions ([858d12d](https://github.com/GreenTech-Solutions/nestro/commit/858d12d8cbeb35376d2d39e793277670714b8d5b))

## [0.4.1](https://github.com/GreenTech-Solutions/nestro/compare/v0.4.0...v0.4.1) (2026-07-09)


### Bug Fixes

* **audit:** ignore concurrent audit runs ([b463fc8](https://github.com/GreenTech-Solutions/nestro/commit/b463fc8a442ff09397756136f7611cd2f6a08908))
* **clients:** detect package manager from workspace ancestors ([8081d4c](https://github.com/GreenTech-Solutions/nestro/commit/8081d4cb11dee28c3852092c428d05d2d0423812))
* **deps:** update dependency version in selected section ([6184fbb](https://github.com/GreenTech-Solutions/nestro/commit/6184fbbade0f394bdbc2eb6095f1a34d043f6ce5))
* **docs:** update extension patterns and agents documentation for workspace folder handling and task execution ([82abd9a](https://github.com/GreenTech-Solutions/nestro/commit/82abd9a56e450545076fbdf9fbd342985bb9cf55))
* ensure consistent newline at end of files across multiple source and test files ([da030bc](https://github.com/GreenTech-Solutions/nestro/commit/da030bc7e2ed2d942ef62cc6744ea38d55b25df2))
* **manifest:** declare filter commands ([9d3d59a](https://github.com/GreenTech-Solutions/nestro/commit/9d3d59a9604fb856ce3b60816d0b3a7289f6725d))
* **package-json:** preserve tab indentation ([9e70535](https://github.com/GreenTech-Solutions/nestro/commit/9e705359a8907640c7f7d1961357cc7a65dae674))
* **package-manager:** respect nearest marker precedence ([6c5b946](https://github.com/GreenTech-Solutions/nestro/commit/6c5b946534c0ab31662e0a360c6ffda765563e24))
* **package:** audit fixes ([746bd03](https://github.com/GreenTech-Solutions/nestro/commit/746bd03a87a13d8e337e0c08ad58abaca16cbc7a))
* **picker:** dispose version quick pick ([c838343](https://github.com/GreenTech-Solutions/nestro/commit/c838343fe30ce5c5432b74c124160ac05a1fffb7))
* **picker:** format workspace package labels by path segment ([ea17118](https://github.com/GreenTech-Solutions/nestro/commit/ea171188a23575b7c1b0814f5011160fb766196d))
* **pnpm:** remove unused tmp dependency from overrides ([c92d3b5](https://github.com/GreenTech-Solutions/nestro/commit/c92d3b5884421f9cf2047b0cc83111a89fd517e8))
* **provider:** ignore concurrent update checks ([6fef779](https://github.com/GreenTech-Solutions/nestro/commit/6fef779c27c20c1fa53d5f73b6c9eed8145191af))
* **provider:** include dependency section in package identity ([8e8c0d4](https://github.com/GreenTech-Solutions/nestro/commit/8e8c0d415913491ae9daab822a5d96dac80c9e65))
* **provider:** preserve live package state during update checks ([115e8fe](https://github.com/GreenTech-Solutions/nestro/commit/115e8fe4fd22381e3c02d82a2fee4e411124eb84))
* **provider:** refcount write suppression timers ([cd9537f](https://github.com/GreenTech-Solutions/nestro/commit/cd9537fdb6793d49c884b1fe31762517373783c5))
* **provider:** reset update debounce on cache invalidation ([1dd82d9](https://github.com/GreenTech-Solutions/nestro/commit/1dd82d9cc011042963aecd0b2a4b0ac8528b3a83))
* **provider:** target package mutations by file path ([239a801](https://github.com/GreenTech-Solutions/nestro/commit/239a801485a4e74b3b72aa91469e62e3a2e694c7))
* **registry:** reject non-success package metadata responses ([fb3acaf](https://github.com/GreenTech-Solutions/nestro/commit/fb3acaf4c3708c082a789e176f14ab144301a85e))
* **registry:** resolve npmrc from owning workspace ([210a10c](https://github.com/GreenTech-Solutions/nestro/commit/210a10cd5fcfac28802cca898f1771ecfd103207))
* **registry:** resolve package metadata registry from npmrc ([3352c69](https://github.com/GreenTech-Solutions/nestro/commit/3352c696f8d0d1026d4ef69033d0e51c89d072b1))
* **registry:** timeout and cap package metadata responses ([33437ce](https://github.com/GreenTech-Solutions/nestro/commit/33437ce81038172428838bd70ef6c9d672748c15))
* **tasks:** handle shell task completion during startup ([22c27df](https://github.com/GreenTech-Solutions/nestro/commit/22c27df7191e51e1afe5f61594c5059706d5aca6))
* **tasks:** quote package manager task arguments ([e3f1793](https://github.com/GreenTech-Solutions/nestro/commit/e3f1793780e4b076f5e8ee2db63d7eae6cd61309))
* **tasks:** surface failed install and remove tasks ([0f73a18](https://github.com/GreenTech-Solutions/nestro/commit/0f73a184a8beaf16782a04c077959b671b621230))
* update VS Code engine version to ^1.125.0 and add check:vsce script ([4ade89b](https://github.com/GreenTech-Solutions/nestro/commit/4ade89b351a6383b0d36d80b988e2d10242b71cc))
* **updates:** preserve valid update cache ([2d2dd2d](https://github.com/GreenTech-Solutions/nestro/commit/2d2dd2d276ca365bbc5ae2448a8bb6567ca4008c))
* **watcher:** route package deletes through debounced refresh ([ed4ffb9](https://github.com/GreenTech-Solutions/nestro/commit/ed4ffb90c2a400bbdc517fbb42c1d468a0916c42))
* **workspace:** refresh packages when folders change ([35cda83](https://github.com/GreenTech-Solutions/nestro/commit/35cda833f49de5d113fd58457774742834288401))

# [0.4.0](https://github.com/GreenTech-Solutions/nestro/compare/v0.3.0...v0.4.0) (2026-06-12)


### Bug Fixes

* show relative paths in package.json picker instead of absolute ([1300258](https://github.com/GreenTech-Solutions/nestro/commit/1300258c949af38ded1b377be45b199a665281bd))


### Features

* add checkUpdatesForceAlways setting to bypass debounce ([9e9c1af](https://github.com/GreenTech-Solutions/nestro/commit/9e9c1afb71994e81c674332ca4adf41b4725cd2f))
* add Pin All Versions command to advanced tools overflow menu ([09000e6](https://github.com/GreenTech-Solutions/nestro/commit/09000e61972217a5f5539de21b2f7ec2b8c47e36))
* toolbar cleanup, pin-version update preservation, forced re-check ([3c6f7a5](https://github.com/GreenTech-Solutions/nestro/commit/3c6f7a5f3d18108f882a2f65e406ca6ac38850ec))

# [0.3.0](https://github.com/GreenTech-Solutions/nestro/compare/v0.2.0...v0.3.0) (2026-06-12)


### Features

* add cache invalidation to command updates and sort workspace folders ([6834ff0](https://github.com/GreenTech-Solutions/nestro/commit/6834ff01634e5846ffedd7d8d875930f59556e3b))
* enhance package manager commands to support devDependencies ([efe24ee](https://github.com/GreenTech-Solutions/nestro/commit/efe24ee039384895fd1f2b4886d4fe40239a6b9f))

# [0.2.0](https://github.com/GreenTech-Solutions/nestro/compare/v0.1.1...v0.2.0) (2026-06-08)


### Bug Fixes

* keep dependency sections alphabetized ([7e4f50e](https://github.com/GreenTech-Solutions/nestro/commit/7e4f50eca2c7f9a3c70281cb28b4fd1b207d2328))
* show complete stable version list in picker ([4319ac1](https://github.com/GreenTech-Solutions/nestro/commit/4319ac1bb576e0413dd78550f6e2ca12e268bab2))


### Features

* add package removal command ([ca3515e](https://github.com/GreenTech-Solutions/nestro/commit/ca3515e89ab5097cc5c4eb2dee59df64e4caff90))
* add package search in sidebar ([a8e241a](https://github.com/GreenTech-Solutions/nestro/commit/a8e241ade554ef36c9e69ee9b7ad92143fdecf1f))
* **search:** add clear search query command ([cd7e7fb](https://github.com/GreenTech-Solutions/nestro/commit/cd7e7fbe549f0e02dfb38d71f82774a16afc6e8a))
* **search:** split search query into tree item ([9c5907c](https://github.com/GreenTech-Solutions/nestro/commit/9c5907ccd18b5662e02d3857ea96f9f2b20965fe))

## [Unreleased]

- Declare internal filter commands for keybinding metadata while keeping them hidden from the Command Palette.
- Fix check-for-updates debounce so cache/config invalidation allows an immediate fresh update check.
- Fix `npm-check-updates` loading so the full VS Code test suite compiles and runs again under the CommonJS test build.
- Fix package-manager update commands so `devDependencies` stay in `devDependencies` for single updates, version picks, and bulk updates.
- Fix monorepo watcher handling so `nestro.monorepoGlob` changes recreate file watchers immediately.
- Fix `Run Install` and security audits to target the correct package root instead of always using the first workspace folder.
- Fix audit badges so vulnerabilities are tracked per `package.json` instead of leaking across matching package names in different workspaces.
- Fix filter counts so installing packages immediately disappear from update counters, preserve version prefixes after install, and invalidate cached update data when update tasks succeed.
- Fix monorepo refresh ordering so the workspace root stays first and other package sources sort alphabetically.
- Fix filter labels so update severities display as Patch, Minor, and Breaking.
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
