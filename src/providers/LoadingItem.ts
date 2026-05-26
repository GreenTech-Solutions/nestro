import * as vscode from 'vscode';

export class LoadingItem extends vscode.TreeItem {
    constructor() {
        super('Loading packages…', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
}
