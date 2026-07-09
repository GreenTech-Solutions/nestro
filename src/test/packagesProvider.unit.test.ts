import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  FilterBarItem,
  FilterManager,
  GroupItem,
  PackageDetailItem,
  PackageItem,
  PackagesProvider,
  SearchQueryItem,
  StatusItem,
  WorkspaceFolderItem,
} from '../providers';
import {
  fetchAllLatestVersions,
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
} from '../utils';

const getClientMock = vi.fn();

vi.mock('../clients', () => ({
  ClientManager: vi.fn(function (this: { getClient: typeof getClientMock }) {
    this.getClient = getClientMock;
  }),
}));

vi.mock('../utils', () => ({
  fetchAllLatestVersions: vi.fn(),
  getPackageDirectory: vi.fn((packageFilePath: string) => packageFilePath.replace(/\/package\.json$/, '')),
  getWorkspacePackageFilePaths: vi.fn(),
  getUpdateType: vi.fn((current: string, latest: string) => (
    current.split('.')[0] === latest.split('.')[0] ? 'minor' : 'breaking'
  )),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  },
  readAllWorkspaceDependencies: vi.fn(),
  readWorkspaceDependencies: vi.fn(),
  runNpmAudit: vi.fn(),
  showError: vi.fn(),
}));

describe('PackagesProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'eslint',
        current: '8.0.0',
        dev: true,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([
      ['react', '19.0.0'],
    ]));
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(['/workspace/package.json']);
    getClientMock.mockReset();
  });

  it('starts with the configured initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.loadPackages();
    await provider.checkUpdates();

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[1]).toBeInstanceOf(SearchQueryItem);
    expect(tree[2].label).toBe('Filter: Has Updates');
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
    expect(tree[1]).toBeInstanceOf(SearchQueryItem);
    expect(tree[2].label).toBe('Filter: All');
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

  it('reuses fresh update check results', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('reuses update cache after debounce but before cache expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.checkUpdates();
      vi.advanceTimersByTime(61_000);
      await provider.checkUpdates();

      expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('fetches fresh updates when force-always mode is enabled', async () => {
    mockNestroConfiguration({ checkUpdatesForceAlways: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('does not reuse update cache when the package-file set changes', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const existingEntries = (provider as unknown as { allEntries: unknown[] }).allEntries;
    setProviderState(provider, {
      allEntries: [
        ...existingEntries,
        {
          item: new PackageItem(
            'typescript',
            '5.0.0',
            undefined,
            'none',
            false,
            undefined,
            '/workspace/tools/package.json',
            true,
          ),
          dev: true,
          packageFilePath: '/workspace/tools/package.json',
        },
      ],
    });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(3);
    expect(fetchAllLatestVersions).toHaveBeenLastCalledWith(
      '/workspace/tools/package.json',
      'latest',
      true,
    );
  });

  it('fetches updates again after cache invalidation', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.invalidateUpdateCache();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('ignores concurrent update checks while a check is already running', async () => {
    let resolveFetch: (value: Map<string, string>) => void = () => {};
    vi.mocked(fetchAllLatestVersions).mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const firstCheck = provider.checkUpdates();
    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);

    const secondCheck = provider.checkUpdates();
    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);

    resolveFetch(new Map([['react', '19.0.0']]));
    await Promise.all([firstCheck, secondCheck]);

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('ignores concurrent update checks before workspace packages are loaded', async () => {
    let resolveDependencies: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
    vi.mocked(readAllWorkspaceDependencies).mockReturnValueOnce(new Promise((resolve) => {
      resolveDependencies = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    const firstCheck = provider.checkUpdates();
    expect(readAllWorkspaceDependencies).toHaveBeenCalledTimes(1);

    const secondCheck = provider.checkUpdates();
    expect(readAllWorkspaceDependencies).toHaveBeenCalledTimes(1);

    resolveDependencies([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await Promise.all([firstCheck, secondCheck]);

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('preserves live installing state when update checks finish', async () => {
    let resolveFetch: (value: Map<string, string>) => void = () => {};
    vi.mocked(fetchAllLatestVersions).mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const updateCheck = provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, true);
    resolveFetch(new Map([['react', '19.0.0']]));
    await updateCheck;

    const packages = provider.getChildren()
      .filter((item): item is GroupItem => item instanceof GroupItem)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    const react = packages.find(item => item.packageName === 'react');

    expect(react?.latest).toBe('19.0.0');
    expect(react?.installing).toBe(true);
    expect(react?.contextValue).toBe('installing');
  });

  it('keeps write suppression active for overlapping suppressed writes', async () => {
    vi.useFakeTimers();
    try {
      let finishFirst: () => void = () => {};
      let finishSecond: () => void = () => {};
      const provider = new PackagesProvider(new FilterManager('all'));
      const firstWrite = provider.withWriteSuppressed(async () => {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      });
      const secondWrite = provider.withWriteSuppressed(async () => {
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      });

      finishFirst();
      await firstWrite;
      vi.advanceTimersByTime(600);

      expect(provider.suppressingWrites).toBe(true);

      finishSecond();
      await secondWrite;
      vi.advanceTimersByTime(599);
      expect(provider.suppressingWrites).toBe(true);

      vi.advanceTimersByTime(1);
      expect(provider.suppressingWrites).toBe(false);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('clears pending write suppression timers on dispose', async () => {
    vi.useFakeTimers();
    try {
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.withWriteSuppressed(async () => {});
      expect(provider.suppressingWrites).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      provider.dispose();
      expect(provider.suppressingWrites).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(600);
      expect(provider.suppressingWrites).toBe(false);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('expires update check cache after five minutes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.checkUpdates();
      vi.setSystemTime(new Date('2026-05-27T00:05:01.000Z'));
      await provider.checkUpdates();

      expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse update cache when update target changes', async () => {
    mockNestroConfiguration({ updateTarget: 'latest' });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    mockNestroConfiguration({ updateTarget: 'minor' });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('does not reuse update cache when pre-release setting changes', async () => {
    mockNestroConfiguration({ includePreReleases: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    mockNestroConfiguration({ includePreReleases: false });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
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

  it('shows status rows above the filter bar', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([]);
    setProviderState(provider, {
      loading: false,
      checkState: 'done',
      lastCheckTime: new Date('2026-05-27T08:45:00.000Z'),
      auditState: 'done',
      lastAuditCount: 2,
      allEntries: [{
        item: new PackageItem('react', '18.0.0', undefined, 'none'),
        dev: false,
        packageFilePath: '/workspace/package.json',
      }],
    });

    const tree = provider.getChildren();

    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[0].label).toBe('Last update check');
    expect(tree[1]).toBeInstanceOf(StatusItem);
    expect(tree[1].label).toBe('Audit complete');
    expect(tree[2]).toBeInstanceOf(SearchQueryItem);
    expect(tree[3]).toBeInstanceOf(FilterBarItem);
  });

  it('preserves the version prefix when a package is marked updated', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    setProviderState(provider, {
      allEntries: [{
        item: new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
        dev: false,
        packageFilePath: '/workspace/package.json',
      }],
    });

    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '19.0.0');

    const entry = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries[0];
    expect(entry.item.currentVersion).toBe('^19.0.0');
    expect(entry.item.versionPrefix).toBe('^');
    expect(entry.item.updateType).toBe('none');
  });

  it('targets package mutations by exact package file path', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    setProviderState(provider, {
      allEntries: [
        {
          item: new PackageItem(
            'react',
            '^18.0.0',
            '19.0.0',
            'breaking',
            false,
            undefined,
            '/workspace/apps/web/package.json',
            false,
            '^',
          ),
          dev: false,
          packageFilePath: '/workspace/apps/web/package.json',
        },
        {
          item: new PackageItem(
            'react',
            '~18.0.0',
            '18.3.1',
            'minor',
            false,
            undefined,
            '/workspace/packages/ui/package.json',
            false,
            '~',
          ),
          dev: false,
          packageFilePath: '/workspace/packages/ui/package.json',
        },
      ],
    });

    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '/workspace/packages/ui/package.json',
      section: 'dependencies',
    }, '18.3.1');
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/packages/ui/package.json',
      section: 'dependencies',
    }, true);
    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '',
      section: 'dependencies',
    }, '20.0.0');
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '',
      section: 'dependencies',
    }, false);

    const entries = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries;

    expect(entries.map(entry => ({
      currentVersion: entry.item.currentVersion,
      installing: entry.item.installing,
      packageFilePath: entry.item.packageFilePath,
      updateType: entry.item.updateType,
    }))).toEqual([
      {
        currentVersion: '^18.0.0',
        installing: false,
        packageFilePath: '/workspace/apps/web/package.json',
        updateType: 'breaking',
      },
      {
        currentVersion: '~18.3.1',
        installing: true,
        packageFilePath: '/workspace/packages/ui/package.json',
        updateType: 'none',
      },
    ]);
  });

  it('targets package state mutations by dependency section', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'react',
        current: '~18.1.0',
        dev: true,
        versionPrefix: '~',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, true);

    let packages = getPackageItems(provider);
    expect(packages.map(item => ({
      currentVersion: item.currentVersion,
      dev: item.dev,
      installing: item.installing,
    }))).toEqual([
      { currentVersion: '^18.0.0', dev: false, installing: false },
      { currentVersion: '~18.1.0', dev: true, installing: true },
    ]);

    await provider.loadPackages();
    packages = getPackageItems(provider);
    expect(packages.map(item => ({
      dev: item.dev,
      installing: item.installing,
    }))).toEqual([
      { dev: false, installing: false },
      { dev: true, installing: true },
    ]);

    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, '19.0.0');

    packages = getPackageItems(provider);
    expect(packages.map(item => ({
      currentVersion: item.currentVersion,
      dev: item.dev,
      installing: item.installing,
      updateType: item.updateType,
    }))).toEqual([
      { currentVersion: '^18.0.0', dev: false, installing: false, updateType: 'breaking' },
      { currentVersion: '~19.0.0', dev: true, installing: false, updateType: 'none' },
    ]);
  });

  it('runs audits per package file and keeps vulnerability badges scoped to that file', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/apps/web/package.json',
      },
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    getClientMock
      .mockResolvedValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
      })
      .mockResolvedValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map()),
      });

    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    const folders = provider.getChildren().filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    const groups = folders.flatMap(folder => folder.children);
    const packages = groups.flatMap(group => group.children).filter((item): item is PackageItem => item instanceof PackageItem);

    expect(getClientMock).toHaveBeenCalledWith('/workspace/apps/web');
    expect(getClientMock).toHaveBeenCalledWith('/workspace/packages/ui');
    expect(packages.map(item => [item.packageFilePath, item.vulnerabilitySeverity])).toEqual([
      ['/workspace/apps/web/package.json', 'high'],
      ['/workspace/packages/ui/package.json', undefined],
    ]);
  });

  it('ignores concurrent audits while allowing a later manual audit', async () => {
    let resolveAudit: (value: Map<string, 'high'>) => void = () => {};
    const runAuditMock = vi.fn()
      .mockReturnValueOnce(new Promise<Map<string, 'high'>>((resolve) => {
        resolveAudit = resolve;
      }))
      .mockResolvedValueOnce(new Map([['react', 'moderate']]));
    getClientMock.mockResolvedValue({
      runAudit: runAuditMock,
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const firstAudit = provider.runAudit();
    const secondAudit = provider.runAudit();

    await Promise.resolve();
    await Promise.resolve();

    expect(getClientMock).toHaveBeenCalledTimes(1);
    expect(runAuditMock).toHaveBeenCalledTimes(1);

    resolveAudit(new Map([['react', 'high']]));
    await Promise.all([firstAudit, secondAudit]);

    await provider.runAudit();

    const packages = provider.getChildren()
      .filter((item): item is GroupItem => item instanceof GroupItem)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    const react = packages.find(item => item.packageName === 'react');

    expect(getClientMock).toHaveBeenCalledTimes(2);
    expect(runAuditMock).toHaveBeenCalledTimes(2);
    expect(react?.vulnerabilitySeverity).toBe('moderate');
  });

  it('allows a later manual audit when package file discovery fails', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths)
      .mockRejectedValueOnce(new Error('workspace scan failed'))
      .mockResolvedValueOnce(['/workspace/package.json']);
    const runAuditMock = vi.fn().mockResolvedValue(new Map([['react', 'high']]));
    getClientMock.mockResolvedValue({
      runAudit: runAuditMock,
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();
    await provider.runAudit();

    expect(getClientMock).toHaveBeenCalledTimes(1);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
  });
});

function mockNestroConfiguration(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}

function getPackageItems(provider: PackagesProvider): PackageItem[] {
  return provider.getChildren()
    .filter((item): item is GroupItem => item instanceof GroupItem)
    .flatMap(group => group.children)
    .filter((item): item is PackageItem => item instanceof PackageItem);
}

function setProviderState(
  provider: PackagesProvider,
  state: {
    allEntries?: unknown[];
    auditState?: string;
    auditResults?: Map<string, unknown>;
    checkState?: string;
    lastAuditCount?: number;
    lastCheckTime?: Date;
    loading?: boolean;
  },
): void {
  Object.assign(provider as unknown as Record<string, unknown>, state);
}