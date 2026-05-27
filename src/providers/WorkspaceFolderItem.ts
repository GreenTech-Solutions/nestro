import * as vscode from 'vscode';
import { GroupItem } from './GroupItem';

export class WorkspaceFolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderLabel: string,
    public readonly folderPath: string,
    public readonly children: GroupItem[],
  ) {
    super(folderLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'workspaceFolder';
  }
}