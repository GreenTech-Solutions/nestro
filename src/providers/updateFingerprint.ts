import { compareCodeUnits } from '../shared';
import type { PackageIdentityTuple } from './packageIdentity';
import type { UpdateFingerprintPolicy, UpdateOrchestrationDependencies } from './updateOrchestrationTypes';

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

  return JSON.stringify({
    entries: [...entryFingerprints].sort(compareCodeUnits),
    target: policy.target,
    includePreReleases: policy.includePreReleases,
    minimumReleaseAgeDays: policy.minimumReleaseAgeDays,
  });
}