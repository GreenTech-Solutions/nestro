import { startRootOperations } from '../utils';
import type { PackageMetadataOutcome, RootOperationResult } from '../utils';
import { packageIdentityKey } from './packageIdentity';
import type { PackageIdentityTuple } from './packageIdentity';
import type { UpdateCheckProgress, UpdateOrchestrationDependencies } from './updateOrchestrationTypes';

interface MetadataLookup {
  readonly identity: PackageIdentityTuple;
  readonly key: string;
  readonly coordinationKey: string;
}

export async function fetchMetadataOutcomes(
  identities: readonly PackageIdentityTuple[],
  coordinationKeys: ReadonlyMap<string, string>,
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
  onProgress?: (progress: UpdateCheckProgress) => void,
): Promise<(PackageMetadataOutcome | undefined)[] | undefined> {
  const lookups = await resolveMetadataLookups(identities, coordinationKeys, signal, dependencies);
  if (lookups === undefined || signal.aborted) {
    return undefined;
  }
  const uniqueEntries = uniqueMetadataRequests(lookups);
  onProgress?.({ phase: 'release-dates', completed: 0, total: uniqueEntries.length });
  let completed = 0;
  const outcomes = await fetchUniqueMetadataOutcomes(uniqueEntries, signal, dependencies, () => {
    if (!signal.aborted) {
      completed += 1;
      onProgress?.({ phase: 'release-dates', completed, total: uniqueEntries.length });
    }
  });
  if (outcomes === undefined || signal.aborted) {
    return undefined;
  }
  return alignMetadataOutcomes(identities, lookups, uniqueEntries, outcomes);
}

async function resolveMetadataLookups(
  identities: readonly PackageIdentityTuple[],
  coordinationKeys: ReadonlyMap<string, string>,
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<MetadataLookup[] | undefined> {
  const lookupRun = startRootOperations(
    identities,
    identity => packageIdentityKey(identity),
    dependencies.metadataCoordinator,
    signal,
    async (identity): Promise<MetadataLookup> => {
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
  onRequestComplete: () => void,
): Promise<readonly RootOperationResult<readonly [string, PackageMetadataOutcome | undefined]>[] | undefined> {
  const outcomeRun = startRootOperations(
    entries,
    ([key, lookup]) => lookup.coordinationKey + '\u0000' + key,
    dependencies.metadataCoordinator,
    signal,
    async ([key, lookup], requestSignal): Promise<readonly [string, PackageMetadataOutcome | undefined]> => {
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
      finally {
        if (!requestSignal.aborted) {
          onRequestComplete();
        }
      }
    },
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
  return [identity.packageName, registryKey ?? 'unresolved:' + identity.packageFilePath].join('\u0000');
}