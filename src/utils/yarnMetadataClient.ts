import { checkCliMetadataRequest, runCliMetadata } from './metadata/cliAdapter';
import { parsePackument } from './metadata/packument';
import type { MetadataSchemaResult } from './metadataRunner';
import type {
  MetadataAdapter,
  MetadataRequest,
  PackageMetadata,
  PackageMetadataOutcome,
} from './metadataRegistry';
import { resolveYarnFamily } from './yarnFamily';
import { isRecord, YARN_DIALECTS } from '../shared';

type YarnFamily = keyof typeof YARN_DIALECTS;

/** Runs Yarn Classic's wrapped package metadata command in the package root. */
export async function fetchPackageMetadataFromYarnClassic(
  request: MetadataRequest,
): Promise<PackageMetadataOutcome> {
  return await fetchPackageMetadataFromYarnFamily(request, 'classic', parseYarnClassicMetadata);
}

/** Runs Yarn Modern's npm plugin metadata command in the package root. */
export async function fetchPackageMetadataFromYarnModern(
  request: MetadataRequest,
): Promise<PackageMetadataOutcome> {
  return await fetchPackageMetadataFromYarnFamily(request, 'modern', parseYarnModernMetadata);
}

/** Validates the wrapper emitted by Yarn Classic before reading its payload. */
export function parseYarnClassicMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json) || json.type !== 'inspect' || !Object.hasOwn(json, 'data')) {
    return { kind: 'unrecognized' };
  }
  return parsePackument(json.data);
}

/** Validates the direct package metadata document emitted by Yarn Modern. */
export function parseYarnModernMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json) || Object.hasOwn(json, 'type')) {
    return { kind: 'unrecognized' };
  }
  return parsePackument(json);
}

export const yarnClassicMetadataAdapter: MetadataAdapter = {
  tier: 'native-cli',
  packageManagers: ['yarn'],
  fetchMetadata: fetchPackageMetadataFromYarnClassic,
};

export const yarnModernMetadataAdapter: MetadataAdapter = {
  tier: 'native-cli',
  packageManagers: ['yarn'],
  fetchMetadata: fetchPackageMetadataFromYarnModern,
};

async function fetchPackageMetadataFromYarnFamily(
  request: MetadataRequest,
  expectedFamily: YarnFamily,
  parse: (json: unknown) => MetadataSchemaResult<PackageMetadata>,
): Promise<PackageMetadataOutcome> {
  const checked = checkCliMetadataRequest(request, ['yarn']);
  if (checked.kind === 'rejected') {
    return checked.outcome;
  }

  const family = await resolveYarnFamily(checked.packageRoot);
  if (family.family !== expectedFamily) {
    return { kind: 'unrecognized' };
  }
  return await runCliMetadata(
    request,
    checked.packageManager,
    YARN_DIALECTS[expectedFamily].metadata,
    checked.packageRoot,
    parse,
  );
}