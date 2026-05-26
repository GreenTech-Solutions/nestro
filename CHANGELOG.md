# Change Log

All notable changes to the "nestro" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
