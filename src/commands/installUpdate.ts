import * as vscode from 'vscode';
import { getDeferInstallAfterUpdate } from '../config';
import { ClientManager } from '../clients';
import { isPackageItem, PackagesProvider } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import { COMMAND_IDS, describeError } from '../shared';
import { logger, showError } from '../utils';
import type { ReleaseAgeState } from '../utils';
import { resolveCommandPackageItem } from './packageIdentity';
import { revalidateUpdates, runImmediateUpdateGroups } from './packageUpdateExecution';
import type { BulkUpdateChecked, ImmediateUpdateRun } from './packageUpdateExecution';
import { confirmRiskyUpdates } from './updateRiskConfirmation';
import {
  confirmBulkPackageUpdate,
  formatUnverifiedUpdateMessage,
  reconcileFailedPackageMutation,
  writeAndMarkPackageUpdates,
  writePackageUpdateBatch,
} from './packageUpdateSteps';
import type { PackageUpdate } from './packageUpdateSteps';
import { clearMutationProgress, markPackageCapabilities, runRowMutation } from './rowMutation';
import type { RowMutationExecution, RowMutationProgress } from './rowMutation';

const clientManager = new ClientManager();

interface UpdateItemRequest {
  readonly kind: 'item';
  readonly item: unknown;
  readonly provider: PackagesProvider;
}

interface SelectedUpdateRequest {
  readonly kind: 'selected';
  readonly capability: ResolvedPackageItem;
  readonly version: string;
  readonly provider: PackagesProvider;
  readonly releaseAge?: ReleaseAgeState;
}

type UpdateAllRequest = { readonly kind: 'all'; readonly provider: PackagesProvider };

type UpdateRequest = UpdateItemRequest | SelectedUpdateRequest | UpdateAllRequest;

interface UpdateBatchMutation {
  readonly kind: 'single' | 'bulk';
  readonly updates: readonly PackageUpdate[];
  readonly provider: PackagesProvider;
}

type BulkUpdateMarked
  = | { readonly kind: 'immediate' }
    | { readonly kind: 'deferred'; readonly progress: RowMutationProgress; readonly updates: readonly PackageUpdate[] };

type BulkUpdateApplied
  = | { readonly kind: 'deferred' }
    | { readonly kind: 'unverified' }
    | { readonly kind: 'immediate'; readonly outcome: ImmediateUpdateRun };

type BulkUpdateExecution = RowMutationExecution<BulkUpdateChecked, BulkUpdateMarked, BulkUpdateApplied>;

export async function installUpdateCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  await runUpdateMutation({ kind: 'item', item, provider });
}

/**
 * Execute an explicitly selected version (used by the version picker) against a
 * canonical capability. The version is the only operation-specific input; package
 * identity, section, cwd, and all current row fields come from the revalidated provider.
 */
export async function runResolvedPackageVersion(
  capability: ResolvedPackageItem,
  version: string,
  provider: PackagesProvider,
  selectedReleaseAge?: ReleaseAgeState,
): Promise<void> {
  await runUpdateMutation({ kind: 'selected', capability, version, provider, releaseAge: selectedReleaseAge });
}

async function runUpdateMutation(request: UpdateRequest): Promise<void> {
  await runRowMutation<UpdateRequest, UpdateBatchMutation, BulkUpdateChecked, BulkUpdateMarked, BulkUpdateApplied>(request, {
    guard: current => guardUpdateRequest(current),
    resolve: current => resolveUpdateBatch(current),
    lockTargets: batch => batch.updates.map(update => update.capability.packageFilePath),
    revalidate: batch => createBulkUpdatePlan(batch),
    mark: checked => markBulkUpdates(checked, request.provider),
    apply: (checked, marked) => applyBulkUpdates(checked, marked, request.provider),
    reconcile: execution => reconcileBulkUpdates(execution, request.provider),
    reportError: error => reportUpdateError(request, error),
  });
}

function reportUpdateError(request: UpdateRequest, error: unknown): void {
  if (request.kind === 'all') {
    showError(vscode.l10n.t('failed to update packages — {0}', describeError(error)), error);
    return;
  }
  showError(vscode.l10n.t('failed to install update — {0}', describeError(error)), error);
}

function guardUpdateRequest(request: UpdateRequest): boolean {
  if (request.kind !== 'item' || isPackageItem(request.item)) {
    return true;
  }
  logger.warn(`${COMMAND_IDS.installUpdate} invoked without a valid package item; ignoring.`);
  return false;
}

async function resolveUpdateBatch(request: UpdateRequest): Promise<UpdateBatchMutation | undefined> {
  if (request.kind === 'all') {
    const updates = await resolveBulkUpdates(request.provider);
    return updates === undefined ? undefined : { kind: 'bulk', updates, provider: request.provider };
  }
  if (request.kind === 'selected') {
    return {
      kind: 'single',
      updates: [{
        capability: request.capability,
        version: request.version,
        releaseAge: request.releaseAge,
        source: 'selected',
      }],
      provider: request.provider,
    };
  }
  const capability = await resolveCommandPackageItem(request.item, request.provider);
  const version = capability?.item.latest;
  if (capability === undefined || version === undefined || capability.item.operation !== undefined) {
    return undefined;
  }
  return {
    kind: 'single',
    updates: [{ capability, version, source: 'latest' }],
    provider: request.provider,
  };
}

export async function updateAllVisibleCommand(provider: PackagesProvider): Promise<void> {
  await runUpdateMutation({ kind: 'all', provider });
}

async function resolveBulkUpdates(provider: PackagesProvider): Promise<PackageUpdate[] | undefined> {
  const items = provider.getVisibleOutdatedPackages();
  if (items.length === 0) {
    return undefined;
  }
  const updates: PackageUpdate[] = [];
  for (const item of items) {
    const capability = await resolveCommandPackageItem(item, provider);
    if (capability === undefined) {
      return undefined;
    }
    if (capability.item.latest !== undefined && capability.item.operation === undefined) {
      updates.push({ capability, version: capability.item.latest, source: 'latest' });
    }
  }
  if (updates.length === 0 || !await confirmBulkPackageUpdate(updates.length)) {
    return undefined;
  }
  return updates;
}

async function createBulkUpdatePlan(
  batch: UpdateBatchMutation,
): Promise<BulkUpdateChecked | undefined> {
  let checkedUpdates = await revalidateUpdates(batch.updates, batch.provider, batch.kind === 'bulk');
  if (checkedUpdates === undefined) {
    return undefined;
  }
  const confirmedRiskyUpdates = new Set<string>();
  if (batch.kind === 'bulk' && !await confirmRiskyUpdates(checkedUpdates, confirmedRiskyUpdates)) {
    return undefined;
  }
  const strategy = getDeferInstallAfterUpdate() ? 'deferred' : 'immediate';
  if (strategy === 'deferred') {
    if (batch.kind === 'bulk') {
      checkedUpdates = await revalidateUpdates(checkedUpdates, batch.provider, true) ?? [];
      if (checkedUpdates.length === 0 || !await confirmRiskyUpdates(checkedUpdates, confirmedRiskyUpdates)) {
        return undefined;
      }
    }
    else if (!await confirmRiskyUpdates(checkedUpdates, confirmedRiskyUpdates)) {
      return undefined;
    }
  }
  return { kind: batch.kind, strategy, updates: checkedUpdates, confirmedRiskyUpdates };
}

function markBulkUpdates(checked: BulkUpdateChecked, provider: PackagesProvider): BulkUpdateMarked | undefined {
  if (checked.strategy === 'immediate') {
    return { kind: 'immediate' };
  }
  const progress = markPackageCapabilities(provider, checked.updates.map(update => ({
    capability: update.capability,
    operation: { kind: 'update' as const, target: update.version },
  })));
  return progress === undefined
    ? undefined
    : {
        kind: 'deferred',
        progress,
        updates: checked.updates.map((update, index) => ({
          ...update,
          capability: progress.capabilities[index],
        })),
      };
}

async function applyBulkUpdates(
  checked: BulkUpdateChecked,
  marked: BulkUpdateMarked,
  provider: PackagesProvider,
): Promise<BulkUpdateApplied> {
  if (marked.kind === 'immediate') {
    return {
      kind: 'immediate',
      outcome: await runImmediateUpdateGroups(checked, provider, clientManager),
    };
  }
  const refreshed = await writeAndMarkPackageUpdates(marked.updates, provider, () => (
    writePackageUpdateBatch(checked.kind, marked.updates)
  ));
  if (refreshed === undefined) {
    return { kind: 'unverified' };
  }
  return { kind: 'deferred' };
}

async function reconcileBulkUpdates(execution: BulkUpdateExecution, provider: PackagesProvider): Promise<void> {
  if (execution.kind === 'apply-failed') {
    if (execution.marked.kind === 'deferred') {
      clearMutationProgress(execution.marked.progress);
    }
    if (execution.checked.kind === 'bulk') {
      await reconcileFailedPackageMutation(provider, 'Failed to reconcile package state after a failed Update All.');
    }
    return;
  }
  if (execution.result.kind === 'unverified') {
    if (execution.checked.kind === 'bulk') {
      await reconcileFailedPackageMutation(provider, 'Failed to reconcile package state after a failed Update All.');
    }
    else {
      await provider.loadPackages();
    }
    throw new Error(formatUnverifiedUpdateMessage());
  }
  if (execution.result.kind !== 'immediate') {
    return;
  }
  if (execution.result.outcome.kind === 'stopped') {
    await reconcileFailedPackageMutation(provider, 'Failed to reconcile package state after a failed Update All.');
    showError(execution.result.outcome.message, execution.result.outcome.error);
  }
  else if (execution.result.outcome.kind === 'stopped-cancelled') {
    await reconcileFailedPackageMutation(provider, 'Failed to reconcile package state after a cancelled Update All.');
    logger.info(execution.result.outcome.message);
    void vscode.window.showInformationMessage(execution.result.outcome.message);
  }
  else if (execution.result.outcome.kind === 'single-cancelled') {
    await reconcileFailedPackageMutation(provider, 'Failed to reconcile package state after a cancelled update.');
  }
  else if (execution.result.outcome.kind === 'single-failed') {
    showError(execution.result.outcome.message);
  }
  else if (execution.result.outcome.kind === 'single-unverified') {
    await provider.loadPackages();
    throw new Error(formatUnverifiedUpdateMessage());
  }
}