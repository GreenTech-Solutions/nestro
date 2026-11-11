import { isRecord } from '../../shared';
import type { MetadataSchemaResult } from '../metadataRunner';
import type { PackageMetadata } from '../metadataRegistry';

/** Validates a package document from the registry or a package-manager CLI; versions are listed newest first. */
export function parsePackument(json: unknown): MetadataSchemaResult<PackageMetadata> {
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
    return value.every(entry => typeof entry === 'string') ? [...value].reverse() : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.values(value).every(entry => isRecord(entry)) ? Object.keys(value).reverse() : undefined;
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