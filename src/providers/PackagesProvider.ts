import * as path from 'path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ClientManager, resolveAuditProjects } from '../clients';
import type { AuditProject } from '../clients';
import {
  fetchAllLatestVersions,
  getUpdateType,
  getWorkspacePackageFilePaths,
  inferPathAttribution,
  logger,
  mergeAuditAdvisories,
  NcuUpdateTarget,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import type { AuditSeverity, UpdateType } from '../utils';
import type {
  AuditAdvisory,
  AuditPackageManager,
  AuditResult,
  AuditSchemaId,
} from '../utils';
import { LoadingItem } from './LoadingItem';
import { isPackageItem, PackageItem, sanitizePackageText } from './PackageItem';
import { PackageDetailItem } from './PackageDetailItem';
import { GroupItem } from './GroupItem';
import { StatusItem } from './StatusItem';
import { FilterManager, FilterType } from './FilterManager';
import { buildTree, getFilterCounts, getFilteredEntries, PackageTreeEntry, toWorkspaceFolderDescriptors } from './treeBuilder';
import type { WorkspaceFolderDescriptor } from './treeBuilder';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';
import {
  packageIdentityFromValues,
  packageIdentityKey,
  readCanonicalDependencySpec,
  readCanonicalDependencySpecs,
  resolveCanonicalPackageLocation,
  samePackageFileStamp,
} from './packageIdentity';
import type {
  CanonicalPackageItem,
  CanonicalPackageLocation,
  PackageIdentityResolution,
  PackageIdentityTuple,
  PackageItemRecord,
  ResolvedPackageItem,
} from './packageIdentity';

export type PackageStateIdentity = PackageIdentityTuple;
export { PACKAGE_IDENTITY_REJECTED_MESSAGE } from './packageIdentity';
export type { PackageIdentityResolution, ResolvedPackageItem } from './packageIdentity';

/**
 * One resolved audit project (canonical root, lockfile, origin manifests) together with
 * the raw vulnerability map its audit run produced. Kept project-level, not flattened
 * into row badges, so the full result and origin manifest set survive even when row
 * attribution is suppressed below and can back a structured, resolved-path-aware report.
 */
export interface AuditProjectSummary {
  readonly project: AuditProject;
  readonly status: 'success' | 'failure';
  readonly manager: AuditPackageManager;
  readonly schema?: AuditSchemaId;
  readonly vulnerabilities: ReadonlyMap<string, AuditSeverity>;
  readonly advisories: readonly AuditAdvisory[];
  readonly failure?: {
    readonly reason: string;
    readonly detail: string;
  };
}

export interface AuditProjectFailure {
  readonly project?: AuditProject;
  readonly packageFilePaths: readonly string[];
  readonly manager?: AuditPackageManager;
  readonly reason: string;
  readonly detail: string;
}

export interface AuditReportSnapshot {
  readonly projects: readonly AuditProjectSummary[];
  readonly failures: readonly AuditProjectFailure[];
}

type UpdateFetchResult
  = | { readonly accepted: true; readonly data: ReadonlyMap<string, string> }
    | { readonly accepted: false };

interface AuditOperation {
  readonly generation: number;
  readonly snapshotGeneration: number;
  readonly abortController: AbortController;
}

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly filterChangeDisposable: vscode.Disposable;
  private allEntries: PackageTreeEntry[] = [];
  private packageFilePaths: string[] = [];
  private packageLocationBaselines = new Map<string, CanonicalPackageLocation>();
  private readonly packageItemRecords = new WeakMap<PackageItem, PackageItemRecord>();
  private readonly packageCapabilityRecords = new WeakMap<object, {
    readonly sourceItem: PackageItem;
    readonly identity: PackageIdentityTuple;
    readonly packageFilePath: string;
    readonly packageDirectory: string;
    readonly workspaceFolderPath: string;
    readonly fileStamp: ResolvedPackageItem['fileStamp'];
    readonly manifestDigest: string;
    readonly snapshotGeneration: number;
  }>();

  private packageSnapshotGeneration = 0;
  /**
   * Owns cancellation for the in-flight `loadPackages()` run. A new run aborts the
   * previous one immediately; `dispose()` aborts it too, which the snapshot generation
   * alone cannot express since disposal does not advance the generation counter.
   */
  private loadAbortController: AbortController | undefined;
  private loading = true;
  private writeSuppressionDepth = 0;
  private readonly writeSuppressionTimers = new Set<ReturnType<typeof setTimeout>>();
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
  private auditResults: Map<string, AuditSeverity> = new Map();
  private auditProjects: AuditProjectSummary[] = [];
  private auditFailures: AuditProjectFailure[] = [];
  private checkState: 'idle' | 'running' | 'done' = 'idle';
  private lastCheckTime: Date | undefined;
  private auditState: 'idle' | 'running' | 'done' | 'incomplete' = 'idle';
  /**
   * Owns the current audit generation and its cancellation for one run. A completed or
   * superseded run cannot clear a replacement operation through this identity boundary.
   */
  private auditGeneration = 0;
  private auditOperation: AuditOperation | undefined;
  private lastAuditCount: number | undefined;
  private lastAuditSuccessfulRootCount: number | undefined;
  private failedAuditPaths: string[] = [];
  private failedPackageReadPaths: string[] = [];
  private readonly clientManager = new ClientManager();
  private updateCache: {
    data: Map<string, string>;
    timestamp: number;
    policyKey: string;
    fingerprint: string;
  } | undefined;

  constructor(private readonly filterManager: FilterManager) {
    this.filterChangeDisposable = this.filterManager.onDidChange(() => this.emitTreeChanged());
  }

  attachTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.treeView = treeView;
    this.updateTreeViewState();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (this.loading) {
      return element ? [] : [...this.buildStatusItems(), new LoadingItem()];
    }
    if (element instanceof GroupItem) {
      return element.children;
    }
    if (element instanceof StatusItem) {
      return [];
    }
    if (element instanceof WorkspaceFolderItem) {
      return element.children;
    }
    if (element instanceof PackageItem) {
      return this.getPackageDetails(element);
    }
    return [...this.buildStatusItems(), ...buildTree(
      this.allEntries,
      this.filterManager.current,
      this.filterManager.search,
      this.workspaceFolderDescriptors,
      this.packageFilePaths,
    )];
  }

  setFilter(type: FilterType): void {
    this.filterManager.set(type);
  }

  async showSearch(): Promise<void> {
    await this.filterManager.showSearch();
  }

  clearSearch(): void {
    this.filterManager.clearSearch();
  }

  get suppressingWrites(): boolean {
    return this.writeSuppressionDepth > 0;
  }

  async withWriteSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.writeSuppressionDepth += 1;
    try {
      const result = await fn();
      this.invalidateUpdateCache();
      return result;
    }
    finally {
      const timer = setTimeout(() => {
        this.writeSuppressionTimers.delete(timer);
        this.writeSuppressionDepth = Math.max(0, this.writeSuppressionDepth - 1);
      }, 600);
      this.writeSuppressionTimers.add(timer);
    }
  }

  /**
   * Resolve a rendered row against this provider's current snapshot and canonical
   * workspace filesystem. Tuple matching is mandatory; the object reference is only a
   * freshness check after the tuple has selected exactly one current row. No caller path,
   * name, version, or section is used by command mutations after this method returns.
   */
  async resolvePackageItem(value: unknown): Promise<PackageIdentityResolution> {
    let item: PackageItem;
    try {
      if (!isPackageItem(value)) {
        return { ok: false, reason: 'invalid-item' };
      }
      item = value;
    }
    catch {
      return { ok: false, reason: 'invalid-item' };
    }

    const record = this.packageItemRecords.get(item);
    if (record === undefined) {
      return { ok: false, reason: 'not-current' };
    }

    const { identity } = record;
    const generation = this.packageSnapshotGeneration;
    const entry = this.findCurrentEntry(identity, item);
    if (this.loading || entry === undefined) {
      return { ok: false, reason: 'not-current' };
    }

    const location = await resolveCanonicalPackageLocation(identity.packageFilePath);
    if (!location.ok) {
      return location;
    }
    if (record.baselineLocation === undefined
      || !sameCanonicalPackageLocation(record.baselineLocation, location.value)) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (await readCanonicalDependencySpec(location.value, identity) !== record.row.currentVersion) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (generation !== this.packageSnapshotGeneration || this.findCurrentEntry(identity, item) === undefined) {
      return { ok: false, reason: 'not-current' };
    }

    return this.issuePackageCapability(item, record, location.value, generation);
  }

  /**
   * Re-check a previously resolved capability immediately before a write or task. This
   * closes the async realpath check/use window as far as the extension boundary allows:
   * generation, exact tuple/current row, owning workspace, canonical path, and manifest
   * file stamp must all remain unchanged. Filesystem atomicity against an external actor
   * after this final check is intentionally not claimed.
   */
  async revalidatePackageItem(value: ResolvedPackageItem): Promise<PackageIdentityResolution> {
    let capabilityRecord: {
      readonly sourceItem: PackageItem;
      readonly identity: PackageIdentityTuple;
      readonly packageFilePath: string;
      readonly packageDirectory: string;
      readonly workspaceFolderPath: string;
      readonly fileStamp: ResolvedPackageItem['fileStamp'];
      readonly manifestDigest: string;
      readonly snapshotGeneration: number;
    } | undefined;
    try {
      capabilityRecord = typeof value === 'object' && value !== null
        ? this.packageCapabilityRecords.get(value)
        : undefined;
    }
    catch {
      return { ok: false, reason: 'invalid-item' };
    }
    if (capabilityRecord === undefined) {
      return { ok: false, reason: 'invalid-item' };
    }

    const { sourceItem, identity, snapshotGeneration } = capabilityRecord;
    if (this.loading
      || snapshotGeneration !== this.packageSnapshotGeneration
      || this.findCurrentEntry(identity, sourceItem) === undefined) {
      return { ok: false, reason: 'not-current' };
    }

    const location = await resolveCanonicalPackageLocation(identity.packageFilePath);
    if (!location.ok) {
      return location;
    }
    const sourceRecord = this.packageItemRecords.get(sourceItem);
    if (sourceRecord?.baselineLocation === undefined
      || !sameCanonicalPackageLocation(sourceRecord.baselineLocation, location.value)) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (await readCanonicalDependencySpec(location.value, identity) !== sourceRecord.row.currentVersion) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (this.loading
      || snapshotGeneration !== this.packageSnapshotGeneration
      || this.findCurrentEntry(identity, sourceItem) === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    if (location.value.packageFilePath !== capabilityRecord.packageFilePath
      || location.value.packageDirectory !== capabilityRecord.packageDirectory
      || location.value.workspaceFolderPath !== capabilityRecord.workspaceFolderPath
      || location.value.manifestDigest !== capabilityRecord.manifestDigest
      || !samePackageFileStamp(location.value.fileStamp, capabilityRecord.fileStamp)) {
      return { ok: false, reason: 'path-replaced' };
    }

    const record = this.packageItemRecords.get(sourceItem);
    if (record === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    return this.issuePackageCapability(sourceItem, record, location.value, snapshotGeneration);
  }

  /**
   * Project-level audit results from the most recent run, keyed by canonical project
   * root rather than by row. Row badges may be suppressed for ambiguous multi-manifest
   * or duplicate-name matches (see `applyProjectAuditResults()`), but the underlying
   * project result and its origin manifest set are always kept here.
   */
  getAuditProjects(): readonly AuditProjectSummary[] {
    return this.auditProjects.map(summary => this.cloneAuditProjectSummary(summary));
  }

  getAuditFailures(): readonly AuditProjectFailure[] {
    return this.auditFailures.map(failure => this.cloneAuditProjectFailure(failure));
  }

  getAuditReport(): AuditReportSnapshot {
    return {
      projects: this.getAuditProjects(),
      failures: this.getAuditFailures(),
    };
  }

  getVisibleOutdatedPackages(): PackageItem[] {
    if (this.loading) {
      return [];
    }
    return getFilteredEntries(this.allEntries, this.filterManager.current, this.filterManager.search)
      .map(entry => entry.item)
      .filter(item => item.updateType !== 'none' && item.latest !== undefined && !item.installing);
  }

  markPackageUpdated(identity: PackageStateIdentity, newVersion: string): void {
    const index = this.findEntryIndex(identity);
    if (index === -1) {
      return;
    }

    const { dev, packageFilePath: entryPackageFilePath, item } = this.allEntries[index];
    this.allEntries[index] = {
      item: this.createPackageItem(
        identity.packageName,
        item.versionPrefix + newVersion,
        undefined,
        'none',
        false,
        entryPackageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath: entryPackageFilePath,
    };
    this.emitTreeChanged();
  }

  /** Mark a package row only when the provider-issued capability still owns the current row. */
  markPackageUpdatedForCapability(capability: ResolvedPackageItem, newVersion: string): void {
    const record = this.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return;
    }
    const index = this.findEntryIndex(record.identity);
    const entry = index === -1 ? undefined : this.allEntries[index];
    const currentRecord = entry === undefined ? undefined : this.packageItemRecords.get(entry.item);
    if (entry === undefined || currentRecord === undefined) {
      return;
    }
    const row = currentRecord.row;
    this.allEntries[index] = {
      item: this.createPackageItem(
        row.packageName,
        row.versionPrefix + newVersion,
        undefined,
        'none',
        false,
        row.packageFilePath,
        row.dev,
        row.versionPrefix,
      ),
      dev: row.dev,
      packageFilePath: row.packageFilePath,
    };
    this.emitTreeChanged();
  }

  resetUpdateData(): void {
    this.invalidateUpdateCache();
    this.allEntries = this.allEntries.map(({ item, dev, packageFilePath }) => ({
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        undefined,
        'none',
        item.installing,
        packageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath,
    }));
    this.emitTreeChanged();
  }

  invalidateUpdateCache(): void {
    this.updateCache = undefined;
    this.lastCheckTime = undefined;
    logger.info('Update cache invalidated.');
  }

  markPackageUpdating(identity: PackageStateIdentity, installing: boolean): void {
    const index = this.findEntryIndex(identity);
    if (index === -1) {
      return;
    }

    const { item, dev, packageFilePath: entryPackageFilePath } = this.allEntries[index];
    const updateType = installing || item.latest === undefined
      ? item.updateType
      : getUpdateType(item.currentVersion, item.latest);
    this.allEntries[index] = {
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        item.latest,
        updateType,
        installing,
        entryPackageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath: entryPackageFilePath,
    };
    this.emitTreeChanged();
  }

  /**
   * Update progress and issue a replacement capability for the newly rendered row.
   * The replacement is required because progress updates intentionally replace the
   * PackageItem object, making the previous capability stale.
   */
  markPackageUpdatingForCapability(
    capability: ResolvedPackageItem,
    installing: boolean,
  ): ResolvedPackageItem | undefined {
    const record = this.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return undefined;
    }
    const index = this.findEntryIndex(record.identity);
    const currentEntry = index === -1 ? undefined : this.allEntries[index];
    const currentRecord = currentEntry === undefined
      ? undefined
      : this.packageItemRecords.get(currentEntry.item);
    if (currentEntry === undefined || currentRecord === undefined) {
      return undefined;
    }
    const generation = this.packageSnapshotGeneration;
    const previousEntry = currentEntry;
    const previousRecord = currentRecord;
    const row = currentRecord.row;
    const updateType = installing || row.latest === undefined
      ? row.updateType
      : getUpdateType(row.currentVersion, row.latest);
    this.allEntries[index] = {
      item: this.createPackageItem(
        row.packageName,
        row.currentVersion,
        row.latest,
        updateType,
        installing,
        row.packageFilePath,
        row.dev,
        row.versionPrefix,
      ),
      dev: row.dev,
      packageFilePath: row.packageFilePath,
    };
    this.emitTreeChanged();
    const replacementEntry = this.allEntries[index];
    if (replacementEntry === undefined
      || generation !== this.packageSnapshotGeneration
      || this.loading
      || this.findCurrentEntry(record.identity, replacementEntry.item) === undefined) {
      this.restorePackageEntryAfterProgressRace(record.identity, index, previousEntry, previousRecord);
      return undefined;
    }
    const replacementRecord = this.packageItemRecords.get(replacementEntry.item);
    if (replacementRecord === undefined) {
      return undefined;
    }
    return this.issuePackageCapability(
      replacementEntry.item,
      replacementRecord,
      {
        packageFilePath: record.packageFilePath,
        packageDirectory: record.packageDirectory,
        workspaceFolderPath: record.workspaceFolderPath,
        fileStamp: record.fileStamp,
        manifestDigest: record.manifestDigest,
      },
      this.packageSnapshotGeneration,
    ).value;
  }

  private restorePackageEntryAfterProgressRace(
    identity: PackageIdentityTuple,
    originalIndex: number,
    originalEntry: PackageTreeEntry,
    originalRecord: PackageItemRecord,
  ): void {
    const currentEntry = this.allEntries[originalIndex];
    if (currentEntry?.item === originalEntry.item || currentEntry?.item === undefined) {
      this.allEntries[originalIndex] = originalEntry;
      this.packageItemRecords.set(originalEntry.item, originalRecord);
    }
    else {
      const currentIndex = this.findEntryIndex(identity);
      const entry = currentIndex === -1 ? undefined : this.allEntries[currentIndex];
      const record = entry === undefined ? undefined : this.packageItemRecords.get(entry.item);
      if (entry !== undefined && record !== undefined) {
        const row = record.row;
        this.allEntries[currentIndex] = {
          item: this.createPackageItem(
            row.packageName,
            row.currentVersion,
            row.latest,
            row.updateType,
            originalRecord.row.installing,
            row.packageFilePath,
            row.dev,
            row.versionPrefix,
          ),
          dev: row.dev,
          packageFilePath: row.packageFilePath,
        };
      }
    }
    this.emitTreeChanged();
  }

  /** Refresh the load-time manifest baseline after a mutation this provider authorized. */
  async refreshPackageBaselineForCapability(
    capability: ResolvedPackageItem,
    expectedCurrentVersion: string,
  ): Promise<ResolvedPackageItem | undefined> {
    const record = this.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return undefined;
    }
    const location = await resolveCanonicalPackageLocation(record.identity.packageFilePath);
    if (!location.ok
      || location.value.packageFilePath !== record.packageFilePath
      || location.value.packageDirectory !== record.packageDirectory
      || location.value.workspaceFolderPath !== record.workspaceFolderPath) {
      return undefined;
    }
    if (await readCanonicalDependencySpec(location.value, record.identity) !== expectedCurrentVersion) {
      return undefined;
    }
    if (this.loading
      || record.snapshotGeneration !== this.packageSnapshotGeneration
      || this.findCurrentEntry(record.identity, record.sourceItem) === undefined) {
      return undefined;
    }

    const baselineLocation = Object.freeze({
      ...location.value,
      fileStamp: Object.freeze({ ...location.value.fileStamp }),
    });
    this.packageLocationBaselines.set(record.identity.packageFilePath, baselineLocation);
    for (const entry of this.allEntries) {
      const entryRecord = this.packageItemRecords.get(entry.item);
      if (entryRecord?.identity.packageFilePath === record.identity.packageFilePath) {
        this.packageItemRecords.set(entry.item, Object.freeze({
          ...entryRecord,
          baselineLocation,
        }));
      }
    }
    const currentEntry = this.findCurrentEntry(record.identity, record.sourceItem);
    const currentRecord = currentEntry === undefined
      ? undefined
      : this.packageItemRecords.get(currentEntry.item);
    if (currentEntry === undefined || currentRecord === undefined) {
      return undefined;
    }
    return this.issuePackageCapability(currentEntry.item, currentRecord, location.value, this.packageSnapshotGeneration).value;
  }

  /** Re-issue a current capability after an authorized sibling-row mutation refreshed its baseline. */
  async reissuePackageCapability(
    capability: ResolvedPackageItem,
  ): Promise<ResolvedPackageItem | undefined> {
    const record = this.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return undefined;
    }
    const location = await resolveCanonicalPackageLocation(record.identity.packageFilePath);
    if (!location.ok) {
      return undefined;
    }
    const sourceRecord = this.packageItemRecords.get(record.sourceItem);
    if (sourceRecord?.baselineLocation === undefined
      || !sameCanonicalPackageLocation(sourceRecord.baselineLocation, location.value)
      || await readCanonicalDependencySpec(location.value, record.identity) !== sourceRecord.row.currentVersion) {
      return undefined;
    }
    if (this.loading
      || record.snapshotGeneration !== this.packageSnapshotGeneration
      || this.findCurrentEntry(record.identity, record.sourceItem) === undefined) {
      return undefined;
    }
    return this.issuePackageCapability(record.sourceItem, sourceRecord, location.value, record.snapshotGeneration).value;
  }

  async showFilterPicker(): Promise<void> {
    if (this.allEntries.length === 0) {
      return;
    }
    await this.filterManager.showPicker(getFilterCounts(this.allEntries));
  }

  async loadPackages(): Promise<void> {
    logger.info('Loading workspace packages.');
    const snapshotGeneration = this.packageSnapshotGeneration + 1;
    this.packageSnapshotGeneration = snapshotGeneration;
    this.loadAbortController?.abort();
    const abortController = new AbortController();
    this.loadAbortController = abortController;
    this.packageLocationBaselines = new Map();
    this.loading = true;
    // A reload must not clear another operation's own running guard; only reset audit
    // state when no audit is currently in flight for it to own.
    if (this.auditState !== 'running') {
      this.auditResults = new Map();
      this.auditProjects = [];
      this.auditFailures = [];
      this.auditState = 'idle';
      this.lastAuditCount = undefined;
      this.lastAuditSuccessfulRootCount = undefined;
      this.failedAuditPaths = [];
    }
    this.failedPackageReadPaths = [];
    this.emitTreeChanged();
    try {
      const entries = await readAllWorkspaceDependencies();
      const packageFilePaths = [...new Set(entries.map(entry => entry.packageFilePath))];
      if (entries.length > 0) {
        try {
          const discoveredPackageFilePaths = await getWorkspacePackageFilePaths();
          packageFilePaths.push(...discoveredPackageFilePaths.filter(
            packageFilePath => !packageFilePaths.includes(packageFilePath),
          ));
        }
        catch {
          logger.warn('Failed to discover workspace package files for labels; using loaded package entries.');
        }
      }
      const baselines = new Map<string, CanonicalPackageLocation>();
      const canonicalManifestOwners = new Map<string, string>();
      const collidingManifestPaths = new Set<string>();
      for (const packageFilePath of new Set(entries.map(entry => entry.packageFilePath))) {
        const location = await resolveCanonicalPackageLocation(packageFilePath);
        if (this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
          return;
        }
        if (location.ok) {
          const canonicalOwner = canonicalManifestOwners.get(location.value.packageFilePath);
          if (canonicalOwner !== undefined && canonicalOwner !== packageFilePath) {
            collidingManifestPaths.add(canonicalOwner);
            collidingManifestPaths.add(packageFilePath);
            baselines.delete(canonicalOwner);
            baselines.delete(packageFilePath);
            continue;
          }
          canonicalManifestOwners.set(location.value.packageFilePath, packageFilePath);
          if (!collidingManifestPaths.has(packageFilePath)) {
            baselines.set(packageFilePath, freezePackageLocation(location.value));
          }
        }
      }
      if (this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
        return;
      }
      this.packageLocationBaselines = baselines;
      this.packageFilePaths = packageFilePaths;
      this.failedPackageReadPaths = (entries.skippedFiles ?? []).map(file => file.packageFilePath);
      logger.info(`Loaded ${entries.length} workspace package(s).`);
      const existingMap = new Map(this.allEntries.map(e => [
        this.packageStateKey({
          packageName: e.item.packageName,
          packageFilePath: e.packageFilePath,
          section: e.dev ? 'devDependencies' : 'dependencies',
        }),
        e,
      ]));
      this.allEntries = entries.map((e) => {
        const existing = existingMap.get(this.packageStateKey({
          packageName: e.name,
          packageFilePath: e.packageFilePath,
          section: e.dev ? 'devDependencies' : 'dependencies',
        }));
        // Compare bare semver (strip prefix) so that a pin operation (^1.2.3 → 1.2.3)
        // preserves existing update data rather than resetting it to 'none'.
        const existingSemver = existing?.item.currentVersion.slice(existing.item.versionPrefix.length);
        const newSemver = e.current.slice(e.versionPrefix.length);
        const preserveExistingUpdateState = existing !== undefined
          && (existing.item.installing || existingSemver === newSemver);
        if (preserveExistingUpdateState) {
          return {
            item: this.createPackageItem(
              e.name,
              e.current,
              existing.item.latest,
              existing.item.updateType,
              existing.item.installing,
              e.packageFilePath,
              e.dev,
              e.versionPrefix,
            ),
            dev: e.dev,
            packageFilePath: e.packageFilePath,
          };
        }
        return {
          item: this.createPackageItem(e.name, e.current, undefined, 'none', false, e.packageFilePath, e.dev, e.versionPrefix),
          dev: e.dev,
          packageFilePath: e.packageFilePath,
        };
      });
    }
    catch (err) {
      if (this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
        return;
      }
      this.packageLocationBaselines = new Map();
      showError(`failed to load packages — ${err instanceof Error ? err.message : String(err)}`, err);
    }
    finally {
      if (!this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
        this.loading = false;
        this.emitTreeChanged();
      }
      if (this.loadAbortController === abortController) {
        this.loadAbortController = undefined;
      }
    }
  }

  async checkUpdates(): Promise<void> {
    if (this.checkState === 'running') {
      return;
    }

    const snapshotGeneration = this.packageSnapshotGeneration;
    this.checkState = 'running';
    this.emitTreeChanged();
    try {
      const config = vscode.workspace.getConfiguration('nestro');
      const forceAlways = config.get<boolean>('checkUpdatesForceAlways', false);
      const includePreReleases = config.get<boolean>('includePreReleases', false);
      const target = config.get<NcuUpdateTarget>('updateTarget', 'latest');
      const source = this.allEntries.length > 0
        ? this.allEntries.map(e => ({
            name: e.item.packageName,
            current: e.item.currentVersion,
            dev: e.dev,
            versionPrefix: e.item.versionPrefix,
            packageFilePath: e.packageFilePath,
          }))
        : await this.readPackagesForUpdateCheck();
      const packageFiles = [...new Set(source.map(entry => entry.packageFilePath))];
      const identities = source.map(entry => packageIdentityFromValues(entry.name, entry.packageFilePath, entry.dev));
      // The debounce gate uses the cheap policy/file-set key: reading every manifest to
      // decide whether to skip a run would cost more than the run being skipped.
      const policyKey = this.updatePolicyKey(packageFiles, target, includePreReleases);
      if (!forceAlways && this.isCachePolicyCurrent(policyKey) && this.lastCheckTime !== undefined) {
        const debounceSec = config.get<number>('checkUpdatesDebounce', 60);
        if (debounceSec > 0 && Date.now() - this.lastCheckTime.getTime() < debounceSec * 1000) {
          logger.info('Check for updates skipped — debounce interval has not elapsed.');
          this.checkState = 'done';
          return;
        }
      }
      const fingerprint = await this.computeUpdateFingerprint(identities, target, includePreReleases);
      const cacheValid = this.isCacheValid(fingerprint);
      logger.info('Checking package updates.');
      logger.info(`Checking updates for ${source.length} package(s).`);
      let upgrades: ReadonlyMap<string, string>;
      if (!forceAlways && cacheValid) {
        upgrades = this.updateCache?.data ?? new Map<string, string>();
      }
      else {
        const fetchResult = await this.fetchAndCacheUpdates(
          identities,
          packageFiles,
          target,
          includePreReleases,
          policyKey,
          fingerprint,
          snapshotGeneration,
        );
        if (!fetchResult.accepted) {
          this.checkState = 'idle';
          return;
        }
        upgrades = fetchResult.data;
      }
      if (snapshotGeneration !== this.packageSnapshotGeneration) {
        this.checkState = 'idle';
        return;
      }
      const liveEntries = this.allEntries.length > 0
        ? this.allEntries
        : source.map(entry => ({
            item: this.createPackageItem(
              entry.name,
              entry.current,
              undefined,
              'none',
              false,
              entry.packageFilePath,
              entry.dev,
              entry.versionPrefix,
            ),
            dev: entry.dev,
            packageFilePath: entry.packageFilePath,
          }));
      this.allEntries = liveEntries.map(({ item, dev, packageFilePath }) => {
        const latest = upgrades.get(this.entryKey(item.packageName, packageFilePath));
        const updateType = latest === undefined ? 'none' : getUpdateType(item.currentVersion, latest);
        return {
          item: this.createPackageItem(
            item.packageName,
            item.currentVersion,
            latest,
            updateType,
            item.installing,
            packageFilePath,
            dev,
            item.versionPrefix,
          ),
          dev,
          packageFilePath,
        };
      });
      logger.info(`Checked updates for ${source.length} package(s).`);
      this.checkState = 'done';
      this.lastCheckTime = new Date();
    }
    catch (err) {
      this.checkState = 'idle';
      showError(`failed to check updates — ${err instanceof Error ? err.message : String(err)}`, err);
    }
    finally {
      this.emitTreeChanged();
    }
  }

  dispose(): void {
    for (const timer of this.writeSuppressionTimers) {
      clearTimeout(timer);
    }
    this.writeSuppressionTimers.clear();
    this.writeSuppressionDepth = 0;
    this.loadAbortController?.abort();
    this.cancelAudit();
    this.filterChangeDisposable.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Cancels the in-flight audit run, if any. Resets the busy state synchronously — before
   * the aborted `client.runAudit()` call settles — so a caller never observes a stale
   * "running" state while process teardown is still happening. A no-op when idle.
   */
  cancelAudit(): void {
    const operation = this.auditOperation;
    if (this.auditState !== 'running' || operation === undefined) {
      return;
    }
    operation.abortController.abort();
    this.auditState = 'idle';
    this.emitTreeChanged();
  }

  async runAudit(): Promise<void> {
    if (this.auditState === 'running') {
      return;
    }

    this.auditState = 'running';
    this.lastAuditSuccessfulRootCount = undefined;
    this.failedAuditPaths = [];
    // Cleared here, not just on success below, so getAuditProjects() never hands back a
    // previous run's stale projects while this run is in progress, after an early exit
    // with no package files, or after an exception.
    this.auditProjects = [];
    this.auditFailures = [];
    // Clear row-scoped evidence atomically with the report snapshot. Rebuild before
    // discovery/resolution so a failed new run cannot leave badges from the previous run.
    this.auditResults = new Map();
    this.rebuildPackageItems();
    const operation: AuditOperation = {
      generation: this.auditGeneration + 1,
      snapshotGeneration: this.packageSnapshotGeneration,
      abortController: new AbortController(),
    };
    this.auditGeneration = operation.generation;
    this.auditOperation = operation;
    let shouldEmit = false;
    this.emitTreeChanged();

    try {
      const packageFilePaths = await this.getKnownPackageFilePaths();
      if (!this.isAuditCurrent(operation)) {
        return;
      }
      if (packageFilePaths.length === 0) {
        this.auditState = 'idle';
        shouldEmit = true;
        return;
      }

      // Canonical project graph: manifests sharing a lock file resolve to the same
      // project root and are audited exactly once. Rejected manifests — no owning
      // workspace, or a workspace-escaping root — never reach a client at all.
      const { projects, rejected } = await resolveAuditProjects(packageFilePaths);
      if (!this.isAuditCurrent(operation)) {
        return;
      }

      const auditResults = new Map<string, AuditSeverity>();
      const auditProjects: AuditProjectSummary[] = [];
      const auditFailures: AuditProjectFailure[] = rejected.map(rejection => ({
        packageFilePaths: [rejection.packageFilePath],
        reason: rejection.reason,
        detail: rejection.detail,
      }));
      const failedAuditPaths: string[] = rejected.map(rejection => rejection.packageFilePath);
      let successfulAuditRootCount = 0;
      let failedProjectCount = 0;
      for (const project of projects) {
        if (!this.isAuditCurrent(operation)) {
          return;
        }
        try {
          const client = this.clientManager.createClient(project.packageManager, project.projectRoot);
          const reportRunner = client as unknown as {
            runAuditReport?: (signal?: AbortSignal) => Promise<unknown>;
          };
          const rawResult = typeof reportRunner.runAuditReport === 'function'
            ? await reportRunner.runAuditReport(operation.abortController.signal)
            : await client.runAudit(operation.abortController.signal);
          if (!this.isAuditCurrent(operation)) {
            return;
          }
          successfulAuditRootCount += 1;
          if (this.isAuditResult(rawResult)) {
            const advisories = mergeAuditAdvisories(rawResult.advisories);
            auditProjects.push({
              project,
              status: 'success',
              manager: rawResult.manager,
              schema: rawResult.schema,
              vulnerabilities: new Map(rawResult.vulnerabilities),
              advisories: advisories.map(advisory => cloneAdvisorySnapshot(advisory)),
            });
            await this.applyStructuredProjectAuditResults(project, advisories, auditResults);
            if (!this.isAuditCurrent(operation)) {
              return;
            }
          }
          else if (rawResult instanceof Map) {
            const vulnerabilities = new Map(rawResult as Map<string, AuditSeverity>);
            auditProjects.push({
              project,
              status: 'success',
              manager: project.packageManager,
              vulnerabilities,
              advisories: [],
            });
            this.applyLegacyProjectAuditResults(project, vulnerabilities, auditResults);
          }
          else {
            throw new Error('Audit client returned an unrecognized audit result.');
          }
        }
        catch (err) {
          if (!this.isAuditCurrent(operation)) {
            return;
          }
          failedAuditPaths.push(...project.originManifests);
          const failure = describeAuditFailure(err);
          auditProjects.push({
            project,
            status: 'failure',
            manager: project.packageManager,
            vulnerabilities: new Map(),
            advisories: [],
            failure,
          });
          auditFailures.push({
            project,
            packageFilePaths: [...project.originManifests],
            manager: project.packageManager,
            reason: failure.reason,
            detail: failure.detail,
          });
          failedProjectCount += 1;
        }
      }

      if (!this.isAuditCurrent(operation)) {
        return;
      }

      this.auditResults = auditResults;
      this.auditProjects = auditProjects;
      this.auditFailures = auditFailures;
      this.failedAuditPaths = failedAuditPaths;
      this.auditState = failedAuditPaths.length === 0 ? 'done' : 'incomplete';
      this.lastAuditCount = countProjectVulnerablePackages(auditProjects);
      this.lastAuditSuccessfulRootCount = successfulAuditRootCount;
      shouldEmit = true;
      if (rejected.length > 0) {
        logger.error('Audit project resolution failed; see the security audit report for redacted details.');
      }
      for (let index = 0; index < failedProjectCount; index += 1) {
        logger.error('Audit failed for a project; see the security audit report for redacted details.');
      }
      logger.info(
        failedAuditPaths.length === 0
          ? `Audit: ${this.lastAuditCount} vulnerable package(s).`
          : `Audit incomplete: ${this.lastAuditCount} vulnerable package(s); `
            + `failed ${failedAuditPaths.length} package root(s).`,
      );
      this.rebuildPackageItems();
    }
    catch (err) {
      if (this.isAuditCurrent(operation)) {
        const failure = describeAuditFailure(err);
        this.auditFailures = [{
          packageFilePaths: [],
          reason: failure.reason,
          detail: failure.detail,
        }];
        this.auditState = 'idle';
        shouldEmit = true;
        showError('package audit failed — the security audit report is incomplete.');
      }
    }
    finally {
      if (this.auditOperation === operation) {
        this.auditOperation = undefined;
        if (this.auditState === 'running') {
          this.auditState = 'idle';
          shouldEmit = !operation.abortController.signal.aborted;
        }
        if (shouldEmit) {
          this.emitTreeChanged();
        }
      }
    }
  }

  /** A load is outdated once a newer load has started or the provider has been disposed. */
  private isLoadOutdated(snapshotGeneration: number, abortSignal: AbortSignal): boolean {
    return snapshotGeneration !== this.packageSnapshotGeneration || abortSignal.aborted;
  }

  /** An audit is current only while its operation owns the provider and snapshot. */
  private isAuditCurrent(operation: AuditOperation): boolean {
    return this.auditOperation === operation
      && operation.generation === this.auditGeneration
      && operation.snapshotGeneration === this.packageSnapshotGeneration
      && this.auditState === 'running'
      && !operation.abortController.signal.aborted;
  }

  private emitTreeChanged(): void {
    this.updateTreeViewState();
    void vscode.commands.executeCommand(
      'setContext',
      'nestro.canUpdateVisiblePackages',
      this.getVisibleOutdatedPackages().length > 0,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'nestro.noWorkspace',
      !this.loading && this.allEntries.length === 0 && this.failedPackageReadPaths.length === 0,
    );
    this._onDidChangeTreeData.fire();
  }

  private createPackageItem(
    packageName: string,
    currentVersion: string,
    latest: string | undefined,
    updateType: UpdateType,
    installing = false,
    packageFilePath = '',
    dev = false,
    versionPrefix = '',
  ): PackageItem {
    const item = new PackageItem(
      packageName,
      currentVersion,
      latest,
      updateType,
      installing,
      this.auditResults.get(this.auditEntryKey(packageName, packageFilePath, dev)),
      packageFilePath,
      dev,
      versionPrefix,
    );
    const identity = Object.freeze(packageIdentityFromValues(packageName, packageFilePath, dev));
    const row: CanonicalPackageItem = Object.freeze({
      packageName,
      currentVersion,
      latest,
      updateType,
      installing,
      vulnerabilitySeverity: this.auditResults.get(this.auditEntryKey(packageName, packageFilePath, dev)),
      packageFilePath,
      dev,
      versionPrefix,
    });
    const baselineLocation = this.packageLocationBaselines.get(packageFilePath);
    this.packageItemRecords.set(item, Object.freeze({ identity, row, baselineLocation }));
    return item;
  }

  private issuePackageCapability(
    sourceItem: PackageItem,
    record: PackageItemRecord,
    location: CanonicalPackageLocation,
    snapshotGeneration: number,
  ): { readonly ok: true; readonly value: ResolvedPackageItem } {
    const capabilityRecord = {
      sourceItem,
      identity: record.identity,
      packageFilePath: location.packageFilePath,
      packageDirectory: location.packageDirectory,
      workspaceFolderPath: location.workspaceFolderPath,
      fileStamp: Object.freeze({ ...location.fileStamp }),
      manifestDigest: location.manifestDigest,
      snapshotGeneration,
    } as const;
    const capabilityIdentity = record.identity;
    const capabilityFileStamp = Object.freeze({ ...location.fileStamp });
    const capability: ResolvedPackageItem = Object.freeze({
      item: record.row,
      identity: capabilityIdentity,
      packageFilePath: location.packageFilePath,
      packageDirectory: location.packageDirectory,
      workspaceFolderPath: location.workspaceFolderPath,
      fileStamp: capabilityFileStamp,
      manifestDigest: location.manifestDigest,
      snapshotGeneration,
    });
    this.packageCapabilityRecords.set(capability, capabilityRecord);
    return { ok: true, value: capability };
  }

  private rebuildPackageItems(): void {
    this.allEntries = this.allEntries.map(({ item, dev, packageFilePath }) => ({
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        item.latest,
        item.updateType,
        item.installing,
        packageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath,
    }));
  }

  private updateTreeViewState(): void {
    if (this.treeView === undefined) {
      return;
    }

    const outdatedCount = this.allEntries.filter(e => (
      e.item.updateType !== 'none'
      && e.item.latest !== undefined
      && !e.item.installing
    )).length;
    this.treeView.badge = outdatedCount > 0
      ? { tooltip: `${outdatedCount} package updates available`, value: outdatedCount }
      : undefined;
    this.treeView.message = undefined;
  }

  private isCacheValid(fingerprint: string): boolean {
    if (this.updateCache === undefined || this.updateCache.fingerprint !== fingerprint) {
      return false;
    }
    return Date.now() - this.updateCache.timestamp < PackagesProvider.CACHE_TTL_MS;
  }

  /** Cheap half of cache validity: update policy and package-file set, without reading manifests. */
  private isCachePolicyCurrent(policyKey: string): boolean {
    if (this.updateCache === undefined || this.updateCache.policyKey !== policyKey) {
      return false;
    }
    return Date.now() - this.updateCache.timestamp < PackagesProvider.CACHE_TTL_MS;
  }

  /**
   * Fetches latest versions, then re-reads manifests and config immediately before
   * committing the result. A mismatch against the pre-fetch fingerprint, or a newer
   * load superseding this one, discards the fetch instead of caching or applying it.
   */
  private async fetchAndCacheUpdates(
    identities: readonly PackageIdentityTuple[],
    packageFiles: readonly string[],
    target: NcuUpdateTarget,
    includePreReleases: boolean,
    policyKey: string,
    beforeFingerprint: string,
    snapshotGeneration: number,
  ): Promise<UpdateFetchResult> {
    const upgrades = new Map<string, string>();
    for (const packageFilePath of packageFiles) {
      const fileUpgrades = await fetchAllLatestVersions(packageFilePath, target, includePreReleases);
      for (const [packageName, version] of fileUpgrades) {
        upgrades.set(this.entryKey(packageName, packageFilePath), version);
      }
    }

    const config = vscode.workspace.getConfiguration('nestro');
    const currentTarget = config.get<NcuUpdateTarget>('updateTarget', 'latest');
    const currentIncludePreReleases = config.get<boolean>('includePreReleases', false);
    const afterFingerprint = await this.computeUpdateFingerprint(identities, currentTarget, currentIncludePreReleases);
    if (afterFingerprint !== beforeFingerprint || snapshotGeneration !== this.packageSnapshotGeneration) {
      logger.info('Update results discarded — packages or update settings changed during the check.');
      return { accepted: false };
    }

    this.updateCache = {
      data: upgrades,
      timestamp: Date.now(),
      policyKey,
      fingerprint: beforeFingerprint,
    };
    return { accepted: true, data: upgrades };
  }

  /**
   * Deterministic key over exactly what makes a cached update result valid: each
   * package's canonical location, section, name, on-disk spec, and the update policy.
   * Adding a future policy setting (e.g. a release cooldown) is one extra field here.
   */
  private async computeUpdateFingerprint(
    identities: readonly PackageIdentityTuple[],
    target: NcuUpdateTarget,
    includePreReleases: boolean,
  ): Promise<string> {
    const byManifest = new Map<string, PackageIdentityTuple[]>();
    for (const identity of identities) {
      const group = byManifest.get(identity.packageFilePath);
      if (group === undefined) {
        byManifest.set(identity.packageFilePath, [identity]);
      }
      else {
        group.push(identity);
      }
    }
    const entryFingerprints: string[] = [];
    for (const [packageFilePath, manifestIdentities] of byManifest) {
      const location = await resolveCanonicalPackageLocation(packageFilePath);
      if (!location.ok) {
        // The rejection reason stays in the key, so an unresolvable manifest cannot
        // collapse the fingerprint into a path-only key that accepts any spec change.
        for (const identity of manifestIdentities) {
          entryFingerprints.push(JSON.stringify([
            packageFilePath, identity.section, identity.packageName, null, location.reason,
          ]));
        }
        continue;
      }
      const specs = await readCanonicalDependencySpecs(location.value, manifestIdentities);
      manifestIdentities.forEach((identity, index) => {
        entryFingerprints.push(JSON.stringify([
          location.value.packageFilePath, identity.section, identity.packageName, specs[index] ?? null, 'ok',
        ]));
      });
    }
    // Plain code-unit order, not localeCompare: this key only needs to be
    // deterministic within one process, never locale- or ICU-stable.
    entryFingerprints.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify({ entries: entryFingerprints, target, includePreReleases });
  }

  /** Update policy plus the discovered manifest set — everything the fingerprint covers without disk reads. */
  private updatePolicyKey(
    packageFiles: readonly string[],
    target: NcuUpdateTarget,
    includePreReleases: boolean,
  ): string {
    const files = [...packageFiles].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify({ files, target, includePreReleases });
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private get workspaceFolderDescriptors(): WorkspaceFolderDescriptor[] {
    return toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  }

  private async getKnownPackageFilePaths(): Promise<string[]> {
    const knownPackageFilePaths = [...new Set(this.allEntries.map(entry => entry.packageFilePath).filter(Boolean))];
    if (knownPackageFilePaths.length > 0) {
      return knownPackageFilePaths;
    }

    return await getWorkspacePackageFilePaths();
  }

  private async readPackagesForUpdateCheck(): Promise<Awaited<ReturnType<typeof readAllWorkspaceDependencies>>> {
    const entries = await readAllWorkspaceDependencies();
    this.failedPackageReadPaths = (entries.skippedFiles ?? []).map(file => file.packageFilePath);
    return entries;
  }

  /** Legacy Map-only adapters retain the conservative single-manifest behavior. */
  private applyLegacyProjectAuditResults(
    project: AuditProject,
    vulnerabilities: ReadonlyMap<string, AuditSeverity>,
    auditResults: Map<string, AuditSeverity>,
  ): void {
    if (project.originManifests.length !== 1) {
      return;
    }

    const [packageFilePath] = project.originManifests;
    for (const [packageName, severity] of vulnerabilities) {
      const matchingRows = this.allEntries.filter(entry => (
        entry.packageFilePath === packageFilePath && entry.item.packageName === packageName
      ));
      if (matchingRows.length === 1) {
        const [matchingRow] = matchingRows;
        auditResults.set(this.auditEntryKey(packageName, packageFilePath, matchingRow.dev), severity);
      }
    }
  }

  /**
   * Projects become row-scoped only when the advisory proves all of the following:
   * direct attribution, one filesystem resolution path, one installed version, one
   * owning manifest/section row, and a version/range relationship that can be checked
   * without guessing. Anything else remains available in the project report only.
   */
  private async applyStructuredProjectAuditResults(
    project: AuditProject,
    advisories: readonly AuditAdvisory[],
    auditResults: Map<string, AuditSeverity>,
  ): Promise<void> {
    for (const advisory of advisories) {
      if (advisory.attribution !== 'direct'
        || advisory.resolvedPaths.length !== 1
        || advisory.resolvedVersions.length !== 1
        || advisory.affectedRanges.length === 0) {
        continue;
      }

      const resolvedPath = advisory.resolvedPaths[0];
      const resolvedVersion = advisory.resolvedVersions[0];
      const owningRows: PackageTreeEntry[] = [];
      for (const entry of this.allEntries) {
        if (entry.item.packageName === advisory.packageName
          && await this.resolvedPathBelongsToManifest(
            resolvedPath,
            advisory.packageName,
            entry.packageFilePath,
            project,
          )) {
          owningRows.push(entry);
        }
      }
      // Resolve ownership before checking versions. If the same manifest declares a
      // package in both sections, the audit has no authoritative section evidence;
      // choosing the row whose spec happens to match would create a false badge.
      if (owningRows.length !== 1) {
        continue;
      }
      const [match] = owningRows;
      if (matchesManifestVersion(match.item.currentVersion, resolvedVersion)
        && isVersionInAffectedRange(resolvedVersion, advisory.affectedRanges)) {
        auditResults.set(
          this.auditEntryKey(match.item.packageName, match.packageFilePath, match.dev),
          advisory.severity,
        );
      }
    }
  }

  private async resolvedPathBelongsToManifest(
    resolvedPath: string,
    packageName: string,
    packageFilePath: string,
    project: AuditProject,
  ): Promise<boolean> {
    if (project.originManifests.length !== 1
      || resolvedPath.trim() === ''
      || resolvedPath.startsWith('workspace:')) {
      return false;
    }
    if (packageFilePath !== project.originManifests[0]
      || inferPathAttribution(packageName, [resolvedPath]) !== 'direct') {
      return false;
    }
    const normalizedPath = resolvedPath.replace(/\\/g, '/');
    const dependencySuffix = `/node_modules/${packageName.replace(/\\/g, '/')}`;

    // A manager may report `node_modules/pkg` relative to the project root, or an
    // absolute path. A single-origin project is required before this evidence can
    // identify one manifest row; merged projects remain report-only.
    if (normalizedPath !== packageName && normalizedPath !== `node_modules/${packageName}`
      && !normalizedPath.endsWith(dependencySuffix)) {
      return false;
    }
    const absoluteResolvedPath = path.isAbsolute(resolvedPath)
      ? path.normalize(resolvedPath)
      : path.resolve(project.projectRoot, resolvedPath);
    try {
      const [canonicalProjectRoot, canonicalManifest, canonicalResolvedPath] = await Promise.all([
        realpath(project.projectRoot),
        realpath(packageFilePath),
        realpath(absoluteResolvedPath),
      ]);
      return isWithinPath(canonicalManifest, canonicalProjectRoot)
        && isWithinPath(canonicalResolvedPath, canonicalProjectRoot);
    }
    catch {
      // Missing paths, broken symlinks, and other realpath failures do not constitute
      // ownership evidence. Keep the advisory in the project report only.
      return false;
    }
  }

  private isAuditResult(value: unknown): value is AuditResult {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as {
      vulnerabilities?: unknown;
      advisories?: unknown;
      manager?: unknown;
      schema?: unknown;
    };
    return candidate.vulnerabilities instanceof Map
      && Array.isArray(candidate.advisories)
      && isAuditPackageManager(candidate.manager)
      && isAuditSchemaId(candidate.schema);
  }

  private cloneAuditProjectSummary(summary: AuditProjectSummary): AuditProjectSummary {
    return {
      ...summary,
      project: {
        ...summary.project,
        originManifests: [...summary.project.originManifests],
      },
      vulnerabilities: new Map(summary.vulnerabilities),
      advisories: summary.advisories.map(advisory => cloneAdvisorySnapshot(advisory)),
      failure: summary.failure === undefined ? undefined : { ...summary.failure },
    };
  }

  private cloneAuditProjectFailure(failure: AuditProjectFailure): AuditProjectFailure {
    return {
      ...failure,
      project: failure.project === undefined
        ? undefined
        : {
            ...failure.project,
            originManifests: [...failure.project.originManifests],
          },
      packageFilePaths: [...failure.packageFilePaths],
    };
  }

  private entryKey(packageName: string, packageFilePath: string): string {
    return `${packageFilePath}\0${packageName}`;
  }

  private auditEntryKey(packageName: string, packageFilePath: string, dev: boolean): string {
    return this.packageStateKey({
      packageName,
      packageFilePath,
      section: dev ? 'devDependencies' : 'dependencies',
    });
  }

  private packageStateKey(identity: PackageStateIdentity): string {
    return packageIdentityKey(identity);
  }

  private findEntryIndex(identity: PackageStateIdentity): number {
    const key = this.packageStateKey(identity);
    return this.allEntries.findIndex((entry) => {
      const record = this.packageItemRecords.get(entry.item);
      if (record !== undefined) {
        return this.packageStateKey(record.identity) === key;
      }
      return this.packageStateKey({
        packageName: entry.item.packageName,
        packageFilePath: entry.packageFilePath,
        section: entry.dev ? 'devDependencies' : 'dependencies',
      }) === key;
    });
  }

  private findCurrentEntry(
    identity: PackageIdentityTuple,
    expectedItem?: PackageItem,
  ): PackageTreeEntry | undefined {
    const key = this.packageStateKey(identity);
    const matches = this.allEntries.filter((entry) => {
      const entryIdentity = this.packageItemRecords.get(entry.item)?.identity;
      return entryIdentity !== undefined && this.packageStateKey(entryIdentity) === key;
    });
    if (matches.length !== 1) {
      return undefined;
    }
    const [match] = matches;
    return expectedItem === undefined || match.item === expectedItem ? match : undefined;
  }

  private getCurrentCapabilityRecord(capability: ResolvedPackageItem): {
    readonly sourceItem: PackageItem;
    readonly identity: PackageIdentityTuple;
    readonly packageFilePath: string;
    readonly packageDirectory: string;
    readonly workspaceFolderPath: string;
    readonly fileStamp: ResolvedPackageItem['fileStamp'];
    readonly manifestDigest: string;
    readonly snapshotGeneration: number;
  } | undefined {
    if (typeof capability !== 'object' || capability === null) {
      return undefined;
    }
    const record = this.packageCapabilityRecords.get(capability);
    if (record === undefined
      || record.snapshotGeneration !== this.packageSnapshotGeneration
      || this.loading
      || this.findCurrentEntry(record.identity, record.sourceItem) === undefined) {
      return undefined;
    }
    return record;
  }

  private getPackageDetails(item: PackageItem): vscode.TreeItem[] {
    const details = [
      new PackageDetailItem(item.dev ? 'Dev dependency' : 'Dependency', item.dev ? 'tools' : 'package'),
      new PackageDetailItem(`Current: ${sanitizePackageText(item.currentVersion)}`, 'tag'),
    ];
    if (item.latest !== undefined) {
      details.push(new PackageDetailItem(`Update: ${sanitizePackageText(item.currentVersion)} → ${sanitizePackageText(item.latest)} (${item.updateType})`, 'arrow-up'));
    }
    if (item.vulnerabilitySeverity !== undefined) {
      details.push(new PackageDetailItem(`Vulnerability: ${item.vulnerabilitySeverity}`, 'warning'));
    }
    if (this.workspaceRoot !== undefined) {
      const relativeFile = this.toRelativePackageFilePath(item.packageFilePath);
      if (relativeFile !== undefined) {
        details.push(new PackageDetailItem(`File: ${sanitizePackageText(relativeFile)}`, 'file'));
      }
    }
    return details;
  }

  private buildStatusItems(): StatusItem[] {
    const items: StatusItem[] = [];

    if (this.failedPackageReadPaths.length > 0) {
      items.push(new StatusItem(
        'Package read incomplete',
        `Fix invalid or unreadable package.json: ${this.failedPackageReadPaths.join(', ')}`,
        'warning',
        'charts.yellow',
      ));
    }

    if (this.checkState === 'running') {
      items.push(new StatusItem('Checking updates…', '', 'loading~spin'));
    }
    else if (this.checkState === 'done' && this.lastCheckTime !== undefined) {
      items.push(new StatusItem(
        'Last update check',
        this.lastCheckTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        'clock',
      ));
    }

    if (this.auditState === 'running') {
      items.push(new StatusItem('Running audit…', '', 'loading~spin'));
    }
    else if (this.auditState === 'done') {
      const count = this.lastAuditCount ?? 0;
      items.push(new StatusItem(
        'Audit complete',
        count === 0 ? 'No vulnerabilities' : `${count} vulnerable package(s)`,
        count === 0 ? 'shield-check' : 'warning',
        count === 0 ? 'charts.green' : 'charts.red',
      ));
    }
    else if (this.auditState === 'incomplete') {
      const count = this.lastAuditCount ?? 0;
      const resultDescription = this.lastAuditSuccessfulRootCount === 0
        ? 'No successful audit results'
        : `${count} vulnerable package(s) from successful audit roots`;
      items.push(new StatusItem(
        'Audit incomplete',
        `${resultDescription}; `
        + `failed: ${this.failedAuditPaths.join(', ')}`,
        'warning',
        'charts.yellow',
      ));
    }

    return items;
  }

  private toRelativePackageFilePath(packageFilePath: string): string | undefined {
    if (packageFilePath === '') {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath));
    if (workspaceFolder === undefined) {
      return packageFilePath;
    }

    const relativeFile = path.relative(workspaceFolder.uri.fsPath, packageFilePath).replace(/\\/g, '/');
    if (relativeFile === 'package.json') {
      return undefined;
    }

    return relativeFile;
  }
}

function isAuditPackageManager(value: unknown): value is AuditPackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun';
}

function isAuditSchemaId(value: unknown): value is AuditSchemaId {
  return value === 'npm-v2-vulnerabilities'
    || value === 'npm-v1-advisories'
    || value === 'bun-bulk-advisory'
    || value === 'yarn-classic-audit'
    || value === 'yarn-modern-npm-audit';
}

function sameCanonicalPackageLocation(
  left: CanonicalPackageLocation,
  right: CanonicalPackageLocation,
): boolean {
  return left.packageFilePath === right.packageFilePath
    && left.packageDirectory === right.packageDirectory
    && left.workspaceFolderPath === right.workspaceFolderPath
    && left.manifestDigest === right.manifestDigest
    && samePackageFileStamp(left.fileStamp, right.fileStamp);
}

function freezePackageLocation(location: CanonicalPackageLocation): CanonicalPackageLocation {
  return Object.freeze({
    ...location,
    fileStamp: Object.freeze({ ...location.fileStamp }),
  });
}

function countProjectVulnerablePackages(projects: readonly AuditProjectSummary[]): number {
  const packageNames = new Set<string>();
  for (const project of projects) {
    for (const packageName of project.vulnerabilities.keys()) {
      packageNames.add(packageName);
    }
  }
  return packageNames.size;
}

function describeAuditFailure(error: unknown): { reason: string; detail: string } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      outcome?: { reason?: unknown; detail?: unknown };
      message?: unknown;
    };
    if (typeof candidate.outcome?.reason === 'string') {
      return {
        reason: candidate.outcome.reason,
        detail: typeof candidate.outcome.detail === 'string'
          ? candidate.outcome.detail
          : 'Audit did not produce a complete result.',
      };
    }
    if (typeof candidate.message === 'string') {
      return { reason: 'audit-failed', detail: candidate.message };
    }
  }
  return { reason: 'audit-failed', detail: String(error) };
}

function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function matchesManifestVersion(spec: string, resolvedVersion: string): boolean {
  const resolved = parseVersion(resolvedVersion);
  if (resolved === undefined) {
    return false;
  }
  const normalizedSpec = spec.trim();
  const exact = parseVersion(normalizedSpec.replace(/^=/, ''));
  if (exact !== undefined) {
    return compareVersions(resolved, exact) === 0;
  }
  const operator = normalizedSpec[0];
  if (operator !== '^' && operator !== '~') {
    return false;
  }
  const base = parseVersion(normalizedSpec.slice(1));
  if (base === undefined || compareVersions(resolved, base) < 0) {
    return false;
  }
  if (operator === '~') {
    return resolved.major === base.major && resolved.minor === base.minor;
  }
  if (base.major > 0) {
    return resolved.major === base.major;
  }
  if (base.minor > 0) {
    return resolved.major === 0 && resolved.minor === base.minor;
  }
  return resolved.major === 0 && resolved.minor === 0 && resolved.patch === base.patch;
}

function isVersionInAffectedRange(version: string, ranges: readonly string[]): boolean {
  const parsedVersion = parseVersion(version);
  if (parsedVersion === undefined) {
    return false;
  }
  return ranges.some((range) => {
    const normalizedRange = range.trim();
    if (normalizedRange === '*' || normalizedRange === '') {
      return normalizedRange === '*';
    }
    if (normalizedRange.includes('||')) {
      return false;
    }
    const tokens = normalizedRange.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(token => matchesComparator(parsedVersion, token));
  });
}

function matchesComparator(version: ParsedVersion, token: string): boolean {
  const match = /^(<=|>=|<|>|=)?(\d+\.\d+\.\d+)$/.exec(token);
  if (match === null) {
    return false;
  }
  const expected = parseVersion(match[2]);
  if (expected === undefined) {
    return false;
  }
  const comparison = compareVersions(version, expected);
  switch (match[1] ?? '=') {
    case '<':
      return comparison < 0;
    case '<=':
      return comparison <= 0;
    case '>':
      return comparison > 0;
    case '>=':
      return comparison >= 0;
    default:
      return comparison === 0;
  }
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function cloneAdvisorySnapshot(advisory: AuditAdvisory): AuditAdvisory {
  return {
    ...advisory,
    sources: [...advisory.sources],
    titles: [...advisory.titles],
    urls: [...advisory.urls],
    affectedRanges: [...advisory.affectedRanges],
    resolvedPaths: [...advisory.resolvedPaths],
    resolvedVersions: [...advisory.resolvedVersions],
    via: advisory.via.map(via => ({ ...via })),
    fixAvailable: typeof advisory.fixAvailable === 'object' && advisory.fixAvailable !== null
      ? { ...advisory.fixAvailable }
      : advisory.fixAvailable,
  };
}