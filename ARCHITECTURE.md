# Nestro Architecture

## 1. Purpose and scope

This document explains the mechanisms behind Nestro's package-management pipeline: how a
`package.json` becomes a project, how concurrent operations on that project are kept safe, how
update and audit results are computed and applied, and why the tree view exposes the state it
does. It is written for an engineer who needs to change the operation coordinator, the audit
model, or one of the provider services without re-deriving the design by reading every source
file first.

It complements, and does not repeat, two other documents: `CLAUDE.md` gives the high-level data
flow, the command inventory, and per-module summaries — read it first for orientation.
`CODESTYLE.md` defines the module layering and barrel-export contract (`tools` → `utils` →
`clients` → `providers` → `commands`/`extension.ts`) enforced by
`src/test/importContract.unit.test.ts`; this document assumes that layering.

Everything below describes the mechanism as implemented, including trade-offs deliberately
chosen over an alternative. Symbol names and file paths are given so the reader can jump to the
source directly; no line numbers are used, because they drift.

## 2. Runtime model

### Activation

VS Code calls `activate()` in `src/extension.ts` when Nestro activates in the extension host.
`package.json` explicitly declares `workspaceContains:package.json` in `activationEvents`; the
contributed commands and view can also activate the extension, so this is not the sole activation
path. Activation constructs `FilterManager` from the `nestro.defaultFilter` setting and
`PackagesProvider` (whose constructor also builds its own service instances unless a test injects
replacements — see
below), creates the `nestro.packagesView` `TreeView` and calls `provider.attachTreeView()`,
registers every command from `src/commands`, registers three watchers
(`registerPackageJsonWatcher()`, `registerConfigurationWatcher()`,
`registerWorkspaceFoldersWatcher()`), then calls `provider.loadPackages()`, optionally followed
by `checkUpdates()`/`runAudit()` when the matching `*OnStartup` setting is enabled.

`registerPackageJsonWatcher()` debounces filesystem events per
`PACKAGE_JSON_WATCHER_DEBOUNCE_MS` (500 ms) and skips scheduling entirely while
`provider.suppressingWrites` is true — the write-suppression feedback-loop guard described in
section 5. `registerWorkspaceFoldersWatcher()` refreshes the package-file watcher and reloads
packages on `vscode.workspace.onDidChangeWorkspaceFolders`, so a folder added or removed after
activation is picked up without a window reload.

### The provider as a thin adapter over four services

`PackagesProvider` (`src/providers/PackagesProvider.ts`) implements
`vscode.TreeDataProvider<vscode.TreeItem>` and `vscode.Disposable`. It owns mutable UI state —
`allEntries` (the flat row list), `packageFilePaths`, `workspaceCapabilities`, operation
generation and cancellation records, audit results and report summaries, and two `WeakMap`s
backing the capability system (section 5). The update-result cache and its fingerprint belong to
`UpdateOrchestrationService`. The provider delegates every non-trivial computation to one of four
collaborators:

| Service | File | Responsibility |
|---|---|---|
| `PackageLoadingService` | `packageLoadingService.ts` | Reads every workspace `package.json`, builds the flat entry list, snapshots a canonical-location baseline per manifest. |
| `UpdateOrchestrationService` | `updateOrchestrationService.ts` | Runs `npm-check-updates` once per manifest, computes release-age state, owns the update-result cache and its fingerprint. |
| `AuditOrchestrationService` | `auditOrchestrationService.ts` | Resolves the canonical audit project graph, runs one audit per project, attributes advisories back to rows. |
| view projection | `viewProjectionService.ts` | A stateless module (`computeViewProjection()`, `projectStatusRows()`, `resolvePublishedWorkspaceCapabilities()`, `diffViewContexts()`) that turns a plain snapshot of provider fields into contexts, badge, description, and status rows. |

(All four files live under `src/providers/`.) The first three are constructor-injectable —
`PackagesProvider` accepts each as an optional parameter, defaulting to a production instance —
which is how `src/test/packagesProvider.unit.test.ts` substitutes fakes without touching VS
Code APIs. The fourth is not a class: it holds no state, so every call site builds a
`ViewProjectionSnapshot` from current provider fields and gets a fresh `ViewProjection` back.

`getChildren()` returns early while `loading` is true, and otherwise returns status rows from
`buildStatusItems()` first, followed by the package groups from `buildTree()` in `treeBuilder.ts`.
`buildTree()` and its sibling `projectPackageTree()` are pure functions over
`PackageTreeEntry[]`: no VS Code state in, none out except constructing `TreeItem` subclasses.

### Context keys and how menus consume them

`emitTreeChanged()` — the provider's single mutation-notification path — computes one
`ViewProjection` via `computeViewProjection()`, applies `badge`/`description` to the attached
`TreeView`, publishes only the context keys that changed since the last publication
(`publishViewContexts()` + `diffViewContexts()`), and fires `_onDidChangeTreeData`. The
published keys are declared once in `VIEW_CONTEXT_KEYS` (`viewProjectionService.ts`):
`canUpdateVisiblePackages`, `hasPackageFiles`, `hasReadablePackageFiles`,
`hasDependencyEntries`, `hasAuditableProjects`, `canRunInstall`, `canRunAudit`,
`canSearchPackages`, `canFilterPackages`, `canPinAllVersions`, `noWorkspace`, `hasSearchQuery`.

`package.json`'s `contributes.menus` reads these as `"when"` clauses: `view/title` controls which
global actions contribute to the view title, including its overflow menu; `viewsWelcome` gates the
empty-workspace message on `nestro.noWorkspace`. `view/item/context` gates per-row actions
(`nestro.installUpdate`, `nestro.pickVersion`, `nestro.switchDepType`, `nestro.pinVersion`,
`nestro.removePackage`, `nestro.openOnNpm`, `nestro.copyPackageName`) with expressions against
`viewItem`, i.e. `PackageItem.contextValue` — a string the `PackageItem` constructor composes from
the row's own state: a base of `outdated`/`package`/`installing-<kind>`, a
`-pinnable`/`-pin-unsupported` suffix from `parseDependencySpec()`, and a
`-vulnerable-<severity>` suffix when an audit result exists.

Package-row context-menu visibility is controlled by those `view/item/context` `"when"`
expressions; the row actions do not declare `"enablement"`. Some global commands
(`nestro.runAudit`, `nestro.updateAllVisible`, `nestro.runInstall`, `nestro.pinAllVersions`) do
declare `"enablement"` on `contributes.commands`, independently of the `"when"` conditions on
their `view/title` entries. These view-title actions may appear in the toolbar or its overflow
menu; their command enablement is not a Command-Palette-only setting. Command enablement is also
distinct from menu visibility: for a command assigned through a `TreeItem.command`, VS Code
checks its enablement precondition when the row is clicked, not only when a menu renders —
confirmed empirically against VS Code 1.125.0 and 1.138.0. A failing precondition can leave that
bound click as a no-op, with the row rendered but its click a no-op — exactly the state a
`TreeItem.command` must never be able to reach. The only tree item that sets `this.command` is
`StatusItem`: a diagnostics row sets `nestro.openStatusReport` when `actionable`; the Filter and
Search rows instead carry an explicit `command` (`{ command, title }`) from `projectStatusRows()`
that opens `nestro.showFilterPicker`/`nestro.searchPackages`. Every other row omits the command
property. All three of these commands carry no `"enablement"` entry in `package.json`:
`nestro.searchPackages`'s `view/title` toolbar entry gates its visibility with `"when"` alone,
exactly like `nestro.showFilterPicker`'s — the invariant holds for every command a tree item can
bind through `TreeItem.command`, with no exception.

## 3. Canonical project graph

Nestro operates over two related but distinct notions of "project": a **manifest** is one
`package.json` discovered by `findWorkspacePackageJsonFiles()`
(`src/utils/packageRepository.ts`), glob-configured via `nestro.monorepoGlob`; an
`AuditProject` (`src/clients/projectResolver.ts`) groups manifests whose audit graph resolves to
the same canonical, symlink-resolved `projectRoot`. That root is the audit execution directory
and the coordination identity for per-project work; it is not the working directory for every
package-manager operation. `PackageManager` is defined in `src/utils/packageManagerKind.ts` and
re-exported by `projectResolver.ts`.

`resolveAuditProjects()` turns the manifest list into the project graph, used both to decide
what the security audit runs against and (via `resolveMutationCoordinatorKey()`) what a
mutation locks on. For each manifest it:

1. Confirms an owning `vscode.workspace.WorkspaceFolder` exists; otherwise rejects with
   `no-owning-workspace`.
2. Walks ancestor directories from the manifest's directory up to the owning workspace folder
   (`detectPackageManagerSignalFromAncestors()`/`getAncestorDirectories()`). The nearest directory
   containing a recognized signal wins. Within each directory, the `packageManager` field is
   checked before lock files; if none is recognized, `LOCKFILES` precedence is
   `pnpm-lock.yaml` → `yarn.lock` → `bun.lock`/`bun.lockb` →
   `package-lock.json`/`npm-shrinkwrap.json`. Thus a nearer directory's signal wins over any
   signal in an ancestor, while `packageManager` wins over lock files in the same directory.
3. Canonicalizes the signal's directory with `realpath()` (`canonicalizeRoot()`) and confirms it
   stays inside the realpath of the owning workspace folder; an unreadable path is
   `unresolvable-path`, one resolving outside the workspace is `workspace-escape` — kept
   separate so an unreadable path is never reported as a proven symlink escape.
4. Signal discovery reads `package.json` files and checks lock-file paths along the lexical
   ancestor walk before the selected root has been canonicalized. A selected signal root is not
   accepted as an audit root until that canonicalization proves it remains inside the workspace.
   If a selected signal root above the manifest directory escapes or cannot be resolved,
   `resolveManifestProject()` discards it and retries from the manifest's own directory,
   canonicalizing that directory before any second signal read there. If the manifest directory
   also cannot be resolved inside the workspace — or is itself the failed selected root —
   `resolveAuditProjects()` rejects the manifest; it does not return a degraded audit project.
5. Manifests whose canonical root coincides are merged into one `AuditProject`
   (`originManifests` records every contributor). Two manifests resolving to the same root
   through *different* workspace folders reject the second as `cross-workspace-collision`
   rather than merging — first claim wins, and input is sorted by `localeCompare` before
   resolution so the winner is deterministic regardless of `vscode.workspace.findFiles()`'s
   unspecified order.

Key project-graph behaviors are covered in `src/test/projectResolver.unit.test.ts`, including
merging and deduplication, nearest-signal precedence, escape and path-resolution failures, the
safe manifest-directory retry, and deterministic cross-workspace collision handling.

The audit root is not a universal client cwd. `AuditOrchestrationService` constructs its client
with `AuditProject.projectRoot`. Update checks still call NCU once for each manifest path and use
the canonical project root only to serialize those calls through the shared check coordinator.
For other clients, `ClientManager.getClient()` keeps the supplied manifest directory as `cwd` for
npm, pnpm, and Bun; it redirects Yarn to the directory where the winning Yarn signal was found.

`resolveMutationCoordinatorKey()` reuses the same canonicalization: it resolves the manifest's
own realpath, selects the deepest matching canonical workspace folder (not a lexical prefix
match — `resolveCanonicalOwningWorkspaceFolder()` realpaths every open folder and picks the
longest containing one), and calls the same `resolveManifestProject()`. When that resolution
fails, this mutation-key function logs the failure and falls back to the manifest's own directory
so the mutation still takes a lock. This degraded fallback belongs only to
`resolveMutationCoordinatorKey()`; audit resolution either returns a contained project root or
rejects the manifest. When both resolve successfully, the mutation key and audit project use the
same canonical root in the common case; a symlinked ancestor inside the workspace can make the
two ancestor walks pick different signal roots, because audit resolution starts from the lexical
manifest directory while the mutation key starts from its real path.

Row-level identity resolution is separate and narrower: `resolveCanonicalPackageLocation()`
(`src/providers/packageIdentity.ts`) validates one manifest path immediately before a read or
write, independent of the project graph. It realpaths the manifest and its directory, selects the
deepest canonical workspace folder containing it, and rejects duplicate entries for that
deepest root or a lexical/canonical owner mismatch as `cross-workspace`. It also handles the
case-insensitive-filesystem edge case where a manifest path
differs from the workspace URI only in letter case: `isCaseOnlyAlias()` plus
`hasSymlinkAfterCaseDifference()` compare `lstat` identity (`dev`/`ino`) segment by segment so a
case-only spelling difference is accepted while a real symlink at the point of divergence is
still rejected. It then captures a `PackageFileStamp` (`dev`/`ino`/`size`/`mtimeMs`) and a
SHA-256 `manifestDigest` — the digest exists because a stat-only comparison cannot detect a
rewrite that lands on the same size and millisecond-resolution mtime.

Monorepo grouping and labels are built by `treeBuilder.ts` (`resolvePackageOwnerLabel()`,
`resolvePackageFileLabels()`, `resolveWorkspaceFolderDisplayNames()`), entirely independent of
the project graph above. Rows are labeled `<display name> — <relative path>` (root:
`<display name> — (root)`), grouped and sorted by the owning folder's `WorkspaceFolder.index`,
root before subpaths, alphabetical beyond that (`comparePackageOwnerLabels()`) — never a flat
cross-root sort. Folders sharing a `WorkspaceFolder.name` fall back to the shortest unique path
suffix (`shortestUniqueSuffix()`), then to a stable `#<index>` suffix on a full collision.

## 4. Operation coordinator

`OperationCoordinator` (`src/utils/operationCoordinator.ts`) is a generic keyed mutex with a
bounded concurrency pool, used for two independent purposes with two independent instances.

**Lock keys.** A key is normally a canonical project root string, produced by
`resolveMutationCoordinatorKey()` for mutations, or the equivalent root inside the update/audit
services; both producers fall back to a non-canonical path when resolution fails (section 3), so
a key is an opaque identity rather than a guaranteed canonical root. `runExclusive(key, fn)`
serializes callers sharing one key; `runManyExclusive(keys,
fn)` — used by bulk operations spanning several roots in one call, such as
`updateAllVisibleCommand()` and `pinAllVersionsCommand()` — holds every key in the deduplicated
set for the whole duration of `fn`.

**Key ordering.** `runManyExclusive()` sorts its key set by code-unit order (not
`localeCompare`) before acquiring, regardless of caller-supplied order. This makes overlapping
multi-key acquisitions deadlock-free: if operation A holds `{x, y}` and B wants `{y, x}`, both
acquire `x`-then-`y`, so one strictly precedes the other. Code-unit order specifically agrees
with `Set`'s deduplication identity — a locale-aware compare could treat two distinct keys as
equal for sorting while `Set` still treats them as distinct, destabilizing the shared order.

**Mutation coordinator vs. check coordinator.** Two separate instances, both keyed by canonical
project root, not serialized against each other:

- `mutationCoordinator` (`MUTATION_CONCURRENCY_CAP = 8`) is a module-level singleton imported
  directly by every command that writes `package.json` or runs an install/update/remove shell
  task (`installUpdate.ts`, `pinVersion.ts`, `pinAllVersions.ts`, `switchDepType.ts`,
  `removePackage.ts`). Holding its key is what serializes two mutations on one project root.
- `checkCoordinator` is created per `PackagesProvider` by `createCheckCoordinator()`
  (`CHECK_CONCURRENCY_CAP = 6`) and shared between `UpdateOrchestrationService` and
  `AuditOrchestrationService` — both constructed with the *same* instance via
  `UpdateOrchestrationService.withCoordinators()`/`AuditOrchestrationService.withCoordinator()`.
  This serializes an update check and a security audit on the same root against each other and
  bounds their combined fan-out, pinned by `packagesProvider.unit.test.ts`'s *"shares the read
  cap and canonical root serialization between update and audit runs"*.
- `metadataCoordinator` (`METADATA_CONCURRENCY_CAP = 4`) is a third, provider-owned instance
  nested inside the check coordinator's work: every metadata lookup acquires a check-coordinator
  slot for its root *and* a metadata-coordinator slot for its `packageName`/`registryKey` pair,
  because native CLI metadata lookups spawn their own process and are kept more conservative.

A check and a mutation on the same root are therefore **not** mutually exclusive — only within
their own domain. This is deliberate: checks and audits are read-only against the filesystem,
so there is nothing for them to corrupt; every mutation re-validates the manifest immediately
before writing (section 5), so a concurrent check observing an in-flight version is, at worst,
stale until the next reload. The original finding this coordinator closes — two mutations on
one root each reading the same stale document, the last full write silently discarding the
first — is specifically the mutation-vs-mutation case, which `mutationCoordinator` prevents.

**Concurrency caps and where they were measured.** Mutation caps 4 through 12 were measured as
statistically indistinguishable given run-to-run variance, and 8 was picked from within that
range. The synthetic native-process benchmark for read work showed a throughput knee around caps
4–6; cap 6 had the lowest wall time among the stable large-fixture samples, while higher caps
did not improve wall time consistently and used more child CPU. That evidence set
`CHECK_CONCURRENCY_CAP = 6`. `METADATA_CONCURRENCY_CAP = 4` remains a more conservative bound for
metadata lookups that may spawn native processes; the provider test observes exactly four
active requests at peak. These measurements are specific to their work profiles; changing a cap
should
be supported by measurements for that work rather than by transferring another cap's result.

**Cancellation.** `OperationCoordinator` itself has no cancellation concept — a queued call
simply waits its turn. Cancellation is layered on top by `startRootOperations()`/
`runRootOperations()` (section 6), which race the coordinator call against an `AbortSignal`
without ever releasing the key or slot early: a started worker keeps both until its own promise
settles, even after the caller has moved on. Releasing a slot before the underlying
process/task actually stops would let a second operation start against the same root.

## 5. Operation lifecycle

### Generations

`PackagesProvider` tracks three independent monotonic counters. `packageSnapshotGeneration` is
bumped at the start of every `loadPackages()`; any outstanding update check or audit is aborted
immediately, and `isLoadOutdated()` guards every await point inside `loadPackages()` against a
still-later reload superseding it. `updateGeneration` pairs with an `UpdateOperation` record
(`{generation, snapshotGeneration, abortController}`); `isUpdateCurrent()` requires the
operation to still be the provider's `updateOperation`, its generation to match, its
`snapshotGeneration` to match the *current* snapshot, `checkState` to still be `'running'`, and
its signal not aborted — all five checked at every await boundary. `auditGeneration` mirrors
this via `AuditOperation`/`isAuditCurrent()`. `checkUpdates()`/`runAuditCore()` both no-op
immediately if already `'running'`, preventing two concurrent checks/audits from overlapping in
the first place; the generation machinery exists for the case where a reload — which bumps the
snapshot generation without going through that busy-check — supersedes an already-running one.

### Capability records

A `PackageItem` rendered in the tree cannot, by itself, be trusted as a write target: its
fields are exactly what was true when last rendered, and any async gap (a QuickPick, a
confirmation dialog) can let the file change underneath it. `resolvePackageItem()` is the
boundary every command calls first: it confirms the raw argument is a real `PackageItem` this
provider issued (`packageItemRecords: WeakMap<PackageItem, PackageItemRecord>`), confirms
exactly one current row still matches that identity tuple (`findCurrentEntry()`), resolves the
canonical filesystem location, and issues a `ResolvedPackageItem` "capability" recorded in a
second `WeakMap` (`packageCapabilityRecords`). Every field a command reads afterward — name,
spec, section, canonical paths, file stamp — comes from this capability, never the original
tree-rendered item.

Because the capability itself can go stale during a long-running operation, commands
re-validate it again immediately before the write or task via `revalidatePackageItem()`, which
re-runs every check `resolvePackageItem()` did against the *stored* capability record.
`installUpdate.ts`, `pinVersion.ts`, `switchDepType.ts`, `removePackage.ts` all re-validate at
least once between resolving the capability and writing; the immediate-install path in
`installUpdate.ts` re-validates a second time after the client is built and before
`confirmRiskyUpdates()`, so the risky-update dialog is the last async gap before the shell
task and is not itself followed by another filesystem re-validation —
`markPackageUpdatingForCapability()` after it only re-checks the capability record and the
current row in memory. After a successful mutation,
`refreshPackageBaselineForCapability()` re-reads the manifest and rewrites the load-time
baseline so a following check compares against the *new* on-disk state instead of treating the
write itself as a staleness failure.

### The update fingerprint

`computeUpdateFingerprint()` decides whether a cached update result may be reused. For every
identity being checked, it groups by manifest, resolves the canonical location, and re-reads
the exact dependency spec currently on disk (`readCanonicalDependencySpecs()`). Each entry
becomes a sorted JSON tuple of `[canonicalManifestPath, section, packageName, spec-or-null,
'ok'-or-rejection-reason]`, combined with the effective policy (`target`, `includePreReleases`,
`minimumReleaseAgeDays`) into one string. `UpdateOrchestrationService.check()` computes this
twice: once before the NCU fetch, to decide whether the cache can be reused, and once more —
against the live, re-read policy — immediately before writing the freshly fetched result into
the cache. A mismatch discards the fetch as `'stale'` without caching it; an
`invalidateCache()` in between (tracked by a separate `cacheGeneration` counter) discards it as
`'invalidated'`. A mismatch means something about the on-disk manifests or the policy changed
while the fetch was in flight, so the fetch's answer no longer describes current state.

A cheaper debounce check runs first: if the cache's `policyKey` (package-file set plus policy)
still matches, the cache is within its 5-minute TTL, and `checkUpdatesDebounce` has not elapsed
since `lastCheckTime`, the check returns `'debounced'` without touching the fingerprint or the
network — unless `checkUpdatesForceAlways` is set, or the debounce is `0`.

### Write suppression

`withWriteSuppressed()` wraps every write a command makes to `package.json` so the watcher does
not react to the extension's own edit as an external change. Suppression is reference-counted
(`writeSuppressionDepth`), decremented only after a 600 ms timer fires on exit — not
immediately — so a burst of near-simultaneous writes never lets the watcher's debounce window
observe a gap. Every timer is tracked in `writeSuppressionTimers` and cleared in `dispose()`.
`registerPackageJsonWatcher()` checks `provider.suppressingWrites` before scheduling its own
debounced reload; the two debounce timers are independent mechanisms with similar durations.

### Atomic multi-file write and switch-collision no-write

`updateDependencyVersionsInFilesAtomically()` and `pinAllWorkspaceDependencyVersions()`
(`src/utils/packageReader.ts`) both go through `writeManyPreparedPackageFilesAtomically()`
(`src/utils/packageRepository.ts`): every file's new content is prepared up front (parse,
transform, re-serialize — a transform failure on file 3 of 5 never touches disk), then written
in order; if any write throws, every file written so far is restored, in reverse order, from
its captured original bytes. `pinAllWorkspaceDependencyVersions()` additionally skips a
manifest that fails to parse, naming it in the result, instead of aborting the whole run.

Switching a dependency's section (`switchDepTypeCommand()` → `switchDependencyType()` →
`transformDependencyType()`) never writes on a naming collision: `transformDependencyType()`
validates the source spec and the target section against the in-memory document and throws a
typed `DependencyTypeConflictError` before any part of the transform is applied — and before
`serializePackageJson()` or any write runs — if the
source spec no longer matches expectation, or the target section already declares the same
name. Because the throw happens before `writePreparedPackageFile()` is reached, a collision is
a true no-write: the manifest is untouched and the command surfaces the conflict as an error
instead of guessing which entry should win.

## 6. Async and partial results

Per-item work runs through `startRootOperations()`/`runRootOperations()`
(`src/utils/rootOperation.ts`), a shared layer over `OperationCoordinator` that gives every
outcome a stable, ordered, three-way status: `success`, `failure`, or `cancelled`
(`RootOperationResult<T>`). NCU still runs once per manifest, metadata requests are deduplicated
by package and registry, and audits run once per resolved `AuditProject`; the shared check
coordinator uses canonical project roots as keys where a project root is available. Results are
always in input order — a pre-sized array indexed by original item index, not settlement order.

`startRootOperations()` exposes two promises with different guarantees: `settled` resolves only
once every scheduled worker has actually finished, including workers still queued behind the
concurrency cap when cancellation happened — a cancelled queue never lets a queued item begin.
`result` resolves as soon as *either* `settled` resolves *or* the `AbortSignal` fires
(`Promise.race([settled, cancelled])`), the cancelled branch being a synthetic all-`cancelled`
array — letting a caller that only needs prompt cancellation stop waiting while workers keep
running in the background until they release their key/slot. `UpdateOrchestrationService` and
the provider's metadata fan-out use `.result`, since a cancelled check should return control to
the UI immediately. `AuditOrchestrationService.run()` uses `runRootOperations()` (always
`.settled`), since audit reporting needs the final per-project verdict including which projects
were genuinely cancelled.

**Cancel and reload mid-flight.** A reload aborts any in-flight update/audit operation
unconditionally, bumping the snapshot generation in the same call. Because every
result-application path checks `isUpdateCurrent()`/`isAuditCurrent()` (which include the
snapshot-generation comparison) before writing its outcome, a result arriving after a reload
superseded it is discarded rather than applied over the fresh snapshot — pinned by
*"discards an audit result after the package snapshot reloads"* and *"aborts an audit on reload
and never starts queued roots from the old snapshot"*. A **cancelled** predecessor's result
arriving *late*, after a newer operation has started or finished, must not clobber that newer
state either — pinned by *"keeps the current audit failure when a cancelled predecessor
succeeds late"* and its mirror (all in `packagesProvider.unit.test.ts`).

**Partial statuses.** `checkState` and `auditState` both carry an `'incomplete'` value distinct
from `'done'` (and, for `auditState`, from `'failed'`): a run with at least one successful and
one failed root is
`'incomplete'`, keeping whatever the successful roots produced
(`failedUpdatePaths`/`failedAuditPaths` record which did not) rather than discarding a
partially-successful run. This feeds the status rows before the package groups
(`projectStatusRows()`), recomputed on each tree read rather than cached, and surfaced through the
`openStatusReport`/`openAuditReport`
diagnostics output channels created in `activate()`.

## 7. Audit model

### Outcome taxonomy

Every audit-capable process runner returns one of four `AuditOutcome` kinds
(`src/utils/auditClient.ts`): `clean` (recognized schema, zero vulnerabilities, compatible exit
code), `advisories` (recognized schema, at least one vulnerability), `incomplete` (output
received but not trustworthy — see reasons below), or `error` (the process never produced
inspectable output). `incomplete`/`error` both throw `UnrecognizedAuditResultError` when
narrowed through `toAuditResult()`, so a caller cannot mistake either for a genuinely clean
result. `AuditIncompleteReason` enumerates: `empty-output`, `malformed-json`,
`unrecognized-schema`, `unexpected-exit`, `summary-mismatch`, `unknown-yarn-family`, and the
three a terminated process can never escape — `timeout`, `aborted`, `output-overflow`.

### Manager and schema contracts

| Manager | Command | Schema id(s) | Notes |
|---|---|---|---|
| npm / pnpm | `<cmd> audit --json` | `npm-v2-vulnerabilities`, `npm-v1-advisories` | Shared parser in `auditClient.ts`; exit `0`/`1` accepted only with a recognized schema; zero readable advisories with a positive summary total is `summary-mismatch` at any exit code, not clean. |
| Yarn Classic | `yarn audit --json` | `yarn-classic-audit` | `yarnAuditClient.ts`; NDJSON lines individually validated; the final `auditSummary`'s per-severity counts must match parsed advisories, and its bitmask must match the exit code, or the run is `incomplete`. |
| Yarn Modern | `yarn npm audit --all --recursive --json` | `yarn-modern-npm-audit` | Same file; requires empty `stderr`; empty stdout is clean only at exit `0`; advisory output requires exit `1`. |
| Bun | `bun audit --json` | `bun-bulk-advisory` | `bunAuditClient.ts`; parses the raw npm Bulk Advisory shape (`Record<packageName, Advisory[]>`); `{}` is clean only at exit `0`; any partially-shaped entry invalidates the whole payload. |

Which Yarn command family applies is resolved once per project root by `resolveYarnFamily()`
(`src/utils/yarnFamily.ts`), in order: the manifest's `packageManager` field (`yarn@<major>`),
then same-root markers considered as a set (`.yarnrc.yml`/a `__metadata:`-versioned
`yarn.lock` mean modern; `.yarnrc`/a `# yarn lockfile v1` header mean classic — both present is
`unknown`, never guessed), and only as a last resort a bounded `yarn --version` probe. Nothing
defaults to Classic; an unresolved family disables the Audit action entirely
(`PackagesProvider.isAuditableProject()`) rather than assuming a command shape.

### Bounded processes

Every audit command (npm/pnpm/Yarn/Bun) runs through `runBoundedProcess()`
(`src/utils/processRunner.ts`), which spawns the child in its own process group
(`detached: true` on posix) and enforces a hard timeout and a per-stream byte cap independently
of the child's behavior. On timeout, external abort, or overflow it signals the whole process
group, waits `killGracePeriodMs` (2 s default), and escalates to a forceful kill if still alive —
reaching grandchildren the npm/pnpm/yarn/bun wrappers commonly fork, which a plain `child.kill()`
would not. `AUDIT_PROCESS_TIMEOUT_MS` (120 s) and `AUDIT_PROCESS_MAX_BUFFER_BYTES` (20 MiB per
stream) remain the audit-command bounds. The fallback `yarn --version` family probe is separate:
`yarnFamily.ts` uses promisified `execFile` with a 5 s timeout and an 8 KiB `maxBuffer`; it does
not use `runBoundedProcess()`, a process-group kill, or an `AbortSignal`.

### Report building and sanitization

`AuditOrchestrationService.run()` resolves the project graph, runs one bounded audit per
project through `runRootOperations()`, and folds each outcome into an `AuditProjectSummary`
(kept even when row attribution is suppressed, so the report never loses a project's result)
and, where advisories exist, into `auditResults: Map<identityKey, AuditSeverity>` for row
badges. npm audit report v2 advisories carry no version field of their own, so
`enrichNpmV2AdvisoryVersions()` resolves one first by reading
`<projectRoot>/node_modules/<name>/package.json` through a bounded reader — a regular file
under a size cap, a value matching a plain semver pattern, and a realpath check placing the
read inside the project root — leaving the version unresolved on any failure. Row attribution
(`applyStructuredProjectAuditResults()`) only badges a row when an
advisory's `attribution` is `'direct'`, resolves to exactly one row by manifest and canonical
resolved path (`resolvedPathBelongsToManifest()`, itself gated on the project having exactly
one origin manifest), and the row's spec is compatible with the resolved version inside the
advisory's affected range. Any ambiguity — several manifests sharing a project, several rows
matching a resolved path, an unrecognized spec — leaves the advisory project-level only.

Three separate sanitizers exist for three audiences, each with its own policy rather than a
shared one: `sanitizeLogText()` (`src/utils/logger.ts`) for the output channel,
`sanitizePackageText()` (`src/providers/PackageItem.ts`) for tree labels (collapses newlines,
truncates to 240 characters), `sanitizeAuditText()` (`src/utils/auditReport.ts`) for the audit
report. `statusReport.ts` layers a fourth pass (`sanitizeReportText()`) on top of
`sanitizeLogText()` that substitutes known package-file paths with owner-qualified labels and
redacts any *unknown* absolute path outright, so a diagnostics report never leaks a filesystem
layout it cannot already explain.

## 8. Update-check model

### NCU integration

`fetchAllLatestVersions()` (`src/utils/ncuClient.ts`) dynamically imports `npm-check-updates`
on first use and calls its `run()` with `jsonUpgraded: true`, `removeRange: true`, a 60 s
`timeout`, and `cooldown` set to the resolved minimum-release-age days — NCU's own cooldown is
reused, though Nestro also independently classifies release age below for the "held back" UI
state and confirmation prompt. Each NCU run receives one manifest through the `packageFile`
option. The orchestration service schedules one run per manifest and uses the canonical project
root only as the shared check-coordinator key; two manifests that resolve to the same root are
still checked separately and serialized against each other.

### Metadata adapter tiers

Release-age classification and the version picker both need publish-time metadata beyond NCU,
fetched through `MetadataAdapterRegistry` (`src/utils/metadataRegistry.ts`). The registry tries
adapters in ascending `MetadataAdapterTier` order for the detected manager and cascades only
when the current tier could not answer (`shouldTryNextTier()`): cancellation and a definitive
HTTP status stop the chain immediately, and an outcome carrying a `privateRegistry` marker also
stops the chain rather than falling through to a different registry.

1. **`native-cli`** — `nativeCliMetadataAdapter` (npm/pnpm, `<cmd> view <pkg> --json`) and the
   two Yarn-family adapters in `yarnMetadataClient.ts` (`yarn info --json` Classic, `yarn npm
   info --json` Modern) all register here; a Yarn adapter whose expected family does not match
   the resolved family returns `unrecognized` without spawning a process.
2. **`config-aware-https`** — `fetchPackageMetadataFromRegistry()`
   (`src/utils/registryClient.ts`) resolves registry URL, auth, TLS and proxy settings from
   nested configuration sources (below) and issues one bounded HTTPS request. This tier also
   serves as the effective public-npm fallback: its default registry is
   `https://registry.npmjs.org/`, used whenever nothing overrides it.
3. **`public-npm`** — declared in the `MetadataAdapterTier` type with a tier-order slot, but no
   adapter is currently registered at it; `config-aware-https` already covers the public
   registry case, so only two tiers are populated in practice today. This is not a fallback
   slot: an unsupported or unstable response from a configured registry never falls through to
   the public registry (section 10).

### Registry configuration sources

`registryClient.ts` resolves, per manager, the nested configuration chain a real CLI would
honor: npm/pnpm read project-to-user `.npmrc` plus `npm_config_*` overrides; Yarn Classic reads
`.yarnrc`; Yarn Modern reads `.yarnrc.yml` including per-scope `npmScopes`; Bun reads
`bunfig.toml` (`src/utils/bunConfig.ts`) including environment-reference expansion and
credentials embedded in a registry URL. Every HTTPS request goes through
`runBoundedMetadataRequest()` (`src/utils/metadataRunner.ts`): a 15 s timeout, a 5 MiB response
cap, and redirects capped at `MAX_REGISTRY_REDIRECTS` (3), each confirmed same-origin before an
`Authorization` header survives it, and confirmed `https:` with no embedded credentials before
being followed at all.

### Release-age cooldown and prerelease policy

`readMinimumReleaseAgeDays()` (`src/utils/releaseAge.ts`) validates the configured value,
falling back to `DEFAULT_MINIMUM_RELEASE_AGE_DAYS` (7) for anything not a finite non-negative
integer within `MAX_MINIMUM_RELEASE_AGE_DAYS`; `0` is an explicit opt-out, not a fallback. At
`0`, classification short-circuits to `'accepted'` and the metadata fan-out is skipped
entirely. Otherwise `resolveUpdateReleaseAge()` classifies the accepted (NCU-selected) version
and the true `dist-tags.latest` independently: an accepted version still inside cooldown is
`held-back` even if `latest` has aged past it, and a newer `latest` still inside its own
cooldown surfaces as `held-back` metadata on top of an already-accepted older update — so the
UI can show "a newer release exists but is held back" without blocking the accepted one.
Missing or unparseable publish data classifies as `unknown`, deliberately distinct from
`held-back`: an `unknown` release age never blocks an update. Prereleases are opt-in via
`nestro.includePreReleases`, passed straight to NCU's `pre` option.

### Caching and debounce

Covered in detail in section 5 (the fingerprint). At the provider level, `checkUpdates()` is
itself a no-op while `checkState === 'running'`, independent of the cache — preventing two
clicks of the same button from racing before the fingerprint/debounce logic ever runs.

## 9. Invariants

Each invariant below is enforced by the mechanism described above and pinned by at least one
test (all under `src/test/`, path prefix omitted for brevity).

| Invariant | Pinned by |
|---|---|
| Two mutations on the same canonical project root never interleave their read-modify-write. | `operationCoordinator.unit.test.ts` — *"serializes two operations on the same key…"* |
| Independent project roots run concurrently, bounded by their coordinator's cap. | `operationCoordinator.unit.test.ts` — *"never lets more than `concurrencyCap` independent keys execute at once"*; `rootOperation.unit.test.ts` — *"bounds concurrent items at the given cap…"* |
| A coordinator key/slot is released on throw, never leaked. | `operationCoordinator.unit.test.ts` — *"releases the key lock when the operation throws…"* and its slot-release counterpart |
| Root operation results preserve input order regardless of settlement order. | `rootOperation.unit.test.ts` — *"returns results in input order even when later items finish first"* |
| A cancelled root operation never starts queued work. | `rootOperation.unit.test.ts` — *"cancels items still queued behind the cap once the signal aborts mid-run, without starting them"* |
| A manifest resolving outside its owning workspace is rejected, never treated as a project root. | `projectResolver.unit.test.ts` — *"rejects a project root whose canonical path escapes the owning workspace folder"* |
| Two manifests colliding across workspace folders never silently merge. | `projectResolver.unit.test.ts` — *"rejects a cross-workspace collision instead of silently merging two workspace folders"* |
| The update fingerprint mismatch discards a fetch instead of caching it. | `updateOrchestrationService.unit.test.ts` — *"discards as stale when the manifest spec changes mid-fetch…"*, *"discards as stale when the live policy changes mid-fetch"* |
| Metadata lookups are deduplicated and bounded, not fetched once per row. | `packagesProvider.unit.test.ts` — *"deduplicates metadata by package and registry while capping concurrent requests"* |
| A superseded audit/update result is discarded, never applied over a newer snapshot. | `packagesProvider.unit.test.ts` — *"discards an audit result after the package snapshot reloads"*, *"aborts an audit on reload and never starts queued roots from the old snapshot"* |
| A late result from a cancelled predecessor never overwrites the current operation's outcome. | `packagesProvider.unit.test.ts` — *"keeps the current audit failure when a cancelled predecessor succeeds late"* and its mirror |
| A multi-file write rolls back every already-written file, in reverse order, on failure. | `packageRepository.unit.test.ts` — *"rolls back only successfully written files in reverse order on failure"* |
| A dependency-type-switch collision writes nothing. | `packageTransforms.unit.test.ts` — *"throws a typed conflict when the target already has the package"* |
| An audit outcome with an unrecognized or truncated result is never reported as clean. | `auditClient.unit.test.ts`, `bunAuditClient.unit.test.ts`, `yarnAuditClient.unit.test.ts` — incomplete/error classification cases |
| A capability re-validated after a manifest changed underneath it fails closed, not stale-open. | `pinVersionInterleaving.unit.test.ts` — *"rejects a spec changed after final resolver validation without writing the fresh spec"*; `switchDepTypeInterleaving.unit.test.ts` (writer boundary: no write, no reload, typed conflict) |

### Never do this

- Cache the view projection or status rows in the provider; recompute them from the state
  snapshot on every read (`ownerLabels` is a deliberate, explicitly invalidated exception).
- Put `enablement` on a command that a tree item binds through `TreeItem.command`; gate row and
  overflow *visibility* with a `when` clause instead. Global `view/title` commands legitimately
  carry their own `enablement` (section 2).
- Mutate a manifest outside the mutation coordinator (`runExclusive()`, or `runManyExclusive()`
  for a bulk operation spanning several roots) on its canonical project root key.
- Write from a row-targeted command without re-validating the capability record before the write
  or the shell task (section 5 names the one remaining async gap); a workspace-wide command such as
  `pinAllVersionsCommand()` instead re-reads every manifest inside the lock.
- Fall through to the public npm registry when a configured registry answers with an unsupported
  or unstable document.
- Apply a fetched update result whose fingerprint no longer matches the manifests on disk.

## 10. Decision log

Choices the codebase makes deliberately, with the rejected alternative, so a future change does
not silently re-introduce it.

- **Keyed coordinator over a single global write lock.** A single lock would serialize
  unrelated monorepo packages for no correctness reason; the canonical project root is the same
  unit the audit and package-manager processes already operate on.
- **Two coordinator instances (mutation, check) instead of one shared instance.** A shared
  instance would serialize read-only checks against writes for no benefit — checks never
  corrupt `package.json` — while making every check wait behind the busiest write path's queue.
- **Yarn Classic and Modern as fully separate command/parser/adapter pairs, never a shared
  guess.** The earlier design always ran the Classic command and parsed whatever came back,
  which could report a Modern project as vulnerability-free simply because the wrong CLI syntax
  produced no usable output. Family resolution now fails closed (`unknown`, audit disabled)
  rather than defaulting to Classic.
- **Bun's bulk-advisory response parsed on its own schema, not folded into the npm parser.**
  Bun's raw registry shape is structurally different from npm's `vulnerabilities`/`advisories`
  objects; treating it as an unrecognized npm shape used to silently collapse to an empty map.
- **A switch-type collision is a no-write error, not an automatic overwrite or merge.** The
  target section already having an entry is evidence the caller's view is stale, not permission
  to pick a winner.
- **Minimum release age default is non-zero; `0` is an explicit opt-out, not the fallback for
  an invalid setting.** An invalid or unset value still resolves to the non-zero default, so a
  misconfiguration cannot silently disable the cooldown.
- **The config-aware HTTPS adapter is the terminal tier; an unstable or unsupported private
  registry response does not fall through to the public npm registry.** Silently reaching the
  public registry for a package a private registry could not answer risks resolving the wrong
  package identity across two registries; the version picker instead disables itself with an
  explanation.
- **Canonical project root must resolve inside its owning workspace folder; a symlink escape is
  rejected outright rather than trusted.** A project root outside the workspace would let audit
  or mutation commands operate on a directory the user never opened.
- **`untrustedWorkspaces`/`virtualWorkspaces` are declared unsupported** (`package.json`
  `capabilities`), rather than degrading gracefully inside either; Remote SSH and Containers
  remain supported because those run a normal workspace extension host with real filesystem
  semantics.
- **No cached view projection in the provider.** An earlier revision cached the computed
  tree projection until explicit invalidation; a reload's own field-assignment order created a
  real window where the cache and `allEntries` disagreed. `computeViewProjection()` is cheap
  enough to run on every `emitTreeChanged()` and every status-row read, so there is no cache to
  go stale.
- **Package-row context actions use `viewItem` conditions for visibility.** Global `view/title`
  actions may also appear in the title overflow and use their own `when` conditions alongside
  command `enablement` (section 2). For commands assigned through `TreeItem.command`, VS Code
  checks the enablement precondition when the row is clicked; `StatusItem` instead controls which
  command a row invokes — `nestro.openStatusReport`, `nestro.showFilterPicker`, or
  `nestro.searchPackages` — by setting or omitting the command property. None of the three carries
  `enablement`: a row-bound command must never be able to render clickable while its precondition
  is false.
- **The three text sanitizers stay separate rather than being consolidated into one.** Each
  serves a different audience with a different policy (log continuation lines, truncated tree
  labels, audit report text); merging them would touch each call site's already-reviewed
  behavior for a stylistic gain only, so the duplication is accepted deliberately.

## 11. Extension points

**Adding a package manager.** Extend `PackageManager` (`src/utils/packageManagerKind.ts`), add
its lock-file descriptor to `LOCKFILES`, implement a `Client` subclass in `src/clients/`
(section flag before the `--` operand separator, names/versions validated through
`operandValidation.ts` before shell-quoting), wire it into `ClientManager.createClient()`, add
an audit adapter following the `AuditResult`/`AuditOutcome` contract in `auditClient.ts` (own
schema id, bounded-process call, incomplete/error mapping), and add a metadata adapter at the
appropriate tier in `metadataRegistry.ts` if the manager exposes a native metadata command or a
distinct registry configuration format.

**Adding a command.** Declare the command id in `package.json` `contributes.commands` (an
internal-only command additionally gets a `commandPalette` entry with `"when": "false"`);
register it in `activate()`; if it targets a row, resolve identity through
`resolveCommandPackageItem()`/`revalidateCommandPackageItem()` (`src/commands/packageIdentity.ts`)
rather than trusting the raw argument; if it mutates `package.json`, acquire
`mutationCoordinator` on the row's `resolveMutationCoordinatorKey()` result and wrap the write
in `provider.withWriteSuppressed()`.

**Adding a status row.** Add a case to `projectStatusRows()` in `viewProjectionService.ts`
reading from the `ViewProjectionSnapshot` fields `buildViewProjectionSnapshot()` already
exposes; set `actionable: true` for a row that should open the diagnostics report, or an explicit
`command: { command, title }` for a row that should invoke a different existing command instead —
that command must carry no `"enablement"` in `package.json`; gate its visibility with `"when"`
only (section 2/9). Rows are ordered package-read/no-dependencies diagnostics, then check state,
then audit state, then the active Filter row, then the active Search row — `projectStatusRows()`
builds them in exactly that order and it is pinned by test; place a new row accordingly rather
than appending it unconditionally to the end. If the new row needs state the snapshot does not
yet carry, add the field to both the provider and `ViewProjectionSnapshot`, keeping the
projection a pure function of the snapshot.

**Adding a context key.** Add it to `VIEW_CONTEXT_KEYS` (`viewProjectionService.ts`), compute
its value inside `computeViewProjection()`, and reference it from a `"when"` clause in
`package.json` — never from `enablement` on a package-row context action (section 2). A key
gating a global action should be added to `WorkspaceCapabilities` and resolved inside
`PackagesProvider.resolveWorkspaceCapabilities()` alongside the existing `can*` fields, so it
shares the pre-first-load permissive default (`resolvePublishedWorkspaceCapabilities()`) and
the all-`false` reset on `dispose()`.
