import * as path from 'path';
import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { PackageItem, PackagesProvider } from '../providers';
import { logger, showError } from '../utils';

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
    logger.info(`Running remove command: ${command}`);
    const execution = await executeShellTask(command, `Remove ${item.packageName}`, cwd);
    let listener: vscode.Disposable | undefined;
    listener = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== execution) {
        return;
      }

      listener?.dispose();
      provider.invalidateUpdateCache();
      if (e.exitCode === 0) {
        void provider.loadPackages();
        return;
      }
      provider.markPackageUpdating(item.packageName, false, item.packageFilePath);
    });
  }
  catch (err) {
    if (item.packageFilePath !== '') {
      provider.markPackageUpdating(item.packageName, false, item.packageFilePath);
    }
    showError(`failed to remove package — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

async function executeShellTask(command: string, taskName: string, cwd: string): Promise<vscode.TaskExecution> {
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    taskName,
    'Nestro',
    new vscode.ShellExecution(command, { cwd }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.New,
  };

  return await vscode.tasks.executeTask(task);
}

function getPackageCwd(item: PackageItem): string {
  if (item.packageFilePath === '') {
    throw new Error(`No package.json path found for ${item.packageName}.`);
  }

  return path.dirname(item.packageFilePath);
}
