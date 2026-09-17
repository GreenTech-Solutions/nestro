# Security Policy

Nestro reads and writes workspace `package.json` files, runs local package-manager processes,
and contacts a package registry over HTTPS to check for updates, resolve versions, and run
security audits. This document describes what those operations do, what they never do, and how
to report a vulnerability privately.

## Supported versions

| Version | Supported |
|---|---|
| Latest published release | Yes |
| Any older release | No |

Security fixes ship only as part of a new release. There is no backport policy, so upgrading to
the latest published version is the only way to receive a fix.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub Private Vulnerability Reporting for
this repository:

<https://github.com/GreenTech-Solutions/nestro/security/advisories/new>

Do not open a public GitHub issue for a security report. Include, where you have it:

- the affected Nestro version and VS Code version;
- the package manager (`npm`, `pnpm`, `yarn`, or `bun`) and operating system;
- whether the workspace is a single-root project or a monorepo;
- reproduction steps or a minimal `package.json`;
- your assessment of the impact, if known.

Reports are triaged by the maintainer. There is no guaranteed response-time SLA. A confirmed fix
is published as a new release on the Visual Studio Marketplace and Open VSX — there is no
separate advisory-only distribution channel.

## Security model

### Trust boundary

- `package.json`'s `capabilities.untrustedWorkspaces.supported` is `false`: Nestro does not run
  in Restricted Mode.
- `capabilities.virtualWorkspaces.supported` is `false`: Nestro requires local package files and
  does not activate in a virtual workspace.
- `extensionKind` is `["workspace"]`: in Remote SSH, Dev Containers, and WSL, Nestro runs on the
  remote or container's extension host, so its file reads/writes and process launches happen
  there, not on the local client.
- Activation is declared on `workspaceContains:package.json` (a contributed command or the
  sidebar view can also trigger activation).

### Local processes

Nestro only runs the four package-manager CLIs a project can already declare — `npm`, `pnpm`,
`yarn`, or `bun` — resolved from `PATH`; it never bundles or downloads an executable.

- **Install / update / remove** run through a VS Code shell task in the integrated terminal
  (`runShellTaskAndWait()`), so package lifecycle scripts (`postinstall` and similar) execute
  exactly as they would from a terminal in the workspace, with the same privileges as the user
  running VS Code. Commands are `npm install` / `npm uninstall`, `pnpm add` / `pnpm remove`,
  `yarn add` / `yarn remove`, and `bun add` / `bun remove`, plus a plain install per manager for
  "Run Install". Every package name and version operand is validated
  (`src/clients/operandValidation.ts`), strong-quoted as a `vscode.ShellQuotedString`, and placed
  after a `--` separator so a dependency name can never be parsed as a CLI option.
- "Run Install" runs the plain install in the package root you pick when the workspace has more
  than one `package.json`; it never installs in every root at once.
- When `nestro.deferInstallAfterUpdate` is enabled, an update writes only `package.json` and runs
  no package manager and no lifecycle script until "Run Install" is invoked separately.
- **Security audit** runs `npm audit --json`, `pnpm audit --json`, `yarn audit --json` (Yarn
  Classic), `yarn npm audit --all --recursive --json` (Yarn Modern), or `bun audit --json`, each
  spawned in its own process group (a process tree on Windows) with a 120-second timeout and a 20 MiB per-stream output cap;
  on timeout, cancellation, or overflow the whole process group is killed.
- **Update metadata** prefers the package manager's own command — `npm view <package> --json`,
  `pnpm view <package> --json`, `yarn info <package> --json`, or `yarn npm info <package> --json`
  — bounded to 15 seconds and 5 MiB (Bun has no native metadata command here, so its metadata
  always goes through the bounded HTTPS path below); `npm-check-updates` itself runs in-process (dynamically imported), bounded to
  60 seconds per manifest.
- No command is built by string concatenation; arguments are always passed as an argv array.

### Network

- The version picker and release-age classification read the registry configuration a real CLI
  would honor — nested project-to-user `.npmrc` plus `npm_config_*` overrides for npm/pnpm,
  `.yarnrc` for Yarn Classic, `.yarnrc.yml` (including per-scope `npmScopes`) for Yarn Modern,
  and `bunfig.toml` (including environment-reference expansion) for Bun — and use
  `https://registry.npmjs.org/` when nothing configures a registry.
- The update check runs `npm-check-updates`, which resolves the registry through its own
  configuration: the `.npmrc` next to the manifest, the user and global npm config, `npm_config_*`
  overrides, and `.yarnrc.yml` in a Yarn Modern project. It does not read `.yarnrc` (Yarn Classic)
  or `bunfig.toml`, so in those projects an update check follows the npm configuration and, when
  none of it sets a registry, the public npm registry. An update check covers every discovered
  `package.json`, so every dependency name in the workspace is sent to the resolved registry.
- Every HTTPS metadata request Nestro issues itself goes through one bounded requester: a
  15-second timeout, a 5 MiB response cap, and at most 3 redirects, each one confirmed `https:`
  with no embedded credentials before being followed and confirmed same-origin before an
  `Authorization` header survives it. Requests always use `https.get`; a registry configured with
  `http://` is rejected outright rather than downgraded, and Nestro never issues a plain HTTP
  request. `strict-ssl=false` and a custom `ca`/`cafile` from the same configuration are honored,
  so the user's own npm configuration can weaken certificate validation for this path.
- Credentials read from those configuration files (npm/pnpm `_authToken` / `_auth` /
  username+password, Yarn `npmAuthToken` / `npmAuthIdent`, Bun registry tokens including ones
  embedded in a registry URL) are attached to a request only when that request's origin and path
  match the scope the credential is configured for.
- If a proxy is configured for the registry host, Nestro does not attempt that HTTPS request
  itself — it reports the lookup as unavailable instead of silently bypassing the configured proxy.
- "Open on npmjs.com" opens `https://www.npmjs.com/package/<name>` in your browser regardless of
  the configured registry; it is the only command that targets the public site directly.
- An unstable or unsupported response from a configured private registry never falls through to
  the public npm registry; the affected version picker or update check surfaces the failure
  instead of risking a resolution against the wrong registry (see `ARCHITECTURE.md`, sections 8
  and 10).
- `nestro.minimumReleaseAgeDays` (default 7 days) and `nestro.includePreReleases` (default
  `false`, opt-in) gate which versions Nestro will offer or apply; the cooldown is also passed to
  `npm-check-updates` as its own `cooldown` option.

### Files written

Nestro writes only the `package.json` files it discovers under `nestro.monorepoGlob` (default
`**/package.json`). A multi-file write, such as Pin All Versions, is atomic: every file's new
content is prepared before any write happens, and if a later write fails, every file already
written is restored from its captured original bytes, in reverse order. Nestro never writes a
lockfile directly — that is left entirely to the package manager's own install, which updates the
lockfile as part of installing. A resolved
project or package root that would fall outside its owning workspace folder, including through a
symlink, is rejected rather than used.

### Logs and telemetry

Nestro sends nothing to any external service. It creates three local VS Code Output channels —
`Nestro` (general log), `Nestro Security Audit`, and `Nestro Diagnostics` — and everything written
to them stays on the machine.

- Every line written to the `Nestro` output channel is sanitized first: ANSI and control
  sequences are stripped, URL credentials in `user:password@` form are redacted, `Authorization` headers are redacted, and
  `_authToken` / `_auth` / `_password` / token / API-key style assignments and npm token literals
  are replaced with `[REDACTED]`.
- The Diagnostics report applies that same sanitization and additionally redacts filesystem
  detail: known package-file paths are replaced with an owner-qualified label, and any other
  absolute path or `file://` URI is hidden outright rather than left in the report.
- Audit report text shown in the tree and the audit report is stripped of control/ANSI sequences
  and truncated before display.

### What Nestro never does

- No arbitrary command execution beyond the fixed set of package-manager CLIs and their
  install/update/remove/audit/view/info subcommands listed above, plus a `yarn --version` probe
  to identify the Yarn family and, on Windows, the system `taskkill` used to terminate a bounded
  process tree.
- No credential storage of its own — it only reads (never writes) the same registry configuration
  files a package-manager CLI would already read.
- No background network call outside an explicit command or an opt-in startup setting:
  `nestro.checkUpdatesOnStartup` and `nestro.runAuditOnStartup` both default to `false`, and a
  manual update check is further bounded by `nestro.checkUpdatesDebounce`.
- No `eval`, no `new Function`, no webview, and no bundled or downloaded executable.

## Known limitations

- Package lifecycle scripts run with the same trust and privileges as running the package manager
  directly from a terminal in the workspace; Nestro does not sandbox or intercept them.
- Nestro trusts the output of the package manager's own audit and registry-view commands; a
  compromised registry, a poisoned lockfile, or a malicious `.npmrc` / `bunfig.toml` entry is
  outside what Nestro can detect or prevent.
- In Remote SSH, Dev Containers, and WSL, Nestro's processes and network calls run on the remote
  or container side; the local client only renders the UI.
- The HTTPS metadata path does not route through an HTTP/HTTPS proxy: when one is configured for
  the registry host, the lookup is reported as unavailable rather than bypassing it.

## More

`ARCHITECTURE.md` documents the underlying mechanisms in full — project resolution, the mutation
and check coordinators, the audit model, and the update-check model — including the invariants
each one is pinned by. `CONTRIBUTING.md` covers the contributor workflow and links back to this
document as the threat model contributors are expected to respect.
