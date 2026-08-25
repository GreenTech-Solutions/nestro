import { resolveMutationCoordinatorKey } from '../clients';
import { isPackageItem, PackagesProvider } from '../providers';
import {
  logger,
  mutationCoordinator,
  setVersionPin,
  showError,
} from '../utils';
import { resolveCommandPackageItem, resolveUnambiguousManifestEntry } from './packageIdentity';

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
    const checked = await resolveUnambiguousManifestEntry(capability, provider);
    if (checked === undefined) {
      return;
    }

    try {
      const shouldPin = checked.item.versionPrefix === '^' || checked.item.versionPrefix === '~';
      logger.info(`${shouldPin ? 'Pinning' : 'Unpinning'} ${checked.item.packageName} version.`);
      await provider.withWriteSuppressed(async () => {
        await setVersionPin(checked.packageFilePath, checked.item.packageName, shouldPin);
      });
      await provider.loadPackages();
    }
    catch (err) {
      showError(`failed to toggle version pin — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  });
}