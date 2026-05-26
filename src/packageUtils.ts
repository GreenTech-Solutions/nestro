import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PackageEntry {
    name: string;
    current: string;
}

export async function readWorkspaceDependencies(): Promise<PackageEntry[]> {
    const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1);
    if (files.length === 0) {
        return [];
    }

    const raw = await vscode.workspace.fs.readFile(files[0]);
    const json = JSON.parse(Buffer.from(raw).toString('utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };

    const deps: Record<string, string> = {
        ...json.dependencies,
        ...json.devDependencies,
    };

    return Object.entries(deps).map(([name, current]) => ({ name, current }));
}

export async function fetchLatestVersion(pkgName: string): Promise<string> {
    const { stdout } = await execFileAsync('npm', ['view', pkgName, 'version'], {
        timeout: 10_000,
    });
    return stdout.trim();
}

export function runInstall(pkgName: string, version: string): void {
    const terminal = vscode.window.createTerminal('Nestro: Update');
    terminal.sendText(`npm install ${pkgName}@${version}`);
    terminal.show();
}
