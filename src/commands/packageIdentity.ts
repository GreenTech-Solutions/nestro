import * as vscode from 'vscode';
import { PACKAGE_IDENTITY_REJECTED_MESSAGE, PackagesProvider } from '../providers';
import type { PackageIdentityResolution, ResolvedPackageItem } from '../providers';
import { showError } from '../utils';

/**
 * Resolve a command argument to the provider's current row and canonical manifest.
 * Structural command guards remain the provider boundary; callers must not recover
 * from a failed resolution by using fields from the rendered argument.
 */
export async function resolveCommandPackageItem(
  item: unknown,
  provider: PackagesProvider,
): Promise<ResolvedPackageItem | undefined> {
  const resolution = await provider.resolvePackageItem(item);
  if (!resolution.ok) {
    reportPackageIdentityFailure(resolution);
    return undefined;
  }
  return resolution.value;
}

/** Re-check a previously resolved capability immediately before a write/task. */
export async function revalidateCommandPackageItem(
  item: ResolvedPackageItem,
  provider: PackagesProvider,
): Promise<ResolvedPackageItem | undefined> {
  const resolution = await provider.revalidatePackageItem(item);
  if (!resolution.ok) {
    reportPackageIdentityFailure(resolution);
    return undefined;
  }
  return resolution.value;
}

/**
 * The remove writer has legacy section inference. Require one manifest entry in the
 * canonical section before invoking it, then revalidate after the async read.
 */
export async function resolveUnambiguousManifestEntry(
  item: ResolvedPackageItem,
  provider: PackagesProvider,
): Promise<ResolvedPackageItem | undefined> {
  const checked = await revalidateCommandPackageItem(item, provider);
  if (checked === undefined) {
    return undefined;
  }

  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(checked.packageFilePath));
    const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as {
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    const expected = getManifestEntry(manifest[checked.identity.section], checked.item.packageName);
    const alternateSection = checked.identity.section === 'dependencies'
      ? 'devDependencies'
      : 'dependencies';
    const alternate = getManifestEntry(manifest[alternateSection], checked.item.packageName);
    if (expected !== checked.item.currentVersion || alternate !== undefined) {
      showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
      return undefined;
    }
  }
  catch {
    showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
    return undefined;
  }

  return await revalidateCommandPackageItem(checked, provider);
}

/** Revalidate a pin row without treating a duplicate name in the other section as ambiguous. */
export async function resolvePinManifestEntry(
  item: ResolvedPackageItem,
  provider: PackagesProvider,
): Promise<ResolvedPackageItem | undefined> {
  const checked = await revalidateCommandPackageItem(item, provider);
  if (checked === undefined) {
    return undefined;
  }

  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(checked.packageFilePath));
    const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as {
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    const expected = getManifestEntry(manifest[checked.identity.section], checked.item.packageName);
    if (expected !== checked.item.currentVersion) {
      showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
      return undefined;
    }
  }
  catch {
    showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
    return undefined;
  }

  return await revalidateCommandPackageItem(checked, provider);
}

function reportPackageIdentityFailure(resolution: Exclude<PackageIdentityResolution, { readonly ok: true }>): void {
  // Invalid/non-item values are already handled by the command's structural guard;
  // avoid turning a malformed palette invocation into a user-facing error.
  if (resolution.reason !== 'invalid-item') {
    showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
  }
}

function getManifestEntry(section: unknown, packageName: string): unknown {
  if (typeof section !== 'object' || section === null) {
    return undefined;
  }
  return Object.hasOwn(section, packageName)
    ? (section as Record<string, unknown>)[packageName]
    : undefined;
}