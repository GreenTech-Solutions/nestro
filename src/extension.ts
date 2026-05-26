import * as vscode from 'vscode';
import { PackagesProvider, PackageItem } from './PackagesProvider';
import { runInstall } from './packageUtils';

export function activate(context: vscode.ExtensionContext): void {
    console.log('Congratulations, your extension "nestro" is now active!');

    const provider = new PackagesProvider();

    context.subscriptions.push(
        vscode.commands.registerCommand('nestro.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from Nestro again!');
        }),
        vscode.window.registerTreeDataProvider('nestro.packagesView', provider),
        vscode.commands.registerCommand('nestro.refresh', () => { void provider.refresh(); }),
        vscode.commands.registerCommand('nestro.installUpdate', (item: PackageItem) => {
            if (item.latest !== undefined) {
                runInstall(item.packageName, item.latest);
            }
        }),
        provider,
    );

    void provider.refresh();
}

export function deactivate(): void {}
