import * as vscode from 'vscode';
import type { AuditSeverity, ReleaseAgeState, StatusReportFailure, UpdateType } from '../utils';
import type { AuditProjectFailure, AuditProjectSummary } from './auditOrchestrationService';
import { PackageItem } from './PackageItem';
import type { PackageOperation } from './PackageItem';
import { PackageCapabilityService } from './capabilityService';
import { ManifestWriteBaselines } from './manifestWriteBaselines';
import { packageIdentityFromValues, packageIdentityKey } from './packageIdentity';
import type { CanonicalPackageItem, CanonicalPackageLocation, PackageItemRecord } from './packageIdentity';
import { PackageRowStore } from './packageRowStore';
import { OperationLifecycle } from './operationLifecycle';
import type { PackageTreeEntry } from './treeBuilder';
import type { WorkspaceFolderDescriptor } from './packageLabels';
import { getLocalizedPackageLabelFormatting, resolvePackageFileLabels, toWorkspaceFolderDescriptors } from './packageLabels';
import { EMPTY_WORKSPACE_CAPABILITIES } from './workspaceCapabilityResolver';
import type { WorkspaceCapabilities } from './workspaceCapabilityResolver';

export interface CreatePackageItemOptions {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly latest?: string;
  readonly updateType: UpdateType;
  readonly operation?: PackageOperation;
  readonly packageFilePath: string;
  readonly dev: boolean;
  readonly versionPrefix: string;
  readonly releaseAge?: ReleaseAgeState;
}

/** Mutable snapshot and operation state shared by the provider's focused services. */
export class PackageProviderState {
  readonly capabilities = new PackageCapabilityService();
  readonly rowStore = new PackageRowStore(identity => this.capabilities.noteRowMutation(identity));
  readonly packageItemRecords = new WeakMap<PackageItem, PackageItemRecord>();
  readonly loadLifecycle = new OperationLifecycle<'load'>('load');
  readonly updateLifecycle = new OperationLifecycle<'update'>('update');
  readonly auditLifecycle = new OperationLifecycle<'audit'>('audit');
  readonly manifestWriteBaselines = new ManifestWriteBaselines();
  packageFilePaths: string[] = [];
  readablePackageFilePaths: string[] = [];
  workspaceCapabilities: WorkspaceCapabilities = EMPTY_WORKSPACE_CAPABILITIES;
  capabilitiesInitialized = false;
  packageReadFailed = false;
  packageLocationBaselines = new Map<string, CanonicalPackageLocation>();
  packageSnapshotGeneration = 0;
  loading = true;
  auditResults = new Map<string, AuditSeverity>();
  auditProjects: AuditProjectSummary[] = [];
  auditFailures: AuditProjectFailure[] = [];
  checkState: 'idle' | 'running' | 'done' | 'incomplete' = 'idle';
  lastCheckTime: Date | undefined;
  auditState: 'idle' | 'running' | 'done' | 'incomplete' | 'failed' = 'idle';
  lastAuditCount: number | undefined;
  lastAuditSuccessfulRootCount: number | undefined;
  failedAuditPaths: string[] = [];
  failedUpdatePaths: string[] = [];
  packageReadFailures: StatusReportFailure[] = [];
  updateFailures: StatusReportFailure[] = [];
  disposed = false;
  private ownerLabelCache: ReadonlyMap<string, string> | undefined;

  get allEntries(): readonly PackageTreeEntry[] {
    return this.rowStore.allEntries;
  }

  set allEntries(entries: PackageTreeEntry[]) {
    this.rowStore.replaceAll(entries);
  }

  get workspaceFolderDescriptors(): WorkspaceFolderDescriptor[] {
    return toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  }

  setPackageFilePaths(packageFilePaths: readonly string[]): void {
    this.packageFilePaths = [...packageFilePaths];
    this.ownerLabelCache = undefined;
  }

  createPackageItem(options: CreatePackageItemOptions): PackageItem {
    const {
      packageName,
      currentVersion,
      latest,
      updateType,
      operation,
      packageFilePath,
      dev,
      versionPrefix,
      releaseAge = { kind: 'accepted' },
    } = options;
    const identity = Object.freeze(packageIdentityFromValues(packageName, packageFilePath, dev));
    const vulnerabilitySeverity = this.auditResults.get(packageIdentityKey(identity));
    const item = new PackageItem(
      packageName,
      currentVersion,
      latest,
      updateType,
      operation,
      vulnerabilitySeverity,
      packageFilePath,
      dev,
      versionPrefix,
      releaseAge,
      this.resolveOwnerLabel(packageFilePath),
    );
    const row: CanonicalPackageItem = Object.freeze({
      packageName,
      currentVersion,
      latest,
      updateType,
      operation,
      vulnerabilitySeverity,
      packageFilePath,
      dev,
      versionPrefix,
      releaseAge,
    });
    const baselineLocation = this.packageLocationBaselines.get(packageFilePath);
    this.packageItemRecords.set(item, Object.freeze({ identity, row, baselineLocation }));
    return item;
  }

  rebuildPackageItems(): void {
    this.rowStore.replaceAll(this.rowStore.allEntries.map(({ item, dev, packageFilePath }) => ({
      item: this.createPackageItem({
        packageName: item.packageName,
        currentVersion: item.currentVersion,
        latest: item.latest,
        updateType: item.updateType,
        operation: item.operation,
        packageFilePath,
        dev,
        versionPrefix: item.versionPrefix,
        releaseAge: item.releaseAge,
      }),
      dev,
      packageFilePath,
    })));
  }

  private resolveOwnerLabel(packageFilePath: string): string | undefined {
    if (packageFilePath === '') {
      return undefined;
    }
    const cached = this.ownerLabels.get(packageFilePath);
    if (cached !== undefined) {
      return cached;
    }
    const folders = this.workspaceFolderDescriptors;
    if (folders.length === 0) {
      return undefined;
    }
    return resolvePackageFileLabels(
      [...this.packageFilePaths, packageFilePath],
      folders,
      getLocalizedPackageLabelFormatting(),
    ).find(entry => entry.packageFilePath === packageFilePath)?.owner.label;
  }

  private get ownerLabels(): ReadonlyMap<string, string> {
    if (this.ownerLabelCache === undefined) {
      const folders = this.workspaceFolderDescriptors;
      this.ownerLabelCache = folders.length === 0
        ? new Map()
        : new Map(resolvePackageFileLabels(
            this.packageFilePaths,
            folders,
            getLocalizedPackageLabelFormatting(),
          ).map(entry => [entry.packageFilePath, entry.owner.label]));
    }
    return this.ownerLabelCache;
  }
}