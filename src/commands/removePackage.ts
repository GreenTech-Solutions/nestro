import * as path from 'path';
import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { PackageItem, PackagesProvider } from '../providers';
import {
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  logger,
  runShellTaskAndWait,
  showError,
} from '../utils';

const clientManager = new ClientManager();

export async function removePackageCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
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
    provider.markPackageUpdating(item.packageName, true, item.packageFilePath);
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
    provider.markPackageUpdating(item.packageName, false, item.packageFilePath);
    showError(formatShellTaskFailureMessage(taskName, exitCode));
    await provider.loadPackages();
  }
  catch (err) {
    if (item.packageFilePath !== '') {
      provider.markPackageUpdating(item.packageName, false, item.packageFilePath);
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