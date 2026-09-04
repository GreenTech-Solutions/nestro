import * as vscode from 'vscode';
import { AuditSeverity, parseDependencySpec, ReleaseAgeState, UpdateType } from '../utils';

export type PackageOperation
  = | { readonly kind: 'update'; readonly target: string }
    | { readonly kind: 'remove' }
    | { readonly kind: 'install' }
    | { readonly kind: 'pin' }
    | { readonly kind: 'switch' };

type PackageOperationInput = PackageOperation | boolean | undefined;

const PACKAGE_ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}(?:\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)|\\[[0-?]*[ -/]*[@-~])`,
  'g',
);
const PACKAGE_CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

export class PackageItem extends vscode.TreeItem {
  public readonly operation: PackageOperation | undefined;

  constructor(
    public readonly packageName: string,
    public readonly currentVersion: string,
    public readonly latest: string | undefined,
    public readonly updateType: UpdateType,
    operation: PackageOperationInput = undefined,
    public readonly vulnerabilitySeverity: AuditSeverity | undefined = undefined,
    public readonly packageFilePath = '',
    public readonly dev = false,
    public readonly versionPrefix = '',
    public readonly releaseAge: ReleaseAgeState = { kind: 'accepted' },
  ) {
    const safePackageName = sanitizePackageText(packageName);
    const safeCurrentVersion = sanitizePackageText(currentVersion);
    const safeLatest = latest === undefined ? undefined : sanitizePackageText(latest);
    super(safePackageName, vscode.TreeItemCollapsibleState.Collapsed);
    this.operation = normalizeOperation(operation, latest ?? currentVersion);
    const hasUpdate = updateType !== 'none';
    const parsedSpec = parseDependencySpec(currentVersion);
    this.description = this.operation === undefined
      ? hasUpdate
        ? `${safeCurrentVersion} → ${safeLatest}`
        : safeCurrentVersion
      : this.operation.kind === 'update'
        ? `${safeCurrentVersion} → ${sanitizePackageText(this.operation.target)}`
        : safeCurrentVersion;
    this.tooltip = this.operation === undefined
      ? `${safePackageName}@${safeCurrentVersion}${hasUpdate ? ` (latest: ${safeLatest})` : ''}`
      : getOperationTooltip(safePackageName, this.operation);
    if (this.operation === undefined && !parsedSpec.supported) {
      this.tooltip = `${this.tooltip}\nPin unavailable: ${parsedSpec.reason}`;
    }
    const contextBase = this.operation === undefined ? hasUpdate ? 'outdated' : 'package' : `installing-${this.operation.kind}`;
    const pinCapability = this.operation === undefined ? parsedSpec.supported ? '-pinnable' : '-pin-unsupported' : '';
    this.contextValue = `${contextBase}${pinCapability}`;
    if (vulnerabilitySeverity !== undefined) {
      this.description = `${this.description} vulnerability: ${vulnerabilitySeverity}`;
      this.tooltip = `${this.tooltip}\nVulnerability: ${vulnerabilitySeverity}`;
      this.contextValue = `${this.contextValue}-vulnerable-${vulnerabilitySeverity}`;
    }
    const releaseAgeText = getReleaseAgeText(releaseAge);
    if (releaseAgeText !== undefined) {
      this.description = `${this.description} ${releaseAgeText}`;
      this.tooltip = `${this.tooltip}\n${releaseAgeText}`;
    }
    const icons: Record<UpdateType, vscode.ThemeIcon> = {
      breaking: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.red')),
      minor: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow')),
      patch: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.green')),
      none: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
    };
    this.iconPath = this.operation === undefined
      ? vulnerabilitySeverity === undefined
        ? icons[updateType]
        : getVulnerabilityIcon(vulnerabilitySeverity)
      : getOperationIcon(this.operation);
  }

  get installing(): boolean {
    return this.operation !== undefined;
  }
}

function normalizeOperation(operation: PackageOperationInput, defaultTarget: string): PackageOperation | undefined {
  if (typeof operation !== 'boolean') {
    return operation;
  }
  return operation ? { kind: 'update', target: defaultTarget } : undefined;
}

function getOperationTooltip(packageName: string, operation: PackageOperation): string {
  switch (operation.kind) {
    case 'update':
      return `Updating ${packageName} to ${sanitizePackageText(operation.target)}`;
    case 'remove':
      return `Removing ${packageName}`;
    case 'install':
      return `Installing ${packageName}`;
    case 'pin':
      return `Pinning ${packageName} version`;
    case 'switch':
      return `Switching ${packageName} dependency type`;
  }
}

function getOperationIcon(operation: PackageOperation): vscode.ThemeIcon {
  const icons: Record<PackageOperation['kind'], string> = {
    update: 'arrow-up',
    remove: 'trash',
    install: 'cloud-download',
    pin: 'lock',
    switch: 'arrow-swap',
  };
  return new vscode.ThemeIcon(icons[operation.kind]);
}

function getReleaseAgeText(state: ReleaseAgeState): string | undefined {
  if (state.kind === 'held-back') {
    return sanitizePackageText(`Held back ${state.version} until ${state.eligibleAt}`);
  }
  if (state.kind === 'unknown') {
    return sanitizePackageText(
      state.version === undefined
        ? 'Release age unknown; update is not blocked.'
        : `Release age unknown for ${state.version}; update is not blocked.`,
    );
  }
  return undefined;
}

export function sanitizePackageText(value: string): string {
  return value
    .replace(PACKAGE_ANSI_ESCAPE, '')
    .replace(PACKAGE_CONTROL, ' ')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .slice(0, 240);
}

/**
 * Narrows an unknown command argument to `PackageItem`: the Command Palette can invoke a
 * command with no argument, and `executeCommand()` accepts any value regardless of the
 * declared parameter type, so callers must not assume the argument is well-formed.
 */
export function isPackageItem(value: unknown): value is PackageItem {
  try {
    return value instanceof PackageItem;
  }
  catch {
    return false;
  }
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