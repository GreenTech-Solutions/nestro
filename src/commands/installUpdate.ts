import * as vscode from 'vscode';
import { PackageItem } from '../providers';

export function installUpdateCommand(item: PackageItem): void {
    if (item.latest !== undefined) {
        const terminal = vscode.window.createTerminal('Nestro: Update');
        terminal.sendText(`npm install ${item.packageName}@${item.latest}`);
        terminal.show();
    }
}
