import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// LoadingItem is not part of the providers barrel's public surface (used only internally by
// PackagesProvider), so it must be imported directly from its implementation file.
import { LoadingItem } from '../providers/LoadingItem';
import {
  fetchAllLatestVersions,
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import type { AuditAdvisory, AuditResult } from '../utils';
import { getUpdateType as realGetUpdateType } from '../utils/versionUtils';

const createClientMock = vi.fn();
const resolveAuditProjectsMock = vi.fn();
const getUpdateTypeMock = vi.hoisted(() => vi.fn());

async function createRealAuditProject(packageNames: readonly string[]): Promise<{
  root: string;
  manifest: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-aud08-'));
  const manifest = join(root, 'package.json');
  await writeFile(manifest, '{}');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  for (const packageName of packageNames) {
    await mkdir(join(root, 'node_modules', ...packageName.split('/')), { recursive: true });
  }
  return {
    root,
    manifest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

vi.mock('../clients', () => ({
  ClientManager: vi.fn(function (this: { createClient: typeof createClientMock }) {
    this.createClient = createClientMock;
  }),
  resolveAuditProjects: (packageFilePaths: readonly string[]) => resolveAuditProjectsMock(packageFilePaths),
}));

vi.mock('../utils', () => ({
  fetchAllLatestVersions: vi.fn(),
  getPackageDirectory: vi.fn((packageFilePath: string) => packageFilePath.replace(/\/package\.json$/, '')),
  getWorkspacePackageFilePaths: vi.fn(),
  getUpdateType: getUpdateTypeMock,
  inferPathAttribution: vi.fn((packageName: string, paths: readonly string[]) => (
    paths.length === 1 && (paths[0] === packageName || paths[0] === `node_modules/${packageName}`)
      ? 'direct'
      : 'unknown'
  )),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    dispose: vi.fn(),
  },
  readAllWorkspaceDependencies: vi.fn(),
  readWorkspaceDependencies: vi.fn(),
  runNpmAudit: vi.fn(),
  mergeAuditAdvisories: vi.fn((advisories: readonly AuditAdvisory[]) => [...advisories]),
  showError: vi.fn(),
}));

describe('PackagesProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUpdateTypeMock.mockImplementation(realGetUpdateType);
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
    createClientMock.mockReset();
    resolveAuditProjectsMock.mockReset();
    // Default: every package file is its own independent project (no shared
    // ancestor lockfile), matching the real resolver when no manager signal is
    // shared between manifests. Tests that need a merged multi-manifest project
    // override this per test.
    resolveAuditProjectsMock.mockImplementation((packageFilePaths: readonly string[]) => ({
      projects: packageFilePaths.map(packageFilePath => ({
        projectRoot: packageFilePath.replace(/\/package\.json$/, ''),
        workspaceFolder: '/workspace',
        packageManager: 'npm' as const,
        lockfilePath: undefined,
        originManifests: [packageFilePath],
      })),
      rejected: [],
    }));
  });

  it('shows a loading indicator before packages finish loading', () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    const tree = provider.getChildren();

    expect(tree.at(-1)).toBeInstanceOf(LoadingItem);
    expect(provider.getChildren(new LoadingItem())).toEqual([]);
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

  it('allows a later manual update check after a timeout rejection', async () => {
    const timeoutError = new Error('npm-check-updates timed out');
    vi.mocked(fetchAllLatestVersions)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(new Map([['react', '19.0.0']]));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledWith(
      'failed to check updates — npm-check-updates timed out',
      timeoutError,
    );
    expect(showError).toHaveBeenCalledTimes(1);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('19.0.0');
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

  it('shows one actionable status for skipped package files while keeping valid entries', async () => {
    const entries = [{
      name: 'react',
      current: '18.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/good/package.json',
    }];
    Object.defineProperty(entries, 'skippedFiles', {
      value: [{
        packageFilePath: '/workspace/bad/package.json',
        error: 'Unexpected end of JSON input',
      }],
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    const tree = provider.getChildren();
    const readStatus = tree.find(item => item instanceof StatusItem && item.label === 'Package read incomplete');
    expect(readStatus).toBeInstanceOf(StatusItem);
    expect(readStatus?.description).toContain('/workspace/bad/package.json');
    expect(getPackageItems(provider).map(item => item.packageFilePath)).toEqual(['/workspace/good/package.json']);
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows all skipped paths without claiming there is no workspace', async () => {
    const entries: Array<{
      name: string;
      current: string;
      dev: boolean;
      versionPrefix: string;
      packageFilePath: string;
    }> = [];
    Object.defineProperty(entries, 'skippedFiles', {
      value: [
        { packageFilePath: '/workspace/bad/package.json', error: 'malformed' },
        { packageFilePath: '/workspace/unreadable/package.json', error: 'permission denied' },
      ],
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    const readStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Package read incomplete');
    expect(readStatus).toBeInstanceOf(StatusItem);
    expect(readStatus?.description).toContain('/workspace/bad/package.json');
    expect(readStatus?.description).toContain('/workspace/unreadable/package.json');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'nestro.noWorkspace',
      false,
    );
    expect(showError).not.toHaveBeenCalled();
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

  it('reconciles a failed update after reload sees the target current version', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, true);

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '19.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await provider.loadPackages();

    let react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react).toMatchObject({
      currentVersion: '19.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      installing: true,
    });
    expect(provider.getVisibleOutdatedPackages()).toEqual([]);

    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, false);

    react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react).toMatchObject({
      currentVersion: '19.0.0',
      latest: '19.0.0',
      updateType: 'none',
      installing: false,
    });
    expect(provider.getVisibleOutdatedPackages()).toEqual([]);
  });

  it('clears active update state after successful completion following a changed-version reload', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const identity = {
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies' as const,
    };
    provider.markPackageUpdating(identity, true);

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '19.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await provider.loadPackages();

    provider.markPackageUpdated(identity, '19.0.0');

    expect(getPackageItems(provider).map(item => ({
      currentVersion: item.currentVersion,
      latest: item.latest,
      updateType: item.updateType,
      installing: item.installing,
    }))).toEqual([
      { currentVersion: '19.0.0', latest: undefined, updateType: 'none', installing: false },
    ]);
  });

  it('keeps successful audit results and shows failed package paths', async () => {
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
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('audit unavailable')),
      });

    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    const folders = provider.getChildren().filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    const groups = folders.flatMap(folder => folder.children);
    const packages = groups.flatMap(group => group.children).filter((item): item is PackageItem => item instanceof PackageItem);

    expect(createClientMock).toHaveBeenCalledWith('npm', '/workspace/apps/web');
    expect(createClientMock).toHaveBeenCalledWith('npm', '/workspace/packages/ui');
    expect(showError).not.toHaveBeenCalled();
    expect(packages.map(item => [item.packageFilePath, item.vulnerabilitySeverity])).toEqual([
      ['/workspace/apps/web/package.json', 'high'],
      ['/workspace/packages/ui/package.json', undefined],
    ]);

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe(
      '1 vulnerable package(s) from successful audit roots; failed: /workspace/packages/ui/package.json',
    );
    expect(provider.getChildren().some(item => item.label === 'Audit complete')).toBe(false);
    expect(provider.getAuditProjects().map(summary => summary.status)).toEqual(['success', 'failure']);
    expect(provider.getAuditProjects()[1].failure?.reason).toBe('audit-failed');
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      reason: 'audit-failed',
      packageFilePaths: ['/workspace/packages/ui/package.json'],
      project: expect.objectContaining({ projectRoot: '/workspace/packages/ui' }),
    })]);
  });

  it('keeps an unrecognized structured client result incomplete instead of clean', async () => {
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({ unexpected: true }),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(provider.getAuditProjects()[0]).toMatchObject({
      status: 'failure',
      failure: { reason: 'audit-failed' },
      advisories: [],
    });
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      reason: 'audit-failed',
      packageFilePaths: ['/workspace/package.json'],
    })]);
  });

  it('shows every failed package path when all audits fail', async () => {
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
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('web audit unavailable')),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('ui audit unavailable')),
      });

    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(showError).not.toHaveBeenCalled();
    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe(
      'No successful audit results; failed: /workspace/apps/web/package.json, /workspace/packages/ui/package.json',
    );
    expect(provider.getChildren().some(item => item.label === 'Audit complete')).toBe(false);
  });

  it('preserves complete audit wording when all roots succeed', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map()),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit complete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('No vulnerabilities');
  });

  it('ignores concurrent audits while allowing a later manual audit', async () => {
    let resolveAudit: (value: Map<string, 'high'>) => void = () => {};
    const runAuditMock = vi.fn()
      .mockReturnValueOnce(new Promise<Map<string, 'high'>>((resolve) => {
        resolveAudit = resolve;
      }))
      .mockResolvedValueOnce(new Map([['react', 'moderate']]));
    createClientMock.mockReturnValue({
      runAudit: runAuditMock,
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const firstAudit = provider.runAudit();
    const secondAudit = provider.runAudit();

    await Promise.resolve();
    await Promise.resolve();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(runAuditMock).toHaveBeenCalledTimes(1);

    resolveAudit(new Map([['react', 'high']]));
    await Promise.all([firstAudit, secondAudit]);

    await provider.runAudit();

    const packages = provider.getChildren()
      .filter((item): item is GroupItem => item instanceof GroupItem)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    const react = packages.find(item => item.packageName === 'react');

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(runAuditMock).toHaveBeenCalledTimes(2);
    expect(react?.vulnerabilitySeverity).toBe('moderate');
  });

  it('does nothing when cancelling with no audit running', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    provider.cancelAudit();

    expect(createClientMock).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('resets the busy state synchronously when the audit is cancelled, discarding the run', async () => {
    let resolveAudit: (value: Map<string, 'high'>) => void = () => {};
    const runAuditMock = vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>((resolve) => {
      resolveAudit = resolve;
    }));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    const audit = provider.runAudit();
    await Promise.resolve();
    await Promise.resolve();
    expect(runAuditMock).toHaveBeenCalledWith(expect.any(AbortSignal));
    const [signal] = runAuditMock.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    provider.cancelAudit();

    // Synchronous: gone the instant cancelAudit() returns, before the aborted
    // client.runAudit() call has actually settled in the background.
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Running audit…')).toBe(false);
    expect(signal.aborted).toBe(true);

    resolveAudit(new Map([['react', 'high']]));
    await audit;

    // The cancelled run's result is discarded rather than surfaced as a finished audit.
    expect(provider.getChildren().some(item =>
      item instanceof StatusItem && (item.label === 'Audit complete' || item.label === 'Audit incomplete'))).toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });

  it('keeps a replacement audit controller alive after the cancelled run finally settles', async () => {
    let resolveOldAudit: (value: Map<string, 'high'>) => void = () => {};
    let resolveNewAudit: (value: Map<string, 'high'>) => void = () => {};
    let oldSignal!: AbortSignal;
    let newSignal!: AbortSignal;
    const oldRunAudit = vi.fn().mockImplementation((signal: AbortSignal) => {
      oldSignal = signal;
      return new Promise<Map<string, 'high'>>((resolve) => {
        resolveOldAudit = resolve;
      });
    });
    const newRunAudit = vi.fn().mockImplementation((signal: AbortSignal) => {
      newSignal = signal;
      return new Promise<Map<string, 'high'>>((resolve) => {
        resolveNewAudit = resolve;
      });
    });
    createClientMock
      .mockReturnValueOnce({ runAudit: oldRunAudit })
      .mockReturnValueOnce({ runAudit: newRunAudit });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    const oldAudit = provider.runAudit();
    await vi.waitFor(() => expect(oldRunAudit).toHaveBeenCalledTimes(1));
    provider.cancelAudit();
    expect(oldSignal.aborted).toBe(true);

    const newAudit = provider.runAudit();
    await vi.waitFor(() => expect(newRunAudit).toHaveBeenCalledTimes(1));
    expect(newSignal.aborted).toBe(false);

    // The old finally block must take the false side of the identity guard and leave
    // the replacement controller installed. A mutation that unconditionally clears it
    // makes the next cancel a no-op, leaving this second process alive (ARC-07/N3).
    resolveOldAudit(new Map());
    await oldAudit;
    expect(newSignal.aborted).toBe(false);

    provider.cancelAudit();
    expect(newSignal.aborted).toBe(true);
    resolveNewAudit(new Map());
    await newAudit;
  });

  it('stops auditing further projects once cancelled mid-run', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/apps/web/package.json' },
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/packages/ui/package.json' },
    ]);
    let provider!: PackagesProvider;
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockImplementation(() => {
          // Cancellation lands mid-loop, after the first project's own audit already
          // succeeded — proves the loop stops *starting new* work rather than
          // discarding a project that had already finished.
          provider.cancelAudit();
          return Promise.resolve(new Map<string, never>());
        }),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map()),
      });
    provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight audit process on dispose', async () => {
    // The mock never settles on its own — it stands in for a real, still-running child
    // process. dispose() must not need it to settle: cancellation is proven directly by
    // the signal it was called with flipping to aborted, matching what a real
    // execFile(..., { signal }) call would then react to (see processRunner.unit.test.ts
    // for that real-process proof).
    const runAuditMock = vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>(() => {}));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    void provider.runAudit();
    await Promise.resolve();
    await Promise.resolve();
    const [signal] = runAuditMock.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    provider.dispose();

    expect(signal.aborted).toBe(true);
  });

  it('does not surface an error for an exception that races a cancellation', async () => {
    let provider!: PackagesProvider;
    resolveAuditProjectsMock.mockImplementationOnce(() => {
      provider.cancelAudit();
      throw new Error('resolver raced with cancellation');
    });
    provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.runAudit();

    expect(showError).not.toHaveBeenCalled();
  });

  it('allows a later manual audit when package file discovery fails', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths)
      .mockRejectedValueOnce(new Error('workspace scan failed'))
      .mockResolvedValueOnce(['/workspace/package.json']);
    const runAuditMock = vi.fn().mockResolvedValue(new Map([['react', 'high']]));
    createClientMock.mockReturnValue({
      runAudit: runAuditMock,
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();
    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
  });

  it('audits a shared lock file graph exactly once and suppresses row badges across its manifests', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/api/package.json',
      },
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    resolveAuditProjectsMock.mockResolvedValue({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'pnpm',
        lockfilePath: '/workspace/pnpm-lock.yaml',
        originManifests: [
          '/workspace/packages/api/package.json',
          '/workspace/packages/ui/package.json',
        ],
      }],
      rejected: [],
    });
    const runAuditMock = vi.fn().mockResolvedValue(new Map([['react', 'high']]));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith('pnpm', '/workspace');
    expect(runAuditMock).toHaveBeenCalledTimes(1);
    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);

    const [summary] = provider.getAuditProjects();
    expect(summary.project.originManifests).toEqual([
      '/workspace/packages/api/package.json',
      '/workspace/packages/ui/package.json',
    ]);
    expect(summary.vulnerabilities.get('react')).toBe('high');
  });

  it('projects one proven direct path and installed version onto exactly one manifest row', async () => {
    const advisory = {
      identity: 'npm\0npm-v2-vulnerabilities\0react\0GHSA-react',
      identityStability: 'stable' as const,
      packageName: 'react',
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      advisoryId: 'GHSA-react',
      sources: ['npm'],
      titles: ['React issue'],
      urls: ['https://example.test/react'],
      affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct' as const,
      via: [],
      fixAvailable: false,
    };
    const report: AuditResult = {
      vulnerabilities: new Map([['react', 'high']]),
      total: 1,
      advisories: [advisory],
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
    };
    createClientMock.mockReturnValue({ runAuditReport: vi.fn().mockResolvedValue(report) });
    const fixture = await createRealAuditProject(['react']);
    try {
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: fixture.manifest,
      }]);
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      expect(provider.getAuditProjects()[0]).toMatchObject({
        status: 'success',
        advisories: [advisory],
        failure: undefined,
      });
      expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBe('high');
    }
    finally {
      await fixture.cleanup();
    }
  });

  it('suppresses a badge when one manifest has the package in both dependency sections', async () => {
    const fixture = await createRealAuditProject(['react']);
    const advisory: AuditAdvisory = {
      identity: 'audit-section-version', identityStability: 'stable', packageName: 'react',
      severity: 'high', manager: 'npm', schema: 'npm-v2-vulnerabilities', advisoryId: 'audit-section-version',
      sources: [], titles: [], urls: [], affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'], resolvedVersions: ['18.0.0'], attribution: 'direct', via: [],
    };
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({
        vulnerabilities: new Map([['react', 'high']]), total: 1, advisories: [advisory],
        manager: 'npm', schema: 'npm-v2-vulnerabilities',
      } satisfies AuditResult),
    });
    try {
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        {
          name: 'react', current: '18.0.0', dev: false, versionPrefix: '',
          packageFilePath: fixture.manifest,
        },
        {
          name: 'react', current: '17.0.0', dev: true, versionPrefix: '',
          packageFilePath: fixture.manifest,
        },
      ]);
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      const rows = getPackageItems(provider).filter(item => item.packageName === 'react');
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.vulnerabilitySeverity === undefined)).toBe(true);
    }
    finally {
      await fixture.cleanup();
    }
  });

  it('suppresses a badge when a resolved dependency symlink escapes the project root', async () => {
    const fixture = await createRealAuditProject(['react']);
    const outsideRoot = await mkdtemp(join(tmpdir(), 'nestro-aud08-outside-'));
    try {
      const outsidePackage = join(outsideRoot, 'react');
      await mkdir(outsidePackage, { recursive: true });
      await rm(join(fixture.root, 'node_modules', 'react'), { recursive: true, force: true });
      await symlink(outsidePackage, join(fixture.root, 'node_modules', 'react'), 'dir');
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: fixture.manifest,
      }]);
      const advisory: AuditAdvisory = {
        identity: 'audit-symlink-escape', identityStability: 'stable', packageName: 'react',
        severity: 'high', manager: 'npm', schema: 'npm-v2-vulnerabilities', advisoryId: 'audit-symlink-escape',
        sources: [], titles: [], urls: [], affectedRanges: ['<19.0.0'],
        resolvedPaths: ['node_modules/react'], resolvedVersions: ['18.0.0'], attribution: 'direct', via: [],
      };
      createClientMock.mockReturnValue({
        runAuditReport: vi.fn().mockResolvedValue({
          vulnerabilities: new Map([['react', 'high']]), total: 1, advisories: [advisory],
          manager: 'npm', schema: 'npm-v2-vulnerabilities',
        } satisfies AuditResult),
      });
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBeUndefined();
      expect(provider.getAuditProjects()[0].advisories).toHaveLength(1);
    }
    finally {
      await fixture.cleanup();
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing resolved version', { resolvedVersions: [] }],
    ['transitive attribution', { attribution: 'transitive' }],
    ['nested node_modules path', { resolvedPaths: ['node_modules/dependency/node_modules/react'] }],
    ['virtual Yarn locator', { resolvedPaths: [], resolvedVersions: ['18.0.0'], attribution: 'unknown', manager: 'yarn', schema: 'yarn-modern-npm-audit' }],
  ] as const)('keeps %s in the project report without a row badge', async (_label, overrides) => {
    const advisory = {
      identity: 'audit-structured',
      identityStability: 'stable' as const,
      packageName: 'react',
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      sources: [],
      titles: ['React issue'],
      urls: [],
      affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct' as const,
      via: [],
      ...overrides,
    } as const;
    const report: AuditResult = {
      vulnerabilities: new Map([['react', 'high']]),
      total: 1,
      advisories: [advisory],
      manager: advisory.manager,
      schema: advisory.schema,
    };
    createClientMock.mockReturnValue({ runAuditReport: vi.fn().mockResolvedValue(report) });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBeUndefined();
    expect(provider.getAuditProjects()[0].advisories).toHaveLength(1);
  });

  it('requires manifest and affected-range evidence across exact, caret and tilde specs', async () => {
    const namesAndSpecs = [
      ['exact', '1.2.3', '1.2.3'],
      ['caret', '^1.2.3', '1.3.0'],
      ['tilde', '~1.2.3', '1.2.4'],
      ['zero-major', '^0.2.3', '0.2.4'],
      ['zero-minor', '^0.0.3', '0.0.4'],
      ['workspace', 'workspace:*', '1.0.0'],
      ['empty-range', '1.0.0', '1.0.0'],
      ['bad-version', '1.0.0', 'not-a-version'],
      ['bad-range', '1.0.0', '1.0.0'],
    ] as const;
    const fixture = await createRealAuditProject(namesAndSpecs.map(([name]) => name));
    try {
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(namesAndSpecs.map(([name, current]) => ({
        name,
        current,
        dev: false,
        versionPrefix: '',
        packageFilePath: fixture.manifest,
      })));
      const ranges: Record<string, string> = {
        exact: '<=1.2.3',
        caret: '>=1.0.0 <2.0.0',
        tilde: '>1.2.0 <=1.2.4',
        'zero-major': '0.2.4',
        'zero-minor': '*',
        workspace: '||',
        'empty-range': '',
        'bad-version': '*',
        'bad-range': 'not-a-range',
      };
      const makeAdvisory = (name: string, resolvedVersion: string): AuditAdvisory => ({
        identity: `audit-${name}`,
        identityStability: 'stable',
        packageName: name,
        severity: 'high',
        manager: 'npm',
        schema: 'npm-v2-vulnerabilities',
        advisoryId: `audit-${name}`,
        sources: [],
        titles: [],
        urls: [],
        affectedRanges: [ranges[name]],
        resolvedPaths: [`node_modules/${name}`],
        resolvedVersions: [resolvedVersion],
        attribution: 'direct',
        via: [],
      });
      const report: AuditResult = {
        vulnerabilities: new Map(namesAndSpecs.map(([name]) => [name, 'high' as const])),
        total: namesAndSpecs.length,
        advisories: namesAndSpecs.map(([name, , resolvedVersion]) => makeAdvisory(name, resolvedVersion)),
        manager: 'npm',
        schema: 'npm-v2-vulnerabilities',
      };
      createClientMock.mockReturnValue({ runAuditReport: vi.fn().mockResolvedValue(report) });
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      const items = getPackageItems(provider);
      expect(items.filter(item => item.vulnerabilitySeverity !== undefined).map(item => item.packageName)).toEqual(
        expect.arrayContaining(['caret', 'exact', 'tilde', 'zero-major']),
      );
      expect(items.filter(item => item.vulnerabilitySeverity !== undefined)).toHaveLength(4);
      expect(items.find(item => item.packageName === 'zero-minor')?.vulnerabilitySeverity).toBeUndefined();
    }
    finally {
      await fixture.cleanup();
    }
  });

  it('does not infer manifest ownership from an outside or ambiguous resolved path', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react', current: '18.0.0', dev: false, versionPrefix: '',
        packageFilePath: '/workspace/packages/api/package.json',
      },
      {
        name: 'react', current: '18.0.0', dev: false, versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    resolveAuditProjectsMock.mockResolvedValueOnce({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'npm',
        lockfilePath: '/workspace/package-lock.json',
        originManifests: ['/workspace/packages/api/package.json', '/workspace/packages/ui/package.json'],
      }],
      rejected: [],
    });
    const advisory: AuditAdvisory = {
      identity: 'audit-ambiguous',
      identityStability: 'stable',
      packageName: 'react',
      severity: 'high',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'audit-ambiguous',
      sources: [], titles: [], urls: [], affectedRanges: ['<19.0.0'],
      resolvedPaths: ['/workspace/packages/api/node_modules/react'],
      resolvedVersions: ['18.0.0'], attribution: 'direct', via: [],
    };
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({
        vulnerabilities: new Map([['react', 'high']]), total: 1, advisories: [advisory],
        manager: 'npm', schema: 'npm-v2-vulnerabilities',
      } satisfies AuditResult),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
    expect(provider.getAuditProjects()[0].advisories).toHaveLength(1);
  });

  it('returns mutation-safe nested project snapshots', async () => {
    const advisory = {
      identity: 'audit-snapshot',
      identityStability: 'stable' as const,
      packageName: 'react',
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      sources: ['source'],
      titles: ['title'],
      urls: [],
      affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct' as const,
      via: [{ identity: 'via' }],
    };
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({
        vulnerabilities: new Map([['react', 'high']]),
        total: 1,
        advisories: [advisory],
        manager: 'npm',
        schema: 'npm-v2-vulnerabilities',
      } satisfies AuditResult),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    const snapshot = provider.getAuditProjects();
    (snapshot[0].vulnerabilities as Map<string, 'critical'>).set('injected', 'critical');
    (snapshot[0].advisories[0].resolvedPaths as string[]).push('injected');
    (snapshot[0].project.originManifests as string[]).push('injected');

    const fresh = provider.getAuditProjects()[0];
    expect(fresh.vulnerabilities.has('injected')).toBe(false);
    expect(fresh.advisories[0].resolvedPaths).toEqual(['node_modules/react']);
    expect(fresh.project.originManifests).toEqual(['/workspace/package.json']);
    const report = provider.getAuditReport();
    expect(report.projects).toHaveLength(1);
    expect(report.failures).toEqual([]);
  });

  it('suppresses the badge for a package name duplicated across dependencies and devDependencies', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'react',
        current: '17.0.0',
        dev: true,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
  });

  it('never attaches a badge for a transitive-only advisory that matches no direct dependency row', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['left-pad', 'critical']])),
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
  });

  it('returns a fresh array from getAuditProjects on each call rather than the live internal state', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map()),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();
    const first = provider.getAuditProjects();
    const second = provider.getAuditProjects();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('clears audit projects for the duration of a new audit run', async () => {
    let resolveSecondAudit: (value: Map<string, string>) => void = () => {};
    const runAuditMock = vi.fn()
      .mockResolvedValueOnce(new Map([['react', 'high']]))
      .mockReturnValueOnce(new Promise<Map<string, string>>((resolve) => {
        resolveSecondAudit = resolve;
      }));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.runAudit();
    expect(provider.getAuditProjects()).toHaveLength(1);

    const secondAudit = provider.runAudit();
    expect(provider.getAuditProjects()).toEqual([]);

    resolveSecondAudit(new Map());
    await secondAudit;
  });

  it('clears stale audit projects after an early exit with no package files', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();
    expect(provider.getAuditProjects()).toHaveLength(1);

    (provider as unknown as { allEntries: unknown[] }).allEntries = [];
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    await provider.runAudit();

    expect(provider.getAuditProjects()).toEqual([]);
  });

  it('clears stale audit projects after an exception during project resolution', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();
    expect(provider.getAuditProjects()).toHaveLength(1);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBe('high');

    resolveAuditProjectsMock.mockRejectedValueOnce(new Error('resolution exploded'));
    await provider.runAudit();

    expect(provider.getAuditProjects()).toEqual([]);
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      packageFilePaths: [],
      reason: 'audit-failed',
    })]);
    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
    expect(showError).toHaveBeenCalled();
  });

  it('treats a rejected project resolution as a failed audit root without calling a client', async () => {
    resolveAuditProjectsMock.mockResolvedValue({
      projects: [],
      rejected: [{
        packageFilePath: '/workspace/package.json',
        reason: 'workspace-escape',
        detail: '/workspace/package.json resolves outside its owning workspace folder.',
      }],
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(createClientMock).not.toHaveBeenCalled();
    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toContain('/workspace/package.json');
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      packageFilePaths: ['/workspace/package.json'],
      reason: 'workspace-escape',
    })]);
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

describe('PackageDetailItem', () => {
  it('leaves the icon unset when none is provided', () => {
    const detail = new PackageDetailItem('Current: 1.0.0');

    expect(detail.iconPath).toBeUndefined();
  });
});