import { describe, expect, it, vi } from 'vitest';
import { fetchUpdateVersions } from '../providers/updateCheckFetcher';
import type { PackageIdentityTuple } from '../providers/packageIdentity';
import type {
  UpdateCheckProgress,
  UpdateOrchestrationDependencies,
  UpdateOrchestrationRequest,
} from '../providers/updateOrchestrationTypes';
import { OperationCoordinator } from '../utils/operationCoordinator';
import type { PackageMetadataOutcome } from '../utils';

function identity(packageName: string, packageFilePath: string, section: PackageIdentityTuple['section'] = 'dependencies'): PackageIdentityTuple {
  return { packageName, packageFilePath, section };
}

function createRequest(overrides: Partial<UpdateOrchestrationRequest> = {}): UpdateOrchestrationRequest {
  const packageFiles = overrides.packageFiles ?? ['/workspace/package.json'];
  const identities = overrides.identities ?? [identity('react', packageFiles[0] ?? '')];
  return {
    identities,
    currentVersions: new Map(),
    packageFiles,
    target: 'latest',
    includePreReleases: false,
    minimumReleaseAgeDays: 7,
    forceAlways: false,
    debounceSeconds: 60,
    lastCheckTime: undefined,
    signal: new AbortController().signal,
    isCurrent: () => true,
    resolveCurrentPolicy: () => ({ target: 'latest', includePreReleases: false, minimumReleaseAgeDays: 7 }),
    ...overrides,
  };
}

function createDependencies(overrides: Partial<UpdateOrchestrationDependencies> = {}): UpdateOrchestrationDependencies {
  return {
    checkCoordinator: new OperationCoordinator(4),
    metadataCoordinator: new OperationCoordinator(4),
    fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map()),
    resolveMetadataRegistryKey: vi.fn().mockResolvedValue(undefined),
    fetchPackageMetadata: vi.fn().mockResolvedValue({ kind: 'unavailable' } as unknown as PackageMetadataOutcome),
    resolveMutationCoordinatorKey: vi.fn((packageFilePath: string) => Promise.resolve(packageFilePath)),
    resolveCanonicalPackageLocation: vi.fn().mockResolvedValue({ ok: false, reason: 'unresolvable-path' }),
    readCanonicalDependencySpecs: vi.fn().mockResolvedValue([]),
    now: () => 0,
    ...overrides,
  };
}

describe('fetchUpdateVersions()', () => {
  it('reports phase-one progress and maps accepted versions to their package identities', async () => {
    const packageFiles = ['/workspace/package.json', '/workspace/apps/web/package.json'];
    const identities = [
      identity('react', packageFiles[0] ?? ''),
      identity('eslint', packageFiles[0] ?? '', 'devDependencies'),
      identity('unlisted', packageFiles[0] ?? ''),
      identity('vue', packageFiles[1] ?? ''),
    ];
    const progress: UpdateCheckProgress[] = [];
    const dependencies = createDependencies({
      resolveMutationCoordinatorKey: vi.fn((path: string) => Promise.resolve(path.replace('/package.json', ''))),
      fetchAllLatestVersions: vi.fn((path: string) => Promise.resolve(path === packageFiles[0]
        ? new Map([['react', '19.0.0'], ['eslint', '10.0.0']])
        : new Map([['vue', '3.0.0']]))),
    });

    const result = await fetchUpdateVersions(createRequest({
      packageFiles,
      identities,
      onProgress: value => progress.push(value),
    }), dependencies);

    expect(result).toEqual({
      coordinationKeys: new Map([
        [packageFiles[0] ?? '', '/workspace'],
        [packageFiles[1] ?? '', '/workspace/apps/web'],
      ]),
      acceptedVersions: new Map([
        [`${packageFiles[0]}\0react\0dependencies`, '19.0.0'],
        [`${packageFiles[0]}\0eslint\0devDependencies`, '10.0.0'],
        [`${packageFiles[1]}\0vue\0dependencies`, '3.0.0'],
      ]),
      failedPackageFilePaths: [],
      failures: [],
      firstFailure: undefined,
    });
    expect(progress[0]).toEqual({
      phase: 'versions',
      completedFiles: 0,
      totalFiles: 2,
      packageCount: 4,
      lastPackageFilePath: undefined,
    });
    const completionEvents = progress.slice(1).filter((event): event is Extract<UpdateCheckProgress, { phase: 'versions' }> => (
      event.phase === 'versions'
    ));
    expect(completionEvents).toHaveLength(2);
    expect(new Set(completionEvents.map(event => event.completedFiles))).toEqual(new Set([1, 2]));
    expect(new Set(completionEvents.map(event => event.lastPackageFilePath))).toEqual(new Set(packageFiles));
    expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('reports failed coordinator resolution and NCU requests in package-file order', async () => {
    const packageFiles = ['/workspace/package.json', '/workspace/apps/web/package.json'];
    const resolutionFailure = new Error('cannot resolve second root');
    const fetchFailure = new Error('NCU failed');
    const onRootFailure = vi.fn();
    const progress: UpdateCheckProgress[] = [];
    const dependencies = createDependencies({
      resolveMutationCoordinatorKey: vi.fn((path: string) => path === packageFiles[0]
        ? Promise.resolve('/workspace')
        : Promise.reject(resolutionFailure)),
      fetchAllLatestVersions: vi.fn().mockRejectedValue(fetchFailure),
    });

    const result = await fetchUpdateVersions(createRequest({
      packageFiles,
      identities: [identity('react', packageFiles[0] ?? '')],
      onRootFailure,
      onProgress: value => progress.push(value),
    }), dependencies);

    expect(result).toMatchObject({
      coordinationKeys: new Map([[packageFiles[0], '/workspace']]),
      acceptedVersions: new Map(),
      failedPackageFilePaths: packageFiles,
      failures: [
        { packageFilePath: packageFiles[0], error: fetchFailure },
        { packageFilePath: packageFiles[1], error: resolutionFailure },
      ],
      firstFailure: fetchFailure,
    });
    expect(onRootFailure).toHaveBeenCalledTimes(2);
    expect(progress.map(event => event.phase)).toEqual(['versions', 'versions']);
    expect(progress[0]).toMatchObject({ completedFiles: 0, totalFiles: 1, packageCount: 1 });
    expect(progress[1]).toMatchObject({ completedFiles: 1, totalFiles: 1, lastPackageFilePath: packageFiles[0] });
  });

  it('stops phase one before resolving coordinator keys when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const progress = vi.fn();
    const dependencies = createDependencies();

    await expect(fetchUpdateVersions(createRequest({ signal: controller.signal, onProgress: progress }), dependencies))
      .resolves.toBeUndefined();

    expect(dependencies.resolveMutationCoordinatorKey).not.toHaveBeenCalled();
    expect(dependencies.fetchAllLatestVersions).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});