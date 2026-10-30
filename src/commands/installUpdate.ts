import * as vscode from 'vscode';
import { ClientManager, resolveMutationCoordinatorKey } from '../clients';
import {
  getLocalizedPackageLabelFormatting,
  isPackageItem,
  PackagesProvider,
  resolvePackageFileLabels,
  sanitizePackageText,
  toWorkspaceFolderDescriptors,
} from '../providers';
import type { ResolvedPackageItem } from '../providers';
import {
  formatDependencySectionLabel,
  formatHeldBackDate,
  formatPackageCount,
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  getPackageDirectory,
  getWorkspacePackageFilePaths,
  logger,
  mutationCoordinator,
  PackageFileDependencyUpdates,
  runShellTaskAndWait,
  ShellTaskCommand,
  showError,
  updateDependencyVersionsInFile,
  updateDependencyVersionsInFilesAtomically,
} from '../utils';
import type { ReleaseAgeState } from '../utils';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';

const clientManager = new ClientManager();

type PackageUpdate = { capability: ResolvedPackageItem; version: string; releaseAge?: ReleaseAgeState };

type PackageUpdateGroup = { packageFilePath: string; updates: PackageUpdate[] };

type PackageUpdateTaskOutcome
  = | { readonly kind: 'completed' }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'unverified' }
    | { readonly kind: 'failed'; readonly message: string };

type ImmediateUpdateRun
  = | { readonly kind: 'completed' }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'stopped'; readonly message: string; readonly error?: unknown };

interface InstallPackageSelection {
  readonly kind: 'selected';
  readonly packageFilePath: string;
}

interface CancelledInstallPackageSelection {
  readonly kind: 'cancelled';
}

export async function installUpdateCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.installUpdate invoked without a valid package item; ignoring.');
    return;
  }

  const capability = await resolveCommandPackageItem(item, provider);
  if (capability === undefined) {
    return;
  }

  const current = capability.item;
  if (current.latest !== undefined && current.operation === undefined) {
    // The selected version is intentionally read from the freshly resolved row;
    // `item.latest` is never an operation input after validation.
    await runResolvedPackageVersion(capability, current.latest, provider);
  }
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
  // Locked from the pre-write revalidation through the write or task and the
  // reconciliation that follows it; the key comes from the capability's already-canonical
  // `packageFilePath` before any lock is requested.
  const projectKey = await resolveMutationCoordinatorKey(capability.packageFilePath);
  await mutationCoordinator.runExclusive(projectKey, async () => {
    const checked = await revalidateCommandPackageItem(capability, provider);
    if (checked === undefined) {
      return;
    }

    const current = checked.item;
    let activeCapability: ResolvedPackageItem | undefined;
    try {
      logger.info(`Preparing update for ${current.packageName} to ${version}.`);
      const confirmedRiskyUpdates = new Set<string>();
      if (isDeferredInstallEnabled()) {
        if (!await confirmRiskyUpdates([{ capability: checked, version, releaseAge: selectedReleaseAge }], confirmedRiskyUpdates)) {
          return;
        }
        activeCapability = provider.markPackageUpdatingForCapability(checked, {
          kind: 'update',
          target: version,
        });
        if (activeCapability === undefined) {
          return;
        }
        await provider.withWriteSuppressed(() => updateDependencyVersionsInFile(checked.packageFilePath, [
          { name: current.packageName, version, section: checked.identity.section },
        ]));
        const refreshed = await provider.refreshPackageBaselineForCapability(
          activeCapability,
          `${current.versionPrefix}${version}`,
        );
        if (refreshed === undefined) {
          await provider.loadPackages();
          throw new Error(vscode.l10n.t(
            'Package update could not be verified. Refresh the package list and try again.',
          ));
        }
        provider.markPackageUpdatedForCapability(refreshed, version);
        return;
      }

      const cwd = checked.packageDirectory;
      const client = await clientManager.getClient(cwd);
      const beforeTask = await revalidateCommandPackageItem(checked, provider);
      if (beforeTask === undefined) {
        return;
      }
      const taskItem = beforeTask.item;
      if (!await confirmRiskyUpdates([{ capability: beforeTask, version, releaseAge: selectedReleaseAge }], confirmedRiskyUpdates)) {
        return;
      }
      const outcome = await runPackageUpdateTask(
        [{ capability: beforeTask, version }],
        client.buildUpdateCommand([{
          name: taskItem.packageName,
          version,
          section: beforeTask.identity.section,
        }]),
        vscode.l10n.t('Update {0}', sanitizePackageText(taskItem.packageName)),
        provider,
        beforeTask.packageDirectory,
      );
      if (outcome.kind === 'failed') {
        showError(outcome.message);
      }
      else if (outcome.kind === 'unverified') {
        await provider.loadPackages();
        throw new Error(formatUnverifiedUpdateMessage());
      }
    }
    catch (err) {
      if (activeCapability !== undefined) {
        provider.markPackageUpdatingForCapability(activeCapability, undefined);
      }
      showError(vscode.l10n.t('failed to install update — {0}', err instanceof Error ? err.message : String(err)), err);
    }
  });
}

export async function runInstallCommand(provider?: PackagesProvider): Promise<void> {
  try {
    const selection = await resolveInstallPackageSelection();
    if (selection === undefined) {
      throw new Error(vscode.l10n.t('No workspace package.json found.'));
    }
    if (selection.kind === 'cancelled') {
      return;
    }
    const packageFilePath = selection.packageFilePath;
    // Locked for the full task run so a concurrent Update/Pin/Remove/Switch on the same
    // project root cannot start a second package-manager process, or write the manifest,
    // while this install is running.
    const projectKey = await resolveMutationCoordinatorKey(packageFilePath);
    await mutationCoordinator.runExclusive(projectKey, async () => {
      const client = await clientManager.getClient(getPackageDirectory(packageFilePath));
      const command = client.buildInstallCommand();
      logger.info(`Running install command: ${formatShellTaskCommandForLog(command)}`);
      const taskName = vscode.l10n.t('Install Dependencies');
      const activeIdentities = provider?.getPackageIdentitiesForFile(packageFilePath) ?? [];
      activeIdentities.forEach(identity => provider?.markPackageUpdating(identity, { kind: 'install' }));
      try {
        const exitCode = await runShellTaskAndWait(command, taskName, getPackageDirectory(packageFilePath));
        if (exitCode !== 0) {
          showError(formatShellTaskFailureMessage(taskName, exitCode));
        }
      }
      finally {
        activeIdentities.forEach(identity => provider?.markPackageUpdating(identity, undefined));
      }
    });
  }
  catch (err) {
    showError(vscode.l10n.t('failed to run install — {0}', err instanceof Error ? err.message : String(err)), err);
  }
}

export async function updateAllVisibleCommand(provider: PackagesProvider): Promise<void> {
  const packages = provider.getVisibleOutdatedPackages();
  if (packages.length === 0) {
    return;
  }

  const capabilities: ResolvedPackageItem[] = [];
  for (const item of packages) {
    const capability = await resolveCommandPackageItem(item, provider);
    if (capability === undefined) {
      return;
    }
    const current = capability.item;
    if (current.latest !== undefined && current.operation === undefined) {
      capabilities.push(capability);
    }
  }
  if (capabilities.length === 0) {
    return;
  }

  if (isBulkUpdateConfirmationEnabled()) {
    const updateAllAction = vscode.l10n.t('Update All');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Update {0}? This cannot be undone.', formatPackageCount(capabilities.length)),
      { modal: true },
      updateAllAction,
    );
    if (answer !== updateAllAction) {
      return;
    }
  }

  const updates = capabilities.map(capability => ({
    capability,
    version: capability.item.latest as string,
  }));

  // Update All can span multiple project roots in one call, so all of them are locked
  // together for the whole operation: a concurrent single-row command on any of these
  // manifests waits behind it, and the bulk update never holds a subset of its roots.
  const projectKeys = await Promise.all(
    updates.map(update => resolveMutationCoordinatorKey(update.capability.packageFilePath)),
  );

  await mutationCoordinator.runManyExclusive(projectKeys, async () => {
    let activeDeferredUpdates: { capability: ResolvedPackageItem; version: string }[] = [];
    try {
      // Confirm every selected row after the modal confirmation and before any
      // progress mark, write, or task. Group-level checks below close the async
      // window again immediately before each individual task.
      const prevalidatedUpdates = await revalidateUpdates(updates, provider);
      if (prevalidatedUpdates === undefined) {
        return;
      }
      const confirmedRiskyUpdates = new Set<string>();
      if (!await confirmRiskyUpdates(prevalidatedUpdates, confirmedRiskyUpdates)) {
        return;
      }
      if (isDeferredInstallEnabled()) {
        const checkedUpdates = await revalidateUpdates(prevalidatedUpdates, provider);
        if (checkedUpdates === undefined) {
          return;
        }
        if (!await confirmRiskyUpdates(checkedUpdates, confirmedRiskyUpdates)) {
          return;
        }
        const activeUpdates = checkedUpdates.map(update => ({
          ...update,
          capability: provider.markPackageUpdatingForCapability(update.capability, {
            kind: 'update',
            target: update.version,
          }),
        }));
        if (activeUpdates.some(update => update.capability === undefined)) {
          resetActiveCapabilities(activeUpdates, provider);
          return;
        }
        const active = activeUpdates as { capability: ResolvedPackageItem; version: string }[];
        activeDeferredUpdates = active;
        await provider.withWriteSuppressed(async () => {
          await updateDependencyVersionsInFilesAtomically(toDeferredUpdateFileGroups(active));
        });
        const refreshed = await refreshUpdatedCapabilities(active, provider);
        if (refreshed === undefined) {
          throw new Error(formatUnverifiedUpdateMessage());
        }
        refreshed.forEach(update => provider.markPackageUpdatedForCapability(update.capability, update.version));
        return;
      }

      const run = await runImmediateUpdateGroups(
        groupImmediateUpdatesByPackageFile(prevalidatedUpdates),
        confirmedRiskyUpdates,
        provider,
      );
      if (run.kind === 'stopped') {
        await reconcileAfterFailedUpdate(provider);
        showError(run.message, run.error);
      }
    }
    catch (err) {
      activeDeferredUpdates.forEach(update => provider.markPackageUpdatingForCapability(update.capability, undefined));
      await reconcileAfterFailedUpdate(provider);
      showError(vscode.l10n.t('failed to update packages — {0}', err instanceof Error ? err.message : String(err)), err);
    }
  });
}

function isDeferredInstallEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('nestro')
    .get<boolean>('deferInstallAfterUpdate', false);
}

function isBulkUpdateConfirmationEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('nestro')
    .get<boolean>('confirmBulkUpdate', true);
}

async function confirmRiskyUpdates(
  updates: readonly PackageUpdate[],
  confirmedRiskyUpdates: Set<string>,
): Promise<boolean> {
  const riskyUpdates = updates.filter(({ capability, version, releaseAge: selectedReleaseAge }) => {
    const releaseAge = selectedReleaseAge ?? capability.item.releaseAge;
    return releaseAge?.kind === 'held-back'
      && releaseAge.version === version
      && !confirmedRiskyUpdates.has(getRiskyUpdateKey(capability, version));
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
    confirmedRiskyUpdates.add(getRiskyUpdateKey(capability, version));
  });
  return true;
}

function getRiskyUpdateKey(capability: ResolvedPackageItem, version: string): string {
  return [
    capability.packageFilePath,
    capability.identity.section,
    capability.item.packageName,
    version,
  ].join('\u0000');
}

async function runPackageUpdateTask(
  updates: readonly PackageUpdate[],
  command: ShellTaskCommand,
  taskName: string,
  provider: PackagesProvider,
  cwd?: string,
): Promise<PackageUpdateTaskOutcome> {
  const activeUpdates = updates.map(update => ({
    ...update,
    capability: provider.markPackageUpdatingForCapability(update.capability, {
      kind: 'update',
      target: update.version,
    }),
  }));
  if (activeUpdates.some(update => update.capability === undefined)) {
    resetActiveCapabilities(activeUpdates, provider);
    return { kind: 'blocked' };
  }
  const active = activeUpdates as { capability: ResolvedPackageItem; version: string }[];
  logger.info(`Running update command: ${formatShellTaskCommandForLog(command)}`);
  let exitCode: number | undefined;
  try {
    exitCode = await runShellTaskAndWait(command, taskName, cwd);
  }
  catch (err) {
    active.forEach(update => provider.markPackageUpdatingForCapability(update.capability, undefined));
    throw err;
  }
  if (exitCode === 0) {
    const refreshed = await refreshUpdatedCapabilities(active, provider);
    if (refreshed === undefined) {
      active.forEach(update => provider.markPackageUpdatingForCapability(update.capability, undefined));
      return { kind: 'unverified' };
    }
    provider.invalidateUpdateCache();
    refreshed.forEach(update => provider.markPackageUpdatedForCapability(update.capability, update.version));
    return { kind: 'completed' };
  }
  active.forEach(update => provider.markPackageUpdatingForCapability(update.capability, undefined));
  return { kind: 'failed', message: formatShellTaskFailureMessage(taskName, exitCode) };
}

/** Runs the groups in order; a stop reports which groups were updated and which were not. */
async function runImmediateUpdateGroups(
  groups: readonly PackageUpdateGroup[],
  confirmedRiskyUpdates: Set<string>,
  provider: PackagesProvider,
): Promise<ImmediateUpdateRun> {
  let completedCount = 0;
  const stopped = (reason: string, error?: unknown): ImmediateUpdateRun => ({
    kind: 'stopped',
    message: formatPartialUpdateFailure(reason, groups, completedCount),
    error,
  });
  try {
    for (const group of groups) {
      const checkedUpdates = await revalidateUpdates(group.updates, provider);
      if (checkedUpdates === undefined) {
        return stopped(vscode.l10n.t('the package list changed while updating.'));
      }
      const cwd = checkedUpdates[0].capability.packageDirectory;
      const client = await clientManager.getClient(cwd);
      const beforeTaskUpdates = await revalidateUpdates(checkedUpdates, provider);
      if (beforeTaskUpdates === undefined) {
        return stopped(vscode.l10n.t('the package list changed while updating.'));
      }
      if (!await confirmRiskyUpdates(beforeTaskUpdates, confirmedRiskyUpdates)) {
        return { kind: 'cancelled' };
      }
      const command = client.buildUpdateCommand(
        beforeTaskUpdates.map(update => ({
          name: update.capability.item.packageName,
          version: update.version,
          section: update.capability.identity.section,
        })),
      );
      const outcome = await runPackageUpdateTask(
        beforeTaskUpdates,
        command,
        vscode.l10n.t('Update All Packages'),
        provider,
        cwd,
      );
      if (outcome.kind === 'blocked') {
        return stopped(vscode.l10n.t('the package list changed while updating.'));
      }
      if (outcome.kind === 'unverified') {
        // The task ran, so which roots changed is unknown until the reload; no per-root list.
        return {
          kind: 'stopped',
          message: vscode.l10n.t('failed to update packages — {0}', formatUnverifiedUpdateMessage()),
        };
      }
      if (outcome.kind === 'failed') {
        return stopped(outcome.message);
      }
      completedCount += 1;
    }
  }
  catch (err) {
    return stopped(err instanceof Error ? err.message : String(err), err);
  }
  return { kind: 'completed' };
}

function formatUnverifiedUpdateMessage(): string {
  return vscode.l10n.t('Package update could not be verified. Refresh the package list and try again.');
}

function formatPartialUpdateFailure(
  reason: string,
  groups: readonly PackageUpdateGroup[],
  completedCount: number,
): string {
  const labels = formatUpdateGroupLabels(groups);
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

function formatUpdateGroupLabels(groups: readonly PackageUpdateGroup[]): string[] {
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

/** Drops the update cache and re-reads manifests; a reload failure is logged, never raised. */
async function reconcileAfterFailedUpdate(provider: PackagesProvider): Promise<void> {
  try {
    provider.invalidateUpdateCache();
    await provider.loadPackages();
  }
  catch (reconcileErr) {
    logger.error('Failed to reconcile package state after a failed Update All.', reconcileErr);
  }
}

function resetActiveCapabilities(
  updates: readonly { capability: ResolvedPackageItem | undefined; version: string }[],
  provider: PackagesProvider,
): void {
  updates.forEach((update) => {
    if (update.capability !== undefined) {
      provider.markPackageUpdatingForCapability(update.capability, undefined);
    }
  });
}

async function refreshUpdatedCapabilities(
  updates: readonly PackageUpdate[],
  provider: PackagesProvider,
): Promise<PackageUpdate[] | undefined> {
  const refreshed: PackageUpdate[] = [];
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
  return refreshed;
}

function groupDeferredUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
): PackageUpdateGroup[] {
  return groupUpdatesByPackageFile(updates, update => update.capability.packageFilePath);
}

/**
 * Shape `active` deferred updates for `updateDependencyVersionsInFilesAtomically()`.
 * Kept as its own top-level function (rather than inline) so the write call site
 * inside `mutationCoordinator.runManyExclusive()` stays within the project's nested-
 * function-depth limit.
 */
function toDeferredUpdateFileGroups(active: readonly PackageUpdate[]): PackageFileDependencyUpdates[] {
  return groupDeferredUpdatesByPackageFile(active).map(group => ({
    packageFilePath: group.packageFilePath,
    updates: group.updates.map(update => ({
      name: update.capability.item.packageName,
      version: update.version,
      section: update.capability.identity.section,
    })),
  }));
}

function groupImmediateUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
): PackageUpdateGroup[] {
  return groupUpdatesByPackageFile(updates, (update) => {
    return `${update.capability.packageFilePath}\0${update.capability.identity.section}`;
  });
}

function groupUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
  getGroupKey: (update: PackageUpdate) => string,
): PackageUpdateGroup[] {
  const byKey = new Map<string, PackageUpdate[]>();
  for (const update of updates) {
    const groupKey = getGroupKey(update);
    byKey.set(groupKey, [...(byKey.get(groupKey) ?? []), update]);
  }
  return [...byKey.values()].map(groupUpdates => ({
    packageFilePath: groupUpdates[0].capability.packageFilePath,
    updates: groupUpdates,
  }));
}

async function revalidateUpdates(
  updates: readonly PackageUpdate[],
  provider: PackagesProvider,
): Promise<PackageUpdate[] | undefined> {
  const checked: PackageUpdate[] = [];
  for (const update of updates) {
    const capability = await provider.reissuePackageCapability(update.capability)
      ?? await revalidateCommandPackageItem(update.capability, provider);
    if (capability === undefined) {
      return undefined;
    }
    const currentVersion = capability.item.latest;
    if (currentVersion === undefined || capability.item.operation !== undefined) {
      return undefined;
    }
    checked.push({ capability, version: currentVersion });
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