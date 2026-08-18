import * as vscode from 'vscode';
import { AuditSeverity, UpdateType } from '../utils';

export class PackageItem extends vscode.TreeItem {
  constructor(
    public readonly packageName: string,
    public readonly currentVersion: string,
    public readonly latest: string | undefined,
    public readonly updateType: UpdateType,
    public readonly installing = false,
    public readonly vulnerabilitySeverity: AuditSeverity | undefined = undefined,
    public readonly packageFilePath = '',
    public readonly dev = false,
    public readonly versionPrefix = '',
  ) {
    super(packageName, vscode.TreeItemCollapsibleState.Collapsed);
    const hasUpdate = updateType !== 'none';
    this.description = hasUpdate ? `${currentVersion} → ${latest}` : currentVersion;
    this.tooltip = installing
      ? `Updating ${packageName} to ${latest}`
      : `${packageName}@${currentVersion}${hasUpdate ? ` (latest: ${latest})` : ''}`;
    this.contextValue = installing ? 'installing' : hasUpdate ? 'outdated' : 'package';
    if (vulnerabilitySeverity !== undefined) {
      this.description = `${this.description} vulnerability: ${vulnerabilitySeverity}`;
      this.tooltip = `${this.tooltip}\nVulnerability: ${vulnerabilitySeverity}`;
      this.contextValue = `${this.contextValue}-vulnerable-${vulnerabilitySeverity}`;
    }
    const icons: Record<UpdateType, vscode.ThemeIcon> = {
      breaking: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.red')),
      minor: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow')),
      patch: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.green')),
      none: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
    };
    this.iconPath = installing
      ? new vscode.ThemeIcon('loading~spin')
      : vulnerabilitySeverity === undefined
        ? icons[updateType]
        : getVulnerabilityIcon(vulnerabilitySeverity);
  }
}

/**
 * Structural guard for commands that only make sense against a real row: the Command
 * Palette can invoke a contributed command with no argument at all, and `executeCommand()`
 * accepts any value from the API regardless of the declared parameter type. This narrows
 * `unknown` down to an actual `PackageItem` instance so callers can safely no-op instead
 * of dereferencing a missing/malformed argument.
 */
export function isPackageItem(value: unknown): value is PackageItem {
  return value instanceof PackageItem;
}

function getVulnerabilityIcon(severity: AuditSeverity): vscode.ThemeIcon {
  const color = severity === 'critical' || severity === 'high'
    ? 'errorForeground'
    : severity === 'moderate'
      ? 'warningForeground'
      : 'notificationsInfoIcon.foreground';
  const icon = severity === 'low' || severity === 'info' ? 'info' : 'warning';
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}