import * as vscode from 'vscode';

export class PackageDetailItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'packageDetail';
  }
}