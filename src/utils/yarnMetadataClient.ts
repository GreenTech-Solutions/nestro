import path from 'node:path';
import { runBoundedProcess } from './processRunner';
import type { BoundedProcessOutcome } from './processRunner';
import {
  METADATA_REQUEST_TIMEOUT_MS,
  METADATA_RESPONSE_MAX_BYTES,
} from './metadataRunner';
import type { MetadataSchemaResult } from './metadataRunner';
import type {
  MetadataAdapter,
  MetadataRequest,
  PackageMetadata,
  PackageMetadataOutcome,
} from './metadataRegistry';
import { resolveYarnFamily } from './yarnFamily';

/** Runs Yarn Classic's wrapped package metadata command in the package root. */
export async function fetchPackageMetadataFromYarnClassic(
  request: MetadataRequest,
): Promise<PackageMetadataOutcome> {
  return await fetchPackageMetadataFromYarnFamily(request, 'classic', ['info', request.packageName, '--json']);
}

/** Runs Yarn Modern's npm plugin metadata command in the package root. */
export async function fetchPackageMetadataFromYarnModern(
  request: MetadataRequest,
): Promise<PackageMetadataOutcome> {
  return await fetchPackageMetadataFromYarnFamily(request, 'modern', ['npm', 'info', request.packageName, '--json']);
}

/** Validates the wrapper emitted by Yarn Classic before reading its payload. */
export function parseYarnClassicMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json) || json.type !== 'inspect' || !Object.hasOwn(json, 'data')) {
    return { kind: 'unrecognized' };
  }
  return parseYarnPackument(json.data);
}

/** Validates the direct package metadata document emitted by Yarn Modern. */
export function parseYarnModernMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json) || Object.hasOwn(json, 'type')) {
    return { kind: 'unrecognized' };
  }
  return parseYarnPackument(json);
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
  expectedFamily: 'classic' | 'modern',
  args: readonly string[],
): Promise<PackageMetadataOutcome> {
  if (request.packageManager !== 'yarn'
    || request.packageFilePath === undefined
    || request.packageFilePath === '') {
    return { kind: 'transport-error', reason: 'process-failed' };
  }

  const packageRoot = path.resolve(path.dirname(request.packageFilePath));
  const family = await resolveYarnFamily(packageRoot);
  if (family.family !== expectedFamily) {
    return { kind: 'unrecognized' };
  }

  const outcome = await runBoundedProcess('yarn', args, {
    cwd: packageRoot,
    timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
    maxBufferBytes: METADATA_RESPONSE_MAX_BYTES,
    signal: request.signal,
  });
  return mapProcessOutcome(outcome, expectedFamily === 'classic'
    ? parseYarnClassicMetadata
    : parseYarnModernMetadata);
}

function mapProcessOutcome(
  outcome: BoundedProcessOutcome,
  parse: (json: unknown) => MetadataSchemaResult<PackageMetadata>,
): PackageMetadataOutcome {
  switch (outcome.kind) {
    case 'exit':
      if (outcome.exitCode !== 0) {
        return { kind: 'transport-error', reason: 'process-failed' };
      }
      return parseYarnOutput(outcome.stdout, parse);
    case 'timeout':
      return { kind: 'timeout', timeoutMs: outcome.timeoutMs };
    case 'aborted':
      return { kind: 'aborted' };
    case 'overflow':
      return { kind: 'overflow', maxBufferBytes: outcome.maxBufferBytes };
    case 'spawn-error':
      return { kind: 'transport-error', reason: outcome.reason };
  }
}

function parseYarnOutput(
  stdout: string,
  parse: (json: unknown) => MetadataSchemaResult<PackageMetadata>,
): PackageMetadataOutcome {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim()) as unknown;
  }
  catch {
    return { kind: 'malformed', reason: 'json' };
  }
  return mapSchemaResult(parse(json));
}

function mapSchemaResult(parsed: MetadataSchemaResult<PackageMetadata>): PackageMetadataOutcome {
  switch (parsed.kind) {
    case 'recognized':
      return { kind: 'success', result: parsed.result };
    case 'unrecognized':
      return { kind: 'unrecognized' };
    case 'malformed':
      return { kind: 'malformed', reason: 'schema' };
  }
}

function parseYarnPackument(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json) || !Object.hasOwn(json, 'dist-tags') || !Object.hasOwn(json, 'versions')) {
    return { kind: 'unrecognized' };
  }

  const distTags = readStringMap(json['dist-tags']);
  const versions = readVersions(json.versions);
  if (distTags === undefined || versions === undefined) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'recognized',
    result: {
      distTags,
      publishTimes: parsePublishTimes(json.time, versions),
      versions,
    },
  };
}

function readVersions(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every(version => typeof version === 'string') ? [...value] : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.values(value).every(entry => isRecord(entry)) ? Object.keys(value) : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}