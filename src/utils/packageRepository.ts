import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from './logger';

export interface RawPackageFile {
  readonly uri: vscode.Uri;
  readonly original: Uint8Array;
  readonly raw: string;
}

export interface PreparedPackageFile {
  readonly uri: vscode.Uri;
  readonly original: Uint8Array;
  readonly updated: Uint8Array;
}

type PackageFileLocation = string | vscode.Uri;

export function getWorkspacePackageFilePath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return undefined;
  }

  return vscode.Uri.joinPath(folder.uri, 'package.json').fsPath;
}

export async function readPackageFile(packageFilePath: string): Promise<RawPackageFile>;
export async function readPackageFile(uri: vscode.Uri): Promise<RawPackageFile>;
export async function readPackageFile(location: PackageFileLocation): Promise<RawPackageFile> {
  const uri = typeof location === 'string' ? vscode.Uri.file(location) : location;
  const original = await vscode.workspace.fs.readFile(uri);
  const raw = Buffer.from(original).toString('utf8');
  return { uri, original, raw };
}

export async function writePreparedPackageFile(file: PreparedPackageFile): Promise<void> {
  await vscode.workspace.fs.writeFile(file.uri, file.updated);
}

/** Writes prepared files in order and restores written bytes in reverse order on failure. */
export async function writeManyPreparedPackageFilesAtomically(
  prepared: readonly PreparedPackageFile[],
): Promise<void> {
  const written: PreparedPackageFile[] = [];
  try {
    for (const file of prepared) {
      await writePreparedPackageFile(file);
      written.push(file);
    }
  }
  catch (err) {
    const rollbackFailures = await rollbackPreparedPackageFiles(written);
    if (rollbackFailures.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message}; failed to roll back: ${rollbackFailures.join(', ')}`);
    }
    throw err;
  }
}

export async function getWorkspacePackageFilePaths(glob?: string): Promise<string[]> {
  const files = await findWorkspacePackageJsonFiles(glob);
  return files.map(uri => uri.fsPath);
}

export async function findWorkspacePackageJsonFiles(glob?: string): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    logger.info('No workspace folder found.');
    return [];
  }

  const configuredGlob = glob ?? vscode.workspace
    .getConfiguration('nestro')
    .get<string>('monorepoGlob', '**/package.json');
  return await vscode.workspace.findFiles(configuredGlob, '**/node_modules/**');
}

/** Package file path relative to its owning workspace folder, for user-facing messages. */
export function toWorkspaceRelativePackageFilePath(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/');
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized.startsWith(`${root}/`)) {
      return normalized.slice(root.length + 1);
    }
  }
  return path.basename(fsPath);
}

async function rollbackPreparedPackageFiles(files: readonly PreparedPackageFile[]): Promise<string[]> {
  const failures: string[] = [];
  for (const file of [...files].reverse()) {
    try {
      await vscode.workspace.fs.writeFile(file.uri, file.original);
    }
    catch (err) {
      failures.push(toWorkspaceRelativePackageFilePath(file.uri.fsPath));
      logger.error(`Failed to roll back package.json at ${file.uri.toString()}.`, err);
    }
  }
  return failures;
}