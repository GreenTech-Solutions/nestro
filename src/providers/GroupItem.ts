import * as vscode from 'vscode';
import { formatPackageGroupDescription } from '../utils';

export class GroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: vscode.TreeItem[],
    totalCount: number,
    outdatedCount: number,
    isDev: boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = formatPackageGroupDescription(totalCount, outdatedCount);
    this.iconPath = new vscode.ThemeIcon(isDev ? 'tools' : 'package');
    this.contextValue = 'group';
  }
}