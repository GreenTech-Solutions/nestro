import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { PackageItem, PackagesProvider, PackageStateIdentity, toRelativeLabel } from '../providers';
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
} from '../utils';

const clientManager = new ClientManager();

type PackageUpdate = { item: PackageItem; version: string };

export async function installUpdateCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
  if (item.latest !== undefined && !item.installing) {
    const latest = item.latest;
    try {
      logger.info(`Preparing update for ${item.packageName} to ${latest}.`);
      const packageFilePath = getPackageFilePath(item);
      if (isDeferredInstallEnabled()) {
        provider.markPackageUpdating(getPackageIdentity(item), true);
        await provider.withWriteSuppressed(() => updateDependencyVersionsInFile(packageFilePath, [
          { name: item.packageName, version: latest, section: getPackageSection(item) },
        ]));
        provider.markPackageUpdated(getPackageIdentity(item), latest);
        return;
      }

      const cwd = getPackageDirectory(packageFilePath);
      const client = await clientManager.getClient(cwd);
      await runPackageUpdateTask(
        [{ item, version: latest }],
        client.buildUpdateCommand([{ name: item.packageName, version: latest, section: getPackageSection(item) }]),
        `Update ${item.packageName}`,
        provider,
        cwd,
      );
    }
    catch (err) {
      if (item.packageFilePath !== '') {
        provider.markPackageUpdating(getPackageIdentity(item), false);
      }
      showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`, err);
    }
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

  if (isBulkUpdateConfirmationEnabled()) {
    const answer = await vscode.window.showWarningMessage(
      `Update ${packages.length} package${packages.length === 1 ? '' : 's'}? This cannot be undone.`,
      { modal: true },
      'Update All',
    );
    if (answer !== 'Update All') {
      return;
    }
  }

  const updates = packages
    .filter((item): item is PackageItem & { latest: string } => item.latest !== undefined)
    .map(item => ({ item, version: item.latest }));

  try {
    if (isDeferredInstallEnabled()) {
      updates.forEach(update => provider.markPackageUpdating(
        getPackageIdentity(update.item),
        true,
      ));
      await provider.withWriteSuppressed(async () => {
        for (const group of groupDeferredUpdatesByPackageFile(updates)) {
          await updateDependencyVersionsInFile(
            group.packageFilePath,
            group.updates.map(update => ({
              name: update.item.packageName,
              version: update.version,
              section: getPackageSection(update.item),
            })),
          );
        }
      });
      updates.forEach(update => provider.markPackageUpdated(
        getPackageIdentity(update.item),
        update.version,
      ));
      return;
    }

    for (const group of groupImmediateUpdatesByPackageFile(updates)) {
      const cwd = getPackageDirectory(group.packageFilePath);
      const client = await clientManager.getClient(cwd);
      const command = client.buildUpdateCommand(
        group.updates.map(update => ({
          name: update.item.packageName,
          version: update.version,
          section: getPackageSection(update.item),
        })),
      );
      await runPackageUpdateTask(group.updates, command, 'Update All Packages', provider, cwd);
    }
  }
  catch (err) {
    updates
      .filter(update => update.item.packageFilePath !== '')
      .forEach(update => provider.markPackageUpdating(getPackageIdentity(update.item), false));
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
): Promise<void> {
  updates.forEach(update => provider.markPackageUpdating(
    getPackageIdentity(update.item),
    true,
  ));
  logger.info(`Running update command: ${formatShellTaskCommandForLog(command)}`);
  const exitCode = await runShellTaskAndWait(command, taskName, cwd);
  if (exitCode === 0) {
    provider.invalidateUpdateCache();
    updates.forEach(update => provider.markPackageUpdated(
      getPackageIdentity(update.item),
      update.version,
    ));
    return;
  }
  updates.forEach(update => provider.markPackageUpdating(
    getPackageIdentity(update.item),
    false,
  ));
  showError(formatShellTaskFailureMessage(taskName, exitCode));
}

function getPackageFilePath(item: PackageItem): string {
  if (item.packageFilePath === '') {
    throw new Error('No workspace package.json found.');
  }
  return item.packageFilePath;
}

function groupDeferredUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
): { packageFilePath: string; updates: PackageUpdate[] }[] {
  return groupUpdatesByPackageFile(updates, update => getPackageFilePath(update.item));
}

function groupImmediateUpdatesByPackageFile(
  updates: readonly PackageUpdate[],
): { packageFilePath: string; updates: PackageUpdate[] }[] {
  return groupUpdatesByPackageFile(updates, (update) => {
    const packageFilePath = getPackageFilePath(update.item);
    return `${packageFilePath}\0${getPackageSection(update.item)}`;
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
    packageFilePath: getPackageFilePath(groupUpdates[0].item),
    updates: groupUpdates,
  }));
}

function getPackageSection(item: PackageItem): 'dependencies' | 'devDependencies' {
  return item.dev ? 'devDependencies' : 'dependencies';
}

function getPackageIdentity(item: PackageItem): PackageStateIdentity {
  return {
    packageName: item.packageName,
    packageFilePath: getPackageFilePath(item),
    section: getPackageSection(item),
  };
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