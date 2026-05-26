import * as vscode from 'vscode';
import { PackageItem } from '../providers';
import { buildInstallCommand, detectPackageManager, logger, showError } from '../utils';

export async function installUpdateCommand(item: PackageItem): Promise<void> {
    if (item.latest !== undefined) {
        try {
            logger.info(`Preparing update for ${item.packageName} to ${item.latest}.`);
            const packageManager = await detectPackageManager();
            logger.info(`Detected ${packageManager} package manager for ${item.packageName}.`);
            const terminal = vscode.window.createTerminal('Nestro: Update');
            const command = buildInstallCommand(packageManager, item.packageName, item.latest);
            logger.info(`Running update command: ${command}`);
            terminal.sendText(command);
            terminal.show();
        } catch (err) {
            showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`, err);
        }
    }
}
