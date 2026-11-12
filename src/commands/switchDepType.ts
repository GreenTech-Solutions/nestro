import * as vscode from 'vscode';
import { isPackageItem, PackagesProvider } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import { COMMAND_IDS, describeError } from '../shared';
import {
  DependencyTypeConflictError,
  logger,
  showError,
  switchDependencyType,
} from '../utils';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';
import { clearMutationProgress, markPackageCapabilities, runRowMutation } from './rowMutation';
import type { RowMutationExecution, RowMutationProgress } from './rowMutation';

interface SwitchInput {
  readonly item: unknown;
  readonly provider: PackagesProvider;
}

interface SwitchMutation {
  readonly capability: ResolvedPackageItem;
  readonly provider: PackagesProvider;
}

interface SwitchMarked {
  readonly capability: ResolvedPackageItem;
  readonly progress: RowMutationProgress;
}

type SwitchExecution = RowMutationExecution<ResolvedPackageItem, SwitchMarked, void>;

export async function switchDepTypeCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  await runRowMutation<SwitchInput, SwitchMutation, ResolvedPackageItem, SwitchMarked, void>({ item, provider }, {
    guard: input => guardSwitchItem(input.item),
    resolve: async (input) => {
      const capability = await resolveCommandPackageItem(input.item, input.provider);
      return capability === undefined ? undefined : { capability, provider: input.provider };
    },
    lockTargets: ({ capability }) => [capability.packageFilePath],
    revalidate: ({ capability, provider: currentProvider }) => revalidateCommandPackageItem(capability, currentProvider),
    mark: checked => markSwitch(checked, provider),
    apply: async (checked) => {
      logger.info(`Switching ${checked.item.packageName} dependency type.`);
      await provider.withWriteSuppressed(() => switchDependencyType(
        checked.packageFilePath,
        checked.item.packageName,
        checked.identity.section === 'devDependencies',
        checked.item.currentVersion,
      ));
    },
    reconcile: execution => reconcileSwitch(execution, provider),
    reportError: error => reportSwitchError(error),
  });
}

function guardSwitchItem(item: unknown): boolean {
  if (isPackageItem(item)) {
    return true;
  }
  logger.warn(`${COMMAND_IDS.switchDepType} invoked without a valid package item; ignoring.`);
  return false;
}

function markSwitch(checked: ResolvedPackageItem, provider: PackagesProvider): SwitchMarked | undefined {
  const progress = markPackageCapabilities(provider, [{ capability: checked, operation: { kind: 'switch' } }]);
  return progress === undefined ? undefined : { capability: progress.capabilities[0], progress };
}

async function reconcileSwitch(execution: SwitchExecution, provider: PackagesProvider): Promise<void> {
  clearMutationProgress(execution.marked.progress);
  if (execution.kind === 'applied') {
    await provider.loadPackages();
  }
}

function reportSwitchError(error: unknown): void {
  if (error instanceof DependencyTypeConflictError) {
    showError(error.message);
    return;
  }
  showError(vscode.l10n.t('failed to switch dependency type — {0}', describeError(error)), error);
}