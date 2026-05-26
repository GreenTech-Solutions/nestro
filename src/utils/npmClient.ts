import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function fetchLatestVersion(pkgName: string): Promise<string> {
    const { stdout } = await execFileAsync('npm', ['view', pkgName, 'version'], {
        timeout: 10_000,
    });
    return stdout.trim();
}
