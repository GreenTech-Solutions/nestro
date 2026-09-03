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

const nativePackageManagers = ['npm', 'pnpm'] as const;

/** Runs the package manager's own metadata command in the package root. */
export async function fetchPackageMetadataFromNativeCli(
  request: MetadataRequest,
): Promise<PackageMetadataOutcome> {
  const packageManager = request.packageManager;
  if ((packageManager !== 'npm' && packageManager !== 'pnpm')
    || request.packageFilePath === undefined
    || request.packageFilePath === '') {
    return { kind: 'transport-error', reason: 'process-failed' };
  }

  const outcome = await runBoundedProcess(packageManager, ['view', request.packageName, '--json'], {
    cwd: path.resolve(path.dirname(request.packageFilePath)),
    timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
    maxBufferBytes: METADATA_RESPONSE_MAX_BYTES,
    signal: request.signal,
  });
  return mapProcessOutcome(outcome);
}

/** Validates the full JSON document returned by npm or pnpm view. */
export function parseNativeCliMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
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

export const nativeCliMetadataAdapter: MetadataAdapter = {
  tier: 'native-cli',
  packageManagers: nativePackageManagers,
  fetchMetadata: fetchPackageMetadataFromNativeCli,
};

function mapProcessOutcome(outcome: BoundedProcessOutcome): PackageMetadataOutcome {
  switch (outcome.kind) {
    case 'exit':
      if (outcome.exitCode !== 0) {
        return { kind: 'transport-error', reason: 'process-failed' };
      }
      return parseNativeCliOutput(outcome.stdout);
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

function parseNativeCliOutput(stdout: string): PackageMetadataOutcome {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim()) as unknown;
  }
  catch {
    return { kind: 'malformed', reason: 'json' };
  }
  return mapSchemaResult(parseNativeCliMetadata(json));
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

function readVersions(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every(entry => typeof entry === 'string') ? [...value] : undefined;
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