import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FilterManager, GroupItem, PackageDetailItem, PackageItem, PackagesProvider } from '../providers';
import {
  fetchAllLatestVersions,
  readAllWorkspaceDependencies,
} from '../utils';

vi.mock('../utils', () => ({
  fetchAllLatestVersions: vi.fn(),
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
  });

  it('starts with the configured initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.checkUpdates();

    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    expect(provider.getChildren()[0].label).toBe('Filter: Has Updates');
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('allows setFilter to override the initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.checkUpdates();
    provider.setFilter('all');

    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    expect(provider.getChildren()[0].label).toBe('Filter: All');
    expect(groups.flatMap(group => group.children.map(child => child.label))).toEqual(['react', 'eslint']);
  });

  it('reuses fresh update check results', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('fetches updates again after cache invalidation', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.checkUpdates();
    provider.invalidateUpdateCache();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('expires update check cache after five minutes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
      const provider = new PackagesProvider(new FilterManager('all'));

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

    await provider.checkUpdates();
    mockNestroConfiguration({ updateTarget: 'minor' });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('does not reuse update cache when pre-release setting changes', async () => {
    mockNestroConfiguration({ includePreReleases: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.checkUpdates();
    mockNestroConfiguration({ includePreReleases: false });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('exposes expandable package details for package rows', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.checkUpdates();
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packageItem = groups.flatMap(group => group.children).find((item): item is PackageItem => item instanceof PackageItem);

    expect(packageItem).toBeDefined();
    expect(provider.getChildren(packageItem)).toEqual([
      expect.objectContaining({ label: 'Type: dependency' }),
      expect.objectContaining({ label: 'Current: 18.0.0' }),
      expect.objectContaining({ label: 'Latest: 19.0.0' }),
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

    await provider.checkUpdates();
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packageItem = groups.flatMap(group => group.children).find((item): item is PackageItem => item instanceof PackageItem);

    expect(provider.getChildren(packageItem as PackageItem)).toEqual([
      expect.objectContaining({ label: 'Type: dependency' }),
      expect.objectContaining({ label: 'Current: 18.0.0' }),
      expect.objectContaining({ label: 'Latest: 19.0.0' }),
      expect.objectContaining({ label: 'File: apps/frontend/package.json' }),
    ]);
  });
});

function mockNestroConfiguration(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}