import * as https from 'node:https';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';

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
    const request = https.get(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' } }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer | string) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as NpmRegistryPackument;
          resolve({
            tags: json['dist-tags'] ?? {},
            versions: Object.keys(json.versions ?? {}).reverse(),
          });
        }
        catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    request.on('error', reject);
  });
}

export function selectVersionsForPicker(
  allVersions: readonly string[],
  tags: Record<string, string>,
  currentVersion: string,
  includePreReleases: boolean,
): string[] {
  const normalizedCurrent = currentVersion.replace(/^workspace:/, '').replace(/^([~^]|>=|>|<=|<)/, '');
  const selected = new Set([
    ...Object.values(tags),
    normalizedCurrent,
  ]);

  return allVersions
    .filter((version) => (
      includePreReleases
      || !isPreReleaseVersion(version)
      || selected.has(version)
    ))
    .sort((left, right) => compareRawVersions(right, left));
}
