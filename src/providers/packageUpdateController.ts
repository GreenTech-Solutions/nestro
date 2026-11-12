import * as vscode from 'vscode';
import { getCheckUpdatesDebounce, getCheckUpdatesForceAlways, getUpdatePolicySettings } from '../config';
import { describeError, uniqueStrings } from '../shared';
import { getUpdateType, logger, showError } from '../utils';
import { packageIdentityFromValues, packageIdentityKey } from './packageIdentity';
import type { PackageIdentityTuple } from './packageIdentity';
import { createUpdateFailureSnapshot } from './statusReportAssembler';
import type { UpdateFingerprintPolicy, UpdateOrchestrationServiceContract } from './updateOrchestrationService';
import type { PackageProviderState } from './packageProviderState';
import type { OperationRun } from './operationLifecycle';

interface UpdateSourceEntry {
  readonly name: string;
  readonly current: string;
  readonly dev: boolean;
  readonly versionPrefix: string;
  readonly packageFilePath: string;
}

/** Runs update checks and applies only results for the current package snapshot. */
export class PackageUpdateController {
  constructor(
    private readonly state: PackageProviderState,
    private readonly service: UpdateOrchestrationServiceContract,
    private readonly ensurePackageLoad: () => void,
    private readonly emitTreeChanged: () => void,
  ) {}

  async checkUpdates(): Promise<void> {
    if (this.state.checkState === 'running') {
      return;
    }
    this.ensurePackageLoad();
    const operation = this.state.updateLifecycle.start(this.state.packageSnapshotGeneration);
    this.state.checkState = 'running';
    this.state.failedUpdatePaths = [];
    this.state.updateFailures = [];
    const attemptedPackageFilePaths: string[] = [];
    this.emitTreeChanged();
    try {
      await this.state.updateLifecycle.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Checking package updates…'),
          cancellable: true,
        },
        () => this.runUpdateCheck(operation, attemptedPackageFilePaths),
        () => this.cancelCheckUpdates(),
      );
    }
    catch (error) {
      this.recordUpdateFailure(operation, attemptedPackageFilePaths, error);
    }
    finally {
      this.finishUpdate(operation);
    }
  }

  cancelCheckUpdates(): void {
    if (this.state.checkState !== 'running' || this.state.updateLifecycle.cancel() === undefined) {
      return;
    }
    this.state.checkState = 'idle';
    this.emitTreeChanged();
  }

  private async runUpdateCheck(
    operation: OperationRun<'update'>,
    attemptedPackageFilePaths: string[],
  ): Promise<void> {
    if (!this.isUpdateCurrent(operation)) {
      return;
    }
    await this.state.loadLifecycle.waitForCurrent(operation.abortController.signal);
    if (!this.isUpdateCurrent(operation)) {
      return;
    }
    const source = this.readUpdateSource();
    const packageFiles = [...new Set(source.map(entry => entry.packageFilePath))];
    attemptedPackageFilePaths.push(...packageFiles);
    const identities = source.map(entry => packageIdentityFromValues(entry.name, entry.packageFilePath, entry.dev));
    const currentVersions = new Map(identities.map((identity, index) => [
      packageIdentityKey(identity),
      source[index].current,
    ]));
    const result = await this.service.check(this.createUpdateRequest(
      operation,
      source,
      packageFiles,
      identities,
      currentVersions,
    ));
    if (this.isUpdateCurrent(operation)) {
      this.applyUpdateResult(result, source);
    }
  }

  private readUpdateSource(): UpdateSourceEntry[] {
    return this.state.rowStore.allEntries.map(entry => ({
      name: entry.item.packageName,
      current: entry.item.currentVersion,
      dev: entry.dev,
      versionPrefix: entry.item.versionPrefix,
      packageFilePath: entry.packageFilePath,
    }));
  }

  private createUpdateRequest(
    operation: OperationRun<'update'>,
    source: readonly UpdateSourceEntry[],
    packageFiles: readonly string[],
    identities: readonly PackageIdentityTuple[],
    currentVersions: ReadonlyMap<string, string>,
  ) {
    const forceAlways = getCheckUpdatesForceAlways();
    const { includePreReleases, minimumReleaseAgeDays, target } = getUpdatePolicySettings();
    return {
      identities,
      currentVersions,
      packageFiles,
      target,
      includePreReleases,
      minimumReleaseAgeDays,
      forceAlways,
      debounceSeconds: getCheckUpdatesDebounce(),
      lastCheckTime: this.state.lastCheckTime?.getTime(),
      signal: operation.abortController.signal,
      isCurrent: () => this.isUpdateCurrent(operation),
      resolveCurrentPolicy: () => this.currentUpdatePolicy(),
      onCheckStarted: () => {
        logger.info('Checking package updates.');
        logger.info(`Checking updates for ${source.length} package(s).`);
      },
      onRootFailure: () => logger.error('Update check failed for a package root; other roots still completed.'),
      onDiscarded: () => logger.info('Update results discarded — packages or update settings changed during the check.'),
    };
  }

  private applyUpdateResult(
    result: Awaited<ReturnType<UpdateOrchestrationServiceContract['check']>>,
    source: readonly UpdateSourceEntry[],
  ): void {
    if (result.kind === 'debounced') {
      logger.info('Check for updates skipped — debounce interval has not elapsed.');
      this.state.checkState = 'done';
      return;
    }
    if (result.kind === 'discarded') {
      this.state.checkState = 'idle';
      return;
    }
    const upgrades = result.data;
    this.state.failedUpdatePaths = uniqueStrings(result.failedPackageFilePaths);
    this.state.updateFailures = createUpdateFailureSnapshot(result.failedPackageFilePaths, result.failures);
    if (result.allFailed) {
      const failureMessage = result.failure instanceof Error
        ? result.failure.message
        : result.failure === undefined ? vscode.l10n.t('all package roots failed') : String(result.failure);
      showError(vscode.l10n.t('Failed to check updates — {0}', failureMessage), result.failure);
    }
    this.state.rowStore.replaceAll(this.state.rowStore.allEntries.map(({ item, dev, packageFilePath }) => {
      const identity = packageIdentityFromValues(item.packageName, packageFilePath, dev);
      const updateData = upgrades.get(packageIdentityKey(identity));
      const latest = updateData?.acceptedVersion;
      const updateType = latest === undefined ? 'none' : getUpdateType(item.currentVersion, latest);
      return {
        item: this.state.createPackageItem({
          packageName: item.packageName,
          currentVersion: item.currentVersion,
          latest,
          updateType,
          operation: item.operation,
          packageFilePath,
          dev,
          versionPrefix: item.versionPrefix,
          releaseAge: updateData?.releaseAge,
        }),
        dev,
        packageFilePath,
      };
    }));
    logger.info(`Checked updates for ${source.length} package(s).`);
    this.state.checkState = this.state.failedUpdatePaths.length === 0 ? 'done' : 'incomplete';
    this.state.lastCheckTime = new Date();
  }

  private recordUpdateFailure(
    operation: OperationRun<'update'>,
    attemptedPackageFilePaths: readonly string[],
    error: unknown,
  ): void {
    if (!this.isUpdateCurrent(operation)) {
      return;
    }
    this.state.failedUpdatePaths = uniqueStrings(attemptedPackageFilePaths);
    const detail = describeError(error);
    this.state.updateFailures = [{
      packageFilePaths: [...attemptedPackageFilePaths],
      reason: 'update-check-failed',
      detail,
    }];
    this.state.checkState = 'idle';
    showError(vscode.l10n.t('Failed to check updates — {0}', detail), error);
  }

  private finishUpdate(operation: OperationRun<'update'>): void {
    if (!this.state.updateLifecycle.finish(operation)) {
      return;
    }
    if (this.state.checkState === 'running') {
      this.state.checkState = 'idle';
    }
    if (!operation.abortController.signal.aborted) {
      this.emitTreeChanged();
    }
  }

  private currentUpdatePolicy(): UpdateFingerprintPolicy {
    return getUpdatePolicySettings();
  }

  private isUpdateCurrent(operation: OperationRun<'update'>): boolean {
    return this.state.updateLifecycle.isCurrent(
      operation,
      this.state.packageSnapshotGeneration,
      this.state.checkState === 'running',
    );
  }
}