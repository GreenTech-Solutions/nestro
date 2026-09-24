import * as vscode from 'vscode';
import { formatViewDescription, projectPackageTree } from './treeBuilder';
import type { PackageTreeEntry, PackageTreeProjection } from './treeBuilder';
import type { FilterType } from './FilterManager';
import type { WorkspaceCapabilities } from './PackagesProvider';
import {
  formatFailedPackageFileCount,
  formatFailedPackageRootCount,
  formatPackageUpdatesAvailable,
  formatVulnerablePackageCount,
} from '../utils';
import type { StatusReportFailure } from '../utils';

export type CheckState = 'idle' | 'running' | 'done' | 'incomplete';
export type AuditState = 'idle' | 'running' | 'done' | 'incomplete' | 'failed';

/** Plain-data snapshot of every provider field the view projection reads; owns no VS Code state. */
export interface ViewProjectionSnapshot {
  readonly entries: readonly PackageTreeEntry[];
  readonly filterType: FilterType;
  readonly search: string;
  readonly loading: boolean;
  readonly workspaceCapabilities: WorkspaceCapabilities;
  readonly capabilitiesInitialized: boolean;
  readonly packageReadFailed: boolean;
  readonly packageReadFailures: readonly StatusReportFailure[];
  readonly checkState: CheckState;
  readonly lastCheckTime: Date | undefined;
  readonly failedUpdatePaths: readonly string[];
  readonly auditState: AuditState;
  readonly lastAuditCount: number | undefined;
  readonly lastAuditSuccessfulRootCount: number | undefined;
  readonly failedAuditPaths: readonly string[];
}

/** Plain data for one status row; the provider converts it to a `StatusItem`. */
export interface StatusRowProjection {
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly color?: string;
  readonly actionable: boolean;
}

export const VIEW_CONTEXT_KEYS = {
  canUpdateVisiblePackages: 'nestro.canUpdateVisiblePackages',
  hasPackageFiles: 'nestro.hasPackageFiles',
  hasReadablePackageFiles: 'nestro.hasReadablePackageFiles',
  hasDependencyEntries: 'nestro.hasDependencyEntries',
  hasAuditableProjects: 'nestro.hasAuditableProjects',
  canRunInstall: 'nestro.canRunInstall',
  canRunAudit: 'nestro.canRunAudit',
  canSearchPackages: 'nestro.canSearchPackages',
  canFilterPackages: 'nestro.canFilterPackages',
  canPinAllVersions: 'nestro.canPinAllVersions',
  noWorkspace: 'nestro.noWorkspace',
  hasSearchQuery: 'nestro.hasSearchQuery',
} as const;

export type ViewContextKey = keyof typeof VIEW_CONTEXT_KEYS;
export type ViewContextMap = Readonly<Record<ViewContextKey, boolean>>;

export interface ViewBadge {
  readonly value: number;
  readonly tooltip: string;
}

/** One computed pass over provider state: contexts, badge, description, status rows, and the filtered tree. */
export interface ViewProjection {
  readonly contexts: ViewContextMap;
  readonly badge: ViewBadge | undefined;
  readonly description: string | undefined;
  readonly statusRows: readonly StatusRowProjection[];
  readonly packageTree: PackageTreeProjection;
}

/**
 * Global actions (`can*`) publish as executable before the first load ever settles, since
 * "not yet known" is not the same as "known impossible". `dispose()` bypasses this by
 * publishing every context as `false` directly, so teardown still reports capabilities as gone.
 */
export function resolvePublishedWorkspaceCapabilities(
  capabilities: WorkspaceCapabilities,
  capabilitiesInitialized: boolean,
): WorkspaceCapabilities {
  if (capabilitiesInitialized) {
    return capabilities;
  }
  return {
    ...capabilities,
    canRunInstall: true,
    canRunAudit: true,
    canSearchPackages: true,
    canFilterPackages: true,
    canPinAllVersions: true,
  };
}

/** Computes the full view for the current state in one pass: two `projectPackageTree()` calls, no more. */
export function computeViewProjection(snapshot: ViewProjectionSnapshot): ViewProjection {
  const allEntriesProjection = projectPackageTree(snapshot.entries, 'all');
  const packageTree = projectPackageTree(snapshot.entries, snapshot.filterType, snapshot.search);

  const outdatedCount = allEntriesProjection.visibleOutdatedEntries.length;
  const badge: ViewBadge | undefined = outdatedCount > 0
    ? { value: outdatedCount, tooltip: formatPackageUpdatesAvailable(outdatedCount) }
    : undefined;
  const description = formatViewDescription(snapshot.filterType, snapshot.search, packageTree.filterCounts);

  const published = resolvePublishedWorkspaceCapabilities(snapshot.workspaceCapabilities, snapshot.capabilitiesInitialized);
  const contexts: ViewContextMap = {
    canUpdateVisiblePackages: !snapshot.loading && packageTree.canUpdateVisiblePackages,
    hasPackageFiles: published.hasPackageFiles,
    hasReadablePackageFiles: published.hasReadablePackageFiles,
    hasDependencyEntries: published.hasDependencyEntries,
    hasAuditableProjects: published.hasAuditableProjects,
    canRunInstall: published.canRunInstall,
    canRunAudit: published.canRunAudit,
    canSearchPackages: published.canSearchPackages,
    canFilterPackages: published.canFilterPackages,
    canPinAllVersions: published.canPinAllVersions,
    noWorkspace: !snapshot.loading && !snapshot.workspaceCapabilities.hasPackageFiles && !snapshot.packageReadFailed,
    hasSearchQuery: snapshot.search !== '',
  };

  return {
    contexts,
    badge,
    description,
    statusRows: projectStatusRows(snapshot),
    packageTree,
  };
}

/** Returns only the keys whose value changed; a `previous` of `undefined` returns the full map (first publication). */
export function diffViewContexts(
  previous: ViewContextMap | undefined,
  next: ViewContextMap,
): Partial<ViewContextMap> {
  if (previous === undefined) {
    return { ...next };
  }
  const changed: Partial<Record<ViewContextKey, boolean>> = {};
  for (const key of Object.keys(VIEW_CONTEXT_KEYS) as ViewContextKey[]) {
    if (previous[key] !== next[key]) {
      changed[key] = next[key];
    }
  }
  return changed;
}

/** Every context key forced to `false`, for the unconditional reset `dispose()` publishes. */
export function createAllFalseViewContexts(): ViewContextMap {
  const entries = (Object.keys(VIEW_CONTEXT_KEYS) as ViewContextKey[]).map(key => [key, false] as const);
  return Object.fromEntries(entries) as ViewContextMap;
}

/** Status rows for the current state, cheap enough to recompute on every tree read. */
export function projectStatusRows(snapshot: ViewProjectionSnapshot): StatusRowProjection[] {
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
  // A readable package.json with zero dependencies is a real project, not an empty
  // workspace — without this row the panel would show nothing at all in that state.
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

  if (snapshot.checkState === 'running') {
    rows.push({ label: vscode.l10n.t('Checking updates…'), description: '', icon: 'loading~spin', actionable: false });
  }
  else if (snapshot.checkState === 'done' && snapshot.lastCheckTime !== undefined) {
    rows.push({
      label: vscode.l10n.t('Last update check'),
      description: snapshot.lastCheckTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      icon: 'clock',
      actionable: false,
    });
  }
  else if (snapshot.checkState === 'incomplete') {
    rows.push({
      label: vscode.l10n.t('Update check incomplete'),
      description: formatFailedPackageRootCount(uniqueStrings(snapshot.failedUpdatePaths).length),
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    });
  }

  if (snapshot.auditState === 'running') {
    rows.push({ label: vscode.l10n.t('Running audit…'), description: '', icon: 'loading~spin', actionable: false });
  }
  else if (snapshot.auditState === 'done') {
    const count = snapshot.lastAuditCount ?? 0;
    rows.push({
      label: vscode.l10n.t('Audit complete'),
      description: count === 0 ? vscode.l10n.t('No vulnerabilities') : formatVulnerablePackageCount(count),
      icon: count === 0 ? 'shield-check' : 'warning',
      color: count === 0 ? 'charts.green' : 'charts.red',
      actionable: false,
    });
  }
  else if (snapshot.auditState === 'incomplete') {
    const count = snapshot.lastAuditCount ?? 0;
    const resultDescription = snapshot.lastAuditSuccessfulRootCount === 0
      ? vscode.l10n.t('No successful audit results')
      : vscode.l10n.t('{0} from successful audit roots', formatVulnerablePackageCount(count));
    rows.push({
      label: vscode.l10n.t('Audit incomplete'),
      description: vscode.l10n.t(
        '{0}; {1}',
        resultDescription,
        formatFailedPackageRootCount(uniqueStrings(snapshot.failedAuditPaths).length),
      ),
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    });
  }
  else if (snapshot.auditState === 'failed') {
    rows.push({
      label: vscode.l10n.t('Audit failed'),
      description: vscode.l10n.t('No audit results available'),
      icon: 'warning',
      color: 'charts.yellow',
      actionable: true,
    });
  }

  return rows;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}