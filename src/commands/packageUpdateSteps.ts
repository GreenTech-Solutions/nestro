import * as vscode from 'vscode';
import { getConfirmBulkUpdate } from '../config';
import type { PackagesProvider, ResolvedPackageItem } from '../providers';
import {
  formatPackageCount,
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  logger,
  type PackageFileDependencyUpdates,
  runShellTaskAndWait,
  type ShellTaskCommand,
  updateDependencyVersionsInFile,
  updateDependencyVersionsInFilesAtomically,
} from '../utils';

export interface PackageVersionMutation {
  readonly capability: ResolvedPackageItem;
  readonly version: string;
}

export type PackageUpdateTaskOutcome
  = | { readonly kind: 'completed' }
    | { readonly kind: 'unverified' }
    | { readonly kind: 'failed'; readonly message: string };

export interface PackageMutationGroup<Update extends PackageVersionMutation> {
  readonly packageFilePath: string;
  readonly updates: Update[];
}

/** Refreshes post-write capabilities and records the resulting versions through the provider. */
export async function writeAndMarkPackageUpdates<Update extends PackageVersionMutation>(
  updates: readonly Update[],
  provider: Pick<PackagesProvider,
    'withWriteSuppressed' | 'refreshPackageBaselineForCapability' | 'markPackageUpdatedForCapability'>,
  write: () => Promise<void>,
): Promise<Update[] | undefined> {
  await provider.withWriteSuppressed(write);
  return await refreshAndMarkPackageUpdates(updates, provider);
}

async function refreshAndMarkPackageUpdates<Update extends PackageVersionMutation>(
  updates: readonly Update[],
  provider: Pick<PackagesProvider, 'refreshPackageBaselineForCapability' | 'markPackageUpdatedForCapability'>,
): Promise<Update[] | undefined> {
  const refreshed: Update[] = [];
  for (const update of updates) {
    const capability = await provider.refreshPackageBaselineForCapability(
      update.capability,
      `${update.capability.item.versionPrefix}${update.version}`,
    );
    if (capability === undefined) {
      return undefined;
    }
    refreshed.push({ ...update, capability });
  }
  refreshed.forEach(update => provider.markPackageUpdatedForCapability(update.capability, update.version));
  return refreshed;
}

/** Runs and verifies one package-manager task for the rows already marked by the pipeline. */
export async function runMarkedPackageUpdateTask<Update extends PackageVersionMutation>(
  updates: readonly Update[],
  command: ShellTaskCommand,
  taskName: string,
  provider: Pick<PackagesProvider,
    'refreshPackageBaselineForCapability' | 'invalidateUpdateCache' | 'markPackageUpdatedForCapability'>,
  cwd?: string,
): Promise<PackageUpdateTaskOutcome> {
  logger.info(`Running update command: ${formatShellTaskCommandForLog(command)}`);
  const exitCode = await runShellTaskAndWait(command, taskName, cwd);
  if (exitCode !== 0) {
    return { kind: 'failed', message: formatShellTaskFailureMessage(taskName, exitCode) };
  }
  const refreshed = await refreshAndMarkPackageUpdates(updates, provider);
  if (refreshed === undefined) {
    return { kind: 'unverified' };
  }
  provider.invalidateUpdateCache();
  return { kind: 'completed' };
}

/** Groups version mutations by manifest, optionally keeping dependency sections separate. */
export function groupPackageMutationsByFile<Update extends PackageVersionMutation>(
  updates: readonly Update[],
  includeSection = false,
): PackageMutationGroup<Update>[] {
  const byKey = new Map<string, Update[]>();
  for (const update of updates) {
    const groupKey = includeSection
      ? `${update.capability.packageFilePath}\0${update.capability.identity.section}`
      : update.capability.packageFilePath;
    byKey.set(groupKey, [...(byKey.get(groupKey) ?? []), update]);
  }
  return [...byKey.values()].map(groupUpdates => ({
    packageFilePath: groupUpdates[0].capability.packageFilePath,
    updates: groupUpdates,
  }));
}

/** Shapes marked version mutations for the shared atomic multi-manifest writer. */
export function toPackageFileDependencyUpdates<Update extends PackageVersionMutation>(
  updates: readonly Update[],
): PackageFileDependencyUpdates[] {
  return groupPackageMutationsByFile(updates).map(group => ({
    packageFilePath: group.packageFilePath,
    updates: group.updates.map(update => ({
      name: update.capability.item.packageName,
      version: update.version,
      section: update.capability.identity.section,
    })),
  }));
}

/** Writes one package update or an atomic batch while preserving each dependency section. */
export function writePackageUpdateBatch(
  kind: 'single' | 'bulk',
  updates: readonly PackageVersionMutation[],
): Promise<void> {
  const fileUpdates = toPackageFileDependencyUpdates(updates);
  if (kind === 'single') {
    return updateDependencyVersionsInFile(fileUpdates[0].packageFilePath, fileUpdates[0].updates);
  }
  return updateDependencyVersionsInFilesAtomically(fileUpdates);
}

/** Invalidates cached updates and reloads rows after a failed multi-manifest mutation. */
export async function reconcileFailedPackageMutation(
  provider: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages'>,
  logMessage: string,
): Promise<void> {
  try {
    provider.invalidateUpdateCache();
    await provider.loadPackages();
  }
  catch (error) {
    logger.error(logMessage, error);
  }
}

/** Asks for confirmation before applying a visible batch of package updates. */
export async function confirmBulkPackageUpdate(updateCount: number): Promise<boolean> {
  if (!getConfirmBulkUpdate()) {
    return true;
  }
  const updateAllAction = vscode.l10n.t('Update All');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('Update {0}? This cannot be undone.', formatPackageCount(updateCount)),
    { modal: true },
    updateAllAction,
  );
  return answer === updateAllAction;
}

/** Builds the shared message used when a successful package update cannot be verified. */
export function formatUnverifiedUpdateMessage(): string {
  return vscode.l10n.t('Package update could not be verified. Refresh the package list and try again.');
}

/** Formats the roots completed and pending when a package update batch stops early. */
export function formatPartialUpdateFailure(
  reason: string,
  labels: readonly string[],
  completedCount: number,
): string {
  const updated = labels.slice(0, completedCount);
  const notUpdated = labels.slice(completedCount);
  const reasonSentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  const updatedSentence = updated.length === 0
    ? vscode.l10n.t('Nothing was updated.')
    : vscode.l10n.t('Updated: {0}.', updated.join(', '));
  const notUpdatedSentence = vscode.l10n.t('Not updated: {0}.', notUpdated.join(', '));
  return vscode.l10n.t(
    'failed to update packages — {0} {1} {2}',
    reasonSentence,
    updatedSentence,
    notUpdatedSentence,
  );
}