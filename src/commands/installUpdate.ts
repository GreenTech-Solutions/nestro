import * as vscode from 'vscode';
import { getDeferInstallAfterUpdate } from '../config';
import { ClientManager } from '../clients';
import {
  getLocalizedPackageLabelFormatting,
  isPackageItem,
  PackagesProvider,
  resolvePackageFileLabels,
  sanitizePackageText,
  toWorkspaceFolderDescriptors,
} from '../providers';
import type { ResolvedPackageItem } from '../providers';
import { COMMAND_IDS, describeError } from '../shared';
import {
  formatDependencySectionLabel,
  formatHeldBackDate,
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  getPackageDirectory,
  getWorkspacePackageFilePaths,
  logger,
  runShellTaskAndWait,
  ShellTaskCommand,
  showError,
} from '../utils';
import type { ReleaseAgeState } from '../utils';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';
import {
  confirmBulkPackageUpdate,
  formatPartialUpdateFailure,
  formatUnverifiedUpdateMessage,
  groupPackageMutationsByFile,
  reconcileFailedPackageMutation,
  runMarkedPackageUpdateTask,
  writeAndMarkPackageUpdates,
  writePackageUpdateBatch,
} from './packageUpdateSteps';
import type { PackageMutationGroup, PackageUpdateTaskOutcome, PackageVersionMutation } from './packageUpdateSteps';
import { clearMutationProgress, markPackageCapabilities, markPackageIdentities, runRowMutation } from './rowMutation';
import type { IdentityMutationProgress, RowMutationExecution, RowMutationProgress } from './rowMutation';

const clientManager = new ClientManager();

type PackageUpdate = PackageVersionMutation & {
  readonly releaseAge?: ReleaseAgeState;
  readonly source: 'latest' | 'selected';
};

type ImmediateUpdateRun
  = | { readonly kind: 'completed' }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'single-failed'; readonly message: string }
    | { readonly kind: 'single-unverified' }
    | { readonly kind: 'group-failed'; readonly reason: string; readonly error?: unknown }
    | { readonly kind: 'stopped'; readonly message: string; readonly error?: unknown };

interface InstallPackageSelection {
  readonly kind: 'selected';
  readonly packageFilePath: string;
}

interface CancelledInstallPackageSelection {
  readonly kind: 'cancelled';
}

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

interface BulkUpdateChecked {
  readonly kind: 'single' | 'bulk';
  readonly strategy: 'immediate' | 'deferred';
  readonly updates: readonly PackageUpdate[];
  readonly confirmedRiskyUpdates: ReadonlySet<string>;
}

type BulkUpdateMarked
  = | { readonly kind: 'immediate' }
    | { readonly kind: 'deferred'; readonly progress: RowMutationProgress; readonly updates: readonly PackageUpdate[] };

type BulkUpdateApplied
  = | { readonly kind: 'deferred' }
    | { readonly kind: 'unverified' }
    | { readonly kind: 'immediate'; readonly outcome: ImmediateUpdateRun };

type BulkUpdateExecution = RowMutationExecution<BulkUpdateChecked, BulkUpdateMarked, BulkUpdateApplied>;

interface InstallTaskChecked {
  readonly command: ShellTaskCommand;
  readonly taskName: string;
  readonly cwd: string;
  readonly packageFilePath: string;
}

type InstallTaskMarked = { readonly progress: IdentityMutationProgress | undefined };

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

export async function runInstallCommand(provider?: PackagesProvider): Promise<void> {
  await runRowMutation<PackagesProvider | undefined, InstallPackageSelection, InstallTaskChecked, InstallTaskMarked, number | undefined>(provider, {
    guard: () => true,
    resolve: async () => {
      const selection = await resolveInstallPackageSelection();
      if (selection === undefined) {
        throw new Error(vscode.l10n.t('No workspace package.json found.'));
      }
      return selection.kind === 'cancelled' ? undefined : selection;
    },
    lockTargets: selection => [selection.packageFilePath],
    revalidate: async (selection) => {
      const cwd = getPackageDirectory(selection.packageFilePath);
      const client = await clientManager.getClient(cwd);
      const command = client.buildInstallCommand();
      logger.info(`Running install command: ${formatShellTaskCommandForLog(command)}`);
      return { command, taskName: vscode.l10n.t('Install Dependencies'), cwd, packageFilePath: selection.packageFilePath };
    },
    mark: checked => ({
      progress: provider === undefined
        ? undefined
        : markPackageIdentities(provider, provider.getPackageIdentitiesForFile(checked.packageFilePath), { kind: 'install' }),
    }),
    apply: async ({ command, taskName, cwd }) => {
      const exitCode = await runShellTaskAndWait(command, taskName, cwd);
      if (exitCode !== 0) {
        showError(formatShellTaskFailureMessage(taskName, exitCode));
      }
      return exitCode;
    },
    reconcile: (execution) => {
      if (execution.marked.progress !== undefined) {
        clearMutationProgress(execution.marked.progress);
      }
    },
    reportError: error => showError(vscode.l10n.t('failed to run install — {0}', describeError(error)), error),
  });
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
      outcome: await runImmediateUpdateGroups(checked, provider),
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
  else if (execution.result.outcome.kind === 'single-failed') {
    showError(execution.result.outcome.message);
  }
  else if (execution.result.outcome.kind === 'single-unverified') {
    await provider.loadPackages();
    throw new Error(formatUnverifiedUpdateMessage());
  }
}

async function runImmediateUpdateGroups(
  checked: BulkUpdateChecked,
  provider: PackagesProvider,
): Promise<ImmediateUpdateRun> {
  const groups = groupPackageMutationsByFile(checked.updates, true);
  let completedCount = 0;
  const stopped = (reason: string, error?: unknown): ImmediateUpdateRun => ({
    kind: 'stopped',
    message: formatPartialUpdateFailure(reason, formatUpdateGroupLabels(groups), completedCount),
    error,
  });
  try {
    for (const group of groups) {
      const groupUpdates = checked.kind === 'bulk'
        ? await revalidateUpdates(group.updates, provider, true)
        : group.updates;
      if (groupUpdates === undefined) {
        return checked.kind === 'single'
          ? { kind: 'cancelled' }
          : stopped(vscode.l10n.t('the package list changed while updating.'));
      }
      const cwd = groupUpdates[0].capability.packageDirectory;
      const client = await clientManager.getClient(cwd);
      const beforeTask = await revalidateUpdates(groupUpdates, provider, checked.kind === 'bulk');
      if (beforeTask === undefined) {
        return checked.kind === 'single'
          ? { kind: 'cancelled' }
          : stopped(vscode.l10n.t('the package list changed while updating.'));
      }
      if (!await confirmRiskyUpdates(beforeTask, new Set(checked.confirmedRiskyUpdates))) {
        return { kind: 'cancelled' };
      }
      const command = client.buildUpdateCommand(beforeTask.map(update => ({
        name: update.capability.item.packageName,
        version: update.version,
        section: update.capability.identity.section,
      })));
      const outcome = await runMarkedUpdateGroup(checked, beforeTask, provider, command, cwd);
      if (outcome.kind === 'completed') {
        completedCount += 1;
        continue;
      }
      return outcome.kind === 'group-failed' ? stopped(outcome.reason, outcome.error) : outcome;
    }
  }
  catch (error) {
    if (checked.kind === 'single') {
      throw error;
    }
    return stopped(describeError(error), error);
  }
  return { kind: 'completed' };
}

async function runMarkedUpdateGroup(
  checked: BulkUpdateChecked,
  updates: readonly PackageUpdate[],
  provider: PackagesProvider,
  command: ShellTaskCommand,
  cwd: string,
): Promise<ImmediateUpdateRun> {
  const progress = markPackageCapabilities(provider, updates.map(update => ({
    capability: update.capability,
    operation: { kind: 'update' as const, target: update.version },
  })));
  if (progress === undefined) {
    return checked.kind === 'single'
      ? { kind: 'cancelled' }
      : { kind: 'group-failed', reason: vscode.l10n.t('the package list changed while updating.') };
  }
  const activeUpdates = updates.map((update, index) => ({
    ...update,
    capability: progress.capabilities[index],
  }));
  const taskName = checked.kind === 'single'
    ? vscode.l10n.t('Update {0}', sanitizePackageText(updates[0].capability.item.packageName))
    : vscode.l10n.t('Update All Packages');
  let outcome: PackageUpdateTaskOutcome;
  try {
    outcome = await runMarkedPackageUpdateTask(activeUpdates, command, taskName, provider, cwd);
  }
  catch (error) {
    clearMutationProgress(progress);
    if (checked.kind === 'single') {
      throw error;
    }
    return { kind: 'group-failed', reason: describeError(error), error };
  }
  if (outcome.kind === 'completed') {
    return { kind: 'completed' };
  }
  clearMutationProgress(progress);
  if (outcome.kind === 'unverified') {
    return checked.kind === 'single'
      ? { kind: 'single-unverified' }
      : {
          kind: 'stopped',
          message: vscode.l10n.t('failed to update packages — {0}', formatUnverifiedUpdateMessage()),
        };
  }
  return checked.kind === 'single'
    ? { kind: 'single-failed', message: outcome.message }
    : { kind: 'group-failed', reason: outcome.message };
}

async function confirmRiskyUpdates(
  updates: readonly PackageUpdate[],
  confirmedRiskyUpdates: Set<string>,
): Promise<boolean> {
  const updateKey = (capability: ResolvedPackageItem, version: string): string => [
    capability.packageFilePath,
    capability.identity.section,
    capability.item.packageName,
    version,
  ].join('\u0000');
  const riskyUpdates = updates.filter(({ capability, version, releaseAge: selectedReleaseAge }) => {
    const releaseAge = selectedReleaseAge ?? capability.item.releaseAge;
    return releaseAge?.kind === 'held-back'
      && releaseAge.version === version
      && !confirmedRiskyUpdates.has(updateKey(capability, version));
  });
  if (riskyUpdates.length === 0) {
    return true;
  }

  const labels = riskyUpdates.map(({ capability, version, releaseAge: selectedReleaseAge }) => {
    const releaseAge = selectedReleaseAge ?? capability.item.releaseAge;
    const eligibleAt = releaseAge?.kind === 'held-back' ? formatHeldBackDate(releaseAge.eligibleAt) : '';
    return vscode.l10n.t(
      '{0}@{1} (held back until {2})',
      sanitizePackageText(capability.item.packageName),
      sanitizePackageText(version),
      sanitizePackageText(eligibleAt),
    );
  });
  const updateRiskyAction = vscode.l10n.t('Update Risky Packages');
  const riskyPrompt = riskyUpdates.length === 1
    ? vscode.l10n.t(
        'The selected update is inside the minimum release-age window:\n{0}\nUpdate anyway?',
        labels.join('\n'),
      )
    : vscode.l10n.t(
        'The selected updates are inside the minimum release-age window:\n{0}\nUpdate anyway?',
        labels.join('\n'),
      );
  const answer = await vscode.window.showWarningMessage(
    riskyPrompt,
    { modal: true },
    updateRiskyAction,
  );
  if (answer !== updateRiskyAction) {
    return false;
  }
  riskyUpdates.forEach(({ capability, version }) => {
    confirmedRiskyUpdates.add(updateKey(capability, version));
  });
  return true;
}

function formatUpdateGroupLabels(groups: readonly PackageMutationGroup<PackageUpdate>[]): string[] {
  const folders = toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  const labelByPath = new Map(
    resolvePackageFileLabels(
      groups.map(group => group.packageFilePath),
      folders,
      getLocalizedPackageLabelFormatting(),
    ).map(({ packageFilePath, owner }) => [packageFilePath, owner.label]),
  );
  return groups.map((group) => {
    const label = labelByPath.get(group.packageFilePath) ?? group.packageFilePath;
    const hasSiblingGroup = groups.some(other => other !== group && other.packageFilePath === group.packageFilePath);
    return hasSiblingGroup
      ? `${label} (${formatDependencySectionLabel(group.updates[0].capability.identity.section)})`
      : label;
  });
}

async function revalidateUpdates(
  updates: readonly PackageUpdate[],
  provider: PackagesProvider,
  reissueCapabilities: boolean,
): Promise<PackageUpdate[] | undefined> {
  const checked: PackageUpdate[] = [];
  for (const update of updates) {
    const capability = reissueCapabilities
      ? await provider.reissuePackageCapability(update.capability)
      ?? await revalidateCommandPackageItem(update.capability, provider)
      : await revalidateCommandPackageItem(update.capability, provider);
    if (capability === undefined) {
      return undefined;
    }
    const version = update.source === 'selected' ? update.version : capability.item.latest;
    if (version === undefined || capability.item.operation !== undefined) {
      return undefined;
    }
    checked.push({ ...update, capability, version });
  }
  return checked;
}

async function resolveInstallPackageSelection(): Promise<InstallPackageSelection | CancelledInstallPackageSelection | undefined> {
  const packageFilePaths = await getWorkspacePackageFilePaths();
  if (packageFilePaths.length === 0) {
    return undefined;
  }
  const folders = toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  const labels = resolvePackageFileLabels(packageFilePaths, folders, getLocalizedPackageLabelFormatting());
  if (labels.length === 1) {
    return { kind: 'selected', packageFilePath: labels[0].packageFilePath };
  }

  const selected = await vscode.window.showQuickPick(
    labels.map(({ packageFilePath, owner }) => ({
      label: owner.label,
      packageFilePath,
    })),
    { placeHolder: vscode.l10n.t('Select the package.json to install dependencies for') },
  );
  if (selected === undefined) {
    return { kind: 'cancelled' };
  }

  return { kind: 'selected', packageFilePath: selected.packageFilePath };
}