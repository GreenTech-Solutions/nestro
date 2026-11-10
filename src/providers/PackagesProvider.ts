import * as vscode from 'vscode';
import { createCheckCoordinator, logger, OperationCoordinator } from '../utils';
import type { StatusReportSnapshot } from '../utils';
import { FilterManager } from './FilterManager';
import type { FilterType } from './FilterManager';
import { PackageItem } from './PackageItem';
import type { PackageOperationInput } from './PackageItem';
import {
  AuditOrchestrationService,
} from './auditOrchestrationService';
import type {
  AuditOrchestrationServiceContract,
  AuditProjectFailure,
  AuditProjectSummary,
  AuditReportSnapshot,
} from './auditOrchestrationService';
import { PackageCapabilityOperations } from './packageCapabilityOperations';
import { PackageAuditController } from './packageAuditController';
import { PackageLoadController } from './packageLoadController';
import type { PackageLoadingServiceContract } from './packageLoadingService';
import { PackageLoadingService } from './packageLoadingService';
import { PackageProviderState } from './packageProviderState';
import { PackageRowMutationService } from './packageRowMutationService';
import { PackageUpdateController } from './packageUpdateController';
import { PackageViewController } from './packageViewController';
import { getFilterCounts, projectPackageTree } from './treeBuilder';
import type { PackageTreeEntry } from './treeBuilder';
import { createStatusReportSnapshot } from './statusReportAssembler';
import { UpdateOrchestrationService } from './updateOrchestrationService';
import type { UpdateOrchestrationServiceContract } from './updateOrchestrationService';
import { EMPTY_WORKSPACE_CAPABILITIES, WorkspaceCapabilityResolver } from './workspaceCapabilityResolver';
import type { PackageIdentityResolution, PackageIdentityTuple, ResolvedPackageItem } from './packageIdentity';

export type PackageStateIdentity = PackageIdentityTuple;
export { PACKAGE_IDENTITY_REJECTED_MESSAGE } from './packageIdentity';
export type { PackageIdentityResolution, ResolvedPackageItem };
export type { WorkspaceCapabilities } from './workspaceCapabilityResolver';

/** Native metadata lookups spawn package-manager processes, so keep their fan-out conservative. */
export const METADATA_CONCURRENCY_CAP = 4;

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  readonly onDidChangeTreeData: vscode.Event<void>;
  private readonly state: PackageProviderState;
  private readonly view: PackageViewController;
  private readonly capabilities: PackageCapabilityOperations;
  private readonly rowMutations: PackageRowMutationService;
  private readonly loadController: PackageLoadController;
  private readonly updateController: PackageUpdateController;
  private readonly auditController: PackageAuditController;
  private readonly updateOrchestrationService: UpdateOrchestrationServiceContract;
  private readonly filterChangeDisposable: vscode.Disposable;

  constructor(
    private readonly filterManager: FilterManager,
    packageLoadingService: PackageLoadingServiceContract = new PackageLoadingService(),
    updateOrchestrationService?: UpdateOrchestrationServiceContract,
    auditOrchestrationService?: AuditOrchestrationServiceContract,
  ) {
    this.state = new PackageProviderState();
    const checkCoordinator = createCheckCoordinator();
    const metadataCoordinator = new OperationCoordinator(METADATA_CONCURRENCY_CAP);
    this.updateOrchestrationService = updateOrchestrationService
      ?? UpdateOrchestrationService.withCoordinators(checkCoordinator, metadataCoordinator);
    const auditService = auditOrchestrationService
      ?? AuditOrchestrationService.withCoordinator(checkCoordinator);
    this.view = new PackageViewController(this.state, filterManager);
    this.onDidChangeTreeData = this.view.onDidChangeTreeData;
    this.capabilities = new PackageCapabilityOperations(this.state);
    this.rowMutations = new PackageRowMutationService(
      this.state,
      this.capabilities,
      () => this.emitTreeChanged(),
    );
    this.loadController = new PackageLoadController(
      this.state,
      packageLoadingService,
      new WorkspaceCapabilityResolver(),
      () => this.emitTreeChanged(),
    );
    this.updateController = new PackageUpdateController(
      this.state,
      this.updateOrchestrationService,
      () => this.ensurePackageLoad(),
      () => this.emitTreeChanged(),
    );
    this.auditController = new PackageAuditController(
      this.state,
      auditService,
      () => this.ensurePackageLoad(),
      () => this.emitTreeChanged(),
    );
    this.filterChangeDisposable = this.filterManager.onDidChange(() => this.emitTreeChanged());
  }

  attachTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.view.attachTreeView(treeView);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    return this.view.getChildren(element);
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

  async withWriteSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    const packageFilePaths = [...this.state.packageFilePaths];
    const before = await this.state.manifestWriteBaselines.capture(packageFilePaths);
    try {
      const result = await fn();
      this.invalidateUpdateCache();
      return result;
    }
    finally {
      await this.state.manifestWriteBaselines.recordChanges(packageFilePaths, before);
    }
  }

  isOwnManifestWrite(uri: vscode.Uri): Promise<boolean> {
    return this.state.manifestWriteBaselines.isOwnWrite(uri);
  }

  resolvePackageItem(value: unknown): Promise<PackageIdentityResolution> {
    return this.capabilities.resolvePackageItem(value);
  }

  revalidatePackageItem(value: ResolvedPackageItem): Promise<PackageIdentityResolution> {
    return this.capabilities.revalidatePackageItem(value);
  }

  getAuditProjects(): readonly AuditProjectSummary[] {
    return this.auditController.getAuditProjects();
  }

  getAuditFailures(): readonly AuditProjectFailure[] {
    return this.auditController.getAuditFailures();
  }

  getAuditReport(): AuditReportSnapshot {
    return {
      projects: this.getAuditProjects(),
      failures: this.getAuditFailures(),
    };
  }

  getStatusReport(): StatusReportSnapshot {
    return createStatusReportSnapshot({
      packageReadFailures: this.state.packageReadFailures,
      updateFailures: this.state.updateFailures,
      auditFailures: this.state.auditFailures,
      workspaceFolderDescriptors: this.state.workspaceFolderDescriptors,
    });
  }

  getVisibleOutdatedPackages(): PackageItem[] {
    if (this.loading) {
      return [];
    }
    return projectPackageTree(
      this.allEntries,
      this.filterManager.current,
      this.filterManager.search,
    ).visibleOutdatedEntries.map(entry => entry.item);
  }

  getPackageIdentitiesForFile(packageFilePath: string): PackageStateIdentity[] {
    return this.rowMutations.getPackageIdentitiesForFile(packageFilePath);
  }

  markPackageUpdated(identity: PackageStateIdentity, newVersion: string): void {
    this.rowMutations.markPackageUpdated(identity, newVersion);
  }

  markPackageUpdatedForCapability(capability: ResolvedPackageItem, newVersion: string): void {
    this.rowMutations.markPackageUpdatedForCapability(capability, newVersion);
  }

  resetUpdateData(): void {
    this.rowMutations.resetUpdateData(() => this.invalidateUpdateCache());
  }

  invalidateUpdateCache(): void {
    this.updateOrchestrationService.invalidateCache();
    this.state.lastCheckTime = undefined;
    logger.info('Update cache invalidated.');
  }

  markPackageUpdating(identity: PackageStateIdentity, operation: PackageOperationInput): void {
    this.rowMutations.markPackageUpdating(identity, operation);
  }

  markPackageUpdatingForCapability(
    capability: ResolvedPackageItem,
    operation: PackageOperationInput,
  ): ResolvedPackageItem | undefined {
    return this.rowMutations.markPackageUpdatingForCapability(capability, operation);
  }

  refreshPackageBaselineForCapability(
    capability: ResolvedPackageItem,
    expectedCurrentVersion: string,
  ): Promise<ResolvedPackageItem | undefined> {
    return this.capabilities.refreshPackageBaselineForCapability(capability, expectedCurrentVersion);
  }

  reissuePackageCapability(capability: ResolvedPackageItem): Promise<ResolvedPackageItem | undefined> {
    return this.capabilities.reissuePackageCapability(capability);
  }

  async showFilterPicker(): Promise<void> {
    if (this.state.rowStore.allEntries.length === 0) {
      return;
    }
    await this.filterManager.showPicker(getFilterCounts(this.state.rowStore.allEntries, this.filterManager.search));
  }

  loadPackages(): Promise<void> {
    return this.loadController.loadPackages();
  }

  checkUpdates(): Promise<void> {
    return this.updateController.checkUpdates();
  }

  cancelCheckUpdates(): void {
    this.updateController.cancelCheckUpdates();
  }

  runAudit(): Promise<void> {
    return this.auditController.runAudit();
  }

  cancelAudit(): void {
    this.auditController.cancelAudit();
  }

  dispose(): void {
    if (this.state.disposed) {
      return;
    }
    this.state.manifestWriteBaselines.clear();
    this.state.loadLifecycle.cancel();
    this.cancelCheckUpdates();
    this.cancelAudit();
    this.state.disposed = true;
    this.state.workspaceCapabilities = EMPTY_WORKSPACE_CAPABILITIES;
    this.state.packageReadFailed = false;
    this.view.resetContexts();
    this.filterChangeDisposable.dispose();
    this.view.dispose();
  }

  private ensurePackageLoad(): void {
    if (this.state.packageSnapshotGeneration === 0
      || (!this.state.loading && this.state.packageReadFailed && this.state.packageFilePaths.length === 0)) {
      void this.loadPackages();
    }
  }

  private emitTreeChanged(): void {
    this.view.emitTreeChanged();
  }

  private get allEntries(): readonly PackageTreeEntry[] {
    return this.state.allEntries;
  }

  private set allEntries(entries: PackageTreeEntry[]) {
    this.state.allEntries = entries;
  }

  private get loading(): boolean {
    return this.state.loading;
  }

  private set loading(value: boolean) {
    this.state.loading = value;
  }
}