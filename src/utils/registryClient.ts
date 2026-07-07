import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';

const REGISTRY_REQUEST_TIMEOUT_MS = 15_000;
const REGISTRY_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

interface NpmRegistryPackument {
  'dist-tags': Record<string, string>;
  versions: Record<string, unknown>;
}

export interface PackageVersions {
  tags: Record<string, string>;
  versions: string[];
}

export async function fetchPackageVersions(packageName: string): Promise<PackageVersions> {
  const encodedName = encodeURIComponent(packageName).replace('%40', '@');
  const url = `https://registry.npmjs.org/${encodedName}`;

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
