import * as vscode from 'vscode';
import { logger } from './logger';

export interface PackageEntry {
  name: string;
  current: string;
  dev: boolean;
}

export interface PackageVersionUpdate {
  name: string;
  version: string;
}

interface WorkspacePackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function getWorkspacePackageFilePath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return undefined;
  }

  return vscode.Uri.joinPath(folder.uri, 'package.json').fsPath;
}

export async function updateWorkspaceDependencyVersions(updates: readonly PackageVersionUpdate[]): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error('No workspace folder found.');
  }

  const uri = vscode.Uri.joinPath(folder.uri, 'package.json');
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const json = JSON.parse(raw) as WorkspacePackageJson;
  const missing: string[] = [];

  for (const update of updates) {
    if (json.dependencies?.[update.name] !== undefined) {
      json.dependencies[update.name] = update.version;
      continue;
    }
    if (json.devDependencies?.[update.name] !== undefined) {
      json.devDependencies[update.name] = update.version;
      continue;
    }
    missing.push(update.name);
  }

  if (missing.length > 0) {
    throw new Error(`Package(s) not found in package.json: ${missing.join(', ')}`);
  }

  const indent = detectJsonIndent(raw);
  const newline = raw.endsWith('\n') ? '\n' : '';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(json, undefined, indent)}${newline}`));
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
  }
  catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FileNotFound' || code === 'ENOENT') {
      logger.info('No workspace package.json found.');
      return [];
    }
    logger.error(`Failed to read workspace package.json at ${uri.toString()}.`, err);
    throw err;
  }
}

function detectJsonIndent(raw: string): number {
  const match = raw.match(/^[ \t]+"[^"]+":/m);
  if (match === null) {
    return 2;
  }
  return match[0].match(/^[ \t]+/)?.[0].length ?? 2;
}