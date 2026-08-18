import { isPackageItem, PackagesProvider } from '../providers';
import {
  logger,
  showError,
  switchDependencyType,
} from '../utils';

export async function switchDepTypeCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.switchDepType invoked without a valid package item; ignoring.');
    return;
  }

  try {
    logger.info(`Switching ${item.packageName} dependency type.`);
    await provider.withWriteSuppressed(async () => {
      await switchDependencyType(item.packageFilePath, item.packageName, item.dev);
    });
    await provider.loadPackages();
  }
  catch (err) {
    showError(`failed to switch dependency type — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}