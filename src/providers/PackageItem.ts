import * as vscode from 'vscode';

export class PackageItem extends vscode.TreeItem {
    constructor(
        public readonly packageName: string,
        public readonly currentVersion: string,
        public readonly latest: string | undefined,
        outdated: boolean,
    ) {
        super(packageName, vscode.TreeItemCollapsibleState.None);
        this.description = latest ? `${currentVersion} → ${latest}` : currentVersion;
        this.tooltip = `${packageName}@${currentVersion}${latest ? ` (latest: ${latest})` : ''}`;
        this.contextValue = outdated ? 'outdated' : 'package';
        this.iconPath = outdated
            ? new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow'))
            : new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    }
}
