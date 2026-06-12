import * as vscode from 'vscode';
import { PackagesProvider } from '../providers';
import { logger, pinAllWorkspaceDependencyVersions, showError } from '../utils';

export async function pinAllVersionsCommand(provider: PackagesProvider): Promise<void> {
  try {
    let count = 0;
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
  }
  catch (err) {
    showError(`Failed to pin all versions — ${err instanceof Error ? err.message : String(err)}`, err);
  }
}
