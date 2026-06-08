import * as vscode from 'vscode';

export class SearchQueryItem extends vscode.TreeItem {
  constructor(search: string) {
    super('Search query', vscode.TreeItemCollapsibleState.None);
    this.description = search === '' ? 'All packages' : search;
    this.tooltip = search === ''
      ? 'Edit package search query'
      : `Current package search query: ${search}`;
    this.iconPath = new vscode.ThemeIcon('search');
    this.command = { command: 'nestro.searchPackages', title: 'Edit Search Query' };
    this.contextValue = 'search';
  }
}
