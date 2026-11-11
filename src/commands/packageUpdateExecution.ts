import * as vscode from 'vscode';
import type { ClientManager } from '../clients';
import type { PackagesProvider } from '../providers';
import {
  getLocalizedPackageLabelFormatting,
  resolvePackageFileLabels,
  sanitizePackageText,
  toWorkspaceFolderDescriptors,
} from '../providers';
import { describeError } from '../shared';
import {
  formatPartialUpdateCancellation,
  formatPartialUpdateFailure,
  formatUnverifiedUpdateMessage,
  groupPackageMutationsByFile,
  runMarkedPackageUpdateTask,
} from './packageUpdateSteps';
import type { PackageMutationGroup, PackageUpdate, PackageUpdateTaskOutcome } from './packageUpdateSteps';
import { formatDependencySectionLabel } from '../utils';
import type { ShellTaskCommand } from '../utils';
import { confirmRiskyUpdates } from './updateRiskConfirmation';
import { clearMutationProgress, markPackageCapabilities } from './rowMutation';
import type { RowMutationProgress } from './rowMutation';
import { revalidateCommandPackageItem } from './packageIdentity';

export interface BulkUpdateChecked {
  readonly kind: 'single' | 'bulk';
  readonly strategy: 'immediate' | 'deferred';
  readonly updates: readonly PackageUpdate[];
  readonly confirmedRiskyUpdates: ReadonlySet<string>;
}

export type ImmediateUpdateRun
  = | { readonly kind: 'completed' }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'single-cancelled' }
    | { readonly kind: 'single-failed'; readonly message: string }
    | { readonly kind: 'single-unverified' }
    | { readonly kind: 'group-cancelled'; readonly reason: string }
    | { readonly kind: 'group-failed'; readonly reason: string; readonly error?: unknown }
    | { readonly kind: 'stopped-cancelled'; readonly message: string }
    | { readonly kind: 'stopped'; readonly message: string; readonly error?: unknown };

interface MarkedPackageUpdates {
  readonly progress: RowMutationProgress;
  readonly updates: readonly PackageUpdate[];
}

export async function runImmediateUpdateGroups(
  checked: BulkUpdateChecked,
  provider: PackagesProvider,
  clientManager: ClientManager,
): Promise<ImmediateUpdateRun> {
  const groups = groupPackageMutationsByFile(checked.updates, true);
  let completedCount = 0;
  try {
    for (const group of groups) {
      const outcome = await runImmediateUpdateGroup(
        checked,
        group,
        provider,
        clientManager,
        groups,
        completedCount,
      );
      if (outcome.kind !== 'completed') {
        return outcome;
      }
      completedCount += 1;
    }
  }
  catch (error) {
    if (checked.kind === 'single') {
      throw error;
    }
    return createStoppedResult(groups, completedCount, describeError(error), error);
  }
  return { kind: 'completed' };
}

async function runImmediateUpdateGroup(
  checked: BulkUpdateChecked,
  group: PackageMutationGroup<PackageUpdate>,
  provider: PackagesProvider,
  clientManager: ClientManager,
  groups: readonly PackageMutationGroup<PackageUpdate>[],
  completedCount: number,
): Promise<ImmediateUpdateRun> {
  const groupUpdates = checked.kind === 'bulk'
    ? await revalidateUpdates(group.updates, provider, true)
    : group.updates;
  if (groupUpdates === undefined) {
    return stopWhenPackageListChanges(checked.kind, groups, completedCount);
  }
  const cwd = groupUpdates[0].capability.packageDirectory;
  const client = await clientManager.getClient(cwd);
  const beforeTask = await revalidateUpdates(groupUpdates, provider, checked.kind === 'bulk');
  if (beforeTask === undefined) {
    return stopWhenPackageListChanges(checked.kind, groups, completedCount);
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
  if (outcome.kind === 'group-failed') {
    return createStoppedResult(groups, completedCount, outcome.reason, outcome.error);
  }
  if (outcome.kind === 'group-cancelled') {
    return createStoppedCancellation(groups, completedCount, outcome.reason);
  }
  return outcome;
}

function stopWhenPackageListChanges(
  kind: BulkUpdateChecked['kind'],
  groups: readonly PackageMutationGroup<PackageUpdate>[],
  completedCount: number,
): ImmediateUpdateRun {
  return kind === 'single'
    ? { kind: 'cancelled' }
    : createStoppedResult(groups, completedCount, vscode.l10n.t('the package list changed while updating.'));
}

function createStoppedResult(
  groups: readonly PackageMutationGroup<PackageUpdate>[],
  completedCount: number,
  reason: string,
  error?: unknown,
): ImmediateUpdateRun {
  return {
    kind: 'stopped',
    message: formatPartialUpdateFailure(reason, formatUpdateGroupLabels(groups), completedCount),
    error,
  };
}

function createStoppedCancellation(
  groups: readonly PackageMutationGroup<PackageUpdate>[],
  completedCount: number,
  reason: string,
): ImmediateUpdateRun {
  return {
    kind: 'stopped-cancelled',
    message: formatPartialUpdateCancellation(reason, formatUpdateGroupLabels(groups), completedCount),
  };
}

async function runMarkedUpdateGroup(
  checked: BulkUpdateChecked,
  updates: readonly PackageUpdate[],
  provider: PackagesProvider,
  command: ShellTaskCommand,
  cwd: string,
): Promise<ImmediateUpdateRun> {
  const marked = markPackageUpdateGroup(updates, provider);
  if (marked === undefined) {
    return checked.kind === 'single'
      ? { kind: 'cancelled' }
      : { kind: 'group-failed', reason: vscode.l10n.t('the package list changed while updating.') };
  }
  const taskName = getUpdateTaskName(checked, updates);
  let outcome: PackageUpdateTaskOutcome;
  try {
    outcome = await runMarkedPackageUpdateTask(marked.updates, command, taskName, provider, cwd);
  }
  catch (error) {
    clearMutationProgress(marked.progress);
    if (checked.kind === 'single') {
      throw error;
    }
    return { kind: 'group-failed', reason: describeError(error), error };
  }
  if (outcome.kind === 'completed') {
    return { kind: 'completed' };
  }
  clearMutationProgress(marked.progress);
  return mapUpdateTaskOutcome(checked, outcome, taskName);
}

function markPackageUpdateGroup(
  updates: readonly PackageUpdate[],
  provider: PackagesProvider,
): MarkedPackageUpdates | undefined {
  const progress = markPackageCapabilities(provider, updates.map(update => ({
    capability: update.capability,
    operation: { kind: 'update' as const, target: update.version },
  })));
  return progress === undefined
    ? undefined
    : {
        progress,
        updates: updates.map((update, index) => ({
          ...update,
          capability: progress.capabilities[index],
        })),
      };
}

function getUpdateTaskName(checked: BulkUpdateChecked, updates: readonly PackageUpdate[]): string {
  return checked.kind === 'single'
    ? vscode.l10n.t('Update {0}', sanitizePackageText(updates[0].capability.item.packageName))
    : vscode.l10n.t('Update All Packages');
}

function mapUpdateTaskOutcome(
  checked: BulkUpdateChecked,
  outcome: Exclude<PackageUpdateTaskOutcome, { readonly kind: 'completed' }>,
  taskName: string,
): ImmediateUpdateRun {
  if (outcome.kind === 'cancelled') {
    return checked.kind === 'single'
      ? { kind: 'single-cancelled' }
      : { kind: 'group-cancelled', reason: vscode.l10n.t('task "{0}" was cancelled.', taskName) };
  }
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

export async function revalidateUpdates(
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