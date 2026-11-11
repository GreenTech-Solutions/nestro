import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { isPathWithin } from '../../shared';

/** The UTF-8 contents of a config file, or undefined when it cannot be read for any reason. */
export async function readConfigFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  }
  catch {
    return undefined;
  }
}

/** The project root a config lookup starts from: the package directory, else the first workspace folder. */
export function getPackageRoot(packageFilePath: string | undefined): string | undefined {
  if (packageFilePath !== undefined) {
    return path.resolve(path.dirname(packageFilePath));
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspaceRoot === undefined ? undefined : path.resolve(workspaceRoot);
}

/** Candidate paths for a config file, least specific first: the home directory, then workspace root down to the package directory. */
export function getConfigFilePaths(packageFilePath: string | undefined, fileName: string): string[] {
  return [...new Set([
    path.join(homedir(), fileName),
    ...getProjectConfigPaths(packageFilePath, fileName),
  ])];
}

function getProjectConfigPaths(packageFilePath: string | undefined, fileName: string): string[] {
  const workspaceRoot = packageFilePath === undefined
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath))?.uri.fsPath;
  if (workspaceRoot === undefined) {
    return [];
  }

  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const packageRoot = packageFilePath === undefined
    ? normalizedWorkspaceRoot
    : path.resolve(path.dirname(packageFilePath));
  if (!isPathWithin(normalizedWorkspaceRoot, packageRoot)) {
    return [path.join(normalizedWorkspaceRoot, fileName)];
  }

  const projectDirectories: string[] = [];
  let current = packageRoot;
  while (isPathWithin(normalizedWorkspaceRoot, current)) {
    projectDirectories.unshift(current);
    if (current === normalizedWorkspaceRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return [...new Set(projectDirectories.map(directory => path.join(directory, fileName)))];
}