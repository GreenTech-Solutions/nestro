import { describe, expect, it, vi } from 'vitest';
import {
  PackageLoadingService,
} from '../providers';
import type {
  CanonicalPackageLocation,
  CanonicalPackageLocationResult,
} from '../providers';
import type {
  PackageFileEntries,
  PackageFileEntry,
  SkippedPackageFile,
} from '../utils';

function withSkippedFiles(
  entries: PackageFileEntry[],
  skippedFiles: readonly SkippedPackageFile[],
): PackageFileEntries {
  Object.defineProperty(entries, 'skippedFiles', {
    value: skippedFiles,
  });
  return entries as PackageFileEntries;
}

function createLocation(
  packageFilePath: string,
  workspaceFolderPath: string,
): CanonicalPackageLocation {
  return {
    packageFilePath,
    packageDirectory: packageFilePath.replace(/\/package\.json$/, ''),
    workspaceFolderPath,
    fileStamp: {
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
    },
    manifestDigest: `${packageFilePath}:digest`,
  };
}

function resolvedLocation(location: CanonicalPackageLocation): CanonicalPackageLocationResult {
  return { ok: true, value: location };
}

describe('PackageLoadingService', () => {
  it('builds an immutable multi-root snapshot with failed and discovered files', async () => {
    const entries = withSkippedFiles([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace-a/package.json',
      },
      {
        name: 'vite',
        current: '^5.0.0',
        dev: true,
        versionPrefix: '^',
        packageFilePath: '/workspace-b/apps/web/package.json',
      },
    ], [
      { packageFilePath: '/workspace-b/packages/broken/package.json', error: 'malformed' },
    ]);
    const locations = new Map([
      ['/workspace-a/package.json', createLocation('/workspace-a/package.json', '/workspace-a')],
      ['/workspace-b/apps/web/package.json', createLocation('/workspace-b/apps/web/package.json', '/workspace-b')],
    ]);
    const readPackageEntries = vi.fn().mockResolvedValue(entries);
    const discoverPackageFilePaths = vi.fn().mockResolvedValue([
      '/workspace-a/package.json',
      '/workspace-b/apps/web/package.json',
      '/workspace-b/package.json',
    ]);
    const resolveLocation = vi.fn((packageFilePath: string) => Promise.resolve(
      locations.has(packageFilePath)
        ? resolvedLocation(locations.get(packageFilePath) as CanonicalPackageLocation)
        : { ok: false, reason: 'unresolvable-path' } as const,
    ));
    const service = new PackageLoadingService({
      readPackageEntries,
      discoverPackageFilePaths,
      resolveCanonicalPackageLocation: resolveLocation,
    });

    const snapshot = await service.load();

    expect(snapshot).toBeDefined();
    expect(snapshot?.entries).toEqual(entries);
    expect(snapshot?.packageFilePaths).toEqual([
      '/workspace-a/package.json',
      '/workspace-b/apps/web/package.json',
      '/workspace-b/package.json',
      '/workspace-b/packages/broken/package.json',
    ]);
    expect(snapshot?.readablePackageFilePaths).toEqual([
      '/workspace-a/package.json',
      '/workspace-b/apps/web/package.json',
      '/workspace-b/package.json',
    ]);
    expect(snapshot?.failedPackageReadPaths).toEqual(['/workspace-b/packages/broken/package.json']);
    expect(snapshot?.packageReadFailed).toBe(false);
    expect([...snapshot?.packageLocationBaselines.keys() ?? []]).toEqual([
      '/workspace-a/package.json',
      '/workspace-b/apps/web/package.json',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.entries)).toBe(true);
    expect(Object.isFrozen(snapshot?.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot?.packageLocationBaselines.get('/workspace-a/package.json'))).toBe(true);
    expect(readPackageEntries).toHaveBeenCalledOnce();
    expect(discoverPackageFilePaths).toHaveBeenCalledOnce();
    expect(resolveLocation).toHaveBeenCalledTimes(2);
  });

  it('drops canonical baselines when two manifests resolve to one path', async () => {
    const entries = withSkippedFiles([
      {
        name: 'shared',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace-a/package.json',
      },
      {
        name: 'shared',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace-b/package.json',
      },
    ], []);
    const resolveLocation = vi.fn((packageFilePath: string) => Promise.resolve(
      resolvedLocation(createLocation('/canonical/shared/package.json', packageFilePath.includes('workspace-a')
        ? '/workspace-a'
        : '/workspace-b')),
    ));
    const service = new PackageLoadingService({
      readPackageEntries: vi.fn().mockResolvedValue(entries),
      discoverPackageFilePaths: vi.fn().mockResolvedValue([
        '/workspace-a/package.json',
        '/workspace-b/package.json',
      ]),
      resolveCanonicalPackageLocation: resolveLocation,
    });

    const snapshot = await service.load();

    expect(snapshot?.packageLocationBaselines).toEqual(new Map());
  });

  it('returns no snapshot after cancellation during canonical reads', async () => {
    const controller = new AbortController();
    let resolveLocation: ((result: CanonicalPackageLocationResult) => void) | undefined;
    let markCanonicalReadStarted: () => void = () => {};
    const canonicalReadStarted = new Promise<void>((resolve) => {
      markCanonicalReadStarted = resolve;
    });
    const resolveCanonicalPackageLocation = vi.fn(() => new Promise<CanonicalPackageLocationResult>((resolve) => {
      resolveLocation = resolve;
      markCanonicalReadStarted();
    }));
    const service = new PackageLoadingService({
      readPackageEntries: vi.fn().mockResolvedValue(withSkippedFiles([{
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }], [])),
      discoverPackageFilePaths: vi.fn().mockResolvedValue(['/workspace/package.json']),
      resolveCanonicalPackageLocation,
    });

    const loading = service.load(controller.signal);
    await canonicalReadStarted;
    expect(resolveCanonicalPackageLocation).toHaveBeenCalledWith('/workspace/package.json');
    controller.abort();
    const finishCanonicalRead = resolveLocation;
    if (finishCanonicalRead === undefined) {
      throw new Error('Canonical read resolver was not initialized.');
    }
    finishCanonicalRead({
      ok: true,
      value: createLocation('/workspace/package.json', '/workspace'),
    });

    await expect(loading).resolves.toBeUndefined();
  });

  it('keeps loaded entries when discovery fails and propagates read failures', async () => {
    const entries = withSkippedFiles([{
      name: 'react',
      current: '18.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }], []);
    const service = new PackageLoadingService({
      readPackageEntries: vi.fn().mockResolvedValue(entries),
      discoverPackageFilePaths: vi.fn().mockRejectedValue(new Error('discovery failed')),
      resolveCanonicalPackageLocation: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'unresolvable-path',
      }),
    });

    await expect(service.load()).resolves.toEqual(expect.objectContaining({
      entries,
      packageFilePaths: ['/workspace/package.json'],
      readablePackageFilePaths: ['/workspace/package.json'],
      packageReadFailed: true,
    }));

    const readError = new Error('read failed');
    const failedService = new PackageLoadingService({
      readPackageEntries: vi.fn().mockRejectedValue(readError),
      discoverPackageFilePaths: vi.fn(),
      resolveCanonicalPackageLocation: vi.fn(),
    });
    await expect(failedService.load()).rejects.toBe(readError);
  });

  it('does not start discovery when already cancelled and exposes repository adapters', async () => {
    const controller = new AbortController();
    controller.abort();
    const entries = withSkippedFiles([], []);
    const readPackageEntries = vi.fn().mockResolvedValue(entries);
    const discoverPackageFilePaths = vi.fn().mockResolvedValue([]);
    const service = new PackageLoadingService({
      readPackageEntries,
      discoverPackageFilePaths,
      resolveCanonicalPackageLocation: vi.fn(),
    });

    await expect(service.load(controller.signal)).resolves.toBeUndefined();
    await expect(service.readPackageEntries()).resolves.toBe(entries);
    await expect(service.discoverPackageFilePaths()).resolves.toEqual([]);
    expect(discoverPackageFilePaths).toHaveBeenCalledOnce();
  });
});