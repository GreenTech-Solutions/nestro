import * as vscode from 'vscode';
import { logger, showError } from '../utils';
import {
  cloneAuditProjectFailure,
  cloneAuditProjectSummary,
  describeAuditFailure,
} from './auditOrchestrationService';
import type {
  AuditableRow,
  AuditOrchestrationResult,
  AuditOrchestrationServiceContract,
  AuditProjectFailure,
  AuditProjectSummary,
} from './auditOrchestrationService';
import type { PackageProviderState } from './packageProviderState';
import type { OperationRun } from './operationLifecycle';

/** Runs audits and publishes project summaries, failures, and row badges. */
export class PackageAuditController {
  constructor(
    private readonly state: PackageProviderState,
    private readonly service: AuditOrchestrationServiceContract,
    private readonly ensurePackageLoad: () => void,
    private readonly emitTreeChanged: () => void,
  ) {}

  getAuditProjects(): readonly AuditProjectSummary[] {
    return this.state.auditProjects.map(summary => cloneAuditProjectSummary(summary));
  }

  getAuditFailures(): readonly AuditProjectFailure[] {
    return this.state.auditFailures.map(failure => cloneAuditProjectFailure(failure));
  }

  cancelAudit(): void {
    if (this.state.auditState !== 'running' || this.state.auditLifecycle.cancel() === undefined) {
      return;
    }
    this.state.auditState = 'idle';
    this.emitTreeChanged();
  }

  async runAudit(): Promise<void> {
    if (this.state.auditState === 'running') {
      return;
    }
    this.ensurePackageLoad();
    const operation = this.state.auditLifecycle.start(this.state.packageSnapshotGeneration);
    this.state.auditState = 'running';
    this.state.lastAuditCount = undefined;
    this.state.lastAuditSuccessfulRootCount = undefined;
    this.state.failedAuditPaths = [];
    this.state.auditProjects = [];
    this.state.auditFailures = [];
    this.state.auditResults = new Map();
    this.state.rebuildPackageItems();
    this.emitTreeChanged();
    try {
      await this.state.auditLifecycle.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Running package audit…'),
          cancellable: true,
        },
        async (): Promise<void> => {
          if (!this.isAuditCurrent(operation)) {
            return;
          }
          await this.state.loadLifecycle.waitForCurrent(operation.abortController.signal);
          if (this.isAuditCurrent(operation)) {
            await this.runAuditCore(operation);
          }
        },
        () => this.cancelAudit(),
      );
    }
    finally {
      if (this.state.auditLifecycle.finish(operation) && this.state.auditState === 'running') {
        this.state.auditState = 'idle';
        if (!operation.abortController.signal.aborted) {
          this.emitTreeChanged();
        }
      }
    }
  }

  private async runAuditCore(operation: OperationRun<'audit'>): Promise<void> {
    if (!this.isAuditCurrent(operation)) {
      return;
    }
    let shouldEmit = false;
    try {
      const request = this.createAuditRequest(operation);
      if (!this.isAuditCurrent(operation)) {
        return;
      }
      if (request.packageFilePaths.length === 0) {
        this.state.auditState = 'idle';
        shouldEmit = true;
        return;
      }
      const result = await this.service.run(request);
      if (!this.isAuditCurrent(operation) || result.kind === 'discarded') {
        return;
      }
      shouldEmit = this.applyAuditResult(result);
    }
    catch (error) {
      if (this.isAuditCurrent(operation)) {
        this.recordAuditFailure(error);
        shouldEmit = true;
      }
    }
    finally {
      this.finishAuditCore(operation, shouldEmit);
    }
  }

  private createAuditRequest(operation: OperationRun<'audit'>) {
    const packageFilePaths = this.state.rowStore.allEntries.length > 0
      ? [...new Set(this.state.rowStore.allEntries.map(entry => entry.packageFilePath))]
      : this.state.readablePackageFilePaths;
    const rows: AuditableRow[] = this.state.rowStore.allEntries.map(entry => ({
      packageName: entry.item.packageName,
      packageFilePath: entry.packageFilePath,
      dev: entry.dev,
      currentVersion: entry.item.currentVersion,
    }));
    return {
      packageFilePaths,
      rows,
      signal: operation.abortController.signal,
      isCurrent: () => this.isAuditCurrent(operation),
    };
  }

  private applyAuditResult(
    result: Exclude<AuditOrchestrationResult, { readonly kind: 'discarded' }>,
  ): boolean {
    if (result.kind === 'failed') {
      this.state.auditFailures = [{ packageFilePaths: [], reason: result.reason, detail: result.detail }];
      this.state.auditState = 'failed';
      showError(vscode.l10n.t('Package audit failed — the security audit report is incomplete.'));
      return true;
    }
    this.state.auditResults = new Map(result.auditResults);
    this.state.auditProjects = [...result.auditProjects];
    this.state.auditFailures = [...result.auditFailures];
    this.state.failedAuditPaths = [...result.failedAuditPaths];
    this.state.auditState = this.state.failedAuditPaths.length === 0 ? 'done' : 'incomplete';
    this.state.lastAuditCount = result.vulnerablePackageCount;
    this.state.lastAuditSuccessfulRootCount = result.successfulAuditRootCount;
    this.logAuditResult();
    this.state.rebuildPackageItems();
    return true;
  }

  private logAuditResult(): void {
    const rejectedManifestCount = this.state.auditFailures.filter(failure => failure.project === undefined).length;
    const failedProjectCount = this.state.auditFailures.length - rejectedManifestCount;
    if (rejectedManifestCount > 0) {
      logger.error('Audit project resolution failed; see the security audit report for redacted details.');
    }
    for (let index = 0; index < failedProjectCount; index += 1) {
      logger.error('Audit failed for a project; see the security audit report for redacted details.');
    }
    logger.info(
      this.state.failedAuditPaths.length === 0
        ? `Audit: ${this.state.lastAuditCount} vulnerable package(s).`
        : `Audit incomplete: ${this.state.lastAuditCount} vulnerable package(s); `
          + `failed ${this.state.failedAuditPaths.length} package root(s).`,
    );
  }

  private recordAuditFailure(error: unknown): void {
    const failure = describeAuditFailure(error);
    this.state.auditFailures = [{ packageFilePaths: [], reason: failure.reason, detail: failure.detail }];
    this.state.auditState = 'failed';
    showError(vscode.l10n.t('Package audit failed — the security audit report is incomplete.'));
  }

  private finishAuditCore(operation: OperationRun<'audit'>, shouldEmit: boolean): void {
    if (!this.state.auditLifecycle.finish(operation)) {
      return;
    }
    if (this.state.auditState === 'running') {
      this.state.auditState = 'idle';
      shouldEmit = !operation.abortController.signal.aborted;
    }
    if (shouldEmit) {
      this.emitTreeChanged();
    }
  }

  private isAuditCurrent(operation: OperationRun<'audit'>): boolean {
    return this.state.auditLifecycle.isCurrent(
      operation,
      this.state.packageSnapshotGeneration,
      this.state.auditState === 'running',
    );
  }
}