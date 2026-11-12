import * as path from 'path';
import * as vscode from 'vscode';
import { LOCKFILES } from '../shared';
import type { LockfileDescriptor, PackageManager } from '../shared';

async function isFilePresent(filePath: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return (stat.type & vscode.FileType.File) !== 0;
  }
  catch {
    return false;
  }
}

/** The first lock file in detection order present in `directory`, limited to one manager when given; found by `stat`, never read. */
export async function findLockfile(
  directory: string,
  packageManager?: PackageManager,
): Promise<LockfileDescriptor | undefined> {
  for (const lockfile of LOCKFILES) {
    if (packageManager !== undefined && lockfile.packageManager !== packageManager) {
      continue;
    }
    if (await isFilePresent(path.join(directory, lockfile.fileName))) {
      return lockfile;
    }
  }
  return undefined;
}