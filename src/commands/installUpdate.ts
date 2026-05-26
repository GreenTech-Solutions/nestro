import * as vscode from 'vscode';
import { PackageItem } from '../providers';
import { buildInstallCommand, detectPackageManager, showError } from '../utils';

export async function installUpdateCommand(item: PackageItem): Promise<void> {
    if (item.latest !== undefined) {
        try {
            const packageManager = await detectPackageManager();
            const terminal = vscode.window.createTerminal('Nestro: Update');
            terminal.sendText(buildInstallCommand(packageManager, item.packageName, item.latest));
            terminal.show();
        } catch (err) {
            showError(`failed to install update — ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
