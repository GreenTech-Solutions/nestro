import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { isPathWithin } from '../shared';

/** Workspace folders canonicalized at once; the rest wait for the next batch. */
const FOLDER_REALPATH_BATCH_SIZE = 8;

let activeScopes = 0;
const folderRealpaths = new Map<string, Promise<string>>();

/** Shares each workspace folder's `realpath` between every call made while any scope is open. */
export async function withCanonicalWorkspaceFolderScope<T>(operation: () => Promise<T>): Promise<T> {
  activeScopes += 1;
  try {
    return await operation();
  }
  finally {
    activeScopes -= 1;
    if (activeScopes === 0) {
      folderRealpaths.clear();
    }
  }
}

/** The real path of a workspace folder, resolved once per open scope. */
export function realpathWorkspaceFolder(folderPath: string): Promise<string> {
  if (activeScopes === 0) {
    return realpath(folderPath);
  }
  let pending = folderRealpaths.get(folderPath);
  if (pending === undefined) {
    pending = realpath(folderPath);
    folderRealpaths.set(folderPath, pending);
  }
  return pending;
}

async function realpathOrUndefined(folderPath: string): Promise<string | undefined> {
  try {
    return await realpathWorkspaceFolder(folderPath);
  }
  catch {
    return undefined;
  }
}

async function canonicalWorkspaceFolders(): Promise<string[]> {
  const folderPaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  const canonical: string[] = [];
  for (let start = 0; start < folderPaths.length; start += FOLDER_REALPATH_BATCH_SIZE) {
    const batch = await Promise.all(folderPaths.slice(start, start + FOLDER_REALPATH_BATCH_SIZE).map(realpathOrUndefined));
    canonical.push(...batch.filter((folderPath): folderPath is string => folderPath !== undefined));
  }
  return canonical;
}

/** Deepest workspace folder whose realpath contains `canonicalDir`, matched by canonical path rather than a lexical prefix. */
export async function resolveCanonicalOwningWorkspaceFolder(canonicalDir: string): Promise<string | undefined> {
  const owners = (await canonicalWorkspaceFolders())
    .filter(folderPath => isPathWithin(folderPath, canonicalDir))
    .sort((left, right) => right.length - left.length);
  return owners[0];
}