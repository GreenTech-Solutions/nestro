import * as vscode from 'vscode';

export class PackageDetailItem extends vscode.TreeItem {
  constructor(label: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'detail';
    if (icon !== undefined) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}