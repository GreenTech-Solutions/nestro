import { describe, expect, it, vi } from 'vitest';
import {
  computeUpdateFingerprint,
  UpdateOrchestrationService,
} from '../providers';
import type {
  CanonicalPackageLocation,
  PackageIdentityTuple,
  UpdateOrchestrationDependencies,
  UpdateOrchestrationRequest,
  UpdateOrchestrationResult,
} from '../providers';
import { OperationCoordinator } from '../utils';
import type { PackageMetadataOutcome } from '../utils';

function identity(
  packageName: string,
  packageFilePath: string,
  section: 'dependencies' | 'devDependencies' = 'dependencies',
): PackageIdentityTuple {
  return { packageName, packageFilePath, section };
}

function location(packageFilePath: string): CanonicalPackageLocation {
  return {
    packageFilePath,
    packageDirectory: packageFilePath.replace(/\/package\.json$/, ''),
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: `${packageFilePath}:digest`,
  };
}

/** Builds a fully deterministic dependency set; individual fields are overridden per test. */
function createDependencies(
  overrides: Partial<UpdateOrchestrationDependencies> = {},
): UpdateOrchestrationDependencies {
  return {
    checkCoordinator: new OperationCoordinator(4),
    metadataCoordinator: new OperationCoordinator(4),
    fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map()),
    resolveMetadataRegistryKey: vi.fn().mockResolvedValue(undefined),
    fetchPackageMetadata: vi.fn().mockResolvedValue({
      kind: 'unavailable',
    } as unknown as PackageMetadataOutcome),
    resolveMutationCoordinatorKey: vi.fn((packageFilePath: string) => Promise.resolve(packageFilePath)),
    resolveCanonicalPackageLocation: vi.fn((packageFilePath: string) => Promise.resolve({
      ok: true as const,
      value: location(packageFilePath),
    })),
    readCanonicalDependencySpecs: vi.fn((_location, identities: readonly PackageIdentityTuple[]) => Promise.resolve(
      identities.map(() => '^1.0.0'),
    )),
    now: () => 0,
    ...overrides,
  };
}

/** Builds a request with every callback wired to a no-op, so a test only overrides what it checks. */
function createRequest(overrides: Partial<UpdateOrchestrationRequest> = {}): UpdateOrchestrationRequest {
  const packageFiles = overrides.packageFiles ?? ['/workspace/package.json'];
  const identities = overrides.identities ?? [identity('react', packageFiles[0])];
  return {
    identities,
    currentVersions: new Map(identities.map(id => [`${id.packageFilePath}\0${id.packageName}\0${id.section}`, '1.0.0'])),
    packageFiles,
    target: 'latest',
    includePreReleases: false,
    minimumReleaseAgeDays: 0,
    forceAlways: false,
    debounceSeconds: 60,
    lastCheckTime: undefined,
    signal: new AbortController().signal,
    isCurrent: () => true,
    resolveCurrentPolicy: () => ({ target: 'latest', includePreReleases: false, minimumReleaseAgeDays: 0 }),
    ...overrides,
  };
}

function expectCompleted(result: UpdateOrchestrationResult): result is UpdateOrchestrationResult & { kind: 'completed' } {
  expect(result.kind).toBe('completed');
  return result.kind === 'completed';
}

describe('UpdateOrchestrationService', () => {
  describe('computeUpdateFingerprint', () => {
    it('changes when minimum release age changes', async () => {
      const dependencies = createDependencies();
      const identities = [identity('react', '/workspace/package.json')];

      const base = await computeUpdateFingerprint(identities, {
        target: 'latest',
        includePreReleases: false,
        minimumReleaseAgeDays: 7,
      }, dependencies);
      const changed = await computeUpdateFingerprint(identities, {
        target: 'latest',
        includePreReleases: false,
        minimumReleaseAgeDays: 14,
      }, dependencies);

      expect(changed).not.toBe(base);
    });

    it('keys an unresolvable manifest by its rejection reason instead of collapsing to a path-only key', async () => {
      const identities = [identity('react', '/workspace/package.json')];
      const dependencies = createDependencies({
        resolveCanonicalPackageLocation: vi.fn().mockResolvedValue({ ok: false, reason: 'unresolvable-path' }),
      });

      const fingerprint = await computeUpdateFingerprint(identities, {
        target: 'latest',
        includePreReleases: false,
        minimumReleaseAgeDays: 7,
      }, dependencies);

      expect(fingerprint).toContain('unresolvable-path');
    });
  });

  describe('cache contract', () => {
    it('fetches once, reuses the cache on a matching fingerprint, and refetches after invalidation', async () => {
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map([['react', '2.0.0']])),
      });
      const service = new UpdateOrchestrationService(dependencies);
      const onCheckStarted = vi.fn();
      const request = createRequest({ onCheckStarted });

      const first = await service.check(request);
      if (!expectCompleted(first)) {
        return;
      }
      expect(first.data.get('/workspace/package.json\0react\0dependencies')?.acceptedVersion).toBe('2.0.0');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledOnce();

      const second = await service.check(request);
      expect(second.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledOnce();
      expect(onCheckStarted).toHaveBeenCalledTimes(2);

      service.invalidateCache();
      const third = await service.check(request);
      expect(third.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    });

    it('skips a fresh cache-policy match under the debounce window unless forceAlways is set', async () => {
      let currentNow = 1_000;
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map([['react', '2.0.0']])),
        now: () => currentNow,
      });
      const service = new UpdateOrchestrationService(dependencies);
      await service.check(createRequest());
      currentNow += 5_000;

      const debounced = await service.check(createRequest({ lastCheckTime: currentNow - 1_000, debounceSeconds: 60 }));
      expect(debounced.kind).toBe('debounced');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledOnce();

      const forced = await service.check(createRequest({
        lastCheckTime: currentNow - 1_000,
        debounceSeconds: 60,
        forceAlways: true,
      }));
      expect(forced.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancellation and staleness', () => {
    it('discards as cancelled when the signal is already aborted, without fetching', async () => {
      const dependencies = createDependencies();
      const service = new UpdateOrchestrationService(dependencies);
      const controller = new AbortController();
      controller.abort();

      const result = await service.check(createRequest({ signal: controller.signal }));

      expect(result).toEqual({ kind: 'discarded', reason: 'cancelled' });
      expect(dependencies.fetchAllLatestVersions).not.toHaveBeenCalled();
    });

    it('discards a completion that arrives after it has been superseded, without caching it', async () => {
      let current = true;
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockImplementationOnce(() => {
          // A newer operation (a reload, or another check) takes over while this
          // fetch is still in flight — modeling an out-of-order completion.
          current = false;
          return Promise.resolve(new Map([['react', '2.0.0']]));
        }),
      });
      const service = new UpdateOrchestrationService(dependencies);

      const result = await service.check(createRequest({ isCurrent: () => current }));

      expect(result).toEqual({ kind: 'discarded', reason: 'cancelled' });

      // The discarded run must not have left a cache entry for a later, current check to reuse.
      current = true;
      vi.mocked(dependencies.fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '3.0.0']]));
      const followUp = await service.check(createRequest({ isCurrent: () => current, forceAlways: true }));
      expect(followUp.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    });

    it('discards as stale when the manifest spec changes mid-fetch, and does not cache the result', async () => {
      let spec = '^1.0.0';
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockImplementationOnce(() => {
          spec = '^2.0.0';
          return Promise.resolve(new Map([['react', '2.0.0']]));
        }),
        readCanonicalDependencySpecs: vi.fn((_location, identities: readonly PackageIdentityTuple[]) => Promise.resolve(
          identities.map(() => spec),
        )),
      });
      const service = new UpdateOrchestrationService(dependencies);
      const onDiscarded = vi.fn();

      const result = await service.check(createRequest({ onDiscarded }));

      expect(result).toEqual({ kind: 'discarded', reason: 'stale' });
      expect(onDiscarded).toHaveBeenCalledOnce();

      // The manifest is now stable at the changed spec, so a fresh check succeeds
      // instead of inheriting a poisoned cache from the discarded run.
      vi.mocked(dependencies.fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));
      const nextCheck = await service.check(createRequest());
      expect(nextCheck.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    });

    it('discards as invalidated when the cache is invalidated mid-fetch', async () => {
      let resolveFetch: ((value: Map<string, string>) => void) | undefined;
      let markFetchStarted: () => void = () => {};
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
          resolveFetch = resolve;
          markFetchStarted();
        })),
      });
      const service = new UpdateOrchestrationService(dependencies);
      const onDiscarded = vi.fn();

      const pending = service.check(createRequest({ onDiscarded }));
      await fetchStarted;
      service.invalidateCache();
      const finishFetch = resolveFetch;
      if (finishFetch === undefined) {
        throw new Error('The fetch resolver was not initialized.');
      }
      finishFetch(new Map([['react', '2.0.0']]));

      await expect(pending).resolves.toEqual({ kind: 'discarded', reason: 'invalidated' });
      expect(onDiscarded).toHaveBeenCalledOnce();
    });

    it('discards as stale when the live policy changes mid-fetch', async () => {
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map([['react', '2.0.0']])),
      });
      const service = new UpdateOrchestrationService(dependencies);

      const result = await service.check(createRequest({
        resolveCurrentPolicy: () => ({ target: 'minor', includePreReleases: false, minimumReleaseAgeDays: 0 }),
      }));

      expect(result).toEqual({ kind: 'discarded', reason: 'stale' });
    });
  });

  describe('partial and total root failure', () => {
    it('reports a partial failure without caching, and calls onRootFailure once per failed root', async () => {
      const packageFiles = ['/workspace/a/package.json', '/workspace/b/package.json'];
      const identities = [identity('react', packageFiles[0]), identity('vite', packageFiles[1])];
      const failure = new Error('network down');
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn((packageFilePath: string) => (
          packageFilePath === packageFiles[1]
            ? Promise.reject(failure)
            : Promise.resolve(new Map([['react', '2.0.0']]))
        )),
      });
      const service = new UpdateOrchestrationService(dependencies);
      const onRootFailure = vi.fn();

      const result = await service.check(createRequest({ packageFiles, identities, onRootFailure }));

      if (!expectCompleted(result)) {
        return;
      }
      expect(result.allFailed).toBe(false);
      expect(result.failedPackageFilePaths).toEqual([packageFiles[1]]);
      expect(result.failures).toEqual([{ packageFilePath: packageFiles[1], error: failure }]);
      expect(onRootFailure).toHaveBeenCalledOnce();

      const followUp = await service.check(createRequest({ packageFiles, identities, forceAlways: false }));
      expect(followUp.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(4);
    });

    it('reports allFailed and clears a previously cached result when every root fails', async () => {
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map([['react', '2.0.0']])),
      });
      const service = new UpdateOrchestrationService(dependencies);
      const warm = await service.check(createRequest());
      expect(warm.kind).toBe('completed');

      const failure = new Error('registry unreachable');
      vi.mocked(dependencies.fetchAllLatestVersions).mockRejectedValueOnce(failure);
      const result = await service.check(createRequest({ forceAlways: true }));

      if (!expectCompleted(result)) {
        return;
      }
      expect(result.allFailed).toBe(true);
      expect(result.failure).toBe(failure);
      expect(result.data.size).toBe(0);

      // The all-failed run cleared the earlier cache commit, so a fresh cache-eligible
      // check must fetch again rather than silently replaying the pre-failure data.
      vi.mocked(dependencies.fetchAllLatestVersions).mockResolvedValue(new Map([['react', '2.0.0']]));
      const recovered = await service.check(createRequest({ forceAlways: true }));
      expect(recovered.kind).toBe('completed');
      expect(dependencies.fetchAllLatestVersions).toHaveBeenCalledTimes(3);
    });
  });

  describe('release age wiring', () => {
    it('fetches metadata and classifies release age only when minimumReleaseAgeDays is non-zero', async () => {
      const metadataOutcome: PackageMetadataOutcome = {
        kind: 'success',
        result: {
          versions: ['1.0.0', '2.0.0'],
          distTags: { latest: '2.0.0' },
          publishTimes: { kind: 'not-provided' },
        },
      } as unknown as PackageMetadataOutcome;
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map([['react', '2.0.0']])),
        fetchPackageMetadata: vi.fn().mockResolvedValue(metadataOutcome),
      });
      const service = new UpdateOrchestrationService(dependencies);

      const result = await service.check(createRequest({
        minimumReleaseAgeDays: 7,
        resolveCurrentPolicy: () => ({ target: 'latest', includePreReleases: false, minimumReleaseAgeDays: 7 }),
      }));

      if (!expectCompleted(result)) {
        return;
      }
      expect(dependencies.fetchPackageMetadata).toHaveBeenCalledOnce();
      const data = result.data.get('/workspace/package.json\0react\0dependencies');
      expect(data?.releaseAge.kind).toBe('unknown');
    });

    it('never calls fetchPackageMetadata when minimumReleaseAgeDays is zero', async () => {
      const dependencies = createDependencies({
        fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map([['react', '2.0.0']])),
      });
      const service = new UpdateOrchestrationService(dependencies);

      const result = await service.check(createRequest({ minimumReleaseAgeDays: 0 }));

      expect(result.kind).toBe('completed');
      expect(dependencies.fetchPackageMetadata).not.toHaveBeenCalled();
    });
  });

  describe('withCoordinators', () => {
    it('builds a service backed by the shared coordinators and default dependencies', async () => {
      const service = UpdateOrchestrationService.withCoordinators(
        new OperationCoordinator(4),
        new OperationCoordinator(4),
      );

      const result = await service.check(createRequest({ packageFiles: [], identities: [] }));

      expect(result.kind).toBe('completed');
    });
  });
});