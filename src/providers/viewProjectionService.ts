import { formatViewDescription, projectPackageTree } from './treeBuilder';
import type { PackageTreeEntry, PackageTreeProjection } from './treeBuilder';
import type { PackageFilter } from './FilterManager';
import type { WorkspaceCapabilities } from './PackagesProvider';
import { projectStatusRows } from './statusRowProjection';
import { formatPackageUpdatesAvailable } from '../utils';
import type { StatusReportFailure } from '../utils';
import { CONTEXT_KEYS } from '../shared';

export { projectStatusRows } from './statusRowProjection';

export type CheckState = 'idle' | 'running' | 'done' | 'incomplete';
export type AuditState = 'idle' | 'running' | 'done' | 'incomplete' | 'failed';

/** Plain-data snapshot of every provider field the view projection reads; owns no VS Code state. */
export interface ViewProjectionSnapshot {
  readonly entries: readonly PackageTreeEntry[];
  readonly filterType: PackageFilter;
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

/** A row's click target when it opens something other than the diagnostics report. */
export interface StatusRowCommand {
  readonly command: string;
  readonly title: string;
}

/** Plain data for one status row; the provider converts it to a `StatusItem`. */
export interface StatusRowProjection {
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly color?: string;
  readonly actionable: boolean;
  readonly command?: StatusRowCommand;
  readonly contextValue?: string;
}

export const VIEW_CONTEXT_KEYS = CONTEXT_KEYS;

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

/**
 * Computes the full view for the current state in one pass: two `projectPackageTree()` calls,
 * no more — the second is the same filtered projection `projectStatusRows()` reuses below.
 */
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
    statusRows: projectStatusRows(snapshot, packageTree),
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