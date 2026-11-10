import * as vscode from 'vscode';
import { PackagesProvider } from '../providers';
import { describeError } from '../shared';
import {
  formatPinnedPackageVersions,
  getWorkspacePackageFilePaths,
  logger,
  pinAllWorkspaceDependencyVersions,
  showError,
} from '../utils';
import { reconcileFailedPackageMutation } from './packageUpdateSteps';
import { clearMutationProgress, markPackageIdentities, runRowMutation } from './rowMutation';
import type { IdentityMutationProgress, RowMutationExecution } from './rowMutation';

interface PinAllMutation {
  readonly packageFilePaths: readonly string[];
  readonly provider: PackagesProvider;
}

type PinAllOutcome = Awaited<ReturnType<typeof pinAllWorkspaceDependencyVersions>>;
type PinAllExecution = RowMutationExecution<PinAllMutation, IdentityMutationProgress, PinAllOutcome>;

export async function pinAllVersionsCommand(provider: PackagesProvider): Promise<void> {
  await runRowMutation<PackagesProvider, PinAllMutation, PinAllMutation, IdentityMutationProgress, PinAllOutcome>(provider, {
    guard: () => true,
    resolve: async currentProvider => ({
      packageFilePaths: await getWorkspacePackageFilePaths(),
      provider: currentProvider,
    }),
    lockTargets: mutation => mutation.packageFilePaths,
    revalidate: mutation => mutation,
    mark: ({ packageFilePaths, provider: currentProvider }) => markPackageIdentities(
      currentProvider,
      packageFilePaths.flatMap(packageFilePath => currentProvider.getPackageIdentitiesForFile(packageFilePath)),
      { kind: 'pin' },
    ),
    apply: async ({ provider: currentProvider }) => await currentProvider.withWriteSuppressed(
      () => pinAllWorkspaceDependencyVersions(),
    ),
    reconcile: execution => reconcilePinAll(execution),
    reportError: error => showError(vscode.l10n.t('Failed to pin all versions — {0}', describeError(error)), error),
  });
}

async function reconcilePinAll(execution: PinAllExecution): Promise<void> {
  if (execution.kind === 'apply-failed') {
    clearMutationProgress(execution.marked);
    await reconcileFailedPackageMutation(
      execution.checked.provider,
      'Failed to reconcile package state after a failed Pin All.',
    );
    return;
  }
  clearMutationProgress(execution.marked);
  logger.info(`Pinned ${execution.result.count} package version(s).`);
  if (execution.result.skippedFiles.length > 0) {
    logger.warn(`Pin All could not read: ${execution.result.skippedFiles.join(', ')}.`);
  }
  const message = formatPinAllMessage(execution.result.count, execution.result.skippedFiles);
  if (execution.result.count > 0) {
    await execution.checked.provider.loadPackages();
  }
  void vscode.window.showInformationMessage(message);
}

function formatPinAllMessage(count: number, skippedFiles: readonly string[]): string {
  const base = count === 0
    ? skippedFiles.length === 0
      ? vscode.l10n.t('All versions are already pinned.')
      : vscode.l10n.t('All other versions are already pinned.')
    : formatPinnedPackageVersions(count);
  if (skippedFiles.length === 0) {
    return base;
  }
  const skipped = skippedFiles.length === 1
    ? vscode.l10n.t('Skipped unreadable manifest: {0}.', skippedFiles[0])
    : vscode.l10n.t('Skipped unreadable manifests: {0}.', skippedFiles.join(', '));
  return vscode.l10n.t('{0} {1}', base, skipped);
}