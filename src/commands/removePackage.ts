import * as vscode from 'vscode';
import { ClientManager, resolveMutationCoordinatorKey } from '../clients';
import { isPackageItem, PackagesProvider, sanitizePackageText } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import {
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  logger,
  mutationCoordinator,
  runShellTaskAndWait,
  showError,
} from '../utils';
import {
  resolveCommandPackageItem,
  resolveUnambiguousManifestEntry,
  revalidateCommandPackageItem,
} from './packageIdentity';

const clientManager = new ClientManager();

export async function removePackageCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.removePackage invoked without a valid package item; ignoring.');
    return;
  }

  const capability = await resolveCommandPackageItem(item, provider);
  if (capability === undefined) {
    return;
  }

  const current = capability.item;
  const confirmed = await vscode.window.showWarningMessage(
    `Remove ${sanitizePackageText(current.packageName)} from ${capability.identity.section}?`,
    { modal: true },
    'Remove Package',
  );
  if (confirmed !== 'Remove Package') {
    return;
  }

  // Locked from the pre-task manifest re-read through the remove task and the
  // reload/rollback that follows it. The confirmation dialog above stays outside the
  // lock so it never blocks an unrelated project root.
  const projectKey = await resolveMutationCoordinatorKey(capability.packageFilePath);
  await mutationCoordinator.runExclusive(projectKey, async () => {
    const checked = await resolveUnambiguousManifestEntry(capability, provider);
    if (checked === undefined) {
      return;
    }

    let activeCapability: ResolvedPackageItem | undefined = checked;
    try {
      const client = await clientManager.getClient(checked.packageDirectory);
      const beforeTask = await revalidateCommandPackageItem(checked, provider);
      if (beforeTask === undefined) {
        activeCapability = undefined;
        return;
      }
      activeCapability = provider.markPackageUpdatingForCapability(beforeTask, true);
      if (activeCapability === undefined) {
        return;
      }
      const command = client.buildRemoveCommand([beforeTask.item.packageName]);
      logger.info(`Running remove command: ${formatShellTaskCommandForLog(command)}`);
      const taskName = `Remove ${beforeTask.item.packageName}`;
      const exitCode = await runShellTaskAndWait(command, taskName, beforeTask.packageDirectory);
      provider.invalidateUpdateCache();
      if (exitCode === 0) {
        await provider.loadPackages();
        return;
      }
      provider.markPackageUpdatingForCapability(activeCapability, false);
      showError(formatShellTaskFailureMessage(taskName, exitCode));
      await provider.loadPackages();
    }
    catch (err) {
      if (activeCapability !== undefined) {
        provider.markPackageUpdatingForCapability(activeCapability, false);
      }
      showError(`failed to remove package — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  });
}