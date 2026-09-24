import * as vscode from 'vscode';
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
      showError(vscode.l10n.t(
        'cannot toggle version pin for {0} — {1}',
        checked.item.packageName,
        parsed.reason,
      ));
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
      showError(vscode.l10n.t(
        'failed to toggle version pin — {0}',
        err instanceof Error ? err.message : String(err),
      ), err);
    }
  });
}