import * as vscode from 'vscode';
import {
  getLocalizedPackageLabelFormatting,
  PackagesProvider,
  resolvePackageFileLabels,
  toWorkspaceFolderDescriptors,
} from '../providers';
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
  const skippedLabels = labelPackageFiles(execution.result.skippedFiles);
  if (skippedLabels.length > 0) {
    logger.warn(`Pin All could not read: ${skippedLabels.join(', ')}.`);
  }
  const message = formatPinAllMessage(execution.result.count, skippedLabels);
  if (execution.result.count > 0) {
    await execution.checked.provider.loadPackages();
  }
  void vscode.window.showInformationMessage(message);
}

/** Names manifests by the same owner-qualified labels the tree shows. */
function labelPackageFiles(packageFilePaths: readonly string[]): string[] {
  const folders = toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  return resolvePackageFileLabels(packageFilePaths, folders, getLocalizedPackageLabelFormatting())
    .map(({ owner }) => owner.label);
}

function formatPinAllMessage(count: number, skippedLabels: readonly string[]): string {
  const base = count === 0
    ? skippedLabels.length === 0
      ? vscode.l10n.t('All versions are already pinned.')
      : vscode.l10n.t('All other versions are already pinned.')
    : formatPinnedPackageVersions(count);
  if (skippedLabels.length === 0) {
    return base;
  }
  const skipped = skippedLabels.length === 1
    ? vscode.l10n.t('Skipped unreadable manifest: {0}.', skippedLabels[0])
    : vscode.l10n.t('Skipped unreadable manifests: {0}.', skippedLabels.join(', '));
  return vscode.l10n.t('{0} {1}', base, skipped);
}