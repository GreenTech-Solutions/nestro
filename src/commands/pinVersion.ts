import { resolveMutationCoordinatorKey } from '../clients';
import { isPackageItem, PACKAGE_IDENTITY_REJECTED_MESSAGE, PackagesProvider } from '../providers';
import {
  logger,
  mutationCoordinator,
  parseDependencySpec,
  setVersionPin,
  showError,
  VersionPinConflictError,
} from '../utils';
import { resolveCommandPackageItem, resolvePinManifestEntry } from './packageIdentity';

export async function pinVersionCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.pinVersion invoked without a valid package item; ignoring.');
    return;
  }

  const capability = await resolveCommandPackageItem(item, provider);
  if (capability === undefined) {
    return;
  }

  // Held from the manifest re-read below through the write and the post-write reload,
  // so no concurrent mutation of the same project root can interleave with this
  // read-modify-write.
  const projectKey = await resolveMutationCoordinatorKey(capability.packageFilePath);
  await mutationCoordinator.runExclusive(projectKey, async () => {
    const checked = await resolvePinManifestEntry(capability, provider);
    if (checked === undefined) {
      return;
    }

    const parsed = parseDependencySpec(checked.item.currentVersion);
    if (!parsed.supported) {
      showError(`cannot toggle version pin for ${checked.item.packageName} — ${parsed.reason}`);
      return;
    }

    const activeCapability = provider.markPackageUpdatingForCapability(checked, { kind: 'pin' });
    if (activeCapability === undefined) {
      return;
    }

    try {
      const shouldPin = parsed.range !== 'exact';
      logger.info(`${shouldPin ? 'Pinning' : 'Unpinning'} ${checked.item.packageName} version.`);
      await provider.withWriteSuppressed(async () => {
        await setVersionPin(
          checked.packageFilePath,
          checked.item.packageName,
          checked.identity.section,
          checked.item.currentVersion,
          shouldPin,
        );
      });
      provider.markPackageUpdatingForCapability(activeCapability, undefined);
      await provider.loadPackages();
    }
    catch (err) {
      provider.markPackageUpdatingForCapability(activeCapability, undefined);
      if (err instanceof VersionPinConflictError) {
        showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
        return;
      }
      showError(`failed to toggle version pin — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  });
}