import * as vscode from 'vscode';
import { PackagesProvider, PackageItem } from './providers';
import { helloWorldCommand, installUpdateCommand } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    console.log('Congratulations, your extension "nestro" is now active!');

    const provider = new PackagesProvider();

    context.subscriptions.push(
        vscode.commands.registerCommand('nestro.helloWorld', helloWorldCommand),
        vscode.window.registerTreeDataProvider('nestro.packagesView', provider),
        vscode.commands.registerCommand('nestro.refresh', () => { void provider.refresh(); }),
        vscode.commands.registerCommand('nestro.installUpdate', (item: PackageItem) => installUpdateCommand(item)),
        provider,
    );

    void provider.refresh();
}

export function deactivate(): void {}
