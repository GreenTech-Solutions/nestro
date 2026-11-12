import { checkCliMetadataRequest, runCliMetadata } from './metadata/cliAdapter';
import { parsePackument } from './metadata/packument';
import type { MetadataAdapter, MetadataRequest, PackageMetadataOutcome } from './metadataRegistry';
import { PACKAGE_MANAGERS } from '../shared';

const nativePackageManagers = ['npm', 'pnpm'] as const;

/** Runs the package manager's own metadata command in the package root. */
export async function fetchPackageMetadataFromNativeCli(
  request: MetadataRequest,
): Promise<PackageMetadataOutcome> {
  const checked = checkCliMetadataRequest(request, nativePackageManagers);
  if (checked.kind === 'rejected') {
    return checked.outcome;
  }

  const { packageManager, packageRoot } = checked;
  return await runCliMetadata(
    request,
    packageManager,
    PACKAGE_MANAGERS[packageManager].dialect.metadata,
    packageRoot,
    parsePackument,
  );
}

export const nativeCliMetadataAdapter: MetadataAdapter = {
  tier: 'native-cli',
  packageManagers: nativePackageManagers,
  fetchMetadata: fetchPackageMetadataFromNativeCli,
};