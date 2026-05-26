import { execFile } from 'child_process';
import { promisify } from 'util';
import { getGreatestVersion } from './versionUtils';

const execFileAsync = promisify(execFile);

export async function fetchLatestVersion(pkgName: string, includePreReleases: boolean): Promise<string> {
    const { stdout } = await execFileAsync('npm', ['view', pkgName, 'versions', '--json'], {
        timeout: 10_000,
    });
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
