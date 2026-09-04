import * as vscode from 'vscode';
import { resolveMutationCoordinatorKey } from '../clients';
import { PackagesProvider } from '../providers';
import {
  getWorkspacePackageFilePaths,
  logger,
  mutationCoordinator,
  pinAllWorkspaceDependencyVersions,
  showError,
} from '../utils';

export async function pinAllVersionsCommand(provider: PackagesProvider): Promise<void> {
  try {
    // Pin All can touch every workspace package.json, so it locks every project root for
    // the full write + reload rather than one at a time: a concurrent single-row
    // Pin/Update/Remove on any of these manifests waits behind this bulk write.
    const packageFilePaths = await getWorkspacePackageFilePaths();
    const projectKeys = await Promise.all(
      packageFilePaths.map(packageFilePath => resolveMutationCoordinatorKey(packageFilePath)),
    );

    await mutationCoordinator.runManyExclusive(projectKeys, async () => {
      let count = 0;
      let skippedFiles: readonly string[] = [];
      const activeIdentities = packageFilePaths.flatMap(packageFilePath => (
        provider.getPackageIdentitiesForFile?.(packageFilePath) ?? []
      ));
      activeIdentities.forEach(identity => provider.markPackageUpdating(identity, { kind: 'pin' }));
      // Set only after withWriteSuppressed() fully returns, so a throw anywhere in
      // that call — including its own post-write bookkeeping, not just the pin work
      // itself — is treated as a failure rather than inferred from a stray variable.
      let succeeded = false;
      try {
        const outcome = await provider.withWriteSuppressed(() => pinAllWorkspaceDependencyVersions());
        count = outcome.count;
        skippedFiles = outcome.skippedFiles;
        succeeded = true;
      }
      finally {
        activeIdentities.forEach(identity => provider.markPackageUpdating(identity, undefined));
        if (!succeeded) {
          // The bulk write may have applied to a subset of files even though it tries
          // to roll itself back; reconcile from disk. A reload failure here is logged,
          // not raised, so it never replaces the pin failure the user is about to see.
          try {
            provider.invalidateUpdateCache();
            await provider.loadPackages();
          }
          catch (reconcileErr) {
            logger.error('Failed to reconcile package state after a failed Pin All.', reconcileErr);
          }
        }
      }

      logger.info(`Pinned ${count} package version(s).`);
      if (skippedFiles.length > 0) {
        logger.warn(`Pin All could not read: ${skippedFiles.join(', ')}.`);
      }
      const message = formatPinAllMessage(count, skippedFiles);
      if (count === 0) {
        void vscode.window.showInformationMessage(message);
        return;
      }
      await provider.loadPackages();
      void vscode.window.showInformationMessage(message);
    });
  }
  catch (err) {
    showError(`Failed to pin all versions — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

function formatPinAllMessage(count: number, skippedFiles: readonly string[]): string {
  const base = count === 0
    ? skippedFiles.length === 0 ? 'All versions are already pinned.' : 'All other versions are already pinned.'
    : `Pinned ${count} package version(s).`;
  return skippedFiles.length === 0 ? base : `${base} Skipped unreadable manifest(s): ${skippedFiles.join(', ')}.`;
}