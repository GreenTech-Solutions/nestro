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
    // Pin All can touch every workspace package.json across every project root, so it
    // locks all of them for the full write + reload (`AUD-09`) rather than one root at
    // a time — a concurrent single-row Pin/Update/Remove on any of these manifests
    // waits behind this bulk write instead of racing it.
    const packageFilePaths = await getWorkspacePackageFilePaths();
    const projectKeys = await Promise.all(
      packageFilePaths.map(packageFilePath => resolveMutationCoordinatorKey(packageFilePath)),
    );

    let count = 0;
    await mutationCoordinator.runManyExclusive(projectKeys, async () => {
      await provider.withWriteSuppressed(async () => {
        count = await pinAllWorkspaceDependencyVersions();
      });
      logger.info(`Pinned ${count} package version(s).`);
      if (count === 0) {
        void vscode.window.showInformationMessage('All versions are already pinned.');
        return;
      }
      await provider.loadPackages();
      void vscode.window.showInformationMessage(`Pinned ${count} package version(s).`);
    });
  }
  catch (err) {
    showError(`Failed to pin all versions — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}