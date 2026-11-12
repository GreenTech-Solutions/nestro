import * as path from 'node:path';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { isPathWithin, sha256Hex } from '../shared';
import type {
  CanonicalPackageLocationResult,
  PackageFileStamp,
  PackageIdentityFailureReason,
} from './packageIdentity';

interface CanonicalPackagePaths {
  readonly packageFilePath: string;
  readonly packageDirectory: string;
}

interface CanonicalWorkspaceFolder {
  readonly folder: vscode.WorkspaceFolder;
  readonly path: string;
}

type CanonicalWorkspaceOwnerResult
  = | { readonly ok: true; readonly value: CanonicalWorkspaceFolder }
    | { readonly ok: false; readonly reason: PackageIdentityFailureReason };

interface CanonicalManifestSnapshot {
  readonly fileStamp: PackageFileStamp;
  readonly manifestDigest: string;
}

/** Resolves a manifest path to its unique canonical workspace owner. */
export async function resolveCanonicalPackageLocation(
  packageFilePath: string,
): Promise<CanonicalPackageLocationResult> {
  if (packageFilePath === '' || path.basename(packageFilePath) !== 'package.json') {
    return { ok: false, reason: 'invalid-item' };
  }
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const lexicalOwner = findLexicalWorkspaceOwner(workspaceFolders, packageFilePath);
  try {
    const canonicalPaths = await resolveCanonicalPackagePaths(packageFilePath);
    const resolvedWorkspaceFolders = await resolveWorkspaceFolderPaths(workspaceFolders);
    const canonicalOwner = await resolveCanonicalWorkspaceOwner(
      canonicalPaths,
      resolvedWorkspaceFolders,
      lexicalOwner,
      packageFilePath,
    );
    if (!canonicalOwner.ok) {
      return canonicalOwner;
    }
    if (path.basename(canonicalPaths.packageFilePath) !== 'package.json') {
      return { ok: false, reason: 'path-replaced' };
    }
    const manifest = await resolveCanonicalManifestSnapshot(packageFilePath, canonicalPaths.packageFilePath);
    if (manifest === undefined) {
      return { ok: false, reason: 'path-replaced' };
    }
    return {
      ok: true,
      value: {
        packageFilePath: canonicalPaths.packageFilePath,
        packageDirectory: canonicalPaths.packageDirectory,
        workspaceFolderPath: canonicalOwner.value.path,
        fileStamp: manifest.fileStamp,
        manifestDigest: manifest.manifestDigest,
      },
    };
  }
  catch {
    return { ok: false, reason: 'unresolvable-path' };
  }
}

function findLexicalWorkspaceOwner(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  packageFilePath: string,
): vscode.WorkspaceFolder | undefined {
  return workspaceFolders
    .filter(folder => isPathWithin(folder.uri.fsPath, packageFilePath))
    .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0];
}

async function resolveCanonicalPackagePaths(packageFilePath: string): Promise<CanonicalPackagePaths> {
  const canonicalPackageFilePath = await realpath(packageFilePath);
  return {
    packageFilePath: canonicalPackageFilePath,
    packageDirectory: await realpath(path.dirname(canonicalPackageFilePath)),
  };
}

async function resolveWorkspaceFolderPaths(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<CanonicalWorkspaceFolder[]> {
  const candidates = await Promise.all(workspaceFolders.map(async (folder) => {
    try {
      return { folder, path: await realpath(folder.uri.fsPath) };
    }
    catch {
      return undefined;
    }
  }));
  return candidates.filter((candidate): candidate is CanonicalWorkspaceFolder => candidate !== undefined);
}

async function resolveCanonicalWorkspaceOwner(
  canonicalPaths: CanonicalPackagePaths,
  resolvedWorkspaceFolders: readonly CanonicalWorkspaceFolder[],
  lexicalOwner: vscode.WorkspaceFolder | undefined,
  packageFilePath: string,
): Promise<CanonicalWorkspaceOwnerResult> {
  const containingWorkspaceFolders = resolvedWorkspaceFolders
    .filter(candidate => isPathWithin(candidate.path, canonicalPaths.packageFilePath))
    .sort((left, right) => right.path.length - left.path.length);
  const canonicalOwner = containingWorkspaceFolders[0];
  if (canonicalOwner === undefined || !isPathWithin(canonicalOwner.path, canonicalPaths.packageDirectory)) {
    return { ok: false, reason: 'workspace-escape' };
  }
  const equallyDeepOwners = containingWorkspaceFolders.filter(candidate => candidate.path === canonicalOwner.path);
  if (equallyDeepOwners.length !== 1) {
    return { ok: false, reason: 'cross-workspace' };
  }
  if (lexicalOwner === undefined) {
    if (await isCrossWorkspaceCaseAlias(canonicalOwner, canonicalPaths.packageFilePath, packageFilePath)) {
      return { ok: false, reason: 'cross-workspace' };
    }
  }
  else {
    const lexicalOwnerCanonical = resolvedWorkspaceFolders.find(candidate => candidate.folder === lexicalOwner);
    if (lexicalOwnerCanonical?.path !== canonicalOwner.path) {
      return { ok: false, reason: 'cross-workspace' };
    }
  }
  return { ok: true, value: canonicalOwner };
}

async function isCrossWorkspaceCaseAlias(
  canonicalOwner: CanonicalWorkspaceFolder,
  canonicalPackageFilePath: string,
  packageFilePath: string,
): Promise<boolean> {
  const canonicalRelativePath = path.relative(canonicalOwner.path, canonicalPackageFilePath);
  const expectedLexicalPath = path.join(canonicalOwner.folder.uri.fsPath, canonicalRelativePath);
  return !isCaseOnlyAlias(packageFilePath, expectedLexicalPath)
    || await hasSymlinkAfterCaseDifference(packageFilePath, expectedLexicalPath);
}

async function resolveCanonicalManifestSnapshot(
  packageFilePath: string,
  canonicalPackageFilePath: string,
): Promise<CanonicalManifestSnapshot | undefined> {
  const requestedFileStamp = toPackageFileStamp(await stat(packageFilePath));
  const fileStamp = toPackageFileStamp(await stat(canonicalPackageFilePath));
  if (!samePackageFileStamp(requestedFileStamp, fileStamp)) {
    return undefined;
  }
  const manifestBytes = await readFile(canonicalPackageFilePath);
  const afterReadStats = await stat(canonicalPackageFilePath);
  if (!samePackageFileStamp(fileStamp, toPackageFileStamp(afterReadStats))) {
    return undefined;
  }
  return { fileStamp, manifestDigest: sha256Hex(manifestBytes) };
}

function isCaseOnlyAlias(left: string, right: string): boolean {
  if (left === right || left.length !== right.length) {
    return left === right;
  }
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

async function hasSymlinkAfterCaseDifference(left: string, right: string): Promise<boolean> {
  const leftParts = path.resolve(left).split(path.sep);
  const rightParts = path.resolve(right).split(path.sep);
  const firstDifference = leftParts.findIndex((part, index) => part !== rightParts[index]);
  if (firstDifference === -1) {
    return false;
  }
  let leftCurrent = path.parse(path.resolve(left)).root;
  let rightCurrent = path.parse(path.resolve(right)).root;
  for (let index = 0; index < firstDifference; index++) {
    leftCurrent = path.join(leftCurrent, leftParts[index]);
    rightCurrent = path.join(rightCurrent, rightParts[index]);
  }
  for (let index = firstDifference; index < Math.max(leftParts.length, rightParts.length); index++) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) {
      return true;
    }
    leftCurrent = path.join(leftCurrent, leftPart);
    rightCurrent = path.join(rightCurrent, rightPart);
    try {
      const [leftStats, rightStats] = await Promise.all([lstat(leftCurrent), lstat(rightCurrent)]);
      if (leftStats.isSymbolicLink() !== rightStats.isSymbolicLink()) {
        return true;
      }
      if (leftStats.isSymbolicLink()
        && (leftStats.dev !== rightStats.dev || leftStats.ino !== rightStats.ino)) {
        return true;
      }
    }
    catch {
      return true;
    }
  }
  return false;
}

export function samePackageFileStamp(left: PackageFileStamp, right: PackageFileStamp): boolean {
  // The full stat stamp detects replacement and in-place rewrites.
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function toPackageFileStamp(packageStats: {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: number;
  readonly mtimeMs: number;
}): PackageFileStamp {
  return {
    dev: Number(packageStats.dev),
    ino: Number(packageStats.ino),
    size: packageStats.size,
    mtimeMs: packageStats.mtimeMs,
  };
}