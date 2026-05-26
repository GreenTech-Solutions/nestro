import * as vscode from 'vscode';
import { PackageItem, PackagesProvider } from '../providers';
import { buildInstallCommand, detectPackageManager, logger, showError } from '../utils';

export async function installUpdateCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
    if (item.latest !== undefined) {
        try {
            logger.info(`Preparing update for ${item.packageName} to ${item.latest}.`);
            const packageManager = await detectPackageManager();
            logger.info(`Detected ${packageManager} package manager for ${item.packageName}.`);
            const command = buildInstallCommand(packageManager, item.packageName, item.latest);
            logger.info(`Running update command: ${command}`);
            const task = new vscode.Task(
                { type: 'shell' },
                vscode.TaskScope.Workspace,
                `Update ${item.packageName}`,
                'Nestro',
                new vscode.ShellExecution(command),
            );
            task.presentationOptions = {
                reveal: vscode.TaskRevealKind.Always,
                panel: vscode.TaskPanelKind.New,
            };

            const execution = await vscode.tasks.executeTask(task);
            let listener: vscode.Disposable | undefined;
            listener = vscode.tasks.onDidEndTaskProcess((e) => {
                if (e.execution !== execution) {
                    return;
                }

                listener?.dispose();
                if (e.exitCode === 0 && item.latest !== undefined) {
                    provider.markPackageUpdated(item.packageName, item.latest);
                }
            });
        } catch (err) {
            showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`, err);
        }
    }
}
