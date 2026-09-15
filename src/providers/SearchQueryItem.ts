import * as vscode from 'vscode';

export class SearchQueryItem extends vscode.TreeItem {
  constructor(search: string) {
    super(vscode.l10n.t('Search query'), vscode.TreeItemCollapsibleState.None);
    this.description = search === '' ? vscode.l10n.t('All packages') : search;
    this.tooltip = search === ''
      ? vscode.l10n.t('Edit package search query')
      : vscode.l10n.t('Current package search query: {0}', search);
    this.iconPath = new vscode.ThemeIcon('search');
    this.command = { command: 'nestro.searchPackages', title: vscode.l10n.t('Edit Search Query') };
    this.contextValue = search === '' ? 'search-empty' : 'search-active';
  }
}