import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import {
  isPackageItem,
  PackagesProvider,
  toRelativeLabel,
} from '../providers';
import type { ResolvedPackageItem } from '../providers';
import {
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  getPackageDirectory,
  getWorkspacePackageFilePaths,
  logger,
  runShellTaskAndWait,
  ShellTaskCommand,
  showError,
  updateDependencyVersionsInFile,
  updateDependencyVersionsInFilesAtomically,
} from '../utils';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';

const clientManager = new ClientManager();

type PackageUpdate = { capability: ResolvedPackageItem; version: string };

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
  if (current.latest !== undefined && !current.installing) {
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
): Promise<void> {
  const checked = await revalidateCommandPackageItem(capability, provider);
  if (checked === undefined) {
    return;
  }

  const current = checked.item;
  let activeCapability: ResolvedPackageItem | undefined;
  try {
    logger.info(`Preparing update for ${current.packageName} to ${version}.`);
    if (isDeferredInstallEnabled()) {
      activeCapability = provider.markPackageUpdatingForCapability(checked, true);
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
        throw new Error('Package update could not be verified. Refresh the package list and try again.');
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
    await runPackageUpdateTask(
      [{ capability: beforeTask, version }],
      client.buildUpdateCommand([{
        name: taskItem.packageName,
        version,
        section: beforeTask.identity.section,
      }]),
      `Update ${taskItem.packageName}`,
      provider,
      beforeTask.packageDirectory,
    );
  }
  catch (err) {
    if (activeCapability !== undefined) {
      provider.markPackageUpdatingForCapability(activeCapability, false);
    }
    showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

export async function runInstallCommand(): Promise<void> {
  try {
    const packageFilePath = await resolveInstallPackageFilePath();
    const client = await clientManager.getClient(getPackageDirectory(packageFilePath));
    const command = client.buildInstallCommand();
    logger.info(`Running install command: ${formatShellTaskCommandForLog(command)}`);
    const taskName = 'Install Dependencies';
    const exitCode = await runShellTaskAndWait(command, taskName, getPackageDirectory(packageFilePath));
    if (exitCode !== 0) {
      showError(formatShellTaskFailureMessage(taskName, exitCode));
    }
  }
  catch (err) {
    showError(`failed to run install — ${err instanceof Error ? err.message : String(err)}`, err);
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
    if (current.latest !== undefined && !current.installing) {
      capabilities.push(capability);
    }
  }
  if (capabilities.length === 0) {
    return;
  }

  if (isBulkUpdateConfirmationEnabled()) {
    const answer = await vscode.window.showWarningMessage(
      `Update ${capabilities.length} package${capabilities.length === 1 ? '' : 's'}? This cannot be undone.`,
      { modal: true },
      'Update All',
    );
    if (answer !== 'Update All') {
      return;
    }
  }

  const updates = capabilities.map(capability => ({
    capability,
    version: capability.item.latest as string,
  }));
  let activeDeferredUpdates: { capability: ResolvedPackageItem; version: string }[] = [];

  try {
    // Confirm every selected row after the modal confirmation and before any
    // progress mark, write, or task. Group-level checks below close the async
    // window again immediately before each individual task.
    const prevalidatedUpdates = await revalidateUpdates(updates, provider);
    if (prevalidatedUpdates === undefined) {
      return;
    }
    if (isDeferredInstallEnabled()) {
      const checkedUpdates = await revalidateUpdates(prevalidatedUpdates, provider);
      if (checkedUpdates === undefined) {
        return;
      }
      const activeUpdates = checkedUpdates.map(update => ({
        ...update,
        capability: provider.markPackageUpdatingForCapability(update.capability, true),
      }));
      if (activeUpdates.some(update => update.capability === undefined)) {
        resetActiveCapabilities(activeUpdates, provider);
        return;
      }
      const active = activeUpdates as { capability: ResolvedPackageItem; version: string }[];
      activeDeferredUpdates = active;
      await provider.withWriteSuppressed(async () => {
        await updateDependencyVersionsInFilesAtomically(
          groupDeferredUpdatesByPackageFile(active).map(group => ({
            packageFilePath: group.packageFilePath,
            updates: group.updates.map(update => ({
              name: update.capability.item.packageName,
              version: update.version,
              section: update.capability.identity.section,
            })),
          })),
        );
      });
      const refreshed = await refreshUpdatedCapabilities(active, provider);
      if (refreshed === undefined) {
        await provider.loadPackages();
        throw new Error('Package update could not be verified. Refresh the package list and try again.');
      }
      refreshed.forEach(update => provider.markPackageUpdatedForCapability(update.capability, update.version));
      return;
    }

    for (const group of groupImmediateUpdatesByPackageFile(prevalidatedUpdates)) {
      const checkedUpdates = await revalidateUpdates(group.updates, provider);
      if (checkedUpdates === undefined) {
        return;
      }
      const cwd = checkedUpdates[0].capability.packageDirectory;
      const client = await clientManager.getClient(cwd);
      const beforeTaskUpdates = await revalidateUpdates(checkedUpdates, provider);
      if (beforeTaskUpdates === undefined) {
        return;
      }
      const command = client.buildUpdateCommand(
        beforeTaskUpdates.map(update => ({
          name: update.capability.item.packageName,
          version: update.version,
          section: update.capability.identity.section,
        })),
      );
      const completed = await runPackageUpdateTask(beforeTaskUpdates, command, 'Update All Packages', provider, cwd);
      if (!completed) {
        return;
      }
    }
  }
  catch (err) {
    activeDeferredUpdates.forEach(update => provider.markPackageUpdatingForCapability(update.capability, false));
    showError(`failed to update packages — ${err instanceof Error ? err.message : String(err)}`, err);
  }
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

async function runPackageUpdateTask(
  updates: readonly PackageUpdate[],
  command: ShellTaskCommand,
  taskName: string,
  provider: PackagesProvider,
  cwd?: string,
): Promise<boolean> {
  const activeUpdates = updates.map(update => ({
    ...update,
    capability: provider.markPackageUpdatingForCapability(update.capability, true),
  }));
  if (activeUpdates.some(update => update.capability === undefined)) {
    resetActiveCapabilities(activeUpdates, provider);
    return false;
  }
  const active = activeUpdates as { capability: ResolvedPackageItem; version: string }[];
  logger.info(`Running update command: ${formatShellTaskCommandForLog(command)}`);
  let exitCode: number | undefined;
  try {
    exitCode = await runShellTaskAndWait(command, taskName, cwd);
  }
  catch (err) {
    active.forEach(update => provider.markPackageUpdatingForCapability(update.capability, false));
    throw err;
  }
  if (exitCode === 0) {
    const refreshed = await refreshUpdatedCapabilities(active, provider);
    if (refreshed === undefined) {
      active.forEach(update => provider.markPackageUpdatingForCapability(update.capability, false));
      await provider.loadPackages();
      throw new Error('Package update could not be verified. Refresh the package list and try again.');
    }
    provider.invalidateUpdateCache();
    refreshed.forEach(update => provider.markPackageUpdatedForCapability(update.capability, update.version));
    return true;
  }
  active.forEach(update => provider.markPackageUpdatingForCapability(update.capability, false));
  showError(formatShellTaskFailureMessage(taskName, exitCode));
  return false;
}

function resetActiveCapabilities(
  updates: readonly { capability: ResolvedPackageItem | undefined; version: string }[],
  provider: PackagesProvider,
): void {
  updates.forEach((update) => {
    if (update.capability !== undefined) {
      provider.markPackageUpdatingForCapability(update.capability, false);
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
): { packageFilePath: string; updates: PackageUpdate[] }[] {
  return groupUpdatesByPackageFile(updates, update => update.capability.packageFilePath);
}

function groupImmediateUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
): { packageFilePath: string; updates: PackageUpdate[] }[] {
  return groupUpdatesByPackageFile(updates, (update) => {
    return `${update.capability.packageFilePath}\0${update.capability.identity.section}`;
  });
}

function groupUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
  getGroupKey: (update: PackageUpdate) => string,
): { packageFilePath: string; updates: PackageUpdate[] }[] {
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
    if (currentVersion === undefined || capability.item.installing) {
      return undefined;
    }
    checked.push({ capability, version: currentVersion });
  }
  return checked;
}

async function resolveInstallPackageFilePath(): Promise<string> {
  const packageFilePaths = await getWorkspacePackageFilePaths();
  if (packageFilePaths.length === 0) {
    throw new Error('No workspace package.json found.');
  }
  if (packageFilePaths.length === 1) {
    return packageFilePaths[0];
  }

  const selected = await vscode.window.showQuickPick(
    packageFilePaths.map(packageFilePath => ({
      label: formatPackageFileLabel(packageFilePath),
      packageFilePath,
    })),
    { placeHolder: 'Select the package.json to install dependencies for' },
  );
  if (selected === undefined) {
    throw new Error('Install cancelled.');
  }

  return selected.packageFilePath;
}

function formatPackageFileLabel(packageFilePath: string): string {
  const normalized = packageFilePath.replace(/\\/g, '/');
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
    if (normalized === `${folderPath}/package.json` || normalized.startsWith(`${folderPath}/`)) {
      return toRelativeLabel(packageFilePath, folder.uri.fsPath);
    }
  }

  // fallback for paths outside any known workspace folder
  const withoutFile = normalized.endsWith('/package.json')
    ? normalized.slice(0, -'/package.json'.length)
    : normalized;
  return withoutFile || normalized;
}