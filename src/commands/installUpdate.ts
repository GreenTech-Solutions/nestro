import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { PackageItem, PackagesProvider } from '../providers';
import {
  getPackageDirectory,
  getWorkspacePackageFilePaths,
  logger,
  showError,
  updateDependencyVersionsInFile,
} from '../utils';

const clientManager = new ClientManager();

export async function installUpdateCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
  if (item.latest !== undefined && !item.installing) {
    const latest = item.latest;
    try {
      logger.info(`Preparing update for ${item.packageName} to ${latest}.`);
      const packageFilePath = getPackageFilePath(item);
      if (isDeferredInstallEnabled()) {
        markUpdating(provider, item.packageName, true, item.packageFilePath || undefined);
        await provider.withWriteSuppressed(() => updateDependencyVersionsInFile(packageFilePath, [
          { name: item.packageName, version: latest },
        ]));
        markUpdated(provider, item.packageName, latest, item.packageFilePath || undefined);
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
      markUpdating(provider, item.packageName, false, item.packageFilePath || undefined);
      showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }
}

export async function runInstallCommand(): Promise<void> {
  try {
    const packageFilePath = await resolveInstallPackageFilePath();
    const client = await clientManager.getClient(getPackageDirectory(packageFilePath));
    const command = client.buildInstallCommand();
    logger.info(`Running install command: ${command}`);
    await executeShellTask(command, 'Install Dependencies', getPackageDirectory(packageFilePath));
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
      updates.forEach(update => markUpdating(
        provider,
        update.item.packageName,
        true,
        update.item.packageFilePath || undefined,
      ));
      await provider.withWriteSuppressed(async () => {
        for (const group of groupDeferredUpdatesByPackageFile(updates)) {
          await updateDependencyVersionsInFile(
            group.packageFilePath,
            group.updates.map(update => ({ name: update.item.packageName, version: update.version })),
          );
        }
      });
      updates.forEach(update => markUpdated(
        provider,
        update.item.packageName,
        update.version,
        update.item.packageFilePath || undefined,
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
    updates.forEach(update => markUpdating(provider, update.item.packageName, false, update.item.packageFilePath || undefined));
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
  updates: readonly { item: PackageItem; version: string }[],
  command: string,
  taskName: string,
  provider: PackagesProvider,
  cwd?: string,
): Promise<void> {
  updates.forEach(update => markUpdating(provider, update.item.packageName, true, update.item.packageFilePath || undefined));
  logger.info(`Running update command: ${command}`);
  const execution = await executeShellTask(command, taskName, cwd);
  let listener: vscode.Disposable | undefined;
  listener = vscode.tasks.onDidEndTaskProcess((e) => {
    if (e.execution !== execution) {
      return;
    }

    listener?.dispose();
    if (e.exitCode === 0) {
      provider.invalidateUpdateCache();
      updates.forEach(update => markUpdated(
        provider,
        update.item.packageName,
        update.version,
        update.item.packageFilePath || undefined,
      ));
      return;
    }
    updates.forEach(update => markUpdating(provider, update.item.packageName, false, update.item.packageFilePath || undefined));
  });
}

async function executeShellTask(command: string, taskName: string, cwd?: string): Promise<vscode.TaskExecution> {
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    taskName,
    'Nestro',
    new vscode.ShellExecution(command, cwd === undefined ? undefined : { cwd }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.New,
  };

  return await vscode.tasks.executeTask(task);
}

function getPackageFilePath(item: PackageItem): string {
  if (item.packageFilePath === '') {
    throw new Error('No workspace package.json found.');
  }
  return item.packageFilePath;
}

function markUpdated(
  provider: PackagesProvider,
  packageName: string,
  version: string,
  packageFilePath: string | undefined,
): void {
  if (packageFilePath === undefined) {
    provider.markPackageUpdated(packageName, version);
    return;
  }
  provider.markPackageUpdated(packageName, version, packageFilePath);
}

function markUpdating(
  provider: PackagesProvider,
  packageName: string,
  installing: boolean,
  packageFilePath: string | undefined,
): void {
  if (packageFilePath === undefined) {
    provider.markPackageUpdating(packageName, installing);
    return;
  }
  provider.markPackageUpdating(packageName, installing, packageFilePath);
}

function groupDeferredUpdatesByPackageFile(
  updates: readonly { item: PackageItem; version: string }[],
): { packageFilePath: string; updates: { item: PackageItem; version: string }[] }[] {
  const byFile = new Map<string, { item: PackageItem; version: string }[]>();
  for (const update of updates) {
    const packageFilePath = getPackageFilePath(update.item);
    byFile.set(packageFilePath, [...(byFile.get(packageFilePath) ?? []), update]);
  }
  return [...byFile.entries()].map(([packageFilePath, groupUpdates]) => ({
    packageFilePath,
    updates: groupUpdates,
  }));
}

function groupImmediateUpdatesByPackageFile(
  updates: readonly { item: PackageItem; version: string }[],
): { packageFilePath: string; updates: { item: PackageItem; version: string }[] }[] {
  const byFile = new Map<string, { item: PackageItem; version: string }[]>();
  for (const update of updates) {
    const packageFilePath = getPackageFilePath(update.item);
    const section = getPackageSection(update.item);
    const groupKey = `${packageFilePath}\0${section}`;
    byFile.set(groupKey, [...(byFile.get(groupKey) ?? []), update]);
  }
  return [...byFile.values()].map(groupUpdates => ({
    packageFilePath: getPackageFilePath(groupUpdates[0].item),
    updates: groupUpdates,
  }));
}

function getPackageSection(item: PackageItem): 'dependencies' | 'devDependencies' {
  return item.dev ? 'devDependencies' : 'dependencies';
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
      description: packageFilePath,
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
  return normalized.endsWith('/package.json')
    ? normalized.slice(0, -'/package.json'.length) || normalized
    : normalized;
}