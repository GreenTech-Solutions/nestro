import { resolveMutationCoordinatorKey } from '../clients';
import { isPackageItem, PackagesProvider } from '../providers';
import {
  DependencyTypeConflictError,
  logger,
  mutationCoordinator,
  showError,
  switchDependencyType,
} from '../utils';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';

export async function switchDepTypeCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.switchDepType invoked without a valid package item; ignoring.');
    return;
  }

  const capability = await resolveCommandPackageItem(item, provider);
  if (capability === undefined) {
    return;
  }

  // Locked from the pre-write revalidation through the reload so a concurrent
  // Update/Pin/Remove on the same project root cannot interleave with it.
  const projectKey = await resolveMutationCoordinatorKey(capability.packageFilePath);
  await mutationCoordinator.runExclusive(projectKey, async () => {
    const checked = await revalidateCommandPackageItem(capability, provider);
    if (checked === undefined) {
      return;
    }

    try {
      logger.info(`Switching ${checked.item.packageName} dependency type.`);
      await provider.withWriteSuppressed(async () => {
        await switchDependencyType(
          checked.packageFilePath,
          checked.item.packageName,
          checked.identity.section === 'devDependencies',
          checked.item.currentVersion,
        );
      });
      await provider.loadPackages();
    }
    catch (err) {
      if (err instanceof DependencyTypeConflictError) {
        showError(err.message);
        return;
      }
      showError(`failed to switch dependency type — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  });
}