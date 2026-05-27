import * as vscode from 'vscode';

export class GroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: vscode.TreeItem[],
    totalCount: number,
    outdatedCount: number,
    isDev: boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = outdatedCount > 0
      ? `${totalCount} packages · ${outdatedCount} outdated`
      : `${totalCount} packages`;
    this.iconPath = new vscode.ThemeIcon(isDev ? 'tools' : 'package');
    this.contextValue = 'group';
  }
}