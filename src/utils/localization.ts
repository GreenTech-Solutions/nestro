import * as vscode from 'vscode';
import type { AuditSeverity } from './auditClient';
import type { UpdateType } from './versionUtils';

export function formatDependencySectionLabel(section: 'dependencies' | 'devDependencies'): string {
  return section === 'dependencies'
    ? vscode.l10n.t('dependencies')
    : vscode.l10n.t('dev dependencies');
}

export function formatUpdateTypeLabel(updateType: UpdateType): string {
  switch (updateType) {
    case 'patch':
      return vscode.l10n.t('patch');
    case 'minor':
      return vscode.l10n.t('minor');
    case 'breaking':
      return vscode.l10n.t('breaking');
    case 'none':
      return vscode.l10n.t('none');
  }
}

export function formatAuditSeverityLabel(severity: AuditSeverity): string {
  switch (severity) {
    case 'critical':
      return vscode.l10n.t('critical');
    case 'high':
      return vscode.l10n.t('high');
    case 'moderate':
      return vscode.l10n.t('moderate');
    case 'low':
      return vscode.l10n.t('low');
    case 'info':
      return vscode.l10n.t('info');
  }
}

export function formatPackageCount(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} package', count)
    : vscode.l10n.t('{0} packages', count);
}

export function formatPackageGroupDescription(totalCount: number, outdatedCount: number): string {
  const packageCount = formatPackageCount(totalCount);
  return outdatedCount > 0
    ? vscode.l10n.t('{0} · {1} outdated', packageCount, outdatedCount)
    : packageCount;
}

export function formatPackageUpdatesAvailable(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} package update available', count)
    : vscode.l10n.t('{0} package updates available', count);
}

export function formatVulnerablePackageCount(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} vulnerable package', count)
    : vscode.l10n.t('{0} vulnerable packages', count);
}

export function formatPinnedPackageVersions(count: number): string {
  return count === 1
    ? vscode.l10n.t('Pinned {0} package version.', count)
    : vscode.l10n.t('Pinned {0} package versions.', count);
}

export function formatAdvisoryRows(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} advisory row', count)
    : vscode.l10n.t('{0} advisory rows', count);
}

export function formatPackageLevelFindings(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} package-level finding', count)
    : vscode.l10n.t('{0} package-level findings', count);
}

export function formatFailedPackageFileCount(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} package file failed to load', count)
    : vscode.l10n.t('{0} package files failed to load', count);
}

export function formatFailedPackageRootCount(count: number): string {
  return count === 1
    ? vscode.l10n.t('{0} package root failed', count)
    : vscode.l10n.t('{0} package roots failed', count);
}

// Omitting timeZone renders the absolute instant in the caller's local zone.
export function formatHeldBackDate(instant: string, locale?: string, timeZone?: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? instant
    : new Intl.DateTimeFormat(locale ?? vscode.env.language, { dateStyle: 'medium', timeZone }).format(date);
}

export function formatFilteredPackageCount(visibleCount: number, totalCount: number): string {
  return vscode.l10n.t('{0} of {1}', visibleCount, totalCount);
}