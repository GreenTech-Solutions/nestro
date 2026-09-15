import * as vscode from 'vscode';
import {
  AuditSeverity,
  formatAuditSeverityLabel,
  formatUpdateTypeLabel,
  parseDependencySpec,
  ReleaseAgeState,
  UpdateType,
} from '../utils';

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
  public readonly workspaceOwner: string | undefined;

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
    workspaceOwner?: string,
  ) {
    const safePackageName = sanitizePackageText(packageName);
    const safeCurrentVersion = sanitizePackageText(currentVersion);
    const safeLatest = latest === undefined ? undefined : sanitizePackageText(latest);
    const resolvedWorkspaceOwner = workspaceOwner ?? resolveWorkspaceOwner(packageFilePath);
    super(safePackageName, vscode.TreeItemCollapsibleState.Collapsed);
    this.workspaceOwner = resolvedWorkspaceOwner === undefined
      ? undefined
      : sanitizePackageText(resolvedWorkspaceOwner);
    this.operation = normalizeOperation(operation, latest ?? currentVersion);
    const hasUpdate = updateType !== 'none';
    const parsedSpec = parseDependencySpec(currentVersion);
    const baseDescription = this.operation === undefined
      ? hasUpdate
        ? vscode.l10n.t('{0} → {1}', safeCurrentVersion, safeLatest ?? vscode.l10n.t('unavailable'))
        : safeCurrentVersion
      : this.operation.kind === 'update'
        ? vscode.l10n.t('{0} → {1}', safeCurrentVersion, sanitizePackageText(this.operation.target))
        : safeCurrentVersion;
    this.description = hasUpdate
      ? vscode.l10n.t('{0} ({1})', baseDescription, getUpdateTypeLabel(updateType))
      : baseDescription;
    this.tooltip = this.operation === undefined
      ? hasUpdate
        ? vscode.l10n.t(
            '{0}@{1} (latest: {2})',
            safePackageName,
            safeCurrentVersion,
            safeLatest ?? vscode.l10n.t('unavailable'),
          )
        : vscode.l10n.t('{0}@{1}', safePackageName, safeCurrentVersion)
      : getOperationTooltip(safePackageName, this.operation);
    if (this.operation === undefined && !parsedSpec.supported) {
      this.tooltip = vscode.l10n.t(
        '{0}\nPin unavailable: {1}',
        this.tooltip,
        sanitizePackageText(parsedSpec.reason),
      );
    }
    const contextBase = this.operation === undefined ? hasUpdate ? 'outdated' : 'package' : `installing-${this.operation.kind}`;
    const pinCapability = this.operation === undefined ? parsedSpec.supported ? '-pinnable' : '-pin-unsupported' : '';
    this.contextValue = `${contextBase}${pinCapability}`;
    if (vulnerabilitySeverity !== undefined) {
      const severityLabel = formatAuditSeverityLabel(vulnerabilitySeverity);
      this.description = vscode.l10n.t('{0} vulnerability: {1}', this.description, severityLabel);
      this.tooltip = vscode.l10n.t('{0}\nVulnerability: {1}', this.tooltip, severityLabel);
      this.contextValue = `${this.contextValue}-vulnerable-${vulnerabilitySeverity}`;
    }
    const releaseAgeText = getReleaseAgeText(releaseAge);
    if (releaseAgeText !== undefined) {
      this.description = vscode.l10n.t('{0} {1}', this.description, releaseAgeText);
      this.tooltip = vscode.l10n.t('{0}\n{1}', this.tooltip, releaseAgeText);
    }
    const icons: Record<UpdateType, vscode.ThemeIcon> = {
      breaking: new vscode.ThemeIcon('triangle-up', new vscode.ThemeColor('charts.red')),
      minor: new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow')),
      patch: new vscode.ThemeIcon('arrow-small-up', new vscode.ThemeColor('charts.green')),
      none: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
    };
    this.iconPath = this.operation === undefined
      ? vulnerabilitySeverity === undefined
        ? icons[updateType]
        : getVulnerabilityIcon(vulnerabilitySeverity)
      : getOperationIcon(this.operation);
    this.accessibilityInformation = {
      label: getAccessibilityLabel(
        safePackageName,
        safeCurrentVersion,
        safeLatest,
        updateType,
        vulnerabilitySeverity,
        this.operation,
        this.workspaceOwner,
        parsedSpec,
        releaseAgeText,
      ),
    };
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

function resolveWorkspaceOwner(packageFilePath: string): string | undefined {
  if (packageFilePath === '') {
    return undefined;
  }

  try {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath));
    if (folder === undefined) {
      return undefined;
    }
    return folder.name || folder.uri.fsPath.split(/[\\/]/).at(-1);
  }
  catch {
    return undefined;
  }
}

function getUpdateTypeLabel(updateType: UpdateType): string {
  return vscode.l10n.t('{0} update', formatUpdateTypeLabel(updateType));
}

function getAccessibilityLabel(
  packageName: string,
  currentVersion: string,
  latest: string | undefined,
  updateType: UpdateType,
  vulnerabilitySeverity: AuditSeverity | undefined,
  operation: PackageOperation | undefined,
  workspaceOwner: string | undefined,
  parsedSpec: ReturnType<typeof parseDependencySpec>,
  releaseAgeText: string | undefined,
): string {
  const details = [
    vscode.l10n.t('Package name: {0}', packageName),
    vscode.l10n.t('Current version: {0}', currentVersion),
    vscode.l10n.t('Latest version: {0}', latest ?? vscode.l10n.t('unavailable')),
    vscode.l10n.t('Update type: {0}', formatUpdateTypeLabel(updateType)),
    vulnerabilitySeverity === undefined
      ? vscode.l10n.t('Vulnerability: none detected')
      : vscode.l10n.t('Vulnerability: {0}', formatAuditSeverityLabel(vulnerabilitySeverity)),
    operation === undefined
      ? vscode.l10n.t('Active operation: none')
      : vscode.l10n.t('Active operation: {0}', getOperationAccessibilityText(operation)),
    vscode.l10n.t('Workspace owner: {0}', workspaceOwner ?? vscode.l10n.t('unavailable')),
    operation === undefined
      ? parsedSpec.supported
        ? vscode.l10n.t('Pin capability: available')
        : vscode.l10n.t('Pin capability: unavailable — {0}', sanitizePackageText(parsedSpec.reason))
      : vscode.l10n.t('Pin capability: unavailable while busy'),
    ...(releaseAgeText === undefined ? [] : [releaseAgeText]),
  ];
  return details.join('. ');
}

function getOperationAccessibilityText(operation: PackageOperation): string {
  switch (operation.kind) {
    case 'update':
      return vscode.l10n.t('update in progress to {0}', sanitizePackageText(operation.target));
    case 'remove':
      return vscode.l10n.t('remove in progress');
    case 'install':
      return vscode.l10n.t('install in progress');
    case 'pin':
      return vscode.l10n.t('pin in progress');
    case 'switch':
      return vscode.l10n.t('dependency type switch in progress');
  }
}

function getOperationTooltip(packageName: string, operation: PackageOperation): string {
  switch (operation.kind) {
    case 'update':
      return vscode.l10n.t('Updating {0} to {1}', packageName, sanitizePackageText(operation.target));
    case 'remove':
      return vscode.l10n.t('Removing {0}', packageName);
    case 'install':
      return vscode.l10n.t('Installing {0}', packageName);
    case 'pin':
      return vscode.l10n.t('Pinning {0} version', packageName);
    case 'switch':
      return vscode.l10n.t('Switching {0} dependency type', packageName);
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
    return vscode.l10n.t(
      'Held back {0} until {1}',
      sanitizePackageText(state.version),
      sanitizePackageText(state.eligibleAt),
    );
  }
  if (state.kind === 'unknown') {
    return sanitizePackageText(
      state.version === undefined
        ? vscode.l10n.t('Release age unknown; update is not blocked.')
        : vscode.l10n.t(
            'Release age unknown for {0}; update is not blocked.',
            sanitizePackageText(state.version),
          ),
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