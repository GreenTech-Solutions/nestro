import { PackageItem, PackagesProvider } from '../providers';
import {
  logger,
  showError,
  switchDependencyType,
} from '../utils';

export async function switchDepTypeCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
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