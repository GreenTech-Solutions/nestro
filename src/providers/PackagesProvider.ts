import * as path from 'path';
import * as vscode from 'vscode';
import { resolveAuditProjects } from '../clients';
import type { AuditProject } from '../clients';
import {
  createCheckCoordinator,
  DEFAULT_MINIMUM_RELEASE_AGE_DAYS,
  formatAuditSeverityLabel,
  formatUpdateTypeLabel,
  getUpdateType,
  logger,
  NcuUpdateTarget,
  OperationCoordinator,
  readMinimumReleaseAgeDays,
  resolveYarnFamily,
  showError,
} from '../utils';
import type {
  AuditSeverity,
  ReleaseAgeState,
  StatusReportFailure,
  StatusReportFileLabel,
  StatusReportSnapshot,
  UpdateType,
} from '../utils';
import type { PackageFileEntries } from '../utils';
import { LoadingItem } from './LoadingItem';
import { isPackageItem, PackageItem, sanitizePackageText } from './PackageItem';
import type { PackageOperation } from './PackageItem';
import { PackageDetailItem } from './PackageDetailItem';
import { GroupItem } from './GroupItem';
import { StatusItem } from './StatusItem';
import { FilterManager, FilterType } from './FilterManager';
import {
  buildTree,
  getFilterCounts,
  getLocalizedPackageLabelFormatting,
  PackageTreeEntry,
  projectPackageTree,
  resolvePackageFileLabels,
  toWorkspaceFolderDescriptors,
} from './treeBuilder';
import type { WorkspaceFolderDescriptor } from './treeBuilder';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';
import {
  packageIdentityFromValues,
  packageIdentityKey,
  readCanonicalDependencySpec,
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
import {
  AuditOrchestrationService,
  cloneAuditProjectFailure,
  cloneAuditProjectSummary,
  computeViewProjection,
  createAllFalseViewContexts,
  describeAuditFailure,
  diffViewContexts,
  PackageLoadingService,
  projectStatusRows,
  UpdateOrchestrationService,
  VIEW_CONTEXT_KEYS,
} from './index';
import type {
  AuditableRow,
  AuditOrchestrationServiceContract,
  AuditProjectFailure,
  AuditProjectSummary,
  AuditReportSnapshot,
  PackageLoadingServiceContract,
  UpdateFingerprintPolicy,
  UpdateOrchestrationServiceContract,
  ViewContextKey,
  ViewContextMap,
  ViewProjection,
  ViewProjectionSnapshot,
} from './index';

export type PackageStateIdentity = PackageIdentityTuple;
export { PACKAGE_IDENTITY_REJECTED_MESSAGE } from './packageIdentity';
export type { PackageIdentityResolution, ResolvedPackageItem } from './packageIdentity';

/** Global workspace capabilities used by toolbar and Command Palette contexts. */
export interface WorkspaceCapabilities {
  readonly hasPackageFiles: boolean;
  readonly hasReadablePackageFiles: boolean;
  readonly hasDependencyEntries: boolean;
  readonly hasAuditableProjects: boolean;
  readonly canRunInstall: boolean;
  readonly canRunAudit: boolean;
  readonly canSearchPackages: boolean;
  readonly canFilterPackages: boolean;
  readonly canPinAllVersions: boolean;
}

const EMPTY_WORKSPACE_CAPABILITIES: WorkspaceCapabilities = Object.freeze({
  hasPackageFiles: false,
  hasReadablePackageFiles: false,
  hasDependencyEntries: false,
  hasAuditableProjects: false,
  canRunInstall: false,
  canRunAudit: false,
  canSearchPackages: false,
  canFilterPackages: false,
  canPinAllVersions: false,
});

/** Native metadata lookups spawn package-manager processes, so keep their fan-out conservative. */
export const METADATA_CONCURRENCY_CAP = 4;

type PackageOperationInput = PackageOperation | boolean | undefined;

interface AuditOperation {
  readonly generation: number;
  readonly snapshotGeneration: number;
  readonly abortController: AbortController;
}

interface UpdateOperation {
  readonly generation: number;
  readonly snapshotGeneration: number;
  readonly abortController: AbortController;
}

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly filterChangeDisposable: vscode.Disposable;
  private readonly packageLoadingService: PackageLoadingServiceContract;
  private allEntries: PackageTreeEntry[] = [];
  private packageFilePaths: string[] = [];
  /** Cache for `ownerLabels`; invalidated wherever `packageFilePaths` is reassigned. */
  private ownerLabelCache: ReadonlyMap<string, string> | undefined;
  private readablePackageFilePaths: string[] = [];
  private workspaceCapabilities: WorkspaceCapabilities = EMPTY_WORKSPACE_CAPABILITIES;
  // True once a load has settled (success or failure) at least once. Global actions stay
  // enabled while this is false so a command is never hidden just because the extension
  // has not resolved real capabilities yet — see resolvePublishedWorkspaceCapabilities().
  private capabilitiesInitialized = false;
  private packageReadFailed = false;
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
  private checkState: 'idle' | 'running' | 'done' | 'incomplete' = 'idle';
  private lastCheckTime: Date | undefined;
  private auditState: 'idle' | 'running' | 'done' | 'incomplete' | 'failed' = 'idle';
  /**
   * Owns the current audit generation and its cancellation for one run. A completed or
   * superseded run cannot clear a replacement operation through this identity boundary.
   */
  private auditGeneration = 0;
  private auditOperation: AuditOperation | undefined;
  private updateGeneration = 0;
  private updateOperation: UpdateOperation | undefined;
  /** Shared read/process boundary for concurrent update and audit runs. */
  private readonly checkCoordinator = createCheckCoordinator();
  /** Nested metadata profile; every metadata request also holds a shared check slot. */
  private readonly metadataCoordinator = new OperationCoordinator(METADATA_CONCURRENCY_CAP);
  private readonly updateOrchestrationService: UpdateOrchestrationServiceContract;
  private readonly auditOrchestrationService: AuditOrchestrationServiceContract;
  private lastAuditCount: number | undefined;
  private lastAuditSuccessfulRootCount: number | undefined;
  private failedAuditPaths: string[] = [];
  private failedUpdatePaths: string[] = [];
  private failedPackageReadPaths: string[] = [];
  private packageReadFailures: StatusReportFailure[] = [];
  private updateFailures: StatusReportFailure[] = [];
  private disposed = false;
  /** The context map last published to VS Code, so only changed keys are re-published. */
  private lastPublishedContexts: ViewContextMap | undefined;

  constructor(
    private readonly filterManager: FilterManager,
    packageLoadingService: PackageLoadingServiceContract = new PackageLoadingService(),
    updateOrchestrationService?: UpdateOrchestrationServiceContract,
    auditOrchestrationService?: AuditOrchestrationServiceContract,
  ) {
    this.packageLoadingService = packageLoadingService;
    this.updateOrchestrationService = updateOrchestrationService
      ?? UpdateOrchestrationService.withCoordinators(this.checkCoordinator, this.metadataCoordinator);
    this.auditOrchestrationService = auditOrchestrationService
      ?? AuditOrchestrationService.withCoordinator(this.checkCoordinator);
    this.filterChangeDisposable = this.filterManager.onDidChange(() => this.emitTreeChanged());
  }

  attachTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.treeView = treeView;
    this.applyTreeViewState(computeViewProjection(this.buildViewProjectionSnapshot()));
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
   * or duplicate-name matches (attributed by the audit orchestration service), but the
   * underlying project result and its origin manifest set are always kept here.
   */
  getAuditProjects(): readonly AuditProjectSummary[] {
    return this.auditProjects.map(summary => cloneAuditProjectSummary(summary));
  }

  getAuditFailures(): readonly AuditProjectFailure[] {
    return this.auditFailures.map(failure => cloneAuditProjectFailure(failure));
  }

  getAuditReport(): AuditReportSnapshot {
    return {
      projects: this.getAuditProjects(),
      failures: this.getAuditFailures(),
    };
  }

  /** Returns a defensive snapshot for the unified status diagnostics report. */
  getStatusReport(): StatusReportSnapshot {
    const packageReadFailures = this.packageReadFailures.map(cloneStatusReportFailure);
    const updateFailures = this.updateFailures.map(cloneStatusReportFailure);
    const auditFailures = this.auditFailures.map(failure => cloneStatusReportFailure({
      packageFilePaths: failure.packageFilePaths.length > 0
        ? failure.packageFilePaths
        : failure.project?.originManifests ?? [],
      reason: failure.reason,
      detail: failure.detail,
    }));
    const packageFilePaths = uniqueStrings([
      ...packageReadFailures.flatMap(failure => failure.packageFilePaths),
      ...updateFailures.flatMap(failure => failure.packageFilePaths),
      ...auditFailures.flatMap(failure => failure.packageFilePaths),
    ]);
    const fileLabels: StatusReportFileLabel[] = resolvePackageFileLabels(
      packageFilePaths,
      this.workspaceFolderDescriptors,
      getLocalizedPackageLabelFormatting(),
    ).map((entry, order) => ({
      packageFilePath: entry.packageFilePath,
      label: entry.owner.label,
      order,
    }));
    return {
      packageReadFailures,
      updateFailures,
      auditFailures,
      fileLabels,
    };
  }

  getVisibleOutdatedPackages(): PackageItem[] {
    if (this.loading) {
      return [];
    }
    return projectPackageTree(this.allEntries, this.filterManager.current, this.filterManager.search)
      .visibleOutdatedEntries
      .map(entry => entry.item);
  }

  getPackageIdentitiesForFile(packageFilePath: string): PackageStateIdentity[] {
    return this.allEntries
      .filter(entry => entry.packageFilePath === packageFilePath)
      .map(entry => this.packageItemRecords.get(entry.item)?.identity)
      .filter((identity): identity is PackageStateIdentity => identity !== undefined);
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
        undefined,
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
        undefined,
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
        item.operation,
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
    this.updateOrchestrationService.invalidateCache();
    this.lastCheckTime = undefined;
    logger.info('Update cache invalidated.');
  }

  markPackageUpdating(identity: PackageStateIdentity, operation: PackageOperationInput): void {
    const index = this.findEntryIndex(identity);
    if (index === -1) {
      return;
    }

    const { item, dev, packageFilePath: entryPackageFilePath } = this.allEntries[index];
    const activeOperation = normalizeOperation(operation, item.latest ?? item.currentVersion);
    const updateType = activeOperation !== undefined || item.latest === undefined
      ? item.updateType
      : getUpdateType(item.currentVersion, item.latest);
    this.allEntries[index] = {
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        item.latest,
        updateType,
        activeOperation,
        entryPackageFilePath,
        dev,
        item.versionPrefix,
        item.releaseAge,
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
    operation: PackageOperationInput,
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
    const activeOperation = normalizeOperation(operation, row.latest ?? row.currentVersion);
    const updateType = activeOperation !== undefined || row.latest === undefined
      ? row.updateType
      : getUpdateType(row.currentVersion, row.latest);
    this.allEntries[index] = {
      item: this.createPackageItem(
        row.packageName,
        row.currentVersion,
        row.latest,
        updateType,
        activeOperation,
        row.packageFilePath,
        row.dev,
        row.versionPrefix,
        row.releaseAge,
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
            originalRecord.row.operation,
            row.packageFilePath,
            row.dev,
            row.versionPrefix,
            row.releaseAge,
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
    await this.filterManager.showPicker(getFilterCounts(this.allEntries, this.filterManager.search));
  }

  async loadPackages(): Promise<void> {
    logger.info('Loading workspace packages.');
    const snapshotGeneration = this.packageSnapshotGeneration + 1;
    this.packageSnapshotGeneration = snapshotGeneration;
    this.loadAbortController?.abort();
    this.updateOperation?.abortController.abort();
    this.updateOperation = undefined;
    const activeAudit = this.auditOperation;
    if (activeAudit !== undefined) {
      activeAudit.abortController.abort();
      this.auditOperation = undefined;
      this.auditGeneration += 1;
    }
    this.checkState = 'idle';
    this.auditState = 'idle';
    const abortController = new AbortController();
    this.loadAbortController = abortController;
    this.packageLocationBaselines = new Map();
    this.packageFilePaths = [];
    this.readablePackageFilePaths = [];
    // workspaceCapabilities is intentionally left in place here: it still holds the last
    // settled result (or the permissive pre-init default), so a reload never flashes global
    // actions to disabled while it is in flight. It is only overwritten once this load settles.
    this.packageReadFailed = false;
    this.loading = true;
    this.auditResults = new Map();
    this.auditProjects = [];
    this.auditFailures = [];
    this.lastAuditCount = undefined;
    this.lastAuditSuccessfulRootCount = undefined;
    this.failedAuditPaths = [];
    this.failedUpdatePaths = [];
    this.packageReadFailures = [];
    this.updateFailures = [];
    this.failedPackageReadPaths = [];
    this.emitTreeChanged();
    try {
      const snapshot = await this.packageLoadingService.load(abortController.signal);
      if (snapshot === undefined || this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
        return;
      }
      const {
        entries,
        packageFilePaths,
        readablePackageFilePaths,
        failedPackageReadPaths,
        failedPackageReadDetails,
        packageLocationBaselines,
        packageReadFailed,
      } = snapshot;
      this.packageReadFailed = packageReadFailed;
      this.packageLocationBaselines = new Map(packageLocationBaselines);
      this.packageFilePaths = [...packageFilePaths];
      this.ownerLabelCache = undefined;
      this.readablePackageFilePaths = [...readablePackageFilePaths];
      this.failedPackageReadPaths = [...failedPackageReadPaths];
      this.packageReadFailures = createPackageReadFailureSnapshot(
        failedPackageReadPaths,
        failedPackageReadDetails,
        packageReadFailed,
      );
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
          && (existing.item.operation !== undefined || existingSemver === newSemver);
        if (preserveExistingUpdateState) {
          return {
            item: this.createPackageItem(
              e.name,
              e.current,
              existing.item.latest,
              existing.item.updateType,
              existing.item.operation,
              e.packageFilePath,
              e.dev,
              e.versionPrefix,
              existing.item.releaseAge,
            ),
            dev: e.dev,
            packageFilePath: e.packageFilePath,
          };
        }
        return {
          item: this.createPackageItem(e.name, e.current, undefined, 'none', undefined, e.packageFilePath, e.dev, e.versionPrefix),
          dev: e.dev,
          packageFilePath: e.packageFilePath,
        };
      });
      const workspaceCapabilities = await this.resolveWorkspaceCapabilities(
        packageFilePaths,
        readablePackageFilePaths,
        entries,
      );
      if (this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
        return;
      }
      this.workspaceCapabilities = workspaceCapabilities;
      this.capabilitiesInitialized = true;
    }
    catch (err) {
      if (this.isLoadOutdated(snapshotGeneration, abortController.signal)) {
        return;
      }
      this.packageLocationBaselines = new Map();
      this.packageFilePaths = [];
      this.readablePackageFilePaths = [];
      this.workspaceCapabilities = EMPTY_WORKSPACE_CAPABILITIES;
      this.packageReadFailed = true;
      this.capabilitiesInitialized = true;
      this.failedPackageReadPaths = [];
      this.packageReadFailures = [{
        packageFilePaths: [],
        reason: 'package-load-failed',
        detail: err instanceof Error ? err.message : String(err),
      }];
      showError(vscode.l10n.t('Failed to load packages — {0}', err instanceof Error ? err.message : String(err)), err);
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
    this.failedUpdatePaths = [];
    this.updateFailures = [];
    let attemptedPackageFilePaths: string[] = [];
    const operation: UpdateOperation = {
      generation: this.updateGeneration + 1,
      snapshotGeneration,
      abortController: new AbortController(),
    };
    this.updateGeneration = operation.generation;
    this.updateOperation = operation;
    this.emitTreeChanged();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Checking package updates…'),
          cancellable: true,
        },
        async (_progress, token): Promise<void> => {
          const cancellation = token.onCancellationRequested(() => this.cancelCheckUpdates());
          try {
            if (token.isCancellationRequested) {
              this.cancelCheckUpdates();
            }
            const config = vscode.workspace.getConfiguration('nestro');
            const forceAlways = config.get<boolean>('checkUpdatesForceAlways', false);
            const includePreReleases = config.get<boolean>('includePreReleases', false);
            const target = config.get<NcuUpdateTarget>('updateTarget', 'latest');
            const minimumReleaseAgeDays = readMinimumReleaseAgeDays(
              config.get<unknown>('minimumReleaseAgeDays', DEFAULT_MINIMUM_RELEASE_AGE_DAYS),
            );
            const debounceSeconds = config.get<number>('checkUpdatesDebounce', 60);
            const source = this.allEntries.length > 0
              ? this.allEntries.map(e => ({
                  name: e.item.packageName,
                  current: e.item.currentVersion,
                  dev: e.dev,
                  versionPrefix: e.item.versionPrefix,
                  packageFilePath: e.packageFilePath,
                }))
              : await this.readPackagesForUpdateCheck();
            if (!this.isUpdateCurrent(operation)) {
              return;
            }
            const packageFiles = [...new Set(source.map(entry => entry.packageFilePath))];
            attemptedPackageFilePaths = packageFiles;
            const identities = source.map(entry => packageIdentityFromValues(entry.name, entry.packageFilePath, entry.dev));
            const currentVersions = new Map(identities.map((identity, index) => [
              this.packageStateKey(identity),
              source[index].current,
            ]));
            const result = await this.updateOrchestrationService.check({
              identities,
              currentVersions,
              packageFiles,
              target,
              includePreReleases,
              minimumReleaseAgeDays,
              forceAlways,
              debounceSeconds,
              lastCheckTime: this.lastCheckTime?.getTime(),
              signal: operation.abortController.signal,
              isCurrent: () => this.isUpdateCurrent(operation),
              resolveCurrentPolicy: () => this.currentUpdatePolicy(),
              onCheckStarted: () => {
                logger.info('Checking package updates.');
                logger.info(`Checking updates for ${source.length} package(s).`);
              },
              onRootFailure: () => logger.error('Update check failed for a package root; other roots still completed.'),
              onDiscarded: () => logger.info('Update results discarded — packages or update settings changed during the check.'),
            });
            if (!this.isUpdateCurrent(operation)) {
              return;
            }
            if (result.kind === 'debounced') {
              logger.info('Check for updates skipped — debounce interval has not elapsed.');
              this.checkState = 'done';
              return;
            }
            if (result.kind === 'discarded') {
              this.checkState = 'idle';
              return;
            }
            const upgrades = result.data;
            this.failedUpdatePaths = uniqueStrings(result.failedPackageFilePaths);
            this.updateFailures = createUpdateFailureSnapshot(
              result.failedPackageFilePaths,
              result.failures,
            );
            if (result.allFailed) {
              const failureMessage = result.failure instanceof Error
                ? result.failure.message
                : result.failure === undefined ? vscode.l10n.t('all package roots failed') : String(result.failure);
              showError(vscode.l10n.t('Failed to check updates — {0}', failureMessage), result.failure);
            }
            const liveEntries = this.allEntries.length > 0
              ? this.allEntries
              : source.map(entry => ({
                  item: this.createPackageItem(
                    entry.name,
                    entry.current,
                    undefined,
                    'none',
                    undefined,
                    entry.packageFilePath,
                    entry.dev,
                    entry.versionPrefix,
                  ),
                  dev: entry.dev,
                  packageFilePath: entry.packageFilePath,
                }));
            this.allEntries = liveEntries.map(({ item, dev, packageFilePath }) => {
              const updateData = upgrades.get(this.packageStateKey(
                packageIdentityFromValues(item.packageName, packageFilePath, dev),
              ));
              const latest = updateData?.acceptedVersion;
              const updateType = latest === undefined ? 'none' : getUpdateType(item.currentVersion, latest);
              return {
                item: this.createPackageItem(
                  item.packageName,
                  item.currentVersion,
                  latest,
                  updateType,
                  item.operation,
                  packageFilePath,
                  dev,
                  item.versionPrefix,
                  updateData?.releaseAge,
                ),
                dev,
                packageFilePath,
              };
            });
            logger.info(`Checked updates for ${source.length} package(s).`);
            this.checkState = this.failedUpdatePaths.length === 0 ? 'done' : 'incomplete';
            this.lastCheckTime = new Date();
          }
          finally {
            cancellation.dispose();
          }
        },
      );
    }
    catch (err) {
      if (this.isUpdateCurrent(operation)) {
        this.failedUpdatePaths = uniqueStrings(attemptedPackageFilePaths);
        this.updateFailures = [{
          packageFilePaths: attemptedPackageFilePaths,
          reason: 'update-check-failed',
          detail: err instanceof Error ? err.message : String(err),
        }];
        this.checkState = 'idle';
        showError(vscode.l10n.t('Failed to check updates — {0}', err instanceof Error ? err.message : String(err)), err);
      }
    }
    finally {
      if (this.updateOperation === operation) {
        this.updateOperation = undefined;
        if (this.checkState === 'running') {
          this.checkState = 'idle';
        }
        if (!operation.abortController.signal.aborted) {
          this.emitTreeChanged();
        }
      }
    }
  }

  /** Reads the update policy live, so a fetch in flight can detect a setting changed mid-check. */
  private currentUpdatePolicy(): UpdateFingerprintPolicy {
    const config = vscode.workspace.getConfiguration('nestro');
    return {
      target: config.get<NcuUpdateTarget>('updateTarget', 'latest'),
      includePreReleases: config.get<boolean>('includePreReleases', false),
      minimumReleaseAgeDays: readMinimumReleaseAgeDays(
        config.get<unknown>('minimumReleaseAgeDays', DEFAULT_MINIMUM_RELEASE_AGE_DAYS),
      ),
    };
  }

  /** Cancels the in-flight update check and discards its late result. */
  cancelCheckUpdates(): void {
    const operation = this.updateOperation;
    if (this.checkState !== 'running' || operation === undefined) {
      return;
    }
    operation.abortController.abort();
    this.checkState = 'idle';
    this.emitTreeChanged();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    for (const timer of this.writeSuppressionTimers) {
      clearTimeout(timer);
    }
    this.writeSuppressionTimers.clear();
    this.writeSuppressionDepth = 0;
    this.loadAbortController?.abort();
    this.cancelCheckUpdates();
    this.cancelAudit();
    this.disposed = true;
    this.workspaceCapabilities = EMPTY_WORKSPACE_CAPABILITIES;
    this.packageReadFailed = false;
    this.resetViewContexts();
    this.filterChangeDisposable.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /** Unconditionally publishes every context key as `false`, bypassing the change diff. */
  private resetViewContexts(): void {
    const allFalse = createAllFalseViewContexts();
    for (const [key, value] of Object.entries(allFalse) as [ViewContextKey, boolean][]) {
      void vscode.commands.executeCommand('setContext', VIEW_CONTEXT_KEYS[key], value);
    }
    this.lastPublishedContexts = allFalse;
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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Running package audit…'),
        cancellable: true,
      },
      async (_progress, token): Promise<void> => {
        const cancellation = token.onCancellationRequested(() => this.cancelAudit());
        try {
          if (token.isCancellationRequested) {
            this.cancelAudit();
          }
          await this.runAuditCore();
        }
        finally {
          cancellation.dispose();
        }
      },
    );
  }

  private async runAuditCore(): Promise<void> {
    if (this.auditState === 'running') {
      return;
    }

    this.auditState = 'running';
    this.lastAuditCount = undefined;
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

      const rows: AuditableRow[] = this.allEntries.map(entry => ({
        packageName: entry.item.packageName,
        packageFilePath: entry.packageFilePath,
        dev: entry.dev,
        currentVersion: entry.item.currentVersion,
      }));
      const result = await this.auditOrchestrationService.run({
        packageFilePaths,
        rows,
        signal: operation.abortController.signal,
        isCurrent: () => this.isAuditCurrent(operation),
      });
      if (!this.isAuditCurrent(operation)) {
        return;
      }
      if (result.kind === 'discarded') {
        return;
      }
      if (result.kind === 'failed') {
        this.auditFailures = [{
          packageFilePaths: [],
          reason: result.reason,
          detail: result.detail,
        }];
        this.auditState = 'failed';
        shouldEmit = true;
        showError(vscode.l10n.t('Package audit failed — the security audit report is incomplete.'));
        return;
      }

      this.auditResults = new Map(result.auditResults);
      this.auditProjects = [...result.auditProjects];
      this.auditFailures = [...result.auditFailures];
      this.failedAuditPaths = [...result.failedAuditPaths];
      this.auditState = this.failedAuditPaths.length === 0 ? 'done' : 'incomplete';
      this.lastAuditCount = result.vulnerablePackageCount;
      this.lastAuditSuccessfulRootCount = result.successfulAuditRootCount;
      shouldEmit = true;
      const rejectedManifestCount = this.auditFailures.filter(failure => failure.project === undefined).length;
      const failedProjectCount = this.auditFailures.length - rejectedManifestCount;
      if (rejectedManifestCount > 0) {
        logger.error('Audit project resolution failed; see the security audit report for redacted details.');
      }
      for (let index = 0; index < failedProjectCount; index += 1) {
        logger.error('Audit failed for a project; see the security audit report for redacted details.');
      }
      logger.info(
        this.failedAuditPaths.length === 0
          ? `Audit: ${this.lastAuditCount} vulnerable package(s).`
          : `Audit incomplete: ${this.lastAuditCount} vulnerable package(s); `
            + `failed ${this.failedAuditPaths.length} package root(s).`,
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
        this.auditState = 'failed';
        shouldEmit = true;
        showError(vscode.l10n.t('Package audit failed — the security audit report is incomplete.'));
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

  /** An update check is current only while its operation owns the provider and snapshot. */
  private isUpdateCurrent(operation: UpdateOperation): boolean {
    return this.updateOperation === operation
      && operation.generation === this.updateGeneration
      && operation.snapshotGeneration === this.packageSnapshotGeneration
      && this.checkState === 'running'
      && !operation.abortController.signal.aborted;
  }

  /** Computes the view projection once, applies it, and publishes only the contexts that changed. */
  private emitTreeChanged(): void {
    const projection = computeViewProjection(this.buildViewProjectionSnapshot());
    this.applyTreeViewState(projection);
    this.publishViewContexts(projection.contexts);
    this._onDidChangeTreeData.fire();
  }

  private buildViewProjectionSnapshot(): ViewProjectionSnapshot {
    return {
      entries: this.allEntries,
      filterType: this.filterManager.current,
      search: this.filterManager.search,
      loading: this.loading,
      workspaceCapabilities: this.workspaceCapabilities,
      capabilitiesInitialized: this.capabilitiesInitialized,
      packageReadFailed: this.packageReadFailed,
      packageReadFailures: this.packageReadFailures,
      checkState: this.checkState,
      lastCheckTime: this.lastCheckTime,
      failedUpdatePaths: this.failedUpdatePaths,
      auditState: this.auditState,
      lastAuditCount: this.lastAuditCount,
      lastAuditSuccessfulRootCount: this.lastAuditSuccessfulRootCount,
      failedAuditPaths: this.failedAuditPaths,
    };
  }

  private applyTreeViewState(projection: ViewProjection): void {
    if (this.treeView === undefined) {
      return;
    }
    this.treeView.badge = projection.badge;
    this.treeView.message = undefined;
    this.treeView.description = projection.description;
  }

  /** Publishes only the context keys whose value changed since the last publication. */
  private publishViewContexts(next: ViewContextMap): void {
    const changed = diffViewContexts(this.lastPublishedContexts, next);
    for (const key of Object.keys(changed) as ViewContextKey[]) {
      void vscode.commands.executeCommand('setContext', VIEW_CONTEXT_KEYS[key], changed[key]);
    }
    this.lastPublishedContexts = next;
  }

  private createPackageItem(
    packageName: string,
    currentVersion: string,
    latest: string | undefined,
    updateType: UpdateType,
    operation: PackageOperation | undefined = undefined,
    packageFilePath = '',
    dev = false,
    versionPrefix = '',
    releaseAge: ReleaseAgeState = { kind: 'accepted' },
  ): PackageItem {
    const item = new PackageItem(
      packageName,
      currentVersion,
      latest,
      updateType,
      operation,
      this.auditResults.get(this.auditEntryKey(packageName, packageFilePath, dev)),
      packageFilePath,
      dev,
      versionPrefix,
      releaseAge,
      this.resolveOwnerLabel(packageFilePath),
    );
    const identity = Object.freeze(packageIdentityFromValues(packageName, packageFilePath, dev));
    const row: CanonicalPackageItem = Object.freeze({
      packageName,
      currentVersion,
      latest,
      updateType,
      operation,
      vulnerabilitySeverity: this.auditResults.get(this.auditEntryKey(packageName, packageFilePath, dev)),
      packageFilePath,
      dev,
      versionPrefix,
      releaseAge,
    });
    const baselineLocation = this.packageLocationBaselines.get(packageFilePath);
    this.packageItemRecords.set(item, Object.freeze({ identity, row, baselineLocation }));
    return item;
  }

  /** Same owner-qualified label the tree/picker show, so a row's accessible owner never diverges from it. */
  private resolveOwnerLabel(packageFilePath: string): string | undefined {
    if (packageFilePath === '') {
      return undefined;
    }
    const cached = this.ownerLabels.get(packageFilePath);
    if (cached !== undefined) {
      return cached;
    }
    // Defensive: a manifest outside the tracked set resolves on its own instead of
    // widening the cache every other row's lookup relies on.
    const folders = this.workspaceFolderDescriptors;
    if (folders.length === 0) {
      return undefined;
    }
    return resolvePackageFileLabels(
      [...this.packageFilePaths, packageFilePath],
      folders,
      getLocalizedPackageLabelFormatting(),
    )
      .find(entry => entry.packageFilePath === packageFilePath)?.owner.label;
  }

  /** Owner labels for the tracked manifest set; the projection runs once per `packageFilePaths` change, not per row. */
  private get ownerLabels(): ReadonlyMap<string, string> {
    if (this.ownerLabelCache === undefined) {
      const folders = this.workspaceFolderDescriptors;
      this.ownerLabelCache = folders.length === 0
        ? new Map()
        : new Map(resolvePackageFileLabels(
            this.packageFilePaths,
            folders,
            getLocalizedPackageLabelFormatting(),
          ).map(
            entry => [entry.packageFilePath, entry.owner.label],
          ));
    }
    return this.ownerLabelCache;
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
        item.operation,
        packageFilePath,
        dev,
        item.versionPrefix,
        item.releaseAge,
      ),
      dev,
      packageFilePath,
    }));
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private get workspaceFolderDescriptors(): WorkspaceFolderDescriptor[] {
    return toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  }

  private async resolveWorkspaceCapabilities(
    packageFilePaths: readonly string[],
    readablePackageFilePaths: readonly string[],
    entries: readonly { readonly packageFilePath: string }[],
  ): Promise<WorkspaceCapabilities> {
    const hasPackageFiles = packageFilePaths.length > 0;
    const hasReadablePackageFiles = readablePackageFilePaths.length > 0;
    const hasDependencyEntries = entries.length > 0;
    let hasAuditableProjects = false;

    if (hasReadablePackageFiles) {
      try {
        const { projects } = await resolveAuditProjects(readablePackageFilePaths);
        for (const project of projects) {
          if (await this.isAuditableProject(project)) {
            hasAuditableProjects = true;
            break;
          }
        }
      }
      catch {
        logger.warn('Failed to resolve auditable workspace projects.');
      }
    }

    return {
      hasPackageFiles,
      hasReadablePackageFiles,
      hasDependencyEntries,
      hasAuditableProjects,
      canRunInstall: hasReadablePackageFiles,
      canRunAudit: hasAuditableProjects,
      canSearchPackages: hasDependencyEntries,
      canFilterPackages: hasDependencyEntries,
      canPinAllVersions: hasDependencyEntries,
    };
  }

  private async isAuditableProject(project: AuditProject): Promise<boolean> {
    if (project.lockfilePath === undefined) {
      return false;
    }
    if (project.packageManager !== 'yarn') {
      return true;
    }

    // A Yarn lock file alone does not identify a supported audit command. Keep the
    // Audit action disabled when the family resolver cannot establish Classic or Modern.
    if (typeof resolveYarnFamily !== 'function') {
      return false;
    }
    try {
      const resolution = await resolveYarnFamily(project.projectRoot);
      return resolution.family !== 'unknown';
    }
    catch {
      return false;
    }
  }

  private async getKnownPackageFilePaths(): Promise<string[]> {
    const knownPackageFilePaths = [...new Set(this.allEntries.map(entry => entry.packageFilePath).filter(Boolean))];
    if (knownPackageFilePaths.length > 0) {
      return knownPackageFilePaths;
    }

    const discoveredPackageFilePaths = await this.packageLoadingService.discoverPackageFilePaths();
    const failedPackageReadPathSet = new Set(this.failedPackageReadPaths);
    return discoveredPackageFilePaths.filter(
      packageFilePath => !failedPackageReadPathSet.has(packageFilePath),
    );
  }

  private async readPackagesForUpdateCheck(): Promise<PackageFileEntries> {
    const entries = await this.packageLoadingService.readPackageEntries();
    this.failedPackageReadPaths = (entries.skippedFiles ?? []).map(file => file.packageFilePath);
    this.packageReadFailures = createPackageReadFailureSnapshot(
      this.failedPackageReadPaths,
      entries.skippedFiles,
      false,
    );
    return entries;
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
      new PackageDetailItem(item.dev ? vscode.l10n.t('Dev dependency') : vscode.l10n.t('Dependency'), item.dev ? 'tools' : 'package'),
      new PackageDetailItem(vscode.l10n.t('Current: {0}', sanitizePackageText(item.currentVersion)), 'tag'),
    ];
    if (item.latest !== undefined) {
      details.push(new PackageDetailItem(vscode.l10n.t(
        'Update: {0} → {1} ({2})',
        sanitizePackageText(item.currentVersion),
        sanitizePackageText(item.latest),
        formatUpdateTypeLabel(item.updateType),
      ), 'arrow-up'));
    }
    if (item.vulnerabilitySeverity !== undefined) {
      details.push(new PackageDetailItem(vscode.l10n.t(
        'Vulnerability: {0}',
        formatAuditSeverityLabel(item.vulnerabilitySeverity),
      ), 'warning'));
    }
    if (this.workspaceRoot !== undefined) {
      const relativeFile = this.toRelativePackageFilePath(item.packageFilePath);
      if (relativeFile !== undefined) {
        details.push(new PackageDetailItem(vscode.l10n.t('File: {0}', sanitizePackageText(relativeFile)), 'file'));
      }
    }
    return details;
  }

  private buildStatusItems(): StatusItem[] {
    return projectStatusRows(this.buildViewProjectionSnapshot()).map(row => new StatusItem(
      row.label,
      row.description,
      row.icon,
      row.color,
      row.actionable,
    ));
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

function cloneStatusReportFailure(failure: StatusReportFailure): StatusReportFailure {
  return {
    packageFilePaths: [...failure.packageFilePaths],
    reason: failure.reason,
    detail: failure.detail,
  };
}

function createPackageReadFailureSnapshot(
  paths: readonly string[],
  details: readonly { readonly packageFilePath: string; readonly error: string }[] | undefined,
  discoveryFailed: boolean,
): StatusReportFailure[] {
  const detailByPath = new Map<string, string[]>();
  for (const failure of details ?? []) {
    const current = detailByPath.get(failure.packageFilePath) ?? [];
    current.push(failure.error);
    detailByPath.set(failure.packageFilePath, current);
  }
  for (const packageFilePath of paths) {
    if (!detailByPath.has(packageFilePath)) {
      detailByPath.set(packageFilePath, []);
    }
  }
  if (discoveryFailed && !detailByPath.has('')) {
    detailByPath.set('', ['Failed to discover workspace package files.']);
  }
  return [...detailByPath.entries()].map(([packageFilePath, errors]) => ({
    packageFilePaths: packageFilePath === '' ? [] : [packageFilePath],
    reason: packageFilePath === '' ? 'package-discovery-failed' : 'package-read-failed',
    detail: errors.length === 0 ? undefined : errors.join('; '),
  }));
}

function createUpdateFailureSnapshot(
  paths: readonly string[],
  failures: readonly { readonly packageFilePath: string; readonly error: unknown }[],
): StatusReportFailure[] {
  const byPath = new Map<string, StatusReportFailure>();
  for (const failure of failures) {
    byPath.set(failure.packageFilePath, {
      packageFilePaths: [failure.packageFilePath],
      reason: 'update-check-failed',
      detail: formatFailureDetail(failure.error),
    });
  }
  for (const packageFilePath of uniqueStrings(paths)) {
    if (!byPath.has(packageFilePath)) {
      byPath.set(packageFilePath, {
        packageFilePaths: [packageFilePath],
        reason: 'update-check-failed',
      });
    }
  }
  return [...byPath.values()];
}

function formatFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeOperation(operation: PackageOperationInput, defaultTarget: string): PackageOperation | undefined {
  if (typeof operation !== 'boolean') {
    return operation;
  }
  return operation ? { kind: 'update', target: defaultTarget } : undefined;
}