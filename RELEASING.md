# Releasing Nestro

A green `Verify` run on `master` is a precondition for a release, not proof that one happened
correctly. Nobody may call a release finished on that signal alone. This runbook is the actual
release gate: every step below needs a name in the **Owner** column and something recorded in
the **Evidence** column before the release is considered done. Section 8 gives a per-release
template for collecting that evidence.

It complements the other project documents rather than repeating them: [CONTRIBUTING.md](CONTRIBUTING.md)
covers day-to-day development and the full `scripts` table, [ARCHITECTURE.md](ARCHITECTURE.md)
covers the extension's own runtime design, and [SECURITY.md](SECURITY.md) covers the threat
model. This document is only about getting a reviewed commit onto the Visual Studio Marketplace
and Open VSX safely and verifiably.

## Pipeline at a glance

```
push to master
  └─ Verify (.github/workflows/ci.yml)
       quality → extension-host → package → packaged-smoke → required
       │
       ├─ workflow_run(success) ──▶ Release candidate (.github/workflows/release-candidate.yml)
       │                              builds dist/release-candidate/candidate.json + VSIX + SBOM +
       │                              provenance; uploads it only if v<package.json version> has
       │                              no tag yet
       │
       └─ workflow_run(success) ──▶ Release prepare (.github/workflows/release-prepare.yml)
                                      opens/refreshes PR release/v<version> (package.json +
                                      CHANGELOG.md) and re-dispatches Verify on its head

release/v<version> merges into master (ordinary PR review)
  └─ new push to master re-enters the pipeline above; this time Release candidate's uploaded
     candidate has a version nothing has tagged yet

Release candidate run succeeds
  └─ workflow_run(success) ──▶ Release dispatch (.github/workflows/release-dispatch.yml)
                                 creates/verifies tag v<version> on the candidate's source SHA,
                                 then workflow_dispatch's .github/workflows/release.yml on that tag

Release dispatch starts Release (.github/workflows/release.yml) on that tag through
workflow_dispatch — release.yml has no tag-push trigger and needs the artifact_id and
candidate_run_id inputs, so pushing a tag by hand publishes nothing
  └─ job `publish` (environment: release, required reviewer gate) verifies the candidate,
     verifies the GitHub attestation, publishes to the Marketplace and to Open VSX, then
     compares both freshly published copies against the candidate
  └─ job `finalize` creates the GitHub Release and attaches the VSIX, manifest, digest, SBOM,
     provenance and candidate.json
```

Only one step above needs a human to act without a workflow prompting them: reviewing and
merging the `release/v<version>` pull request. Everything else is either fully automated or
paused on the protected `release` environment's required-reviewer approval (§5).

## 1. Prerequisites

| # | Step | Owner | Evidence |
|---|---|---|---|
| 1.1 | Confirm you are an authorized releaser: the person who approves the `release` GitHub environment's required-reviewer gate (§5). Today that reviewer is the repository owner. | Repository owner | Environment protection rule (GitHub → Settings → Environments → `release`) |
| 1.2 | Work happens on `master`; the thing that eventually gets tagged is a commit on `master`, reached either directly or by merging `release/v<version>`. | Releaser | `git log --oneline -1 origin/master` |
| 1.3 | Use the pinned toolchain, not "latest": Node `24.19.0` ([.nvmrc](.nvmrc)) and pnpm `11.20.0` (`packageManager` in [package.json](package.json)). CI pins the same Node version via `node-version-file: .nvmrc` in every job that checks out the repository (`release.yml` installs no Node at all). | Releaser | `node -v`, `pnpm -v` output |
| 1.4 | Clean tree on the commit you intend to ship. | Releaser | `git status --short` (empty) |
| 1.5 | Every gate in the `Verify` workflow's `required` job is green for that exact commit: `required` (job id) needs `quality`, `extension-host`, `package` and `packaged-smoke` and fails if any of them is not `success` (`.github/workflows/ci.yml`). The README `Verify` badge mirrors this same job (`ci.yml` on `master`; see §6 for when it can read as broken even though the pipeline is fine). | CI, confirmed by releaser | Verify run URL, `required` job conclusion |
| 1.6 | No open security advisory blocks the release. | Repository owner | Private vulnerability reporting inbox, checked empty or triaged |
| 1.7 | When Release prepare has opened `release/v<version>`, review and merge that pull request. This is the only human step the `release` environment gate does not cover; nothing is tagged until the merged commit passes Verify again. | Releaser | URL of the merged `release/v<version>` pull request |

## 2. Verified SHA and artifact identity

Every workflow in the chain re-derives its own "expected SHA" from the previous stage and
asserts `git rev-parse HEAD` equals it immediately after checkout — nothing downstream trusts a
ref name alone:

- `ci.yml` sets `env.EXPECTED_SHA: ${{ github.sha }}`; the four building jobs (`quality`,
  `extension-host`, `package`, `packaged-smoke`) check out that ref and run
  `test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"`; `required` only aggregates their results.
- `release-candidate.yml` and `release-prepare.yml` set `env.SOURCE_SHA:
  ${{ github.event.workflow_run.head_sha }}`, call `gh api repos/.../actions/runs/$SOURCE_CI_RUN_ID`
  to confirm that run's `head_sha`/`head_branch`/`event`/`conclusion` before trusting it, then
  check out and re-assert identity the same way.
- `release-dispatch.yml` re-verifies the completed "Release candidate" run via the API before
  creating (or verifying an existing) tag `v<version>` pointing at that exact `source_sha`.
- `release.yml` (`publish` job) re-derives the candidate from `candidate.json` and checks
  `GITHUB_REF = refs/tags/v<version>` plus the tag's target commit against `sourceSha`.

### Artifacts and where they come from

| Artifact | Produced by | Files | Uploaded as |
|---|---|---|---|
| Verify evidence | `ci.yml` job `package`, into `$CI_ARTIFACT_DIR` (`dist/ci`) | `*.vsix`, `*.vsix.manifest.txt`, `*.vsix.sha256` (from `pnpm run check:vsce`), `evidence.json` (from `pnpm run ci:evidence`), `sbom.json` + `provenance.json` (from `pnpm run release:provenance`) | `verify-evidence-<run_id>-<run_attempt>`, retained 7 days |
| GitHub attestation | `ci.yml` job `package`, step "Attest the exact VSIX subject" (`actions/attest-build-provenance`), only on `push` to `master` | a signed provenance attestation on the VSIX subject digest | attached to the workflow run, verified later with `gh attestation verify` |
| Release candidate | `release-candidate.yml`, `pnpm run release:candidate -- --artifact-dir dist/ci --out-dir dist/release-candidate` | the same VSIX/manifest/sha256/sbom/provenance plus `candidate.json` (schema version 2: `sourceSha`, `ciRunId`, `ciRunAttempt`, `version`, `vsixFile`, `digest`, `manifestSha256`, `sbomSha256`, `provenanceSha256`, `notes`, …) | `release-candidate-<version>-<sourceSha>`, retained 90 days, only when `v<version>` has no tag yet |
| GitHub Release | `release.yml` job `finalize` | `<name>.vsix`, `.manifest.txt`, `.sha256`, `sbom.json`, `provenance.json`, `candidate.json` | attached to the `v<version>` GitHub Release |

Recompute and compare digests by hand instead of trusting the number in a JSON file:

```sh
shasum -a 256 <name>-<version>.vsix          # compare against the .sha256 sidecar's first field
shasum -a 256 sbom.json provenance.json      # compare against candidate.json's *Sha256 fields
```

`release.yml`'s "Verify protected candidate attestation" step does the attestation half for you
on every release (`gh attestation verify <vsix> --repo <repo> --signer-workflow
<repo>/.github/workflows/ci.yml`); run the same command yourself against a downloaded VSIX if you
want to re-check it independently.

### Size and file-count budget

`pnpm run check:vsce` (backed by `src/tools/vsixPolicy.ts`) rejects a package that exceeds the
measured baseline plus headroom: compressed size budget `1126757` bytes (baseline `901406` bytes
+ 25%), packaged file count budget `26` files (baseline `16` files + 10). It also runs the
allowlist/forbidden-class/secret-pattern checks described in `src/tools/vsixPolicy.ts` over the
exact package `vsce` produced. Changing either budget number is a separate, reviewed commit, not
something to adjust ad hoc during a release.

## 3. Audits and signatures

`audit:dependencies`, `audit:signatures`, `ci:policy` and `check:vsce` (below the table) can be run
locally; the `quality` job in `ci.yml` runs the first three on every `Verify` run. The other four
scripts are CI-only: they need the environment variables the workflows export (`CI_*`,
`PROVENANCE_*`, `RELEASE_*`) and a real artifact directory, and `release:prepare` rewrites files in
the working tree — do not run them by hand on a release commit.

| Script | Usage | What it verifies | Evidence lands in |
|---|---|---|---|
| `pnpm run audit:dependencies` | `pnpm audit --audit-level high` | No dependency vulnerability at High severity or above. | pnpm's own audit output (exit code) |
| `pnpm run audit:signatures` | no arguments (an extra argument is a hard error) | `pnpm audit signatures --json` and validates the report shape itself: every audited package carried a verified registry signature; an empty, malformed, mismatched-count, or plain-advisory report is rejected rather than read as a pass. | CLI stdout/stderr |
| `pnpm run ci:policy` | no arguments | The pinned action SHAs in every `.github/workflows/*.yml` file against a reviewed allowlist, `CODEOWNERS`, the Dependabot config, `.releaserc.json`, and the structural policy of all five workflow files (secret boundaries, environment scoping, permission scoping, exact publish-step shape). | CLI stdout/stderr |
| `pnpm run ci:evidence -- --out-dir <relative-directory>` | exactly `--out-dir <dir>` | Well-formed CI identity for the current run (full 40-char commit SHA, positive-integer run id/attempt, an `eventName`, the VSIX file name and digest) and writes `evidence.json` (`releaseEligible: false` always — this file is never itself release authority). | `<out-dir>/evidence.json` |
| `pnpm run release:provenance -- --artifact-dir <relative-directory>` | exactly `--artifact-dir <dir>` | Builds the SBOM (`sbom.json`, runtime dependency list) and the provenance evidence file (`provenance.json`: source SHA, CI run id/attempt, event name, artifact digest, attestation subject/digest, signer workflow) for the artifact already in that directory. | `<artifact-dir>/sbom.json`, `<artifact-dir>/provenance.json` |
| `pnpm run release:prepare -- --out-dir <relative-directory>` | exactly `--out-dir <dir>`; requires `RELEASE_REPOSITORY_URL` | Computes the next semantic-release version and changelog entry from commit history. **Mutating:** when a release is needed it rewrites `package.json` and `CHANGELOG.md` in the working tree; only `release-prepare.yml` runs it, to draft the version PR. | `<out-dir>/notes.md` and the tool's own release-needed/version outputs |
| `pnpm run release:candidate -- --artifact-dir <dir> --out-dir <dir>` | exactly `--artifact-dir <dir> --out-dir <dir>` | Builds and validates `candidate.json` (see §2) from verified evidence plus the package version, and copies the VSIX/manifest/digest/SBOM/provenance into the candidate bundle. | `<out-dir>/candidate.json` plus the copied artifact files |

`pnpm run check:vsce -- --out-dir <relative-directory> --require-clean-worktree` (§2, `src/tools/verifyVsix.ts`)
belongs in this list operationally even though it is a packaging check, not an audit: it also
compiles the verifier first (`pnpm run test:compile`) and refuses to run against a dirty tree
when `--require-clean-worktree` is passed, exactly as `ci.yml`'s `package` job does.

## 4. Packaged smoke

`pnpm run test:packaged -- --artifact-dir <directory> --expected-sha <40-char-sha> --channel
<minimum|stable>` (`src/test/packagedSmokeCli.ts`) installs the produced VSIX into a real VS Code
Extension Host and confirms it activates. `ci.yml`'s `packaged-smoke` job runs it across a
`ubuntu-latest` / `windows-latest` / `macos-latest` × `minimum` / `stable` matrix (six runs),
downloading the exact `verify-evidence-*` artifact by id rather than by name.

The Extension Host suites (locally `pnpm run test:minimum` / `pnpm run test:stable`; the
`extension-host` job runs the same suites through `pnpm exec vscode-test --label <channel>`) run in
the `extension-host` job, across the same OS matrix, but against the unpackaged build rather than
the installed VSIX — both matrices must be green before `required` passes (§1.5).

## 5. Environment approval and publish

`release.yml`'s `publish` job declares `environment: release` and only runs when
`github.ref` starts with `refs/tags/v`. The protected `release` environment (configured in
GitHub, not in a workflow file) requires an approving review before the job proceeds, restricts
deployment to tags matching `v*`, and does not allow an administrator bypass. The workflow's own
`concurrency: { group: release, cancel-in-progress: false }` means a second release cannot start
mid-publish and cannot cancel one in flight.

What the `publish` job does today, once approved:

1. Re-verifies the candidate run, artifact and `candidate.json` (§2), then runs
   `gh attestation verify` against the GitHub attestation created in `ci.yml`.
2. Publishes to the Visual Studio Marketplace via `HaaLeo/publish-vscode-extension@ca5561d...`
   (pinned `v2.0.0`) with the token passed through a step-level `env:` block — `env: VSCE_PAT: ${{
   secrets.VSCE_PAT }}` and `with: pat: ${{ env.VSCE_PAT }}` — plus `registryUrl:
   https://marketplace.visualstudio.com`, `skipDuplicate: true`.
3. Publishes to Open VSX with the same pinned action and the same shape (`env: OVSX_PAT: ${{
   secrets.OVSX_PAT }}`, `with: pat: ${{ env.OVSX_PAT }}`), `registryUrl: https://open-vsx.org`,
   `skipDuplicate: true`.
4. Downloads both freshly published copies and compares them against the candidate (§6).

Dated facts about the credentials in use, current as of 2026-09-18:

- `VSCE_PAT` is a global Azure DevOps personal access token (all accessible organizations),
  created 2026-05-28, expiring 2027-05-27. **Azure DevOps retires every global PAT on
  2026-12-01** — the Marketplace publish step above stops working on that date regardless of the
  token's own expiry, unless publishing has migrated off it first.
- The intended replacement is `vsce publish --oidc` (GitHub OIDC trusted publishing, no stored
  Marketplace secret), which needs `@vscode/vsce` ≥ `4.0.0` (currently pinned to `3.9.2` in
  `devDependencies`) and a trusted-publishing policy configured on the Marketplace publisher
  portal. That policy feature has not been released by Microsoft yet, so the migration cannot
  start; the current PAT-based publish step above remains the actual publish path until it can.
  This is tracked outside this file with its own recheck date; do not attempt the migration
  before the Marketplace-side policy form exists — it would break the very next release with no
  PAT fallback.
- `OVSX_PAT` is rotated on a fixed 180-day cadence by the repository owner; last rotated
  2026-09-17, next rotation due 2027-03-16.
- `permissions.id-token: write` exists only on `ci.yml`'s `package` job today (for the GitHub
  attestation, unrelated to Marketplace publishing); `release.yml`'s `publish` job currently
  requests no `id-token` permission at all, since it authenticates with the two stored PATs
  above, not OIDC.

## 6. Post-publish verification

`release.yml`'s own "Compare post-publish registry copies" step is meant to run this automatically,
seconds after both publishes, in the same job. The download URLs the registries actually serve are:

```
Marketplace: https://marketplace.visualstudio.com/_apis/public/gallery/publishers/greentech-solutions/vsextensions/nestro/<version>/vspackage
Open VSX:    https://open-vsx.org/api/greentech-solutions/nestro/<version>/file/greentech-solutions.nestro-<version>.vsix
```

**Known mismatch (verified 2026-09-18):** the workflow builds the Open VSX URL as
`https://open-vsx.org/api/<publisher>/<name>/<version>/file/<name>-<version>.vsix`, but Open VSX
names the file `<publisher>.<name>-<version>.vsix` — for the published `0.4.2` the registry answers
`302` for the form above and `404` for the workflow's form. Until the workflow (and the policy that
pins that URL) is corrected, expect the automated step to fail after both publishes; the manual
comparison in 6.1-6.2 is then the authoritative check. Because `finalize` declares `needs: publish`
without `always()`, it is skipped when `publish` fails, and re-running `publish` hits the same 404, so
until the workflow is fixed the GitHub Release has to be created and its assets attached by hand
from the candidate artifact (retained for 90 days); re-running the job only helps after the fix.

The automated step downloads both (capped at 2 MiB, HTTPS-only, bounded redirects/retries), parses each as a real
ZIP (entry count/size caps, no unsafe paths, no symlinks), checks the packaged `package.json`
identity against the outer `extension.vsixmanifest` identity, and accepts the copy only if it is
either byte-identical to the candidate or an "accepted explicit registry re-pack" — same identity
and the same normalized per-entry SHA-256 manifest, even if the registry re-zipped the container.
A mismatch fails the release job.

Do this again yourself, independently and later — the automated check only proves the registries
served back the right bytes the moment they were asked, not that the listing itself is correct or
that nothing changed afterward:

1. Re-download both URLs above (`curl -L -o marketplace.vsix ...`, `curl -L -o openvsx.vsix ...`)
   and `shasum -a 256` them against the GitHub Release asset.
2. `src/tools/publishedArtifact.ts` exports `comparePublishedVsix()`, which implements exactly
   the identity/normalized-manifest comparison above in code — **it has no CLI or `package.json`
   script yet**. Until one exists, replicate it by hand rather than inventing a command that does
   not exist: `unzip -l` both files, diff the member lists, `shasum -a 256` each member, and
   compare `extension/package.json`'s `name`/`version`/`publisher` and
   `extension.vsixmanifest`'s `Identity` attributes between the two archives and the candidate.
3. Open both listing pages and check: the published version number, the rendered README, all
   four screenshots, and the repository/issues/homepage links.
4. Check the README `Verify` badge (`https://img.shields.io/github/actions/workflow/status/GreenTech-Solutions/nestro/ci.yml?branch=master&label=verify`)
   reads green. It reads "repo or workflow not found" until a `Verify` run has actually completed
   on `master` for that workflow file — if `.github/workflows/ci.yml` and the README badge line
   are ever pushed apart, push the workflow file first (or in the same push) so the badge never
   points at a run that cannot exist yet.

## 7. Rollback and escalation

- **semantic-release cannot be undone.** The version-bump commit and the `CHANGELOG.md` entry it
  produced stay in `master`'s history; reverting the commit does not un-happen the release.
- **Marketplace and Open VSX version numbers cannot be reused.** Once `v<version>` is published,
  a future release must pick a new, higher version — never re-publish or overwrite the same
  number.
- **The safe path after a bad release is a fix-forward patch release**, not a rollback: fix the
  problem, let semantic-release cut the next patch version, and publish that.
- **`vsce unpublish` removes the entire extension listing**, not one version — last resort only,
  requires an explicit repository-owner decision, and is not part of any automated workflow here.
- **Open VSX removal is not self-service**; it needs an admin request to the Open VSX team.
- **Deleting the GitHub Release or the `v<version>` tag does not retract anything already
  published** to either registry — the packages remain live regardless.
- **Escalate to the repository owner** for any of the above. Record what happened, when, which
  version was affected, and the decision taken, using the evidence table in §8.

## 8. Evidence locations

| Kind | Where |
|---|---|
| Verify evidence artifact | GitHub Actions run page for the `Verify` workflow → Artifacts → `verify-evidence-<run_id>-<run_attempt>` (7-day retention) |
| Release candidate artifact | GitHub Actions run page for the `Release candidate` workflow → Artifacts → `release-candidate-<version>-<sourceSha>` (90-day retention) |
| GitHub attestation | `gh attestation verify <file> --repo <owner>/<repo>` against any downloaded VSIX, or the run page for the `Verify` workflow's `package` job |
| GitHub Release | `https://github.com/<owner>/<repo>/releases/tag/v<version>` — VSIX, manifest, sha256, SBOM, provenance, candidate.json |
| Workflow run URLs | Record all four: `Verify`, `Release candidate`, `Release dispatch`, `Release` |

Per-release checklist template — copy this table into the release record and fill it in:

| Item | Evidence link / value | Checked by | Date |
|---|---|---|---|
| Verify run (`required` green) | | | |
| Release candidate run + `candidate.json` digest | | | |
| Tag `v<version>` → source SHA | | | |
| `release` environment approval | | | |
| Marketplace publish confirmed | | | |
| Open VSX publish confirmed | | | |
| Post-publish digest/manifest re-check (§6) | | | |
| Marketplace/Open VSX listing check (§6) | | | |
| GitHub Release assets complete | | | |

## Release is done when

- The `required` job was green on the exact commit that got tagged (§1).
- `candidate.json`'s SHA, run ids and digests were verified, not assumed (§2).
- Dependency and signature audits, and the CI/release workflow policy, all passed (§3).
- Packaged smoke and both Extension Host channels passed on every platform in the matrix (§4).
- A human approved the `release` environment deployment for that specific tag (§5).
- Both registries were compared against the candidate — automatically, or, while the known
  mismatch in §6 stands, by the manual comparison in 6.1-6.2 recorded in the §8 table — **and** re-checked
  independently afterward, including the listing pages themselves (§6).
- Every row in the §8 evidence table has a link or value, a name, and a date.

Anything short of all seven is an unfinished release, whatever the badges say.
