import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as vscode from 'vscode';
import { mockNestroConfiguration } from './fixtures/config';
import { buildPackageItem } from './fixtures/packageItem';
import {
  FilterManager,
  GroupItem,
  PackageItem,
  PackagesProvider,
  StatusItem,
} from '../providers';
import {
  CHECK_CONCURRENCY_CAP,
  fetchAllLatestVersions,
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import { packagesProviderMocks } from './fixtures/packagesProviderMocks';
import { getPackageItems, resetPackagesProviderDefaults, setProviderState } from './fixtures/packagesProviderHarness';
const { createClient: createClientMock } = packagesProviderMocks;

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
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
          item: buildPackageItem({
            name: 'typescript',
            currentVersion: '5.0.0',
            latest: undefined,
            packageFilePath: '/workspace/tools/package.json',
            dev: true,
          }),
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
      false,
      7,
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

  it('reuses the update cache regardless of row order', async () => {
    // Debounce off: the cheap policy gate would otherwise short-circuit the second check
    // before the fingerprint that this test is about is ever computed.
    mockNestroConfiguration({ checkUpdatesDebounce: 0 });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const entries = (provider as unknown as { allEntries: unknown[] }).allEntries;
    setProviderState(provider, { allEntries: [...entries].reverse() });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('ignores concurrent update checks while a check is already running', async () => {
    let resolveFetch: (value: Map<string, string>) => void = () => {};
    vi.mocked(fetchAllLatestVersions).mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    // Both calls are issued before either can reach the fetch: the running guard,
    // set synchronously at the top of checkUpdates(), must still block the second.
    const firstCheck = provider.checkUpdates();
    const secondCheck = provider.checkUpdates();

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

  it('bounds independent update roots at CHECK_CONCURRENCY_CAP and applies results by input order', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/apps/root-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));

    let active = 0;
    let peak = 0;
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAllLatestVersions).mockImplementation(async (packageFilePath) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(packageFilePath);
      await gate;
      active -= 1;
      const index = packageEntries.findIndex(entry => entry.packageFilePath === packageFilePath);
      return new Map([[`package-${index}`, '2.0.0']]);
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));

    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect(started).toEqual(packageEntries.slice(0, CHECK_CONCURRENCY_CAP).map(entry => entry.packageFilePath));
    release();
    await check;

    const rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.map(entry => entry.item.latest)).toEqual(roots.map(() => '2.0.0'));
    expect(rows.map(entry => entry.item.packageName)).toEqual(packageEntries.map(entry => entry.name));
    provider.dispose();
  });

  it('keeps successful update roots when another NCU root fails', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const successfulPath = '/workspace/apps/success/package.json';
    const failedPath = '/workspace/apps/failure/package.json';
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      { name: 'success-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: successfulPath },
      { name: 'failed-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: failedPath },
    ]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([successfulPath, failedPath]);
    const failure = new Error('one root unavailable');
    vi.mocked(fetchAllLatestVersions).mockImplementation((packageFilePath) => {
      if (packageFilePath === failedPath) {
        return Promise.reject(failure);
      }
      return Promise.resolve(new Map([['success-package', '2.0.0']]));
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.checkUpdates();

    const rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.map(entry => [entry.item.packageFilePath, entry.item.latest])).toEqual([
      [successfulPath, '2.0.0'],
      [failedPath, undefined],
    ]);
    const status = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Update check incomplete');
    expect(status).toBeInstanceOf(StatusItem);
    expect(status?.description).toBe('1 package root failed');
    expect(status?.command).toEqual(expect.objectContaining({ command: 'nestro.openStatusReport' }));
    expect(status?.tooltip).toContain('Open detailed diagnostics');
    expect(status?.accessibilityInformation?.label).toContain('Open detailed diagnostics');
    expect(provider.getStatusReport().updateFailures).toEqual([expect.objectContaining({
      packageFilePaths: [failedPath],
      reason: 'update-check-failed',
      detail: expect.stringContaining(failure.message),
    })]);
    expect(showError).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('clears failed roots across repeated checks while retaining fresh successes and live state', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0, checkUpdatesForceAlways: true });
    const successfulPath = '/workspace/apps/recheck-success/package.json';
    const failedPath = '/workspace/apps/recheck-failure/package.json';
    const entries = [
      { name: 'success-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: successfulPath },
      { name: 'failed-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: failedPath },
    ];
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(entries.map(entry => entry.packageFilePath));
    vi.mocked(fetchAllLatestVersions).mockImplementation(packageFilePath => Promise.resolve(
      new Map([[packageFilePath === successfulPath ? 'success-package' : 'failed-package', '2.0.0']]),
    ));
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'failed-package',
      packageFilePath: failedPath,
      section: 'dependencies',
    }, { kind: 'update', target: '2.0.0' });

    const failure = new Error('recheck root unavailable');
    vi.mocked(fetchAllLatestVersions).mockImplementation((packageFilePath) => {
      if (packageFilePath === failedPath) {
        return Promise.reject(failure);
      }
      return Promise.resolve(new Map([['success-package', '3.0.0']]));
    });
    await provider.checkUpdates();

    let rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.map(entry => [entry.item.packageFilePath, entry.item.latest])).toEqual([
      [successfulPath, '3.0.0'],
      [failedPath, undefined],
    ]);
    expect(rows[1]?.item.installing).toBe(true);
    expect(provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Update check incomplete')).toBeInstanceOf(StatusItem);

    vi.mocked(fetchAllLatestVersions).mockRejectedValue(failure);
    await provider.checkUpdates();

    rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.every(entry => entry.item.latest === undefined)).toBe(true);
    expect(rows[1]?.item.installing).toBe(true);
    const status = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Update check incomplete');
    expect(status).toBeInstanceOf(StatusItem);
    expect(status?.description).toBe('2 package roots failed');
    expect(provider.getStatusReport().updateFailures).toHaveLength(2);
    expect(showError).toHaveBeenCalledWith(`Failed to check updates — ${failure.message}`, failure);
    provider.dispose();
  });

  it('shares the read cap and canonical root serialization between update and audit runs', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0, checkUpdatesForceAlways: true });
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/mixed-root-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `mixed-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(roots.map(root => `${root}/package.json`));
    let active = 0;
    let peak = 0;
    const rootActive = new Map<string, number>();
    const rootPeaks = new Map<string, number>();
    const enter = (root: string): void => {
      active += 1;
      peak = Math.max(peak, active);
      const next = (rootActive.get(root) ?? 0) + 1;
      rootActive.set(root, next);
      rootPeaks.set(root, Math.max(rootPeaks.get(root) ?? 0, next));
    };
    const leave = (root: string): void => {
      active -= 1;
      rootActive.set(root, (rootActive.get(root) ?? 1) - 1);
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAllLatestVersions).mockImplementation(async (packageFilePath) => {
      const root = packageFilePath.replace(/\/package\.json$/, '');
      enter(root);
      try {
        await gate;
        const index = roots.indexOf(root);
        return new Map([[`mixed-package-${index}`, '2.0.0']]);
      }
      finally {
        leave(root);
      }
    });
    createClientMock.mockImplementation((_manager: string, projectRoot: string) => ({
      runAudit: async () => {
        enter(projectRoot);
        try {
          await gate;
          return new Map<string, never>();
        }
        finally {
          leave(projectRoot);
        }
      },
    }));

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const update = provider.checkUpdates();
    const audit = provider.runAudit();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));

    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect([...rootPeaks.values()].every(value => value === 1)).toBe(true);
    release();
    await Promise.all([update, audit]);
    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect([...rootPeaks.values()].every(value => value === 1)).toBe(true);
    provider.dispose();
  });

  it('cancels queued update roots without publishing a partial or stale result', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/apps/cancel-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `cancel-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));
    let active = 0;
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAllLatestVersions).mockImplementation(async (packageFilePath) => {
      active += 1;
      started.push(packageFilePath);
      await gate;
      active -= 1;
      return new Map([['unused', '2.0.0']]);
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));
    provider.cancelCheckUpdates();
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Checking updates…')).toBe(false);
    await check;
    expect(started).toHaveLength(CHECK_CONCURRENCY_CAP);
    expect(active).toBe(CHECK_CONCURRENCY_CAP);
    release();
    await vi.waitFor(() => expect(active).toBe(0));
    expect(provider.getChildren().some(item => item instanceof StatusItem && (
      item.label === 'Last update check' || item.label === 'Update check incomplete'
    ))).toBe(false);
    expect((provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries
      .every(entry => entry.item.latest === undefined)).toBe(true);
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('does not let a cancelled check overwrite an immediately restarted check', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchNumber = 0;
    vi.mocked(fetchAllLatestVersions).mockImplementation(async () => {
      fetchNumber += 1;
      if (fetchNumber === 1) {
        await firstFetchGate;
      }
      return new Map([['react', fetchNumber === 1 ? '19.0.0' : '20.0.0']]);
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const firstCheck = provider.checkUpdates();
    await vi.waitFor(() => expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1));

    provider.cancelCheckUpdates();
    const secondCheck = provider.checkUpdates();
    // The second run is allowed to own the provider synchronously, before the first
    // cancelled continuation resumes. Its same-root fetch stays queued until cleanup.
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(2);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Checking updates…')).toBe(true);

    releaseFirstFetch();
    await Promise.all([firstCheck, secondCheck]);

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('20.0.0');
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Last update check')).toBe(true);
    provider.dispose();
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
      'Failed to check updates — npm-check-updates timed out',
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
    expect(react?.contextValue).toBe('installing-update');
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

  it('does not reuse update cache when minimum release age changes', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    mockNestroConfiguration({ minimumReleaseAgeDays: 14 });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });
});