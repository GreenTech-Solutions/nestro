import { PACKAGE_IDENTITY_REJECTED_MESSAGE, PackagesProvider } from '../providers';
import type { PackageIdentityResolution, ResolvedPackageItem } from '../providers';
import { parsePackageJson, readPackageFile, showError } from '../utils';

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

/** Revalidates the selected manifest entry against the requested duplicate policy. */
export async function resolveManifestEntry(
  item: ResolvedPackageItem,
  provider: PackagesProvider,
  otherSectionDuplicate: 'reject' | 'allow',
): Promise<ResolvedPackageItem | undefined> {
  const checked = await revalidateCommandPackageItem(item, provider);
  if (checked === undefined) {
    return undefined;
  }

  try {
    const file = await readPackageFile(checked.packageFilePath);
    const manifest = parsePackageJson(file.raw);
    const expected = getManifestEntry(manifest[checked.identity.section], checked.item.packageName);
    const alternateSection = checked.identity.section === 'dependencies'
      ? 'devDependencies'
      : 'dependencies';
    const alternate = getManifestEntry(manifest[alternateSection], checked.item.packageName);
    if (
      expected !== checked.item.currentVersion
      || (otherSectionDuplicate === 'reject' && alternate !== undefined)
    ) {
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