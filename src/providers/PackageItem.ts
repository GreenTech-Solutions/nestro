import * as vscode from 'vscode';
import { UpdateType } from '../utils';

export class PackageItem extends vscode.TreeItem {
  constructor(
    public readonly packageName: string,
    public readonly currentVersion: string,
    public readonly latest: string | undefined,
    public readonly updateType: UpdateType,
  ) {
    super(packageName, vscode.TreeItemCollapsibleState.None);
    const hasUpdate = updateType !== 'none';
    this.description = hasUpdate ? `${currentVersion} → ${latest}` : currentVersion;
    this.tooltip = `${packageName}@${currentVersion}${hasUpdate ? ` (latest: ${latest})` : ''}`;
    this.contextValue = hasUpdate ? 'outdated' : 'package';
    const icons: Record<UpdateType, vscode.ThemeIcon> = {
      breaking: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.red')),
      minor: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow')),
      patch: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.green')),
      none: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
    };
    this.iconPath = icons[updateType];
  }
}