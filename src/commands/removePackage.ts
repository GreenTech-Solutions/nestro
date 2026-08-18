import * as path from 'path';
import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { isPackageItem, PackageItem, PackagesProvider } from '../providers';
import {
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  logger,
  runShellTaskAndWait,
  showError,
} from '../utils';

const clientManager = new ClientManager();

export async function removePackageCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.removePackage invoked without a valid package item; ignoring.');
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove ${item.packageName} from ${item.dev ? 'devDependencies' : 'dependencies'}?`,
    { modal: true },
    'Remove Package',
  );
  if (confirmed !== 'Remove Package') {
    return;
  }

  try {
    const cwd = getPackageCwd(item);
    provider.markPackageUpdating({
      packageName: item.packageName,
      packageFilePath: item.packageFilePath,
      section: item.dev ? 'devDependencies' : 'dependencies',
    }, true);
    const client = await clientManager.getClient(cwd);
    const command = client.buildRemoveCommand([item.packageName]);
    logger.info(`Running remove command: ${formatShellTaskCommandForLog(command)}`);
    const taskName = `Remove ${item.packageName}`;
    const exitCode = await runShellTaskAndWait(command, taskName, cwd);
    provider.invalidateUpdateCache();
    if (exitCode === 0) {
      await provider.loadPackages();
      return;
    }
    provider.markPackageUpdating({
      packageName: item.packageName,
      packageFilePath: item.packageFilePath,
      section: item.dev ? 'devDependencies' : 'dependencies',
    }, false);
    showError(formatShellTaskFailureMessage(taskName, exitCode));
    await provider.loadPackages();
  }
  catch (err) {
    if (item.packageFilePath !== '') {
      provider.markPackageUpdating({
        packageName: item.packageName,
        packageFilePath: item.packageFilePath,
        section: item.dev ? 'devDependencies' : 'dependencies',
      }, false);
    }
    showError(`failed to remove package — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

function getPackageCwd(item: PackageItem): string {
  if (item.packageFilePath === '') {
    throw new Error(`No package.json path found for ${item.packageName}.`);
  }

  return path.dirname(item.packageFilePath);
}