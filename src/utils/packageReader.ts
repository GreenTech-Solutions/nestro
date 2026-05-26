import * as vscode from 'vscode';

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
