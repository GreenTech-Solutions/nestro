import * as vscode from 'vscode';
import { PackageItem, PackagesProvider } from '../providers';
import {
  buildPackageUpdateCommand,
  buildRunInstallCommand,
  detectPackageManager,
  logger,
  showError,
  updateWorkspaceDependencyVersions,
} from '../utils';

export async function installUpdateCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
  if (item.latest !== undefined && !item.installing) {
    const latest = item.latest;
    try {
      logger.info(`Preparing update for ${item.packageName} to ${latest}.`);
      if (isDeferredInstallEnabled()) {
        provider.markPackageUpdating(item.packageName, true);
        await provider.withWriteSuppressed(() => updateWorkspaceDependencyVersions([
          { name: item.packageName, version: latest },
        ]));
        provider.markPackageUpdated(item.packageName, latest);
        return;
      }

      const packageManager = await detectPackageManager();
      logger.info(`Detected ${packageManager} package manager for ${item.packageName}.`);
      await runPackageUpdateTask(
        [{ item, version: latest }],
        buildPackageUpdateCommand(packageManager, [{ packageName: item.packageName, version: latest }]),
        `Update ${item.packageName}`,
        provider,
      );
    }
    catch (err) {
      provider.markPackageUpdating(item.packageName, false);
      showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }
}

export async function runInstallCommand(): Promise<void> {
  try {
    const packageManager = await detectPackageManager();
    const command = buildRunInstallCommand(packageManager);
    logger.info(`Running install command: ${command}`);
    await executeShellTask(command, 'Install Dependencies');
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
      updates.forEach(update => provider.markPackageUpdating(update.item.packageName, true));
      await provider.withWriteSuppressed(() =>
        updateWorkspaceDependencyVersions(
          updates.map(update => ({ name: update.item.packageName, version: update.version })),
        ),
      );
      updates.forEach(update => provider.markPackageUpdated(update.item.packageName, update.version));
      return;
    }

    const packageManager = await detectPackageManager();
    const command = buildPackageUpdateCommand(
      packageManager,
      updates.map(update => ({ packageName: update.item.packageName, version: update.version })),
    );
    await runPackageUpdateTask(updates, command, 'Update All Packages', provider);
  }
  catch (err) {
    updates.forEach(update => provider.markPackageUpdating(update.item.packageName, false));
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
): Promise<void> {
  updates.forEach(update => provider.markPackageUpdating(update.item.packageName, true));
  logger.info(`Running update command: ${command}`);
  const execution = await executeShellTask(command, taskName);
  let listener: vscode.Disposable | undefined;
  listener = vscode.tasks.onDidEndTaskProcess((e) => {
    if (e.execution !== execution) {
      return;
    }

    listener?.dispose();
    if (e.exitCode === 0) {
      updates.forEach(update => provider.markPackageUpdated(update.item.packageName, update.version));
      return;
    }
    updates.forEach(update => provider.markPackageUpdating(update.item.packageName, false));
  });
}

async function executeShellTask(command: string, taskName: string): Promise<vscode.TaskExecution> {
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    taskName,
    'Nestro',
    new vscode.ShellExecution(command),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.New,
  };

  return await vscode.tasks.executeTask(task);
}