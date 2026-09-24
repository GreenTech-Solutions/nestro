import { describe, expect, it } from 'vitest';
import {
  computeViewProjection,
  createAllFalseViewContexts,
  diffViewContexts,
  PackageItem,
  resolvePublishedWorkspaceCapabilities,
  VIEW_CONTEXT_KEYS,
} from '../providers';
import type {
  PackageTreeEntry,
  ViewContextMap,
  ViewProjectionSnapshot,
  WorkspaceCapabilities,
} from '../providers';
import type { UpdateType } from '../utils';

const EMPTY_CAPABILITIES: WorkspaceCapabilities = {
  hasPackageFiles: false,
  hasReadablePackageFiles: false,
  hasDependencyEntries: false,
  hasAuditableProjects: false,
  canRunInstall: false,
  canRunAudit: false,
  canSearchPackages: false,
  canFilterPackages: false,
  canPinAllVersions: false,
};

const FULL_CAPABILITIES: WorkspaceCapabilities = {
  hasPackageFiles: true,
  hasReadablePackageFiles: true,
  hasDependencyEntries: true,
  hasAuditableProjects: true,
  canRunInstall: true,
  canRunAudit: true,
  canSearchPackages: true,
  canFilterPackages: true,
  canPinAllVersions: true,
};

function createEntry(
  packageName: string,
  updateType: UpdateType = 'none',
  overrides: { readonly dev?: boolean; readonly packageFilePath?: string; readonly latest?: string } = {},
): PackageTreeEntry {
  const packageFilePath = overrides.packageFilePath ?? '/workspace/package.json';
  const dev = overrides.dev ?? false;
  const latest = updateType === 'none' ? undefined : overrides.latest ?? '2.0.0';
  return {
    item: new PackageItem(packageName, '1.0.0', latest, updateType, undefined, undefined, packageFilePath, dev),
    dev,
    packageFilePath,
  };
}

function baseSnapshot(overrides: Partial<ViewProjectionSnapshot> = {}): ViewProjectionSnapshot {
  return {
    entries: [],
    filterType: 'all',
    search: '',
    loading: false,
    workspaceCapabilities: EMPTY_CAPABILITIES,
    capabilitiesInitialized: true,
    packageReadFailed: false,
    packageReadFailures: [],
    checkState: 'idle',
    lastCheckTime: undefined,
    failedUpdatePaths: [],
    auditState: 'idle',
    lastAuditCount: undefined,
    lastAuditSuccessfulRootCount: undefined,
    failedAuditPaths: [],
    ...overrides,
  };
}

describe('computeViewProjection', () => {
  describe('badge', () => {
    it('is undefined when no entries have an actionable update', () => {
      const projection = computeViewProjection(baseSnapshot({ entries: [createEntry('react')] }));
      expect(projection.badge).toBeUndefined();
    });

    it('counts outdated entries across the whole workspace, ignoring the active filter and search', () => {
      const entries = [createEntry('react', 'breaking'), createEntry('vue', 'patch'), createEntry('lodash')];
      const projection = computeViewProjection(baseSnapshot({
        entries,
        filterType: 'patch',
        search: 'react',
      }));
      expect(projection.badge).toEqual({ value: 2, tooltip: '2 package updates available' });
    });

    it('uses singular phrasing for exactly one outdated package', () => {
      const projection = computeViewProjection(baseSnapshot({ entries: [createEntry('react', 'minor')] }));
      expect(projection.badge).toEqual({ value: 1, tooltip: '1 package update available' });
    });
  });

  describe('description', () => {
    const counted = [createEntry('react', 'minor'), createEntry('vue')];

    it('is undefined for the default all-filter, no-search state', () => {
      const projection = computeViewProjection(baseSnapshot({ entries: counted }));
      expect(projection.description).toBeUndefined();
    });

    it('shows the filter label and its count when a filter is active', () => {
      const projection = computeViewProjection(baseSnapshot({ entries: counted, filterType: 'hasUpdates' }));
      expect(projection.description).toBe('Has Updates (1)');
    });

    it('shows the quoted search term when a search is active', () => {
      const projection = computeViewProjection(baseSnapshot({ entries: counted, search: 'react' }));
      expect(projection.description).toBe('"react"');
    });

    it('combines filter and search segments', () => {
      const projection = computeViewProjection(baseSnapshot({ entries: counted, filterType: 'hasUpdates', search: 'react' }));
      expect(projection.description).toBe('Has Updates (1) · "react"');
    });

    it('counts only the search-matched entries in the filter segment', () => {
      const entries = [createEntry('react', 'minor'), createEntry('vue', 'patch')];
      const projection = computeViewProjection(baseSnapshot({ entries, filterType: 'hasUpdates', search: 'react' }));
      expect(projection.description).toBe('Has Updates (1) · "react"');
    });
  });

  describe('packageTree', () => {
    it('respects the active filter and search for visibleOutdatedEntries and getVisibleOutdatedPackages-style reads', () => {
      const entries = [createEntry('react', 'breaking'), createEntry('vue', 'patch')];
      const projection = computeViewProjection(baseSnapshot({ entries, filterType: 'patch' }));
      expect(projection.packageTree.visibleOutdatedEntries.map(entry => entry.item.packageName)).toEqual(['vue']);
    });

    it('computes filterCounts from the search-matched entries independent of the active filterType', () => {
      const entries = [createEntry('react', 'breaking'), createEntry('vue', 'patch'), createEntry('lodash')];
      const viaAll = computeViewProjection(baseSnapshot({ entries, filterType: 'all' }));
      const viaBreaking = computeViewProjection(baseSnapshot({ entries, filterType: 'breaking' }));
      expect(viaBreaking.packageTree.filterCounts).toEqual(viaAll.packageTree.filterCounts);
      expect(viaAll.packageTree.filterCounts).toEqual({ all: 3, hasUpdates: 2, patch: 1, minor: 0, breaking: 1 });
    });
  });

  describe('contexts', () => {
    it('sets canUpdateVisiblePackages from the filtered/searched projection when not loading', () => {
      const entries = [createEntry('react', 'breaking')];
      const visible = computeViewProjection(baseSnapshot({ entries }));
      expect(visible.contexts.canUpdateVisiblePackages).toBe(true);

      const filteredOut = computeViewProjection(baseSnapshot({ entries, filterType: 'patch' }));
      expect(filteredOut.contexts.canUpdateVisiblePackages).toBe(false);
    });

    it('forces canUpdateVisiblePackages to false while loading, regardless of stale entries', () => {
      const entries = [createEntry('react', 'breaking')];
      const projection = computeViewProjection(baseSnapshot({ entries, loading: true }));
      expect(projection.contexts.canUpdateVisiblePackages).toBe(false);
    });

    it('sets noWorkspace only when settled, with no package files, and no read failure', () => {
      expect(computeViewProjection(baseSnapshot({
        workspaceCapabilities: EMPTY_CAPABILITIES,
      })).contexts.noWorkspace).toBe(true);

      expect(computeViewProjection(baseSnapshot({
        loading: true,
        workspaceCapabilities: EMPTY_CAPABILITIES,
      })).contexts.noWorkspace).toBe(false);

      expect(computeViewProjection(baseSnapshot({
        workspaceCapabilities: { ...EMPTY_CAPABILITIES, hasPackageFiles: true },
      })).contexts.noWorkspace).toBe(false);

      expect(computeViewProjection(baseSnapshot({
        workspaceCapabilities: EMPTY_CAPABILITIES,
        packageReadFailed: true,
      })).contexts.noWorkspace).toBe(false);
    });

    it('reflects hasSearchQuery from the active search string', () => {
      expect(computeViewProjection(baseSnapshot({ search: '' })).contexts.hasSearchQuery).toBe(false);
      expect(computeViewProjection(baseSnapshot({ search: 'react' })).contexts.hasSearchQuery).toBe(true);
    });

    it('publishes raw capability values once capabilities are initialized', () => {
      const projection = computeViewProjection(baseSnapshot({
        workspaceCapabilities: { ...FULL_CAPABILITIES, canRunAudit: false },
        capabilitiesInitialized: true,
      }));
      expect(projection.contexts.hasPackageFiles).toBe(true);
      expect(projection.contexts.canRunAudit).toBe(false);
      expect(projection.contexts.canRunInstall).toBe(true);
    });

    it('publishes permissive can* contexts before capabilities are ever known', () => {
      const projection = computeViewProjection(baseSnapshot({
        workspaceCapabilities: EMPTY_CAPABILITIES,
        capabilitiesInitialized: false,
      }));
      expect(projection.contexts.canRunInstall).toBe(true);
      expect(projection.contexts.canRunAudit).toBe(true);
      expect(projection.contexts.canSearchPackages).toBe(true);
      expect(projection.contexts.canFilterPackages).toBe(true);
      expect(projection.contexts.canPinAllVersions).toBe(true);
      // Discovery-derived flags are never guessed permissively, only the can* actions are.
      expect(projection.contexts.hasPackageFiles).toBe(false);
      expect(projection.contexts.hasAuditableProjects).toBe(false);
    });
  });

  describe('statusRows', () => {
    it('is empty for a quiet, settled, empty workspace', () => {
      expect(computeViewProjection(baseSnapshot()).statusRows).toEqual([]);
    });

    it('reports a failed package read with the failed-file count', () => {
      const projection = computeViewProjection(baseSnapshot({
        packageReadFailures: [{ packageFilePaths: ['/workspace/a/package.json'], reason: 'package-read-failed' }],
      }));
      expect(projection.statusRows).toEqual([{
        label: 'Package read incomplete',
        description: '1 package file failed to load',
        icon: 'warning',
        color: 'charts.yellow',
        actionable: true,
      }]);
    });

    it('reports package discovery failure instead of the read-failure row when both could apply', () => {
      const projection = computeViewProjection(baseSnapshot({
        packageReadFailures: [{ packageFilePaths: [], reason: 'package-discovery-failed' }],
      }));
      expect(projection.statusRows).toEqual([{
        label: 'Workspace package loading failed',
        description: '',
        icon: 'warning',
        color: 'charts.yellow',
        actionable: true,
      }]);
    });

    it('reports an empty-dependencies row only for a readable manifest with zero dependencies', () => {
      const projection = computeViewProjection(baseSnapshot({
        workspaceCapabilities: { ...EMPTY_CAPABILITIES, hasPackageFiles: true, hasDependencyEntries: false },
      }));
      expect(projection.statusRows).toEqual([{
        label: 'No dependencies to manage',
        description: 'This package.json has no dependencies yet.',
        icon: 'info',
        actionable: false,
      }]);
    });

    it('reports the running check state', () => {
      const projection = computeViewProjection(baseSnapshot({ checkState: 'running' }));
      expect(projection.statusRows).toEqual([{
        label: 'Checking updates…',
        description: '',
        icon: 'loading~spin',
        actionable: false,
      }]);
    });

    it('reports the last successful check time once done', () => {
      const projection = computeViewProjection(baseSnapshot({
        checkState: 'done',
        lastCheckTime: new Date('2026-05-27T08:45:00.000Z'),
      }));
      expect(projection.statusRows).toEqual([{
        label: 'Last update check',
        description: new Date('2026-05-27T08:45:00.000Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        icon: 'clock',
        actionable: false,
      }]);
    });

    it('reports an incomplete check with the failed-root count', () => {
      const projection = computeViewProjection(baseSnapshot({
        checkState: 'incomplete',
        failedUpdatePaths: ['/workspace/a/package.json', '/workspace/b/package.json'],
      }));
      expect(projection.statusRows).toEqual([{
        label: 'Update check incomplete',
        description: '2 package roots failed',
        icon: 'warning',
        color: 'charts.yellow',
        actionable: true,
      }]);
    });

    it('reports a clean audit as a green shield, and a vulnerable one as a red warning', () => {
      const clean = computeViewProjection(baseSnapshot({ auditState: 'done', lastAuditCount: 0 }));
      expect(clean.statusRows).toEqual([{
        label: 'Audit complete',
        description: 'No vulnerabilities',
        icon: 'shield-check',
        color: 'charts.green',
        actionable: false,
      }]);

      const vulnerable = computeViewProjection(baseSnapshot({ auditState: 'done', lastAuditCount: 3 }));
      expect(vulnerable.statusRows).toEqual([{
        label: 'Audit complete',
        description: '3 vulnerable packages',
        icon: 'warning',
        color: 'charts.red',
        actionable: false,
      }]);
    });

    it('reports an incomplete audit, distinguishing zero successful roots from partial success', () => {
      const zeroRoots = computeViewProjection(baseSnapshot({
        auditState: 'incomplete',
        lastAuditCount: 0,
        lastAuditSuccessfulRootCount: 0,
        failedAuditPaths: ['/workspace/a/package.json'],
      }));
      expect(zeroRoots.statusRows).toEqual([{
        label: 'Audit incomplete',
        description: 'No successful audit results; 1 package root failed',
        icon: 'warning',
        color: 'charts.yellow',
        actionable: true,
      }]);

      const partial = computeViewProjection(baseSnapshot({
        auditState: 'incomplete',
        lastAuditCount: 2,
        lastAuditSuccessfulRootCount: 1,
        failedAuditPaths: ['/workspace/a/package.json'],
      }));
      expect(partial.statusRows).toEqual([{
        label: 'Audit incomplete',
        description: '2 vulnerable packages from successful audit roots; 1 package root failed',
        icon: 'warning',
        color: 'charts.yellow',
        actionable: true,
      }]);
    });

    it('reports a failed audit run', () => {
      const projection = computeViewProjection(baseSnapshot({ auditState: 'failed' }));
      expect(projection.statusRows).toEqual([{
        label: 'Audit failed',
        description: 'No audit results available',
        icon: 'warning',
        color: 'charts.yellow',
        actionable: true,
      }]);
    });

    it('orders package-read, check, and audit rows stably when several are active at once', () => {
      const projection = computeViewProjection(baseSnapshot({
        packageReadFailures: [{ packageFilePaths: ['/workspace/a/package.json'], reason: 'package-read-failed' }],
        checkState: 'incomplete',
        failedUpdatePaths: ['/workspace/a/package.json'],
        auditState: 'incomplete',
        lastAuditCount: 1,
        lastAuditSuccessfulRootCount: 0,
        failedAuditPaths: ['/workspace/a/package.json'],
      }));
      expect(projection.statusRows.map(row => row.label)).toEqual([
        'Package read incomplete',
        'Update check incomplete',
        'Audit incomplete',
      ]);
    });
  });

  describe('projection identity', () => {
    it('returns a deep-equal projection for the same snapshot values', () => {
      const snapshot = baseSnapshot({
        entries: [createEntry('react', 'minor')],
        filterType: 'hasUpdates',
        search: 'rea',
        checkState: 'done',
        lastCheckTime: new Date('2026-05-27T08:45:00.000Z'),
        auditState: 'done',
        lastAuditCount: 0,
      });
      expect(computeViewProjection(snapshot)).toEqual(computeViewProjection(snapshot));
    });
  });
});

describe('resolvePublishedWorkspaceCapabilities', () => {
  it('returns the raw capabilities once capabilitiesInitialized is true', () => {
    const capabilities: WorkspaceCapabilities = { ...EMPTY_CAPABILITIES, hasPackageFiles: true };
    expect(resolvePublishedWorkspaceCapabilities(capabilities, true)).toEqual(capabilities);
  });

  it('forces only the can* actions permissive before capabilities are ever known', () => {
    const published = resolvePublishedWorkspaceCapabilities(EMPTY_CAPABILITIES, false);
    expect(published).toEqual({
      ...EMPTY_CAPABILITIES,
      canRunInstall: true,
      canRunAudit: true,
      canSearchPackages: true,
      canFilterPackages: true,
      canPinAllVersions: true,
    });
  });
});

describe('diffViewContexts', () => {
  const allTrue = Object.fromEntries(
    Object.keys(VIEW_CONTEXT_KEYS).map(key => [key, true]),
  ) as unknown as ViewContextMap;

  it('returns the full map when there is no previous publication', () => {
    expect(diffViewContexts(undefined, allTrue)).toEqual(allTrue);
  });

  it('returns an empty diff when nothing changed', () => {
    expect(diffViewContexts(allTrue, allTrue)).toEqual({});
  });

  it('returns exactly the one key that flipped', () => {
    const next: ViewContextMap = { ...allTrue, hasSearchQuery: false };
    expect(diffViewContexts(allTrue, next)).toEqual({ hasSearchQuery: false });
  });

  it('returns exactly the keys that changed when several flip at once', () => {
    const next: ViewContextMap = { ...allTrue, hasSearchQuery: false, noWorkspace: false };
    expect(diffViewContexts(allTrue, next)).toEqual({ hasSearchQuery: false, noWorkspace: false });
  });
});

describe('createAllFalseViewContexts', () => {
  it('sets every declared context key to false', () => {
    const allFalse = createAllFalseViewContexts();
    const keys = Object.keys(VIEW_CONTEXT_KEYS) as (keyof typeof VIEW_CONTEXT_KEYS)[];
    expect(keys).toHaveLength(12);
    for (const key of keys) {
      expect(allFalse[key]).toBe(false);
    }
  });
});

describe('VIEW_CONTEXT_KEYS', () => {
  it('maps every context key to its nestro.* setContext name', () => {
    expect(VIEW_CONTEXT_KEYS).toEqual({
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
    });
  });
});