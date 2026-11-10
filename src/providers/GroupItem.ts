import * as vscode from 'vscode';
import { CONTEXT_VALUE_TOKENS, PACKAGE_PRESENTATION } from '../shared';
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
    const icon = isDev
      ? PACKAGE_PRESENTATION.dependencyIcons.devDependencies
      : PACKAGE_PRESENTATION.dependencyIcons.dependencies;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = CONTEXT_VALUE_TOKENS.group;
  }
}