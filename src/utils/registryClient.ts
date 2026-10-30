import type { BoundedMetadataOutcome, MetadataOutcome, MetadataSchemaResult } from './metadataRunner';
import type { PackageMetadata, PackageMetadataOutcome } from './metadataRegistry';
import { getAuthorizationHeader } from './registry/auth';
import { resolveRegistryConfiguration } from './registry/configResolution';
import type { RegistryConfiguration } from './registry/configResolution';
import { requestRegistryPayload } from './registry/httpClient';
import { getPackageScope } from './registry/packageScope';
import { isNoProxyHost } from './registry/proxy';
import { buildRegistryPackageUrl, normalizeRegistryUrl } from './registry/registryUrl';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';
import { isRecord, stripVersionDecorations } from '../shared';
import type { PackageManager } from '../shared';

const REGISTRY_ACCEPT_HEADER = 'application/vnd.npm.install-v1+json';

export async function fetchPackageMetadataFromRegistry(
  packageName: string,
  packageFilePath?: string,
  signal?: AbortSignal,
  packageManager?: PackageManager,
): Promise<PackageMetadataOutcome> {
  const encodedName = encodeURIComponent(packageName).replace('%40', '@');
  let configuration: RegistryConfiguration;
  try {
    configuration = await resolveRegistryConfiguration(packageName, packageFilePath, packageManager);
  }
  catch (error) {
    return configurationFailureOutcome(error, packageName, packageManager);
  }

  if (configuration.privateRegistryUnresolved) {
    return { kind: 'unavailable', reason: 'configuration-unavailable', privateRegistry: true };
  }

  let url: string;
  try {
    url = buildRegistryPackageUrl(configuration.registryUrl, encodedName);
  }
  catch {
    return markPrivateRegistryOutcome(
      { kind: 'unavailable', reason: 'configuration-unavailable' },
      configuration.registryConfigured,
    );
  }

  if (configuration.proxyConfigured && !isNoProxyHost(new URL(url).hostname, configuration.noProxy)) {
    return markPrivateRegistryOutcome(
      { kind: 'transport-error', reason: 'proxy-unsupported' },
      configuration.registryConfigured,
    );
  }

  const headers = buildRequestHeaders(url, configuration);
  return markPrivateRegistryOutcome(withoutTransportMessage(await requestRegistryPayload(
    url,
    parseNpmRegistryMetadata,
    packageName,
    { headers, ca: configuration.ca, rejectUnauthorized: configuration.rejectUnauthorized },
    signal,
  )), configuration.registryConfigured);
}

function configurationFailureOutcome(
  error: unknown,
  packageName: string,
  packageManager: PackageManager | undefined,
): PackageMetadataOutcome {
  const configurationMessage = packageManager === 'bun' && error instanceof Error
    ? error.message
    : undefined;
  return markPrivateRegistryOutcome(
    {
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      ...(configurationMessage === undefined ? {} : { message: configurationMessage }),
    },
    packageManager === 'bun' || packageManager === 'yarn' || getPackageScope(packageName) !== undefined,
  );
}

function buildRequestHeaders(url: string, configuration: RegistryConfiguration): Record<string, string> {
  const authorization = getAuthorizationHeader(url, {
    config: configuration.values,
    authToken: configuration.authToken,
    authIdent: configuration.authIdent,
    authRegistryUrl: configuration.authRegistryUrl,
  });
  return authorization === undefined
    ? { Accept: REGISTRY_ACCEPT_HEADER }
    : { Accept: REGISTRY_ACCEPT_HEADER, Authorization: authorization };
}

export async function resolvePackageRegistryUrl(
  packageName: string,
  packageFilePath?: string,
  packageManager?: PackageManager,
): Promise<string> {
  const configuration = await resolveRegistryConfiguration(packageName, packageFilePath, packageManager);
  return normalizeRegistryUrl(configuration.registryUrl);
}

export function parseNpmRegistryMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json)) {
    return { kind: 'unrecognized' };
  }
  if (!Object.hasOwn(json, 'dist-tags') || !Object.hasOwn(json, 'versions')) {
    return { kind: 'unrecognized' };
  }

  const distTags = readStringMap(json['dist-tags']);
  const versions = isRecord(json.versions) ? Object.keys(json.versions).reverse() : undefined;
  if (distTags === undefined || versions === undefined) {
    return { kind: 'malformed' };
  }

  const publishTimes = parsePublishTimes(json.time, versions);
  return {
    kind: 'recognized',
    result: { distTags, versions, publishTimes },
  };
}

function parsePublishTimes(
  value: unknown,
  versions: readonly string[],
): PackageMetadata['publishTimes'] {
  if (!isRecord(value)) {
    return { kind: 'not-provided' };
  }

  const versionSet = new Set(versions);
  return {
    kind: 'provided',
    byVersion: Object.fromEntries(
      Object.entries(value).filter(([version, publishTime]) => (
        versionSet.has(version) && typeof publishTime === 'string'
      )),
    ) as Record<string, string>,
  };
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function withoutTransportMessage<T>(outcome: BoundedMetadataOutcome<T>): MetadataOutcome<T> {
  if (outcome.kind !== 'transport-error') {
    return outcome;
  }
  if (outcome.statusCode === undefined) {
    return { kind: 'transport-error', reason: outcome.reason };
  }
  return { kind: 'transport-error', reason: outcome.reason, statusCode: outcome.statusCode };
}

function markPrivateRegistryOutcome(
  outcome: PackageMetadataOutcome,
  privateRegistry: boolean,
): PackageMetadataOutcome {
  if (!privateRegistry || outcome.kind === 'success' || outcome.kind === 'aborted') {
    return outcome;
  }
  return { ...outcome, privateRegistry: true };
}

export function selectVersionsForPicker(
  allVersions: readonly string[],
  _tags: Record<string, string>,
  currentVersion: string,
  includePreReleases: boolean,
): string[] {
  const normalizedCurrent = stripVersionDecorations(currentVersion);
  const selected = new Set([normalizedCurrent]);

  return allVersions
    .filter(version => (
      includePreReleases
      || !isPreReleaseVersion(version)
      || selected.has(version)
    ))
    .sort((left, right) => -compareRawVersions(left, right));
}