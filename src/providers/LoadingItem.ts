import * as vscode from 'vscode';

export class LoadingItem extends vscode.TreeItem {
  constructor() {
    super(vscode.l10n.t('Loading packages…'), vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('loading~spin');
  }
}