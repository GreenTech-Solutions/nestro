import { resolveUpdateReleaseAge } from '../utils';
import type { PackageIdentityTuple } from './packageIdentity';
import { packageIdentityKey } from './packageIdentity';
import type { CachedUpdateData } from './updateOrchestrationTypes';
import type { PackageMetadataOutcome } from '../utils';

export function classifyUpdateReleaseAges(
  identities: readonly PackageIdentityTuple[],
  currentVersions: ReadonlyMap<string, string>,
  acceptedVersions: ReadonlyMap<string, string>,
  metadataOutcomes: readonly (PackageMetadataOutcome | undefined)[],
  minimumReleaseAgeDays: number,
): ReadonlyMap<string, CachedUpdateData> {
  const updateData = new Map<string, CachedUpdateData>();
  identities.forEach((identity, index) => {
    const key = packageIdentityKey(identity);
    const acceptedVersion = acceptedVersions.get(key);
    updateData.set(key, {
      acceptedVersion,
      releaseAge: resolveUpdateReleaseAge(
        currentVersions.get(key) ?? '',
        acceptedVersion,
        metadataOutcomes[index],
        minimumReleaseAgeDays,
      ),
    });
  });
  return updateData;
}