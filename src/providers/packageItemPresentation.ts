import * as vscode from 'vscode';
import { CONTEXT_VALUE_TOKENS, PACKAGE_PRESENTATION, sanitizeInlineText } from '../shared';
import {
  formatAuditSeverityLabel,
  formatHeldBackDate,
  formatUpdateTypeLabel,
  parseDependencySpec,
} from '../utils';
import type { AuditSeverity, ReleaseAgeState, UpdateType } from '../utils';
import type { PackageItem, PackageOperation } from './PackageItem';
import { getLocalizedPackageLabelFormatting, resolvePackageFileLabels, toWorkspaceFolderDescriptors } from './packageLabels';

interface PackageItemPresentationInput {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly latest: string | undefined;
  readonly updateType: UpdateType;
  readonly vulnerabilitySeverity: AuditSeverity | undefined;
  readonly operation: PackageOperation | undefined;
  readonly workspaceOwner: string | undefined;
  readonly parsedSpec: ReturnType<typeof parseDependencySpec>;
  readonly releaseAge: ReleaseAgeState;
}

interface PackageItemTextPresentation {
  readonly description: string;
  readonly tooltip: string;
  readonly contextValue: string;
}

export function configurePackageItemPresentation(item: PackageItem, input: PackageItemPresentationInput): void {
  const basePresentation = applyBasePackageItemPresentation(item, input);
  const vulnerabilityPresentation = applyVulnerabilityPresentation(item, basePresentation, input);
  applyReleaseAgePresentation(item, vulnerabilityPresentation, input);
}

function applyBasePackageItemPresentation(
  item: PackageItem,
  {
    packageName,
    currentVersion,
    latest,
    updateType,
    operation,
    parsedSpec,
  }: PackageItemPresentationInput,
): PackageItemTextPresentation {
  const hasUpdate = updateType !== 'none';
  const baseDescription = operation === undefined
    ? hasUpdate
      ? vscode.l10n.t('{0} → {1}', currentVersion, latest ?? vscode.l10n.t('unavailable'))
      : currentVersion
    : operation.kind === 'update'
      ? vscode.l10n.t('{0} → {1}', currentVersion, sanitizePackageText(operation.target))
      : currentVersion;
  const description = hasUpdate
    ? vscode.l10n.t('{0} ({1})', baseDescription, getUpdateTypeLabel(updateType))
    : baseDescription;
  item.description = description;
  let tooltip = operation === undefined
    ? hasUpdate
      ? vscode.l10n.t(
          '{0}@{1} (latest: {2})',
          packageName,
          currentVersion,
          latest ?? vscode.l10n.t('unavailable'),
        )
      : vscode.l10n.t('{0}@{1}', packageName, currentVersion)
    : getOperationTooltip(packageName, operation);
  item.tooltip = tooltip;
  if (operation === undefined && !parsedSpec.supported) {
    tooltip = vscode.l10n.t(
      '{0}\nPin unavailable: {1}',
      tooltip,
      sanitizePackageText(parsedSpec.reason),
    );
    item.tooltip = tooltip;
  }
  const contextValue = buildRowContextValue(operation, hasUpdate, parsedSpec.supported);
  item.contextValue = contextValue;
  return { description, tooltip, contextValue };
}

function applyVulnerabilityPresentation(
  item: PackageItem,
  presentation: PackageItemTextPresentation,
  input: PackageItemPresentationInput,
): PackageItemTextPresentation {
  const { vulnerabilitySeverity } = input;
  if (vulnerabilitySeverity === undefined) {
    return presentation;
  }
  const severityLabel = formatAuditSeverityLabel(vulnerabilitySeverity);
  const description = vscode.l10n.t('{0} vulnerability: {1}', presentation.description, severityLabel);
  item.description = description;
  const tooltip = vscode.l10n.t('{0}\nVulnerability: {1}', presentation.tooltip, severityLabel);
  item.tooltip = tooltip;
  const contextValue = `${presentation.contextValue}-${CONTEXT_VALUE_TOKENS.vulnerable}-${vulnerabilitySeverity}`;
  item.contextValue = contextValue;
  return { description, tooltip, contextValue };
}

function applyReleaseAgePresentation(
  item: PackageItem,
  presentation: PackageItemTextPresentation,
  input: PackageItemPresentationInput,
): void {
  const {
    packageName,
    currentVersion,
    latest,
    updateType,
    vulnerabilitySeverity,
    operation,
    workspaceOwner,
    parsedSpec,
    releaseAge,
  } = input;
  const releaseAgeText = getReleaseAgeText(releaseAge);
  let { description, tooltip } = presentation;
  if (releaseAgeText !== undefined) {
    description = vscode.l10n.t('{0} {1}', description, releaseAgeText);
    item.description = description;
    tooltip = vscode.l10n.t('{0}\n{1}', tooltip, releaseAgeText);
    item.tooltip = tooltip;
  }
  item.iconPath = operation === undefined
    ? vulnerabilitySeverity === undefined
      ? getUpdateTypeIcon(updateType)
      : getVulnerabilityIcon(vulnerabilitySeverity)
    : getOperationIcon(operation);
  item.accessibilityInformation = {
    label: getAccessibilityLabel(
      packageName,
      currentVersion,
      latest,
      updateType,
      vulnerabilitySeverity,
      operation,
      workspaceOwner,
      parsedSpec,
      releaseAgeText,
    ),
  };
}

function buildRowContextValue(operation: PackageOperation | undefined, hasUpdate: boolean, pinSupported: boolean): string {
  if (operation !== undefined) {
    return `${CONTEXT_VALUE_TOKENS.installing}-${operation.kind}`;
  }
  const base = hasUpdate ? CONTEXT_VALUE_TOKENS.outdated : CONTEXT_VALUE_TOKENS.package;
  return `${base}-${pinSupported ? CONTEXT_VALUE_TOKENS.pinnable : CONTEXT_VALUE_TOKENS.pinUnsupported}`;
}

export function resolveWorkspaceOwner(packageFilePath: string): string | undefined {
  if (packageFilePath === '') {
    return undefined;
  }
  try {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath));
    if (folder === undefined) {
      return undefined;
    }
    const workspaceFolders = toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
    return resolvePackageFileLabels(
      [packageFilePath],
      workspaceFolders,
      getLocalizedPackageLabelFormatting(),
    ).find(label => label.packageFilePath === packageFilePath)?.owner.label;
  }
  catch {
    return undefined;
  }
}

function getUpdateTypeLabel(updateType: UpdateType): string {
  return vscode.l10n.t('{0} update', formatUpdateTypeLabel(updateType));
}

function getUpdateTypeIcon(updateType: UpdateType): vscode.ThemeIcon {
  const presentation = PACKAGE_PRESENTATION.updateTypes[updateType];
  return new vscode.ThemeIcon(presentation.icon, new vscode.ThemeColor(presentation.color));
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
      sanitizePackageText(formatHeldBackDate(state.eligibleAt)),
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
  return sanitizeInlineText(value);
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