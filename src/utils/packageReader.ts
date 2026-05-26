import * as vscode from 'vscode';

export interface PackageEntry {
    name: string;
    current: string;
    dev: boolean;
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

    return [
        ...Object.entries(json.dependencies ?? {}).map(([name, current]) => ({ name, current, dev: false })),
        ...Object.entries(json.devDependencies ?? {}).map(([name, current]) => ({ name, current, dev: true })),
    ];
}
