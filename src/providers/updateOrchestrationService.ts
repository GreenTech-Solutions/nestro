import { resolveMutationCoordinatorKey } from '../clients';
import * as utils from '../utils';
import type { NcuUpdateTarget, OperationCoordinator, PackageMetadataOutcome, ReleaseAgeState } from '../utils';
import { startRootOperations } from '../utils';
import {
  packageIdentityKey,
  readCanonicalDependencySpecs,
  resolveCanonicalPackageLocation,
} from './packageIdentity';
import type {
  CanonicalPackageLocation,
  CanonicalPackageLocationResult,
  PackageIdentityTuple,
} from './packageIdentity';

export interface CachedUpdateData {
  readonly acceptedVersion: string | undefined;
  readonly releaseAge: ReleaseAgeState;
}

export interface UpdateFingerprintPolicy {
  readonly target: NcuUpdateTarget;
  readonly includePreReleases: boolean;
  readonly minimumReleaseAgeDays: number;
}

export interface UpdateOrchestrationRequest {
  readonly identities: readonly PackageIdentityTuple[];
  readonly currentVersions: ReadonlyMap<string, string>;
  readonly packageFiles: readonly string[];
  readonly target: NcuUpdateTarget;
  readonly includePreReleases: boolean;
  readonly minimumReleaseAgeDays: number;
  readonly forceAlways: boolean;
  readonly debounceSeconds: number;
  readonly lastCheckTime: number | undefined;
  readonly signal: AbortSignal;
  /** Provider-owned operation and snapshot generation guard. */
  readonly isCurrent: () => boolean;
  /** Re-reads the live policy right before committing a fetch, catching a setting changed mid-flight. */
  readonly resolveCurrentPolicy: () => UpdateFingerprintPolicy;
  readonly onCheckStarted?: () => void;
  readonly onCheckCompleted?: () => void;
  readonly onRootFailure?: () => void;
  readonly onDiscarded?: () => void;
}

export interface UpdateRootFailure {
  readonly packageFilePath: string;
  readonly error: unknown;
}

export type UpdateOrchestrationResult
  = | {
    readonly kind: 'completed';
    readonly data: ReadonlyMap<string, CachedUpdateData>;
    readonly failedPackageFilePaths: readonly string[];
    readonly failures: readonly UpdateRootFailure[];
    readonly allFailed: boolean;
    readonly failure?: unknown;
  }
  | { readonly kind: 'debounced' }
  | {
    readonly kind: 'discarded';
    readonly reason: 'cancelled' | 'stale' | 'invalidated';
  };

export interface UpdateOrchestrationDependencies {
  readonly checkCoordinator: OperationCoordinator;
  readonly metadataCoordinator: OperationCoordinator;
  readonly fetchAllLatestVersions: (
    packageFilePath: string,
    target: NcuUpdateTarget,
    includePreReleases: boolean,
    minimumReleaseAgeDays: number,
  ) => Promise<ReadonlyMap<string, string>>;
  readonly resolveMetadataRegistryKey: (
    packageName: string,
    packageFilePath: string,
  ) => Promise<string | undefined>;
  readonly fetchPackageMetadata: (
    packageName: string,
    packageFilePath: string,
    signal: AbortSignal,
  ) => Promise<PackageMetadataOutcome>;
  readonly resolveMutationCoordinatorKey: (
    packageFilePath: string,
  ) => Promise<string>;
  readonly resolveCanonicalPackageLocation: (
    packageFilePath: string,
  ) => Promise<CanonicalPackageLocationResult>;
  readonly readCanonicalDependencySpecs: (
    location: CanonicalPackageLocation,
    identities: readonly PackageIdentityTuple[],
  ) => Promise<(string | undefined)[]>;
  readonly now: () => number;
}

export interface UpdateOrchestrationServiceContract {
  check(request: UpdateOrchestrationRequest): Promise<UpdateOrchestrationResult>;
  invalidateCache(): void;
  computeFingerprint(
    identities: readonly PackageIdentityTuple[],
    policy: UpdateFingerprintPolicy,
  ): Promise<string>;
}

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

function createDefaultDependencies(
  checkCoordinator: OperationCoordinator,
  metadataCoordinator: OperationCoordinator,
): UpdateOrchestrationDependencies {
  return {
    checkCoordinator,
    metadataCoordinator,
    fetchAllLatestVersions: (packageFilePath, target, includePreReleases, minimumReleaseAgeDays) => (
      utils.fetchAllLatestVersions(packageFilePath, target, includePreReleases, minimumReleaseAgeDays)
    ),
    resolveMetadataRegistryKey: (packageName, packageFilePath) => (
      utils.resolveMetadataRegistryKey(packageName, packageFilePath)
    ),
    fetchPackageMetadata: (packageName, packageFilePath, signal) => (
      utils.fetchPackageMetadata(packageName, packageFilePath, signal)
    ),
    // Wrapped rather than passed by reference, so a caller mocking `../clients` or
    // `./index` without this export only fails when the dependency is actually invoked.
    resolveMutationCoordinatorKey: packageFilePath => resolveMutationCoordinatorKey(packageFilePath),
    resolveCanonicalPackageLocation: packageFilePath => resolveCanonicalPackageLocation(packageFilePath),
    readCanonicalDependencySpecs: (location, identities) => readCanonicalDependencySpecs(location, identities),
    now: () => Date.now(),
  };
}

export async function computeUpdateFingerprint(
  identities: readonly PackageIdentityTuple[],
  policy: UpdateFingerprintPolicy,
  dependencies: Pick<
    UpdateOrchestrationDependencies,
    'resolveCanonicalPackageLocation' | 'readCanonicalDependencySpecs'
  >,
): Promise<string> {
  const byManifest = new Map<string, PackageIdentityTuple[]>();
  for (const identity of identities) {
    const group = byManifest.get(identity.packageFilePath);
    if (group === undefined) {
      byManifest.set(identity.packageFilePath, [identity]);
    }
    else {
      group.push(identity);
    }
  }

  const entryFingerprints: string[] = [];
  for (const [packageFilePath, manifestIdentities] of byManifest) {
    const location = await dependencies.resolveCanonicalPackageLocation(packageFilePath);
    if (!location.ok) {
      for (const identity of manifestIdentities) {
        entryFingerprints.push(JSON.stringify([
          packageFilePath,
          identity.section,
          identity.packageName,
          null,
          location.reason,
        ]));
      }
      continue;
    }

    const specs = await dependencies.readCanonicalDependencySpecs(location.value, manifestIdentities);
    manifestIdentities.forEach((identity, index) => {
      entryFingerprints.push(JSON.stringify([
        location.value.packageFilePath,
        identity.section,
        identity.packageName,
        specs[index] ?? null,
        'ok',
      ]));
    });
  }

  entryFingerprints.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify({
    entries: entryFingerprints,
    target: policy.target,
    includePreReleases: policy.includePreReleases,
    minimumReleaseAgeDays: policy.minimumReleaseAgeDays,
  });
}

interface MetadataLookup {
  readonly identity: PackageIdentityTuple;
  readonly key: string;
  readonly coordinationKey: string;
}

async function fetchMetadataOutcomes(
  identities: readonly PackageIdentityTuple[],
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<(PackageMetadataOutcome | undefined)[] | undefined> {
  const lookupRun = startRootOperations(
    identities,
    identity => identity.packageFilePath,
    dependencies.checkCoordinator,
    signal,
    (identity): Promise<MetadataLookup> => dependencies.metadataCoordinator.runExclusive(
      identity.packageFilePath,
      async (): Promise<MetadataLookup> => {
        let registryKey: string | undefined;
        let coordinationKey = identity.packageFilePath;
        try {
          registryKey = await dependencies.resolveMetadataRegistryKey(
            identity.packageName,
            identity.packageFilePath,
          );
        }
        catch {
          registryKey = undefined;
        }
        try {
          coordinationKey = await dependencies.resolveMutationCoordinatorKey(identity.packageFilePath);
        }
        catch {
          coordinationKey = identity.packageFilePath;
        }
        return {
          identity,
          key: buildMetadataLookupKey(identity, registryKey),
          coordinationKey,
        };
      },
    ),
  );
  const lookupResults = await lookupRun.result;
  if (signal.aborted) {
    return undefined;
  }

  const lookups: MetadataLookup[] = lookupResults.map((result, index) => {
    if (result.status === 'success') {
      return result.value;
    }
    const identity = identities[index];
    return {
      identity,
      key: buildMetadataLookupKey(identity, undefined),
      coordinationKey: identity.packageFilePath,
    };
  });
  const uniqueRequests = new Map<string, MetadataLookup>();
  lookups.forEach((lookup) => {
    if (!uniqueRequests.has(lookup.key)) {
      uniqueRequests.set(lookup.key, lookup);
    }
  });
  const uniqueEntries = [...uniqueRequests.entries()];
  const outcomeRun = startRootOperations(
    uniqueEntries,
    ([, lookup]) => lookup.coordinationKey,
    dependencies.checkCoordinator,
    signal,
    ([key, lookup], requestSignal): Promise<readonly [string, PackageMetadataOutcome | undefined]> => (
      dependencies.metadataCoordinator.runExclusive(
        `${lookup.coordinationKey}\u0000${lookup.key}`,
        async (): Promise<readonly [string, PackageMetadataOutcome | undefined]> => {
          try {
            return [key, await dependencies.fetchPackageMetadata(
              lookup.identity.packageName,
              lookup.identity.packageFilePath,
              requestSignal,
            )];
          }
          catch {
            return [key, undefined];
          }
        },
      )
    ),
  );
  const outcomes = await outcomeRun.result;
  if (signal.aborted) {
    return undefined;
  }

  const outcomesByKey = new Map<string, PackageMetadataOutcome | undefined>();
  outcomes.forEach((result, index) => {
    const entry = uniqueEntries[index];
    if (entry === undefined) {
      return;
    }
    outcomesByKey.set(entry[0], result.status === 'success' ? result.value[1] : undefined);
  });
  const keyByIdentity = new Map(lookups.map(({ identity, key }) => [packageIdentityKey(identity), key]));
  return identities.map(identity => outcomesByKey.get(
    keyByIdentity.get(packageIdentityKey(identity)) ?? '',
  ));
}

function buildMetadataLookupKey(identity: PackageIdentityTuple, registryKey: string | undefined): string {
  return [identity.packageName, registryKey ?? `unresolved:${identity.packageFilePath}`].join('\u0000');
}

function buildPolicyKey(
  packageFiles: readonly string[],
  policy: UpdateFingerprintPolicy,
): string {
  const files = [...packageFiles].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify({
    files,
    target: policy.target,
    includePreReleases: policy.includePreReleases,
    minimumReleaseAgeDays: policy.minimumReleaseAgeDays,
  });
}

export class UpdateOrchestrationService implements UpdateOrchestrationServiceContract {
  private cache: {
    readonly data: ReadonlyMap<string, CachedUpdateData>;
    readonly timestamp: number;
    readonly policyKey: string;
    readonly fingerprint: string;
  } | undefined;

  private cacheGeneration = 0;

  constructor(private readonly dependencies: UpdateOrchestrationDependencies) {}

  static withCoordinators(
    checkCoordinator: OperationCoordinator,
    metadataCoordinator: OperationCoordinator,
  ): UpdateOrchestrationService {
    return new UpdateOrchestrationService(createDefaultDependencies(checkCoordinator, metadataCoordinator));
  }

  invalidateCache(): void {
    this.cache = undefined;
    this.cacheGeneration += 1;
  }

  computeFingerprint(
    identities: readonly PackageIdentityTuple[],
    policy: UpdateFingerprintPolicy,
  ): Promise<string> {
    return computeUpdateFingerprint(identities, policy, this.dependencies);
  }

  async check(request: UpdateOrchestrationRequest): Promise<UpdateOrchestrationResult> {
    const policy: UpdateFingerprintPolicy = {
      target: request.target,
      includePreReleases: request.includePreReleases,
      minimumReleaseAgeDays: request.minimumReleaseAgeDays,
    };
    const policyKey = buildPolicyKey(request.packageFiles, policy);
    const now = this.dependencies.now();
    const cacheGeneration = this.cacheGeneration;
    if (!request.forceAlways
      && this.cache !== undefined
      && this.cache.policyKey === policyKey
      && this.isFresh(this.cache.timestamp, now)
      && request.lastCheckTime !== undefined) {
      const debounceMs = request.debounceSeconds * 1000;
      if (request.debounceSeconds > 0 && now - request.lastCheckTime < debounceMs) {
        return { kind: 'debounced' };
      }
    }

    if (!request.isCurrent() || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const fingerprint = await this.computeFingerprint(request.identities, policy);
    if (!request.isCurrent() || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const cacheValid = !request.forceAlways
      && this.cache !== undefined
      && this.cache.fingerprint === fingerprint
      && this.isFresh(this.cache.timestamp, now);
    request.onCheckStarted?.();
    if (cacheValid) {
      request.onCheckCompleted?.();
      return {
        kind: 'completed',
        data: this.cache?.data ?? new Map<string, CachedUpdateData>(),
        failedPackageFilePaths: [],
        failures: [],
        allFailed: false,
      };
    }

    const upgrades = new Map<string, string>();
    const failedPackageFilePaths = new Set<string>();
    const failures: UpdateRootFailure[] = [];
    let firstFailure: unknown;
    const coordinationKeys = await this.resolveCheckCoordinationKeys(
      request.packageFiles,
      request.signal,
    );
    if (coordinationKeys === undefined) {
      return { kind: 'discarded', reason: 'cancelled' };
    }
    const fetchRun = startRootOperations(
      request.packageFiles,
      packageFilePath => coordinationKeys.get(packageFilePath) ?? packageFilePath,
      this.dependencies.checkCoordinator,
      request.signal,
      packageFilePath => this.dependencies.fetchAllLatestVersions(
        packageFilePath,
        request.target,
        request.includePreReleases,
        request.minimumReleaseAgeDays,
      ),
    );
    const fetchOutcomes = await fetchRun.result;
    fetchOutcomes.forEach((outcome, index) => {
      const packageFilePath = request.packageFiles[index];
      if (packageFilePath === undefined) {
        return;
      }
      if (outcome.status === 'success') {
        for (const [packageName, version] of outcome.value) {
          upgrades.set(`${packageFilePath}\0${packageName}`, version);
        }
      }
      else if (outcome.status === 'failure') {
        failedPackageFilePaths.add(packageFilePath);
        failures.push({ packageFilePath, error: outcome.error });
        firstFailure ??= outcome.error;
        request.onRootFailure?.();
      }
    });
    if (request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const allFailed = request.packageFiles.length > 0
      && failedPackageFilePaths.size === request.packageFiles.length;
    if (allFailed) {
      this.cache = undefined;
      request.onCheckCompleted?.();
      return {
        kind: 'completed',
        data: new Map(),
        failedPackageFilePaths: [...failedPackageFilePaths],
        failures,
        allFailed: true,
        failure: firstFailure,
      };
    }

    const successfulIdentities = request.identities.filter(
      identity => !failedPackageFilePaths.has(identity.packageFilePath),
    );
    const metadataOutcomes = request.minimumReleaseAgeDays === 0
      ? successfulIdentities.map((): PackageMetadataOutcome | undefined => undefined)
      : await fetchMetadataOutcomes(
          successfulIdentities,
          request.signal,
          this.dependencies,
        );
    if (metadataOutcomes === undefined || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const updateData = new Map<string, CachedUpdateData>();
    successfulIdentities.forEach((identity, index) => {
      const acceptedVersion = upgrades.get(`${identity.packageFilePath}\0${identity.packageName}`);
      updateData.set(
        packageIdentityKey(identity),
        {
          acceptedVersion,
          releaseAge: utils.resolveUpdateReleaseAge(
            request.currentVersions.get(packageIdentityKey(identity)) ?? '',
            acceptedVersion,
            metadataOutcomes[index],
            request.minimumReleaseAgeDays,
          ),
        },
      );
    });

    if (!request.isCurrent() || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }
    const currentPolicy = request.resolveCurrentPolicy();
    const afterFingerprint = await this.computeFingerprint(request.identities, currentPolicy);
    if (!request.isCurrent() || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }
    if (afterFingerprint !== fingerprint) {
      request.onDiscarded?.();
      return { kind: 'discarded', reason: 'stale' };
    }
    if (cacheGeneration !== this.cacheGeneration) {
      request.onDiscarded?.();
      return { kind: 'discarded', reason: 'invalidated' };
    }

    if (failedPackageFilePaths.size > 0) {
      this.cache = undefined;
    }
    else {
      this.cache = {
        data: updateData,
        timestamp: this.dependencies.now(),
        policyKey,
        fingerprint,
      };
    }
    request.onCheckCompleted?.();
    return {
      kind: 'completed',
      data: updateData,
      failedPackageFilePaths: [...failedPackageFilePaths],
      failures,
      allFailed: false,
    };
  }

  private isFresh(timestamp: number, now: number): boolean {
    return now - timestamp < UPDATE_CACHE_TTL_MS;
  }

  private async resolveCheckCoordinationKeys(
    packageFiles: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const resolutionRun = startRootOperations(
      packageFiles,
      packageFilePath => packageFilePath,
      this.dependencies.checkCoordinator,
      signal,
      async (packageFilePath): Promise<string> => {
        try {
          return await this.dependencies.resolveMutationCoordinatorKey(packageFilePath);
        }
        catch {
          return packageFilePath;
        }
      },
    );
    const results = await resolutionRun.result;
    if (signal.aborted) {
      return undefined;
    }
    const keys = new Map<string, string>();
    results.forEach((result, index) => {
      const packageFilePath = packageFiles[index];
      if (packageFilePath === undefined) {
        return;
      }
      keys.set(packageFilePath, result.status === 'success' ? result.value : packageFilePath);
    });
    return keys;
  }
}