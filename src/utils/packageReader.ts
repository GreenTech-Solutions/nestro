import * as vscode from 'vscode';
import { logger } from './logger';

export interface PackageEntry {
    name: string;
    current: string;
    dev: boolean;
}

export async function readWorkspaceDependencies(): Promise<PackageEntry[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        logger.info('No workspace folder found.');
        return [];
    }

    const uri = vscode.Uri.joinPath(folders[0].uri, 'package.json');

    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const json = JSON.parse(Buffer.from(raw).toString('utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        return [
            ...Object.entries(json.dependencies ?? {}).map(([name, current]) => ({ name, current, dev: false })),
            ...Object.entries(json.devDependencies ?? {}).map(([name, current]) => ({ name, current, dev: true })),
        ];
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'FileNotFound' || code === 'ENOENT') {
            logger.info('No workspace package.json found.');
            return [];
        }
        logger.error(`Failed to read workspace package.json at ${uri.toString()}.`, err);
        throw err;
    }
}
