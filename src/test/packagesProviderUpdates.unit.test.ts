import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mockNestroConfiguration } from './fixtures/config';
import {
  FilterManager,
  METADATA_CONCURRENCY_CAP,
  PackagesProvider,
  StatusItem,
} from '../providers';
import {
  CHECK_CONCURRENCY_CAP,
  fetchAllLatestVersions,
  fetchPackageMetadata,
  formatHeldBackDate,
  getWorkspacePackageFilePaths,
  MUTATION_CONCURRENCY_CAP,
  readAllWorkspaceDependencies,
  resolveMetadataRegistryKey,
  showError,
} from '../utils';
import type { PackageMetadataOutcome } from '../utils';
import { getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
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

  it('excludes prereleases from update checks when the setting is absent', async () => {
    mockNestroConfiguration({});
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'latest',
      false,
      7,
    );
  });

  it('passes explicit prerelease opt-in to update checks', async () => {
    mockNestroConfiguration({ includePreReleases: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'latest',
      true,
      7,
    );
  });

  it('does not enable prereleases for the greatest target when the setting is absent', async () => {
    mockNestroConfiguration({ updateTarget: 'greatest' });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'greatest',
      false,
      7,
    );
  });

  it('passes zero to the NCU wrapper and skips metadata fan-out', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'latest',
      false,
      0,
    );
    expect(fetchPackageMetadata).not.toHaveBeenCalled();
  });

  it('deduplicates metadata by package and registry while capping concurrent requests', async () => {
    expect(CHECK_CONCURRENCY_CAP).toBe(6);
    expect(MUTATION_CONCURRENCY_CAP).toBe(8);
    const packageNames = ['react', 'vue', 'vite', 'eslint', 'typescript', 'vitest', 'react'];
    const packagePaths = packageNames.map((_, index) => `/workspace/metadata-${index}/package.json`);
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageNames.map((name, index) => ({
      name,
      current: '1.0.0',
      dev: index === packageNames.length - 1,
      versionPrefix: '',
      packageFilePath: packagePaths[index],
    })));
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packagePaths);
    vi.mocked(fetchAllLatestVersions).mockImplementation((packageFilePath) => {
      const index = packagePaths.indexOf(packageFilePath);
      return Promise.resolve(new Map([[packageNames[index] ?? 'unknown', '1.1.0']]));
    });
    vi.mocked(resolveMetadataRegistryKey).mockResolvedValue('https://registry.example.test/');
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    vi.mocked(fetchPackageMetadata).mockImplementation(async () => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      activeRequests -= 1;
      return {
        kind: 'success',
        result: {
          versions: ['1.1.0'],
          distTags: { latest: '1.1.0' },
          publishTimes: { kind: 'not-provided' },
        },
      };
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchPackageMetadata).toHaveBeenCalledTimes(6);
    expect(maximumActiveRequests).toBe(METADATA_CONCURRENCY_CAP);
  });

  it('keeps an update actionable when metadata resolution or fetch fails', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.1.0']]));
    vi.mocked(resolveMetadataRegistryKey).mockRejectedValueOnce(new Error('registry lookup failed'));
    vi.mocked(fetchPackageMetadata).mockRejectedValueOnce(new Error('metadata unavailable'));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(getPackageItems(provider).find(item => item.packageName === 'react')).toMatchObject({
      latest: '1.1.0',
      releaseAge: { kind: 'unknown', version: '1.1.0' },
    });
    expect(showError).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('resolves update progress promptly when metadata lookup is cancelled', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.1.0']]));
    let releaseRegistry!: (value: string) => void;
    vi.mocked(resolveMetadataRegistryKey).mockReturnValueOnce(new Promise((resolve) => {
      releaseRegistry = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(resolveMetadataRegistryKey).toHaveBeenCalled());
    provider.cancelCheckUpdates();
    await check;
    releaseRegistry('https://registry.example.test/');
    await vi.waitFor(() => expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Checking updates…')).toBe(false));
    provider.dispose();
  });

  it('resolves update progress promptly when metadata fetch is cancelled', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.1.0']]));
    let releaseMetadata!: (value: PackageMetadataOutcome) => void;
    vi.mocked(fetchPackageMetadata).mockReturnValueOnce(new Promise((resolve) => {
      releaseMetadata = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(fetchPackageMetadata).toHaveBeenCalled());
    provider.cancelCheckUpdates();
    await check;
    releaseMetadata({
      kind: 'success',
      result: {
        versions: ['1.1.0'],
        distTags: { latest: '1.1.0' },
        publishTimes: { kind: 'not-provided' },
      },
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    provider.dispose();
  });

  it('keeps the accepted NCU version while surfacing a newer held-back release', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    try {
      mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
      vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([['react', '1.1.0']]));
      vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({
        kind: 'success',
        result: {
          versions: ['1.1.0', '2.0.0'],
          distTags: { latest: '2.0.0' },
          publishTimes: {
            kind: 'provided',
            byVersion: {
              '1.1.0': '2026-01-01T00:00:00.000Z',
              '2.0.0': '2026-05-26T00:00:00.000Z',
            },
          },
        },
      });
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.checkUpdates();

      const eligibleAt = '2026-06-02T00:00:00.000Z';
      const react = getPackageItems(provider).find(item => item.packageName === 'react');
      expect(react).toMatchObject({
        latest: '1.1.0',
        releaseAge: {
          kind: 'held-back',
          version: '2.0.0',
          eligibleAt,
        },
      });
      const expectedDate = formatHeldBackDate(eligibleAt);
      expect(react?.description).toContain(`Held back 2.0.0 until ${expectedDate}`);
      expect(react?.tooltip).toContain(`Held back 2.0.0 until ${expectedDate}`);
      expect(react?.description).not.toContain(eligibleAt);
      expect(react?.tooltip).not.toContain(eligibleAt);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('surfaces unknown release age without hiding an accepted update', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([['react', '1.1.0']]));
    vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({
      kind: 'success',
      result: {
        versions: ['1.1.0', '2.0.0'],
        distTags: { latest: '2.0.0' },
        publishTimes: { kind: 'not-provided' },
      },
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    const react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react).toMatchObject({
      latest: '1.1.0',
      releaseAge: { kind: 'unknown', version: '1.1.0' },
    });
    expect(react?.tooltip).toContain('Release age unknown for 1.1.0; update is not blocked.');
  });
});