import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures/workspaceFolders';
import { buildPackageItem } from './fixtures/packageItem';
import { FilterManager, PackagesProvider, resolvePackageFileLabels } from '../providers';
import { GroupItem } from '../providers/GroupItem';
import { PackageDetailItem } from '../providers/PackageDetailItem';
import { PackageItem } from '../providers/PackageItem';
import { StatusItem } from '../providers/StatusItem';
import { WorkspaceFolderItem } from '../providers/WorkspaceFolderItem';
import {
  fetchAllLatestVersions,
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
} from '../utils';
import { getLastContextValue, getPackageItems, resetPackagesProviderDefaults, setProviderState } from './fixtures/packagesProviderHarness';

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());

// Wraps the shared label builder so tests can assert it runs once per manifest-set change.
vi.mock('../providers/packageLabels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/packageLabels')>();
  return {
    ...actual,
    resolvePackageFileLabels: vi.fn(actual.resolvePackageFileLabels),
  };
});
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
  });
  it('starts with the configured initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.loadPackages();
    await provider.checkUpdates();

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[0].label).toBe('Last update check');
    expect(tree[1]).toBeInstanceOf(StatusItem);
    expect(tree[1].label).toBe('Filter: Has Updates');
    expect(tree[2]).toBeInstanceOf(StatusItem);
    expect(tree[2].label).toBe('Search packages');
    expect(tree[3]).toBeInstanceOf(GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('allows setFilter to override the initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.setFilter('all');

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[1]).toBeInstanceOf(StatusItem);
    expect(tree[1].label).toBe('Filter: All');
    expect(tree[2]).toBeInstanceOf(StatusItem);
    expect(tree[2].label).toBe('Search packages');
    expect(groups.flatMap(group => group.children.map(child => child.label))).toEqual(['react', 'eslint']);
  });

  it('filters visible packages by search query', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);

    await provider.loadPackages();
    await provider.checkUpdates();
    filterManager.setSearch('react');

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('updates visible-update context and badge consistently through search and busy transitions', async () => {
    const filterManager = new FilterManager('all');
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'vue',
        current: '3.4.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([
      ['react', '19.0.0'],
      ['vue', '3.5.0'],
    ]));
    const provider = new PackagesProvider(filterManager);
    const treeView = { badge: undefined, message: undefined } as unknown as vscode.TreeView<vscode.TreeItem>;
    provider.attachTreeView(treeView);

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    expect(treeView.badge).toEqual({ tooltip: '2 package updates available', value: 2 });

    const identities = provider.getPackageIdentitiesForFile('/workspace/package.json');
    const react = identities.find(identity => identity.packageName === 'react');
    const vue = identities.find(identity => identity.packageName === 'vue');
    if (react === undefined || vue === undefined) {
      throw new Error('expected both package identities');
    }

    provider.markPackageUpdating(react, { kind: 'remove' });
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    expect(treeView.badge).toEqual({ tooltip: '1 package update available', value: 1 });

    filterManager.setSearch('react');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);
    filterManager.setSearch('vue');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    filterManager.set('patch');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);

    filterManager.clearSearch();
    filterManager.set('all');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    provider.markPackageUpdating(vue, { kind: 'pin' });
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);
    expect(treeView.badge).toBeUndefined();

    provider.markPackageUpdating(react, undefined);
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    provider.markPackageUpdating(vue, undefined);
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    expect(treeView.badge).toEqual({ tooltip: '2 package updates available', value: 2 });

    provider.dispose();
  });

  it('reflects the active filter and search in treeView.description', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    const treeView = { badge: undefined, message: undefined, description: undefined } as unknown as vscode.TreeView<vscode.TreeItem>;
    provider.attachTreeView(treeView);

    await provider.loadPackages();
    await provider.checkUpdates();
    expect(treeView.description).toBeUndefined();

    filterManager.set('hasUpdates');
    expect(treeView.description).toBe('Has Updates (1)');

    filterManager.setSearch('react');
    expect(treeView.description).toBe('Has Updates (1) · "react"');

    filterManager.set('all');
    expect(treeView.description).toBe('"react"');

    filterManager.clearSearch();
    expect(treeView.description).toBeUndefined();

    provider.dispose();
  });

  it('shows Filter and Search status rows in the tree, each opening its own picker on click', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);

    await provider.loadPackages();
    await provider.checkUpdates();
    const defaultRows = provider.getChildren().filter((item): item is StatusItem => item instanceof StatusItem);
    expect(defaultRows.map(item => item.label)).toEqual(['Last update check', 'Filter: All', 'Search packages']);

    filterManager.set('hasUpdates');
    const filterRow = provider.getChildren().find(
      (item): item is StatusItem => item instanceof StatusItem && item.label === 'Filter: Has Updates',
    );
    expect(filterRow).toBeInstanceOf(StatusItem);
    expect(filterRow?.description).toBe('1 of 2');
    expect(filterRow?.command).toEqual({ command: 'nestro.showFilterPicker', title: 'Change filter' });

    filterManager.setSearch('react');
    const searchRow = provider.getChildren().find(
      (item): item is StatusItem => item instanceof StatusItem && item.label === 'Search: "react"',
    );
    expect(searchRow).toBeInstanceOf(StatusItem);
    expect(searchRow?.description).toBe('1 package');
    expect(searchRow?.command).toEqual({ command: 'nestro.searchPackages', title: 'Edit search' });
    expect(searchRow?.contextValue).toBe('status-search-active');

    filterManager.clearSearch();
    filterManager.set('all');
    expect(provider.getChildren().filter((item): item is StatusItem => item instanceof StatusItem)
      .map(item => item.label)).toEqual(['Last update check', 'Filter: All', 'Search packages']);

    provider.dispose();
  });

  it('clears the vulnerable filter when a new audit starts', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    await provider.loadPackages();
    setProviderState(provider, {
      allEntries: [{
        item: buildPackageItem({
          name: 'react',
          currentVersion: '18.0.0',
          vulnerabilitySeverity: 'high',
          packageFilePath: '/workspace/package.json',
        }),
        dev: false,
        packageFilePath: '/workspace/package.json',
      }],
      auditState: 'done',
      lastAuditCount: 1,
    });

    filterManager.showVulnerable();
    expect(filterManager.current).toBe('vulnerable');

    const audit = provider.runAudit();
    expect(filterManager.current).toBe('all');
    await audit;
    provider.dispose();
  });

  it('publishes nestro.hasSearchQuery only while a search query is active, and resets it on dispose', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);

    filterManager.setSearch('react');
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(true);

    filterManager.clearSearch();
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);

    filterManager.setSearch('vue');
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(true);

    provider.dispose();
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);
  });

  it('shows the filter picker with counts computed over the search-matched entries', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    await provider.loadPackages();
    await provider.checkUpdates();
    filterManager.setSearch('react');

    await provider.showFilterPicker();

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    const [items] = vi.mocked(vscode.window.showQuickPick).mock.calls[0] as [
      { label: string; description: string }[],
      unknown,
    ];
    // Only react matches the search: if the counts came from the full unfiltered
    // set (2 entries) instead of the search-matched one, "All" would read "2".
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'All', description: '1' }),
      expect.objectContaining({ label: 'Breaking', description: '1' }),
    ]));
  });

  it('does not open the filter picker when there are no packages at all', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.showFilterPicker();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('exposes expandable package details for package rows', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packageItem = groups.flatMap(group => group.children).find((item): item is PackageItem => item instanceof PackageItem);

    expect(packageItem).toBeDefined();
    expect(provider.getChildren(packageItem)).toEqual([
      expect.objectContaining({ label: 'Dependency' }),
      expect.objectContaining({ label: 'Current: 18.0.0' }),
      expect.objectContaining({ label: 'Update: 18.0.0 → 19.0.0 (breaking)' }),
    ]);
    expect(provider.getChildren(packageItem as PackageItem).every(item => item instanceof PackageDetailItem)).toBe(true);
  });

  it('shows the package file path for monorepo package rows', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/apps/frontend/package.json',
      },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packageItem = groups.flatMap(group => group.children).find((item): item is PackageItem => item instanceof PackageItem);

    expect(provider.getChildren(packageItem as PackageItem)).toEqual([
      expect.objectContaining({ label: 'Dependency' }),
      expect.objectContaining({ label: 'Current: 18.0.0' }),
      expect.objectContaining({ label: 'Update: 18.0.0 → 19.0.0 (breaking)' }),
      expect.objectContaining({ label: 'File: apps/frontend/package.json' }),
    ]);
  });

  it('shows status rows above the package groups', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([]);
    setProviderState(provider, {
      loading: false,
      checkState: 'done',
      lastCheckTime: new Date('2026-05-27T08:45:00.000Z'),
      auditState: 'done',
      lastAuditCount: 2,
      allEntries: [{
        item: buildPackageItem({ name: 'react', currentVersion: '18.0.0', packageFilePath: '' }),
        dev: false,
        packageFilePath: '/workspace/package.json',
      }],
    });

    const tree = provider.getChildren();

    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[0].label).toBe('Last update check');
    expect(tree[1]).toBeInstanceOf(StatusItem);
    expect(tree[1].label).toBe('Audit complete');
    expect(tree[2]).toBeInstanceOf(GroupItem);
    expect(tree[2].label).toBe('Dependencies');
  });

  it('gives a package row an accessible workspace owner that matches the disambiguated tree label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-owner-label-'));
    const firstRoot = join(root, 'team-a', 'app');
    const secondRoot = join(root, 'team-b', 'app');
    const firstManifest = join(firstRoot, 'package.json');
    const secondManifest = join(secondRoot, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await mkdir(firstRoot, { recursive: true });
      await mkdir(secondRoot, { recursive: true });
      await writeFile(firstManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      await writeFile(secondManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      // Neither folder declares a `name`, so both derive the same "app" folder name and
      // can only be told apart by the same suffix disambiguation the tree/picker use.
      setWorkspaceFolders([{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: firstManifest },
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: secondManifest },
      ]);
      vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest, secondManifest]);

      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();

      const folders = provider.getChildren()
        .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
      expect(folders.map(folder => folder.folderLabel)).toEqual(['team-a/app — (root)', 'team-b/app — (root)']);

      const rows = folders
        .flatMap(folder => folder.children)
        .flatMap(group => group.children)
        .filter((item): item is PackageItem => item instanceof PackageItem);

      expect(rows).toHaveLength(2);
      const ownerLabels = rows.map(item => item.accessibilityInformation?.label);
      expect(ownerLabels[0]).toContain('Workspace owner: team-a/app — (root)');
      expect(ownerLabels[1]).toContain('Workspace owner: team-b/app — (root)');
      // The two roots share a folder name; a naive `folder.name` fallback would collide here.
      expect(new Set(ownerLabels)).toHaveLength(2);

      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('computes the owner-label projection once per load, not once per row', async () => {
    const manifestCount = 20;
    const packagesPerManifest = 15;
    const manifestPaths = Array.from(
      { length: manifestCount },
      (_, manifestIndex) => `/workspace/pkg-${manifestIndex}/package.json`,
    );
    const entries = manifestPaths.flatMap((packageFilePath, manifestIndex) => (
      Array.from({ length: packagesPerManifest }, (_, packageIndex) => ({
        name: `dep-${manifestIndex}-${packageIndex}`,
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      }))
    ));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(manifestPaths);

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    // A per-row lookup over manifestCount * packagesPerManifest rows would call the
    // projection hundreds of times; caching it per load calls it exactly once, checked
    // before the tree is ever rendered so buildTree()'s own (unrelated) call cannot hide it.
    expect(vi.mocked(resolvePackageFileLabels)).toHaveBeenCalledTimes(1);

    const rows = provider.getChildren()
      .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem)
      .flatMap(folder => folder.children)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    expect(rows).toHaveLength(manifestCount * packagesPerManifest);

    provider.dispose();
  });

  it('does not reuse a stale owner label after the manifest set changes', async () => {
    const firstRoot = '/workspace/team-a/app';
    const secondRoot = '/workspace/team-b/app';
    const firstManifest = `${firstRoot}/package.json`;
    const secondManifest = `${secondRoot}/package.json`;
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      // First load: a single folder named "app" — no collision, no disambiguation needed.
      setWorkspaceFolders([{ uri: { fsPath: firstRoot } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: firstManifest },
      ]);
      vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest]);

      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();

      const soloLabel = getPackageItems(provider)[0]?.accessibilityInformation?.label;
      expect(soloLabel).toContain('Workspace owner: app — (root)');

      // Second load on the same provider: a same-named sibling folder now collides,
      // so the label cached for the single-folder load must not survive unchanged.
      setWorkspaceFolders([{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: firstManifest },
        { name: 'react', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: secondManifest },
      ]);
      vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest, secondManifest]);

      await provider.loadPackages();

      const folders = provider.getChildren()
        .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
      const rows = folders
        .flatMap(folder => folder.children)
        .flatMap(group => group.children)
        .filter((item): item is PackageItem => item instanceof PackageItem);
      const labels = rows.map(item => item.accessibilityInformation?.label);

      expect(labels[0]).toContain('Workspace owner: team-a/app — (root)');
      expect(labels[1]).toContain('Workspace owner: team-b/app — (root)');
      expect(labels[0]).not.toContain('Workspace owner: app — (root)');

      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
    }
  });
});

describe('PackageDetailItem', () => {
  it('leaves the icon unset when none is provided', () => {
    const detail = new PackageDetailItem('Current: 1.0.0');

    expect(detail.iconPath).toBeUndefined();
  });
});