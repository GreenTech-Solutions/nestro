import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';

const REGISTRY_REQUEST_TIMEOUT_MS = 15_000;
const REGISTRY_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';

interface NpmRegistryPackument {
  'dist-tags': Record<string, string>;
  versions: Record<string, unknown>;
}

export interface PackageVersions {
  tags: Record<string, string>;
  versions: string[];
}

export async function fetchPackageVersions(
  packageName: string,
  packageFilePath?: string,
): Promise<PackageVersions> {
  const encodedName = encodeURIComponent(packageName).replace('%40', '@');
  const registryUrl = await resolveRegistryUrl(packageName, packageFilePath);
  const url = buildRegistryPackageUrl(registryUrl, encodedName);

  return await new Promise<PackageVersions>((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      request?.removeListener('timeout', onTimeout);
      response?.removeListener('data', onData);
      response?.removeListener('end', onEnd);
      response?.removeListener('error', onResponseError);
      callback();
    };
    const rejectOnce = (err: Error): void => {
      settle(() => reject(err));
    };
    const resolveOnce = (versions: PackageVersions): void => {
      settle(() => resolve(versions));
    };
    const onTimeout = (): void => {
      const error = new Error(`npm registry request timed out after ${REGISTRY_REQUEST_TIMEOUT_MS}ms for ${packageName}`);
      request?.destroy(error);
      rejectOnce(error);
    };
    const onRequestError = (err: Error): void => {
      rejectOnce(err);
    };
    const onResponseError = (err: Error): void => {
      rejectOnce(err);
    };
    let data = '';
    let receivedBytes = 0;
    const onData = (chunk: Buffer | string): void => {
      const chunkText = chunk.toString();
      receivedBytes += Buffer.byteLength(chunkText);

      if (receivedBytes > REGISTRY_RESPONSE_MAX_BYTES) {
        const error = new Error(`npm registry response exceeded ${REGISTRY_RESPONSE_MAX_BYTES} bytes for ${packageName}`);
        request?.destroy(error);
        rejectOnce(error);
        return;
      }

      data += chunkText;
    };
    const onEnd = (): void => {
      try {
        if (response?.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
          rejectOnce(new Error(`npm registry responded with HTTP ${response.statusCode} for ${packageName}`));
          return;
        }

        const json = JSON.parse(data) as NpmRegistryPackument;
        resolveOnce({
          tags: json['dist-tags'] ?? {},
          versions: Object.keys(json.versions ?? {}).reverse(),
        });
      }
      catch (err) {
        rejectOnce(err instanceof Error ? err : new Error(String(err)));
      }
    };

    request = https.get(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' } }, (res) => {
      response = res;
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('error', onResponseError);
    });
    request.setTimeout(REGISTRY_REQUEST_TIMEOUT_MS);
    request.on('timeout', onTimeout);
    request.on('error', onRequestError);
  });
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