import { startRootOperations } from '../utils';
import type { PackageMetadataOutcome, RootOperationResult } from '../utils';
import {
  addPackageUpdatesByIdentity,
  groupPackageIdentitiesByFile,
  packageIdentityKey,
} from './packageIdentity';
import type { PackageIdentityTuple } from './packageIdentity';
import type { UpdateOrchestrationDependencies, UpdateOrchestrationRequest, UpdateRootFailure } from './updateOrchestrationTypes';

interface CoordinationKeyResults {
  readonly keys: ReadonlyMap<string, string>;
  readonly failures: ReadonlyMap<string, unknown>;
}

export interface UpdateVersionFetchResult {
  readonly coordinationKeys: ReadonlyMap<string, string>;
  readonly acceptedVersions: ReadonlyMap<string, string>;
  readonly failedPackageFilePaths: readonly string[];
  readonly failures: readonly UpdateRootFailure[];
  readonly firstFailure: unknown;
}

interface MetadataLookup {
  readonly identity: PackageIdentityTuple;
  readonly key: string;
  readonly coordinationKey: string;
}

export async function fetchUpdateVersions(
  request: UpdateOrchestrationRequest,
  dependencies: UpdateOrchestrationDependencies,
): Promise<UpdateVersionFetchResult | undefined> {
  const coordination = await resolveCheckCoordinationKeys(request.packageFiles, request.signal, dependencies);
  if (coordination === undefined) {
    return undefined;
  }

  coordination.failures.forEach(() => request.onRootFailure?.());
  const entries = createFetchEntries(request.packageFiles, coordination.keys);
  const outcomes = await fetchLatestVersionOutcomes(request, dependencies, entries);
  if (outcomes === undefined || request.signal.aborted) {
    return undefined;
  }

  return collectVersionFetchResults(request, coordination, entries, outcomes);
}

export async function fetchMetadataOutcomes(
  identities: readonly PackageIdentityTuple[],
  coordinationKeys: ReadonlyMap<string, string>,
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<(PackageMetadataOutcome | undefined)[] | undefined> {
  const lookups = await resolveMetadataLookups(identities, coordinationKeys, signal, dependencies);
  if (lookups === undefined || signal.aborted) {
    return undefined;
  }
  const uniqueEntries = uniqueMetadataRequests(lookups);
  const outcomes = await fetchUniqueMetadataOutcomes(uniqueEntries, signal, dependencies);
  if (outcomes === undefined || signal.aborted) {
    return undefined;
  }
  return alignMetadataOutcomes(identities, lookups, uniqueEntries, outcomes);
}

async function resolveCheckCoordinationKeys(
  packageFiles: readonly string[],
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<CoordinationKeyResults | undefined> {
  const resolutionRun = startRootOperations(
    packageFiles,
    packageFilePath => packageFilePath,
    dependencies.checkCoordinator,
    signal,
    packageFilePath => dependencies.resolveMutationCoordinatorKey(packageFilePath),
  );
  const results = await resolutionRun.result;
  return signal.aborted ? undefined : collectCoordinationKeyResults(packageFiles, results);
}

function collectCoordinationKeyResults(
  packageFiles: readonly string[],
  results: readonly RootOperationResult<string>[],
): CoordinationKeyResults {
  const keys = new Map<string, string>();
  const failures = new Map<string, unknown>();
  results.forEach((result, index) => {
    const packageFilePath = packageFiles[index];
    if (packageFilePath === undefined) {
      return;
    }
    if (result.status === 'success') {
      keys.set(packageFilePath, result.value);
    }
    else if (result.status === 'failure') {
      failures.set(packageFilePath, result.error);
    }
  });
  return { keys, failures };
}

function createFetchEntries(
  packageFiles: readonly string[],
  coordinationKeys: ReadonlyMap<string, string>,
): readonly (readonly [string, string])[] {
  return packageFiles.flatMap((packageFilePath) => {
    const coordinationKey = coordinationKeys.get(packageFilePath);
    return coordinationKey === undefined ? [] : [[packageFilePath, coordinationKey]];
  });
}

function fetchLatestVersionOutcomes(
  request: UpdateOrchestrationRequest,
  dependencies: UpdateOrchestrationDependencies,
  entries: readonly (readonly [string, string])[],
): Promise<readonly RootOperationResult<ReadonlyMap<string, string>>[] | undefined> {
  const fetchRun = startRootOperations(
    entries,
    ([, coordinationKey]) => coordinationKey,
    dependencies.checkCoordinator,
    request.signal,
    ([packageFilePath]) => dependencies.fetchAllLatestVersions(
      packageFilePath,
      request.target,
      request.includePreReleases,
      request.minimumReleaseAgeDays,
    ),
  );
  return fetchRun.result;
}

function collectVersionFetchResults(
  request: UpdateOrchestrationRequest,
  coordination: CoordinationKeyResults,
  entries: readonly (readonly [string, string])[],
  outcomes: readonly RootOperationResult<ReadonlyMap<string, string>>[],
): UpdateVersionFetchResult {
  const acceptedVersions = new Map<string, string>();
  const failures = new Map(coordination.failures);
  const identitiesByPackageFile = groupPackageIdentitiesByFile(request.identities);
  outcomes.forEach((outcome, index) => {
    const packageFilePath = entries[index]?.[0];
    if (packageFilePath === undefined || outcome.status !== 'failure') {
      if (packageFilePath !== undefined && outcome.status === 'success') {
        addPackageUpdatesByIdentity(
          acceptedVersions,
          identitiesByPackageFile.get(packageFilePath) ?? [],
          outcome.value,
        );
      }
      return;
    }
    failures.set(packageFilePath, outcome.error);
    request.onRootFailure?.();
  });

  const orderedFailures = request.packageFiles.flatMap((packageFilePath) => {
    const error = failures.get(packageFilePath);
    return failures.has(packageFilePath) ? [{ packageFilePath, error }] : [];
  });
  return {
    coordinationKeys: coordination.keys,
    acceptedVersions,
    failedPackageFilePaths: orderedFailures.map(failure => failure.packageFilePath),
    failures: orderedFailures,
    firstFailure: orderedFailures[0]?.error,
  };
}

async function resolveMetadataLookups(
  identities: readonly PackageIdentityTuple[],
  coordinationKeys: ReadonlyMap<string, string>,
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<MetadataLookup[] | undefined> {
  const lookupRun = startRootOperations(
    identities,
    identity => identity.packageFilePath,
    dependencies.checkCoordinator,
    signal,
    identity => dependencies.metadataCoordinator.runExclusive(
      identity.packageFilePath,
      async (): Promise<MetadataLookup> => {
        let registryKey: string | undefined;
        try {
          registryKey = await dependencies.resolveMetadataRegistryKey(
            identity.packageName,
            identity.packageFilePath,
          );
        }
        catch {
          registryKey = undefined;
        }
        const coordinationKey = coordinationKeys.get(identity.packageFilePath);
        if (coordinationKey === undefined) {
          throw new Error('Update metadata requires a canonical coordinator key.');
        }
        return { identity, key: buildMetadataLookupKey(identity, registryKey), coordinationKey };
      },
    ),
  );
  const results = await lookupRun.result;
  if (signal.aborted) {
    return undefined;
  }
  return identities.map((identity, index) => {
    const result = results[index];
    if (result?.status === 'success') {
      return result.value;
    }
    const coordinationKey = coordinationKeys.get(identity.packageFilePath);
    if (coordinationKey === undefined) {
      throw new Error('Update metadata requires a canonical coordinator key.');
    }
    return { identity, key: buildMetadataLookupKey(identity, undefined), coordinationKey };
  });
}

function uniqueMetadataRequests(lookups: readonly MetadataLookup[]): [string, MetadataLookup][] {
  const uniqueRequests = new Map<string, MetadataLookup>();
  lookups.forEach((lookup) => {
    if (!uniqueRequests.has(lookup.key)) {
      uniqueRequests.set(lookup.key, lookup);
    }
  });
  return [...uniqueRequests.entries()];
}

function fetchUniqueMetadataOutcomes(
  entries: readonly (readonly [string, MetadataLookup])[],
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<readonly RootOperationResult<readonly [string, PackageMetadataOutcome | undefined]>[] | undefined> {
  const outcomeRun = startRootOperations(
    entries,
    ([, lookup]) => lookup.coordinationKey,
    dependencies.checkCoordinator,
    signal,
    ([key, lookup], requestSignal) => dependencies.metadataCoordinator.runExclusive(
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
    ),
  );
  return outcomeRun.result;
}

function alignMetadataOutcomes(
  identities: readonly PackageIdentityTuple[],
  lookups: readonly MetadataLookup[],
  uniqueEntries: readonly (readonly [string, MetadataLookup])[],
  outcomes: readonly RootOperationResult<readonly [string, PackageMetadataOutcome | undefined]>[],
): (PackageMetadataOutcome | undefined)[] {
  const outcomesByKey = new Map<string, PackageMetadataOutcome | undefined>();
  outcomes.forEach((result, index) => {
    const key = uniqueEntries[index]?.[0];
    if (key !== undefined) {
      outcomesByKey.set(key, result.status === 'success' ? result.value[1] : undefined);
    }
  });
  const keyByIdentity = new Map(lookups.map(({ identity, key }) => [packageIdentityKey(identity), key]));
  return identities.map(identity => outcomesByKey.get(keyByIdentity.get(packageIdentityKey(identity)) ?? ''));
}

function buildMetadataLookupKey(identity: PackageIdentityTuple, registryKey: string | undefined): string {
  return [identity.packageName, registryKey ?? `unresolved:${identity.packageFilePath}`].join('\u0000');
}