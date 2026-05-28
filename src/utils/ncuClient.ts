import { run } from 'npm-check-updates';

export type NcuUpdateTarget = 'latest' | 'greatest' | 'minor' | 'patch';

export async function fetchAllLatestVersions(
  packageFilePath: string,
  target: NcuUpdateTarget,
  includePreReleases: boolean,
): Promise<Map<string, string>> {
  const result = await run({
    packageFile: packageFilePath,
    target,
    pre: includePreReleases,
    jsonUpgraded: true,
    removeRange: true,
    silent: true,
  });

  if (!isStringRecord(result)) {
    return new Map();
  }

  return new Map(Object.entries(result));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every(item => typeof item === 'string');
}