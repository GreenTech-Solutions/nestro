import { PackageItem, PackagesProvider } from '../providers';
import {
  logger,
  setVersionPin,
  showError,
} from '../utils';

export async function pinVersionCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
  try {
    const shouldPin = item.versionPrefix === '^' || item.versionPrefix === '~';
    logger.info(`${shouldPin ? 'Pinning' : 'Unpinning'} ${item.packageName} version.`);
    await provider.withWriteSuppressed(async () => {
      await setVersionPin(item.packageFilePath, item.packageName, shouldPin);
    });
    await provider.loadPackages();
  }
  catch (err) {
    showError(`failed to toggle version pin — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}