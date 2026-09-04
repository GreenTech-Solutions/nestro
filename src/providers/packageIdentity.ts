import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { AuditSeverity, ReleaseAgeState, UpdateType } from '../utils';

export type PackageDependencySection = 'dependencies' | 'devDependencies';

/** Immutable provider-owned row data used after command identity validation. */
export interface CanonicalPackageItem {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly latest: string | undefined;
  readonly updateType: UpdateType;
  readonly installing: boolean;
  readonly vulnerabilitySeverity: AuditSeverity | undefined;
  readonly packageFilePath: string;
  readonly dev: boolean;
  readonly versionPrefix: string;
  readonly releaseAge?: ReleaseAgeState;
}

export interface PackageItemRecord {
  readonly identity: PackageIdentityTuple;
  readonly row: CanonicalPackageItem;
  readonly baselineLocation: CanonicalPackageLocation | undefined;
}

export interface PackageIdentityTuple {
  readonly packageName: string;
  readonly packageFilePath: string;
  readonly section: PackageDependencySection;
}

export interface PackageFileStamp {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface CanonicalPackageLocation {
  readonly packageFilePath: string;
  readonly packageDirectory: string;
  readonly workspaceFolderPath: string;
  readonly fileStamp: PackageFileStamp;
  readonly manifestDigest: string;
}

export type CanonicalPackageLocationResult
  = | { readonly ok: true; readonly value: CanonicalPackageLocation }
    | { readonly ok: false; readonly reason: PackageIdentityFailureReason };

export type PackageIdentityFailureReason
  = | 'invalid-item'
    | 'not-current'
    | 'no-owning-workspace'
    | 'cross-workspace'
    | 'workspace-escape'
    | 'unresolvable-path'
    | 'path-replaced';

export interface ResolvedPackageItem {
  readonly item: CanonicalPackageItem;
  /** The exact tuple used to find the current provider row, never a caller fallback. */
  readonly identity: PackageIdentityTuple;
  /** Canonical, realpath-resolved manifest path used for writes and task cwd derivation. */
  readonly packageFilePath: string;
  readonly packageDirectory: string;
  readonly workspaceFolderPath: string;
  readonly fileStamp: PackageFileStamp;
  readonly manifestDigest: string;
  readonly snapshotGeneration: number;
}

export type PackageIdentityResolution
  = | { readonly ok: true; readonly value: ResolvedPackageItem }
    | { readonly ok: false; readonly reason: PackageIdentityFailureReason };

/** Keep identity failures actionable without exposing workspace or package-controlled paths. */
export const PACKAGE_IDENTITY_REJECTED_MESSAGE
  = 'Package action is no longer available. Refresh the package list and try again.';

export function packageSection(dev: boolean): PackageDependencySection {
  return dev ? 'devDependencies' : 'dependencies';
}

export function packageIdentityFromValues(
  packageName: string,
  packageFilePath: string,
  dev: boolean,
): PackageIdentityTuple {
  return {
    packageName,
    packageFilePath,
    section: packageSection(dev),
  };
}

export function packageIdentityKey(identity: PackageIdentityTuple): string {
  return `${identity.packageFilePath}\0${identity.packageName}\0${identity.section}`;
}

/** Read the exact dependency spec captured for one provider row. */
export async function readCanonicalDependencySpec(
  location: CanonicalPackageLocation,
  identity: PackageIdentityTuple,
): Promise<string | undefined> {
  const [spec] = await readCanonicalDependencySpecs(location, [identity]);
  return spec;
}

/** Reads every identity's spec from one parse of the manifest, aligned to `identities`. */
export async function readCanonicalDependencySpecs(
  location: CanonicalPackageLocation,
  identities: readonly PackageIdentityTuple[],
): Promise<(string | undefined)[]> {
  try {
    const manifest = JSON.parse((await readFile(location.packageFilePath, 'utf8'))) as {
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    return identities.map((identity) => {
      const section = manifest[identity.section];
      if (typeof section !== 'object' || section === null || !Object.hasOwn(section, identity.packageName)) {
        return undefined;
      }
      const value = (section as Record<string, unknown>)[identity.packageName];
      return typeof value === 'string' ? value : undefined;
    });
  }
  catch {
    return identities.map(() => undefined);
  }
}

/**
 * Resolve a manifest path and its owning workspace immediately before a mutation/task.
 * Every accepted path is realpath'd and contained by exactly one deepest workspace root;
 * ambiguous, missing, broken, and escaping paths fail closed.
 */
export async function resolveCanonicalPackageLocation(
  packageFilePath: string,
): Promise<CanonicalPackageLocationResult> {
  if (packageFilePath === '' || path.basename(packageFilePath) !== 'package.json') {
    return { ok: false, reason: 'invalid-item' };
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const lexicalOwners = workspaceFolders
    .filter(folder => isPathContained(folder.uri.fsPath, packageFilePath))
    .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length);
  const lexicalOwner = lexicalOwners[0];

  try {
    const canonicalPackageFilePath = await realpath(packageFilePath);
    const canonicalPackageDirectory = await realpath(path.dirname(canonicalPackageFilePath));
    const canonicalWorkspaceFolders = await Promise.all(workspaceFolders.map(async (folder) => {
      try {
        return { folder, path: await realpath(folder.uri.fsPath) };
      }
      catch {
        return undefined;
      }
    }));
    const resolvedWorkspaceFolders = canonicalWorkspaceFolders.filter((candidate): candidate is {
      folder: vscode.WorkspaceFolder;
      path: string;
    } => candidate !== undefined);
    const containingWorkspaceFolders = resolvedWorkspaceFolders
      .filter(candidate => isPathContained(candidate.path, canonicalPackageFilePath))
      .sort((left, right) => right.path.length - left.path.length);
    const canonicalOwner = containingWorkspaceFolders[0];
    if (canonicalOwner === undefined || !isPathContained(canonicalOwner.path, canonicalPackageDirectory)) {
      return { ok: false, reason: 'workspace-escape' };
    }

    // The lexical owner must resolve to the same deepest canonical owner. A symlink
    // into another open workspace, or two workspace aliases for one root, is ambiguous.
    const equallyDeepOwners = containingWorkspaceFolders.filter(candidate => candidate.path === canonicalOwner.path);
    if (equallyDeepOwners.length !== 1) {
      return { ok: false, reason: 'cross-workspace' };
    }
    if (lexicalOwner === undefined) {
      // A case-insensitive filesystem can resolve a manifest spelling that differs from the
      // workspace URI byte-for-byte; the canonical path and stat below confirm it is the same
      // file, and a symlink into another workspace is still rejected as not a case-only alias.
      const canonicalRelativePath = path.relative(canonicalOwner.path, canonicalPackageFilePath);
      const expectedLexicalPath = path.join(canonicalOwner.folder.uri.fsPath, canonicalRelativePath);
      if (!isCaseOnlyAlias(packageFilePath, expectedLexicalPath)
        || await hasSymlinkAfterCaseDifference(packageFilePath, expectedLexicalPath)) {
        return { ok: false, reason: 'cross-workspace' };
      }
    }
    else {
      const lexicalOwnerCanonical = resolvedWorkspaceFolders.find(candidate => candidate.folder === lexicalOwner);
      if (lexicalOwnerCanonical?.path !== canonicalOwner.path) {
        return { ok: false, reason: 'cross-workspace' };
      }
    }
    if (path.basename(canonicalPackageFilePath) !== 'package.json') {
      return { ok: false, reason: 'path-replaced' };
    }

    const requestedFileStamp = toPackageFileStamp(await stat(packageFilePath));
    const packageStats = await stat(canonicalPackageFilePath);
    const fileStamp = toPackageFileStamp(packageStats);
    if (!samePackageFileStamp(requestedFileStamp, fileStamp)) {
      return { ok: false, reason: 'path-replaced' };
    }
    const manifestBytes = await readFile(canonicalPackageFilePath);
    const afterReadStats = await stat(canonicalPackageFilePath);
    if (!samePackageFileStamp(fileStamp, toPackageFileStamp(afterReadStats))) {
      return { ok: false, reason: 'path-replaced' };
    }
    return {
      ok: true,
      value: {
        packageFilePath: canonicalPackageFilePath,
        packageDirectory: canonicalPackageDirectory,
        workspaceFolderPath: canonicalOwner.path,
        fileStamp,
        manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
      },
    };
  }
  catch {
    return { ok: false, reason: 'unresolvable-path' };
  }
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
  // The full stat stamp plus the manifest digest detects both rename/replace swaps and
  // in-place rewrites between the load-time snapshot and the command boundary.
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

function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}