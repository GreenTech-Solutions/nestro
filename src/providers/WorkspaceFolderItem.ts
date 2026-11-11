import * as vscode from 'vscode';
import { CONTEXT_VALUE_TOKENS } from '../shared';
import { GroupItem } from './GroupItem';

export class WorkspaceFolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderLabel: string,
    public readonly folderPath: string,
    public readonly children: GroupItem[],
  ) {
    super(folderLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = CONTEXT_VALUE_TOKENS.workspaceFolder;
  }
}