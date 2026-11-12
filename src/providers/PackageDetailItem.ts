import * as vscode from 'vscode';
import { CONTEXT_VALUE_TOKENS } from '../shared';

export class PackageDetailItem extends vscode.TreeItem {
  constructor(label: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = CONTEXT_VALUE_TOKENS.detail;
    if (icon !== undefined) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}