import * as vscode from 'vscode';
import { logger, showError } from '../utils';
import { packageIdentityFromValues, packageIdentityKey } from './packageIdentity';
import { createPackageReadFailureSnapshot } from './statusReportAssembler';
import type { PackageLoadingServiceContract, PackageLoadingSnapshot } from './packageLoadingService';
import { PackageProviderState } from './packageProviderState';
import type { OperationRun } from './operationLifecycle';
import { EMPTY_WORKSPACE_CAPABILITIES } from './workspaceCapabilityResolver';
import type { WorkspaceCapabilityResolver } from './workspaceCapabilityResolver';

/** Applies workspace package snapshots and coordinates load cancellation. */
export class PackageLoadController {
  constructor(
    private readonly state: PackageProviderState,
    private readonly packageLoadingService: PackageLoadingServiceContract,
    private readonly capabilityResolver: WorkspaceCapabilityResolver,
    private readonly emitTreeChanged: () => void,
  ) {}

  loadPackages(): Promise<void> {
    logger.info('Loading workspace packages.');
    const snapshotGeneration = this.state.packageSnapshotGeneration + 1;
    this.state.packageSnapshotGeneration = snapshotGeneration;
    this.state.updateLifecycle.cancel();
    this.state.auditLifecycle.cancel();
    this.state.checkState = 'idle';
    this.state.auditState = 'idle';
    const operation = this.state.loadLifecycle.start(snapshotGeneration);
    this.state.capabilities.reset();
    this.state.packageLocationBaselines = new Map();
    this.state.setPackageFilePaths([]);
    this.state.readablePackageFilePaths = [];
    this.state.packageReadFailed = false;
    this.state.loading = true;
    this.clearAuditSnapshot();
    this.clearFailureSnapshots();
    this.emitTreeChanged();
    const completion = this.loadPackageSnapshot(operation);
    this.state.loadLifecycle.trackCompletion(operation, completion);
    return completion;
  }

  private async loadPackageSnapshot(operation: OperationRun<'load'>): Promise<void> {
    try {
      const snapshot = await this.packageLoadingService.load(operation.abortController.signal);
      if (snapshot === undefined || this.isLoadOutdated(operation)) {
        return;
      }
      this.applyPackageSnapshot(snapshot);
      const workspaceCapabilities = await this.capabilityResolver.resolve(
        snapshot.packageFilePaths,
        snapshot.readablePackageFilePaths,
        snapshot.entries,
      );
      if (this.isLoadOutdated(operation)) {
        return;
      }
      this.state.workspaceCapabilities = workspaceCapabilities;
      this.state.capabilitiesInitialized = true;
    }
    catch (error) {
      this.recordLoadFailure(operation, error);
    }
    finally {
      this.finishLoad(operation);
    }
  }

  private applyPackageSnapshot(snapshot: PackageLoadingSnapshot): void {
    this.state.packageReadFailed = snapshot.packageReadFailed;
    this.state.packageLocationBaselines = new Map(snapshot.packageLocationBaselines);
    this.state.setPackageFilePaths(snapshot.packageFilePaths);
    this.state.readablePackageFilePaths = [...snapshot.readablePackageFilePaths];
    this.state.failedPackageReadPaths = [...snapshot.failedPackageReadPaths];
    this.state.packageReadFailures = createPackageReadFailureSnapshot(
      snapshot.failedPackageReadPaths,
      snapshot.failedPackageReadDetails,
      snapshot.packageReadFailed,
    );
    logger.info(`Loaded ${snapshot.entries.length} workspace package(s).`);
    const existingMap = new Map(this.state.rowStore.allEntries.map(entry => [
      packageIdentityKey(packageIdentityFromValues(entry.item.packageName, entry.packageFilePath, entry.dev)),
      entry,
    ]));
    this.state.rowStore.replaceAll(snapshot.entries.map((entry) => {
      const identity = packageIdentityFromValues(entry.name, entry.packageFilePath, entry.dev);
      const existing = existingMap.get(packageIdentityKey(identity));
      const existingSemver = existing?.item.currentVersion.slice(existing.item.versionPrefix.length);
      const newSemver = entry.current.slice(entry.versionPrefix.length);
      const preserveUpdateState = existing !== undefined
        && (existing.item.operation !== undefined || existingSemver === newSemver);
      if (preserveUpdateState && existing !== undefined) {
        return {
          item: this.state.createPackageItem({
            packageName: entry.name,
            currentVersion: entry.current,
            latest: existing.item.latest,
            updateType: existing.item.updateType,
            operation: existing.item.operation,
            packageFilePath: entry.packageFilePath,
            dev: entry.dev,
            versionPrefix: entry.versionPrefix,
            releaseAge: existing.item.releaseAge,
          }),
          dev: entry.dev,
          packageFilePath: entry.packageFilePath,
        };
      }
      return {
        item: this.state.createPackageItem({
          packageName: entry.name,
          currentVersion: entry.current,
          updateType: 'none',
          packageFilePath: entry.packageFilePath,
          dev: entry.dev,
          versionPrefix: entry.versionPrefix,
        }),
        dev: entry.dev,
        packageFilePath: entry.packageFilePath,
      };
    }));
  }

  private recordLoadFailure(operation: OperationRun<'load'>, error: unknown): void {
    if (this.isLoadOutdated(operation)) {
      return;
    }
    this.state.packageLocationBaselines = new Map();
    this.state.setPackageFilePaths([]);
    this.state.readablePackageFilePaths = [];
    this.state.workspaceCapabilities = EMPTY_WORKSPACE_CAPABILITIES;
    this.state.packageReadFailed = true;
    this.state.capabilitiesInitialized = true;
    this.state.rowStore.replaceAll([]);
    const detail = error instanceof Error ? error.message : String(error);
    this.state.packageReadFailures = [{ packageFilePaths: [], reason: 'package-load-failed', detail }];
    showError(vscode.l10n.t('Failed to load packages — {0}', detail), error);
  }

  private finishLoad(operation: OperationRun<'load'>): void {
    if (!this.isLoadOutdated(operation)) {
      this.state.loading = false;
      this.emitTreeChanged();
    }
    this.state.loadLifecycle.finish(operation);
  }

  private clearAuditSnapshot(): void {
    this.state.auditResults = new Map();
    this.state.auditProjects = [];
    this.state.auditFailures = [];
    this.state.lastAuditCount = undefined;
    this.state.lastAuditSuccessfulRootCount = undefined;
    this.state.failedAuditPaths = [];
  }

  private clearFailureSnapshots(): void {
    this.state.failedUpdatePaths = [];
    this.state.packageReadFailures = [];
    this.state.updateFailures = [];
    this.state.failedPackageReadPaths = [];
  }

  private isLoadOutdated(operation: OperationRun<'load'>): boolean {
    return !this.state.loadLifecycle.isCurrent(
      operation,
      this.state.packageSnapshotGeneration,
      this.state.loading,
    );
  }
}