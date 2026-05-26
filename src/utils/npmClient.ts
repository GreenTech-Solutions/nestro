import { execFile } from 'child_process';
import { promisify } from 'util';
import { getGreatestVersion } from './versionUtils';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

export async function fetchLatestVersion(pkgName: string, includePreReleases: boolean): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync('npm', ['view', pkgName, 'versions', '--json'], {
      timeout: 10_000,
    });
    stdout = result.stdout;
  }
  catch (err) {
    logger.error(`Failed to query npm registry for ${pkgName}.`, err);
    throw err;
  }
  const versions = parseVersions(stdout);
  const latest = getGreatestVersion(versions, includePreReleases);

  if (latest === undefined) {
    throw new Error(`No valid versions found for ${pkgName}`);
  }

  return latest;
}

function parseVersions(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === 'string');
  }
  if (typeof parsed === 'string') {
    return [parsed];
  }
  return [];
}