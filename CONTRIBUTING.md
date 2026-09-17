# Contributing to Nestro

Nestro is a VS Code extension for managing npm, pnpm, Yarn, and Bun packages from the
sidebar. This guide covers the local development, test, and review process.

## Setup

Use the versions pinned by the repository:

- Node.js `24.19.0` from [.nvmrc](.nvmrc).
- pnpm `11.20.0` from the `packageManager` field in [package.json](package.json).

After selecting Node.js, enable Corepack if needed and install the dependencies:

```sh
nvm install
nvm use
corepack enable
pnpm install
```

VS Code `^1.125.0` or newer is required. The extension delegates package operations to the
package-manager CLI available in `PATH`: `npm`, `pnpm`, `yarn`, or `bun`.

The minimum supported VS Code `1.125.0` runs its Extension Host on Node.js 24.15.0,
provided by Electron 42.2.0. Keep `@types/node` on the Node 24 major and keep the compiler
target at or below the ES2022 output currently declared in `tsconfig.json`; the build
machine's Node version does not determine the Extension Host runtime contract.

## Architecture

Before changing the operation coordinator, the audit model, or one of the provider services,
read [ARCHITECTURE.md](ARCHITECTURE.md). It covers the canonical project graph, the mutation
and check coordinators, the update and audit lifecycles, and the invariants each one is pinned
by, so you do not have to re-derive the design from source.

## Commands

The table below is derived from the current `scripts` object in [package.json](package.json).
Commands marked **yes** do not intentionally modify repository files. Commands that compile,
bundle, watch, create coverage, or write evidence are not non-mutating gates.

| Script | Command | Purpose | Non-mutating gate? |
|---|---|---|:---:|
| `build` | `tsdown` | Bundle `src/extension.ts` into `out/extension.cjs`. | No |
| `dev` | `tsdown --watch` | Rebuild the extension bundle while source files change. | No |
| `vscode:prepublish` | `pnpm run build` | Build the bundle for publishing. | No |
| `test:compile` | `tsc -p tsconfig.test.json` | Compile Extension Host tests into `out/test/`. | No |
| `pretest` | `pnpm run test:compile && pnpm run lint` | Compile integration tests and lint before the default host suite. | No |
| `check:vsce` | `pnpm run test:compile && node out/tools/verifyVsixCli.js` | Compile the verifier and validate the VSIX package boundary. | No |
| `audit:dependencies` | `pnpm audit --audit-level high` | Run pnpm's dependency vulnerability audit, failing at high severity. | Yes |
| `audit:signatures` | `pnpm run test:compile && node out/tools/auditSignaturesCli.js` | Compile and verify pnpm package signatures. | No |
| `ci:evidence` | `pnpm run test:compile && node out/tools/ciEvidenceCli.js` | Record CI evidence; pass `-- --out-dir <relative-directory>` to choose the output directory. | No |
| `ci:policy` | `pnpm run test:compile && node out/tools/ciPolicyCli.js` | Validate the repository's GitHub Actions configuration, CODEOWNERS, and Dependabot policy. | No |
| `release:provenance` | `pnpm run test:compile && node out/tools/artifactProvenanceCli.js` | Build SBOM and provenance evidence for a release artifact. | No |
| `release:prepare` | `pnpm run test:compile && node out/tools/releasePrepareCli.js` | Build and validate release preparation evidence. | No |
| `release:candidate` | `pnpm run test:compile && node out/tools/releaseCandidateCli.js` | Build and validate release-candidate evidence. | No |
| `typecheck` | `tsc --noEmit` | Type-check the application without emitting files. | Yes |
| `lint:eslint` | `eslint src --max-warnings=0` | Run the strict ESLint check on `src`. | Yes |
| `lint` | `pnpm run lint:eslint` | The non-mutating lint gate. | Yes |
| `lint:fix` | `eslint --fix src` | Apply ESLint fixes to `src`; this is the mutating lint command and is never run automatically. | No |
| `test` | `vscode-test` | Run the configured Extension Host channels; its lifecycle also runs `pretest`. | No |
| `pretest:minimum` | `pnpm run pretest` | Compile and lint before the minimum-version channel. | No |
| `test:minimum` | `vscode-test --label minimum` | Run Extension Host tests on VS Code `1.125.0`. | No |
| `pretest:stable` | `pnpm run pretest` | Compile and lint before the stable channel. | No |
| `test:stable` | `vscode-test --label stable` | Run Extension Host tests on the stable VS Code channel. | No |
| `test:packaged` | `pnpm run test:compile && node out/test/packagedSmokeCli.js` | Run the packaged VSIX smoke test; pass `-- --artifact-dir <directory> --expected-sha <40-char-sha> --channel <minimum\|stable>`. | No |
| `test:unit` | `vitest run` | Run the Vitest unit-test suite. | Yes |
| `test:unit:coverage` | `vitest run --coverage` | Run unit tests and produce the V8 coverage report. | No |
| `test:unit:watch` | `vitest` | Run Vitest in watch mode. | No |

`lint` is the safe check to use in normal validation. Use `lint:fix` only when you explicitly
intend to accept automated source edits.

## Run and debug the extension

The **Run Extension** configuration in [.vscode/launch.json](.vscode/launch.json) opens an
Extension Development Host. Its explicit `preLaunchTask` is `tsdown: watch`, which runs
`pnpm run dev`; this task belongs to the build group but is not the default build task. The
default build task is `build`, defined in [.vscode/tasks.json](.vscode/tasks.json).

`launch.json`'s `outFiles` maps `${workspaceFolder}/out/**/*.cjs`, matching the CommonJS bundle
[tsdown.config.mts](tsdown.config.mts) emits at `out/extension.cjs`, so source-map resolution
and breakpoints resolve against the actual entry point. Press **F5** to build and launch;
`pnpm run dev` keeps rebuilding the bundle as source files change.

## Tests

### Unit tests

`pnpm run test:unit` runs Vitest over `src/**/*.unit.test.ts`. The `vscode` import is aliased to
[`src/test/__mocks__/vscode.ts`](src/test/__mocks__/vscode.ts), so these tests do not require a
VS Code Extension Host.

`pnpm run test:unit:coverage` uses the V8 provider. Coverage includes `src/**/*.ts` and excludes
`src/test/**`. The thresholds use `perFile: true`: the global floor is checked independently
for every included file (statements 80%, branches 70%, functions 86%, lines 84%), and the
module-specific entries in [vitest.config.ts](vitest.config.ts) can impose stricter floors.

### Extension Host integration tests

The non-unit `*.test.ts` files are compiled by `pnpm run test:compile` using
[tsconfig.test.json](tsconfig.test.json); unit tests and the VS Code mock are excluded. The
Extension Host runner then executes `out/test/**/*.test.js` with Mocha's TDD interface:

- `pnpm run test:minimum` runs the minimum supported VS Code version, `1.125.0`.
- `pnpm run test:stable` runs the stable VS Code channel.
- `pnpm run test` runs both configured channels.

Integration tests use the isolated workspace helpers in `src/test/fixtures/`. Fixture manifests,
lockfiles, single-root workspaces, and multi-root workspaces are defined as inline data. Each
fixture is copied into a fresh temporary `nestro-fixture-*` directory, its roots are appended
after the test anchor folder, and the copy is removed during teardown. The repository itself is
not opened as the test workspace.

## Review and commits

Before requesting review, run the checks relevant to the change and inspect the complete diff.
Keep changes focused, describe behavior and test coverage in the review, and call out any
environment-dependent validation that could not run.

Use the Conventional Commits format:

```text
<type>(<scope>): <subject>
```

The canonical type, release-bump, and release-notes table lives in
[CODESTYLE.md](CODESTYLE.md); keep new commit messages aligned with that table. In particular,
documentation, test, CI, and internal-only types do not create a release under the current
configuration.

`CHANGELOG.md` is generated by `@semantic-release/changelog`. Do not hand-edit its release
sections.

## Project decisions

### TypeScript 7 defer

| Field | Value |
|---|---|
| Decision | TypeScript 7 is not adopted — unconditional defer |
| Reason | TypeScript 7 is experimental |
| Owner | Alex Green (`GreenTech-Solutions`) |
| Current pin | `typescript: 6.0.3` (exact) |
| Recheck date | `2027-02-06` |

### Release-scope freeze

Closed 2026-08-06: nothing in the current scope is deferred, so there are no deferred
items to list.
