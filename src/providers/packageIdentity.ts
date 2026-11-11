import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { AuditSeverity, ReleaseAgeState, UpdateType } from '../utils';
import type { PackageOperation } from './PackageItem';

export type PackageDependencySection = 'dependencies' | 'devDependencies';

/** Immutable provider-owned row data used after command identity validation. */
export interface CanonicalPackageItem {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly latest: string | undefined;
  readonly updateType: UpdateType;
  readonly operation: PackageOperation | undefined;
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
  = vscode.l10n.t('Package action is no longer available. Refresh the package list and try again.');

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

export function groupPackageIdentitiesByFile(
  identities: readonly PackageIdentityTuple[],
): ReadonlyMap<string, readonly PackageIdentityTuple[]> {
  const groups = new Map<string, PackageIdentityTuple[]>();
  for (const identity of identities) {
    const fileIdentities = groups.get(identity.packageFilePath) ?? [];
    fileIdentities.push(identity);
    groups.set(identity.packageFilePath, fileIdentities);
  }
  return groups;
}

export function addPackageUpdatesByIdentity(
  updatesByIdentity: Map<string, string>,
  identities: readonly PackageIdentityTuple[],
  latestVersions: ReadonlyMap<string, string>,
): void {
  for (const identity of identities) {
    const version = latestVersions.get(identity.packageName);
    if (version !== undefined) {
      updatesByIdentity.set(packageIdentityKey(identity), version);
    }
  }
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