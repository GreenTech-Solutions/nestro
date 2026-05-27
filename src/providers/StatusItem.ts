import * as vscode from 'vscode';

export class StatusItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, color?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'status';
    this.iconPath = color === undefined
      ? new vscode.ThemeIcon(icon)
      : new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  }
}