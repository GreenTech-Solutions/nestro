import * as vscode from 'vscode';
import { getFilterLabel } from './FilterManager';
import type { StatusRowProjection, ViewProjectionSnapshot } from './viewProjectionService';
import { projectPackageTree, truncateSearchQuery } from './treeBuilder';
import type { PackageTreeProjection } from './treeBuilder';
import { sanitizePackageText } from './packageItemPresentation';
import { COMMAND_IDS, CONTEXT_VALUE_TOKENS, uniqueStrings } from '../shared';
import {
  formatFailedPackageFileCount,
  formatFailedPackageRootCount,
  formatFilteredPackageCount,
  formatPackageCount,
  formatVulnerablePackageCount,
} from '../utils';

/** Builds the current status rows in display order from one plain provider snapshot. */
export function projectStatusRows(
  snapshot: ViewProjectionSnapshot,
  packageTree?: PackageTreeProjection,
): StatusRowProjection[] {
  return [
    ...projectPackageReadRows(snapshot),
    ...projectUpdateRows(snapshot),
    ...projectAuditRows(snapshot),
    ...projectFilterSearchRows(snapshot, packageTree),
  ];
}

function projectPackageReadRows(snapshot: ViewProjectionSnapshot): StatusRowProjection[] {
  const rows: StatusRowProjection[] = [];
  const failedPackageReadCount = uniqueStrings(
    snapshot.packageReadFailures.flatMap(failure => failure.packageFilePaths),
  ).length;
  const packageLoadOperationFailed = snapshot.packageReadFailures.some(
    failure => failure.packageFilePaths.length === 0,
  );
  if (failedPackageReadCount > 0) {
    rows.push({
      label: vscode.l10n.t('Package read incomplete'),
      description: formatFailedPackageFileCount(failedPackageReadCount),
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    });
  }
  if (packageLoadOperationFailed) {
    rows.push({
      label: vscode.l10n.t('Workspace package loading failed'),
      description: '',
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    });
  }
  else if (
    failedPackageReadCount === 0
    && snapshot.workspaceCapabilities.hasPackageFiles
    && !snapshot.workspaceCapabilities.hasDependencyEntries
    && !snapshot.packageReadFailed
  ) {
    rows.push({
      label: vscode.l10n.t('No dependencies to manage'),
      description: vscode.l10n.t('This package.json has no dependencies yet.'),
      icon: 'info',
      actionable: false,
    });
  }
  return rows;
}

function projectUpdateRows(snapshot: ViewProjectionSnapshot): StatusRowProjection[] {
  if (snapshot.checkState === 'running') {
    return [{ label: vscode.l10n.t('Checking updates…'), description: '', icon: 'loading~spin', actionable: false }];
  }
  if (snapshot.checkState === 'done' && snapshot.lastCheckTime !== undefined) {
    return [{
      label: vscode.l10n.t('Last update check'),
      description: snapshot.lastCheckTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      icon: 'clock',
      actionable: false,
    }];
  }
  if (snapshot.checkState === 'incomplete') {
    return [{
      label: vscode.l10n.t('Update check incomplete'),
      description: formatFailedPackageRootCount(uniqueStrings(snapshot.failedUpdatePaths).length),
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    }];
  }
  return [];
}

function projectAuditRows(snapshot: ViewProjectionSnapshot): StatusRowProjection[] {
  const vulnerableRows = snapshot.entries.filter(entry => entry.item.vulnerabilitySeverity !== undefined).length;
  if (snapshot.auditState === 'running') {
    return [{ label: vscode.l10n.t('Running audit…'), description: '', icon: 'loading~spin', actionable: false }];
  }
  if (snapshot.auditState === 'done') {
    const count = snapshot.lastAuditCount ?? 0;
    return [{
      label: vscode.l10n.t('Audit complete'),
      description: count === 0
        ? vscode.l10n.t('No vulnerabilities')
        : formatAuditVulnerableCount(count, vulnerableRows),
      icon: count === 0 ? 'shield-check' : 'warning',
      color: count === 0 ? 'charts.green' : 'charts.red',
      actionable: false,
      command: getAuditRowCommand(snapshot, vulnerableRows, count),
    }];
  }
  if (snapshot.auditState === 'incomplete') {
    return [createIncompleteAuditRow(snapshot, vulnerableRows)];
  }
  if (snapshot.auditState === 'failed') {
    return [{
      label: vscode.l10n.t('Audit failed'),
      description: vscode.l10n.t('No audit results available'),
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    }];
  }
  return [];
}

function createIncompleteAuditRow(
  snapshot: ViewProjectionSnapshot,
  vulnerableRows: number,
): StatusRowProjection {
  const count = snapshot.lastAuditCount ?? 0;
  const resultDescription = snapshot.lastAuditSuccessfulRootCount === 0
    ? vscode.l10n.t('No successful audit results')
    : vscode.l10n.t(
        '{0} from successful audit roots',
        formatAuditVulnerableCount(count, vulnerableRows),
      );
  return {
    label: vscode.l10n.t('Audit incomplete'),
    description: vscode.l10n.t(
      '{0}; {1}',
      resultDescription,
      formatFailedPackageRootCount(uniqueStrings(snapshot.failedAuditPaths).length),
    ),
    icon: 'warning',
    color: 'charts.yellow',
    actionable: vulnerableRows === 0,
    command: getAuditRowCommand(snapshot, vulnerableRows, count),
  };
}

function getAuditRowCommand(
  snapshot: ViewProjectionSnapshot,
  vulnerableRows: number,
  count: number,
): StatusRowProjection['command'] {
  if (vulnerableRows > 0) {
    return snapshot.filterType === 'vulnerable'
      ? { command: COMMAND_IDS.openAuditReport, title: vscode.l10n.t('Open security audit report') }
      : { command: COMMAND_IDS.showVulnerablePackages, title: vscode.l10n.t('Show vulnerable packages') };
  }
  if (snapshot.auditState === 'done' && count > 0) {
    return { command: COMMAND_IDS.openAuditReport, title: vscode.l10n.t('Open security audit report') };
  }
  return undefined;
}

function formatAuditVulnerableCount(count: number, vulnerableRows: number): string {
  const description = formatVulnerablePackageCount(count);
  return count > vulnerableRows && vulnerableRows > 0
    ? vscode.l10n.t('{0}, {1} in the list', description, vulnerableRows)
    : description;
}

function projectFilterSearchRows(
  snapshot: ViewProjectionSnapshot,
  packageTree: PackageTreeProjection | undefined,
): StatusRowProjection[] {
  const showFilterRow = snapshot.filterType !== 'all' || snapshot.workspaceCapabilities.canFilterPackages;
  const showSearchRow = snapshot.search !== '' || snapshot.workspaceCapabilities.canSearchPackages;
  if (!showFilterRow && !showSearchRow) {
    return [];
  }
  const projection = packageTree ?? projectPackageTree(snapshot.entries, snapshot.filterType, snapshot.search);
  const rows: StatusRowProjection[] = [];
  if (showFilterRow) {
    rows.push({
      label: vscode.l10n.t('Filter: {0}', getFilterLabel(snapshot.filterType)),
      description: snapshot.filterType === 'all'
        ? formatPackageCount(projection.filterCounts.all)
        : formatFilteredPackageCount(projection.filterCounts[snapshot.filterType], projection.filterCounts.all),
      icon: 'filter',
      actionable: false,
      command: { command: COMMAND_IDS.showFilterPicker, title: vscode.l10n.t('Change filter') },
    });
  }
  if (showSearchRow && snapshot.search === '') {
    rows.push({
      label: vscode.l10n.t('Search packages'),
      description: '',
      icon: 'search',
      actionable: false,
      command: { command: COMMAND_IDS.searchPackages, title: vscode.l10n.t('Search by name') },
    });
  }
  else if (showSearchRow) {
    rows.push({
      label: vscode.l10n.t('Search: "{0}"', truncateSearchQuery(sanitizePackageText(snapshot.search))),
      description: formatPackageCount(projection.filterCounts.all),
      icon: 'search',
      actionable: false,
      command: { command: COMMAND_IDS.searchPackages, title: vscode.l10n.t('Edit search') },
      contextValue: CONTEXT_VALUE_TOKENS.statusSearchActive,
    });
  }
  return rows;
}