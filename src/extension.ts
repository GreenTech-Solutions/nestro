import * as vscode from 'vscode';
import { PackagesProvider, PackageItem } from './providers';
import type { FilterType } from './providers';
import { helloWorldCommand, installUpdateCommand } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    console.log('Congratulations, your extension "nestro" is now active!');

    const provider = new PackagesProvider();

    const checkUpdatesOnStartup = vscode.workspace
        .getConfiguration('nestro')
        .get<boolean>('checkUpdatesOnStartup', false);

    context.subscriptions.push(
        vscode.commands.registerCommand('nestro.helloWorld', helloWorldCommand),
        vscode.window.registerTreeDataProvider('nestro.packagesView', provider),
        vscode.commands.registerCommand('nestro.refresh', () => { void provider.loadPackages(); }),
        vscode.commands.registerCommand('nestro.checkUpdates', () => { void provider.checkUpdates(); }),
        vscode.commands.registerCommand('nestro.installUpdate', (item: PackageItem) => installUpdateCommand(item)),
        vscode.commands.registerCommand('nestro.setFilter', (type: FilterType) => provider.setFilter(type)),
        vscode.commands.registerCommand('nestro.showFilterPicker', () => { void provider.showFilterPicker(); }),
        vscode.commands.registerCommand('nestro.openSettings', () => {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'nestro');
        }),
        provider,
    );

    void provider.loadPackages().then(() => {
        if (checkUpdatesOnStartup) {
            void provider.checkUpdates();
        }
    });
}

export function deactivate(): void {}
