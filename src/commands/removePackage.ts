import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { isPackageItem, PackagesProvider, sanitizePackageText } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import { COMMAND_IDS, describeError } from '../shared';
import {
  formatDependencySectionLabel,
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  logger,
  runShellTaskAndWait,
  type ShellTaskOutcome,
  showError,
} from '../utils';
import {
  resolveCommandPackageItem,
  resolveManifestEntry,
  revalidateCommandPackageItem,
} from './packageIdentity';
import { clearMutationProgress, markPackageCapabilities, runRowMutation } from './rowMutation';
import type { RowMutationExecution, RowMutationProgress } from './rowMutation';

const clientManager = new ClientManager();

interface RemoveInput {
  readonly item: unknown;
  readonly provider: PackagesProvider;
}

interface RemoveMutation {
  readonly capability: ResolvedPackageItem;
  readonly provider: PackagesProvider;
}

interface RemoveChecked {
  readonly capability: ResolvedPackageItem;
  readonly client: Awaited<ReturnType<ClientManager['getClient']>>;
}

interface RemoveMarked {
  readonly capability: ResolvedPackageItem;
  readonly progress: RowMutationProgress;
}

interface RemoveOutcome {
  readonly taskOutcome: ShellTaskOutcome;
  readonly taskName: string;
}

type RemoveExecution = RowMutationExecution<RemoveChecked, RemoveMarked, RemoveOutcome>;

export async function removePackageCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  await runRowMutation<RemoveInput, RemoveMutation, RemoveChecked, RemoveMarked, RemoveOutcome>({ item, provider }, {
    guard: input => guardRemoveItem(input.item),
    resolve: async (input) => {
      const capability = await resolveCommandPackageItem(input.item, input.provider);
      return capability === undefined || !await confirmRemoval(capability)
        ? undefined
        : { capability, provider: input.provider };
    },
    lockTargets: ({ capability }) => [capability.packageFilePath],
    revalidate: async ({ capability, provider: currentProvider }) => {
      const checked = await resolveManifestEntry(capability, currentProvider, 'reject');
      if (checked === undefined) {
        return undefined;
      }
      const client = await clientManager.getClient(checked.packageDirectory);
      const beforeTask = await revalidateCommandPackageItem(checked, currentProvider);
      return beforeTask === undefined ? undefined : { capability: beforeTask, client };
    },
    mark: checked => markRemove(checked, provider),
    apply: async ({ capability: checked, client }) => {
      const command = client.buildRemoveCommand([checked.item.packageName]);
      logger.info(`Running remove command: ${formatShellTaskCommandForLog(command)}`);
      const taskName = vscode.l10n.t('Remove {0}', sanitizePackageText(checked.item.packageName));
      const taskOutcome = await runShellTaskAndWait(command, taskName, checked.packageDirectory);
      provider.invalidateUpdateCache();
      return { taskOutcome, taskName };
    },
    reconcile: execution => reconcileRemove(execution, provider),
    reportError: error => showError(vscode.l10n.t('failed to remove package — {0}', describeError(error)), error),
  });
}

function guardRemoveItem(item: unknown): boolean {
  if (isPackageItem(item)) {
    return true;
  }
  logger.warn(`${COMMAND_IDS.removePackage} invoked without a valid package item; ignoring.`);
  return false;
}

async function confirmRemoval(capability: ResolvedPackageItem): Promise<boolean> {
  const removeAction = vscode.l10n.t('Remove Package');
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Remove {0} from {1}?',
      sanitizePackageText(capability.item.packageName),
      formatDependencySectionLabel(capability.identity.section),
    ),
    { modal: true },
    removeAction,
  );
  return confirmed === removeAction;
}

function markRemove(checked: RemoveChecked, provider: PackagesProvider): RemoveMarked | undefined {
  const progress = markPackageCapabilities(provider, [{ capability: checked.capability, operation: { kind: 'remove' } }]);
  return progress === undefined
    ? undefined
    : { capability: progress.capabilities[0], progress };
}

async function reconcileRemove(execution: RemoveExecution, provider: PackagesProvider): Promise<void> {
  if (execution.kind === 'apply-failed') {
    clearMutationProgress(execution.marked.progress);
    return;
  }
  const { taskOutcome, taskName } = execution.result;
  if (taskOutcome.kind === 'cancelled') {
    logger.info(`Cancelled remove task "${taskName}".`);
    clearMutationProgress(execution.marked.progress);
    await provider.loadPackages();
    return;
  }
  if (taskOutcome.exitCode !== 0) {
    clearMutationProgress(execution.marked.progress);
    showError(formatShellTaskFailureMessage(taskName, taskOutcome.exitCode));
  }
  await provider.loadPackages();
}