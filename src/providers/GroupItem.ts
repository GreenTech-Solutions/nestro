import * as vscode from 'vscode';

export class GroupItem extends vscode.TreeItem {
  constructor(label: string, public readonly children: vscode.TreeItem[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'group';
  }
}