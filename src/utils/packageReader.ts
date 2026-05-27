import * as vscode from 'vscode';
import { logger } from './logger';

export interface PackageEntry {
  name: string;
  current: string;
  dev: boolean;
}

export interface PackageFileEntry extends PackageEntry {
  packageFilePath: string;
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

export function extractVersionPrefix(versionString: string): string {
  if (versionString.startsWith('workspace:')) {
    return '';
  }

  const match = /^([~^]|>=|>|<=|<)/.exec(versionString);
  return match?.[1] ?? '';
}

export async function updateWorkspaceDependencyVersions(updates: readonly PackageVersionUpdate[]): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error('No workspace folder found.');
  }

  await updateDependencyVersionsInFile(vscode.Uri.joinPath(folder.uri, 'package.json').fsPath, updates);
}

export async function updateDependencyVersionsInFile(
  packageFilePath: string,
  updates: readonly PackageVersionUpdate[],
): Promise<void> {
  const uri = vscode.Uri.file(packageFilePath);
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const json = JSON.parse(raw) as WorkspacePackageJson;
  const missing: string[] = [];

  for (const update of updates) {
    if (json.dependencies?.[update.name] !== undefined) {
      const prefix = extractVersionPrefix(json.dependencies[update.name]);
      json.dependencies[update.name] = `${prefix}${update.version}`;
      continue;
    }
    if (json.devDependencies?.[update.name] !== undefined) {
      const prefix = extractVersionPrefix(json.devDependencies[update.name]);
      json.devDependencies[update.name] = `${prefix}${update.version}`;
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
  const entries = await readAllWorkspaceDependencies();
  return entries.map(({ name, current, dev }) => ({ name, current, dev }));
}

export async function readAllWorkspaceDependencies(glob?: string): Promise<PackageFileEntry[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    logger.info('No workspace folder found.');
    return [];
  }

  const configuredGlob = glob ?? vscode.workspace
    .getConfiguration('nestro')
    .get<string>('monorepoGlob', '**/package.json');
  const files = await vscode.workspace.findFiles(configuredGlob, '**/node_modules/**');
  if (files.length === 0) {
    logger.info('No workspace package.json found.');
    return [];
  }

  const results: PackageFileEntry[] = [];
  for (const uri of files) {
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const json = JSON.parse(Buffer.from(raw).toString('utf8')) as WorkspacePackageJson;
      const packageFilePath = uri.fsPath;

      results.push(
        ...Object.entries(json.dependencies ?? {}).map(([name, current]) => ({
          name,
          current,
          dev: false,
          packageFilePath,
        })),
        ...Object.entries(json.devDependencies ?? {}).map(([name, current]) => ({
          name,
          current,
          dev: true,
          packageFilePath,
        })),
      );
    }
    catch (err) {
      logger.error(`Failed to read workspace package.json at ${uri.toString()}; skipping.`, err);
    }
  }
  return results;
}

function detectJsonIndent(raw: string): number {
  const match = raw.match(/^[ \t]+"[^"]+":/m);
  if (match === null) {
    return 2;
  }
  return match[0].match(/^[ \t]+/)?.[0].length ?? 2;
}