import * as vscode from 'vscode';
import { getFilterLabel } from './FilterManager';
import type { StatusRowProjection, ViewProjectionSnapshot } from './viewProjectionService';
import { projectPackageTree, truncateSearchQuery } from './treeBuilder';
import type { PackageTreeProjection } from './treeBuilder';
import { sanitizePackageText } from './packageItemPresentation';
import { COMMAND_IDS, uniqueStrings } from '../shared';
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
  if (snapshot.auditState === 'running') {
    return [{ label: vscode.l10n.t('Running audit…'), description: '', icon: 'loading~spin', actionable: false }];
  }
  if (snapshot.auditState === 'done') {
    const count = snapshot.lastAuditCount ?? 0;
    return [{
      label: vscode.l10n.t('Audit complete'),
      description: count === 0 ? vscode.l10n.t('No vulnerabilities') : formatVulnerablePackageCount(count),
      icon: count === 0 ? 'shield-check' : 'warning',
      color: count === 0 ? 'charts.green' : 'charts.red',
      actionable: false,
    }];
  }
  if (snapshot.auditState === 'incomplete') {
    return [createIncompleteAuditRow(snapshot)];
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

function createIncompleteAuditRow(snapshot: ViewProjectionSnapshot): StatusRowProjection {
  const count = snapshot.lastAuditCount ?? 0;
  const resultDescription = snapshot.lastAuditSuccessfulRootCount === 0
    ? vscode.l10n.t('No successful audit results')
    : vscode.l10n.t('{0} from successful audit roots', formatVulnerablePackageCount(count));
  return {
    label: vscode.l10n.t('Audit incomplete'),
    description: vscode.l10n.t(
      '{0}; {1}',
      resultDescription,
      formatFailedPackageRootCount(uniqueStrings(snapshot.failedAuditPaths).length),
    ),
    icon: 'warning',
    color: 'charts.yellow',
    actionable: true,
  };
}

function projectFilterSearchRows(
  snapshot: ViewProjectionSnapshot,
  packageTree: PackageTreeProjection | undefined,
): StatusRowProjection[] {
  if (snapshot.filterType === 'all' && snapshot.search === '') {
    return [];
  }
  const projection = packageTree ?? projectPackageTree(snapshot.entries, snapshot.filterType, snapshot.search);
  const rows: StatusRowProjection[] = [];
  if (snapshot.filterType !== 'all') {
    rows.push({
      label: vscode.l10n.t('Filter: {0}', getFilterLabel(snapshot.filterType)),
      description: formatFilteredPackageCount(
        projection.filterCounts[snapshot.filterType],
        projection.filterCounts.all,
      ),
      icon: 'filter',
      actionable: false,
      command: { command: COMMAND_IDS.showFilterPicker, title: vscode.l10n.t('Change filter') },
    });
  }
  if (snapshot.search !== '') {
    rows.push({
      label: vscode.l10n.t('Search: "{0}"', truncateSearchQuery(sanitizePackageText(snapshot.search))),
      description: formatPackageCount(projection.filterCounts.all),
      icon: 'search',
      actionable: false,
      command: { command: COMMAND_IDS.searchPackages, title: vscode.l10n.t('Edit search') },
    });
  }
  return rows;
}