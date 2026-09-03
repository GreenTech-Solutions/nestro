import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { runBoundedMetadataRequest } from './metadataRunner';
import type { BoundedMetadataOutcome, MetadataOutcome, MetadataSchemaResult } from './metadataRunner';
import type { PackageMetadata, PackageMetadataOutcome } from './metadataRegistry';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';

export async function fetchPackageMetadataFromRegistry(
  packageName: string,
  packageFilePath?: string,
  signal?: AbortSignal,
): Promise<PackageMetadataOutcome> {
  const encodedName = encodeURIComponent(packageName).replace('%40', '@');
  let url: string;
  try {
    const registryUrl = await resolveRegistryUrl(packageName, packageFilePath);
    url = buildRegistryPackageUrl(registryUrl, encodedName);
  }
  catch {
    return { kind: 'unavailable', reason: 'configuration-unavailable' };
  }

  return withoutTransportMessage(await requestRegistryPayload(
    url,
    parseNpmRegistryMetadata,
    packageName,
    signal,
  ));
}

async function requestRegistryPayload<T>(
  url: string,
  parse: (payload: unknown) => MetadataSchemaResult<T>,
  packageName: string,
  signal?: AbortSignal,
): Promise<BoundedMetadataOutcome<T>> {
  return await runBoundedMetadataRequest(url, {
    parse,
    signal,
    // This abbreviated response omits publish times; the native CLI tier supplies them for release policy.
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    timeoutErrorMessage: `npm registry request timed out after 15000ms for ${packageName}`,
    overflowErrorMessage: `npm registry response exceeded 5242880 bytes for ${packageName}`,
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function resolveRegistryUrl(packageName: string, packageFilePath: string | undefined): Promise<string> {
  const config = new Map<string, string>();

  for (const npmrcPath of getNpmrcPaths(packageFilePath)) {
    const npmrc = await readNpmrcFile(npmrcPath);
    mergeNpmrcConfig(config, npmrc);
  }

  const scopedRegistry = getScopedRegistry(packageName, config);

  return scopedRegistry ?? config.get('registry') ?? DEFAULT_REGISTRY_URL;
}

function getNpmrcPaths(packageFilePath: string | undefined): string[] {
  const paths = [path.join(homedir(), '.npmrc')];
  const workspaceRoot = packageFilePath === undefined
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath))?.uri.fsPath;

  if (workspaceRoot !== undefined) {
    paths.push(path.join(workspaceRoot, '.npmrc'));
  }

  return paths;
}

async function readNpmrcFile(npmrcPath: string): Promise<string> {
  try {
    return await readFile(npmrcPath, 'utf8');
  }
  catch {
    return '';
  }
}

function mergeNpmrcConfig(config: Map<string, string>, npmrc: string): void {
  for (const rawLine of npmrc.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripNpmrcQuotes(line.slice(separatorIndex + 1).trim());

    if (key === 'registry' || /^@[^:]+:registry$/.test(key)) {
      config.set(key, value);
    }
  }
}

function stripNpmrcQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function getScopedRegistry(packageName: string, config: ReadonlyMap<string, string>): string | undefined {
  if (!packageName.startsWith('@')) {
    return undefined;
  }

  const scopeEndIndex = packageName.indexOf('/');

  if (scopeEndIndex === -1) {
    return undefined;
  }

  return config.get(`${packageName.slice(0, scopeEndIndex)}:registry`);
}

function buildRegistryPackageUrl(registryUrl: string, encodedName: string): string {
  const baseUrl = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`;

  return new URL(encodedName, baseUrl).toString();
}

export function selectVersionsForPicker(
  allVersions: readonly string[],
  _tags: Record<string, string>,
  currentVersion: string,
  includePreReleases: boolean,
): string[] {
  const normalizedCurrent = currentVersion.replace(/^workspace:/, '').replace(/^([~^]|>=|>|<=|<)/, '');
  const selected = new Set([normalizedCurrent]);

  return allVersions
    .filter(version => (
      includePreReleases
      || !isPreReleaseVersion(version)
      || selected.has(version)
    ))
    .sort((left, right) => -compareRawVersions(left, right));
}