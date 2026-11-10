import * as vscode from 'vscode';
import { isPackageItem, PACKAGE_IDENTITY_REJECTED_MESSAGE, PackagesProvider } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import { COMMAND_IDS, describeError } from '../shared';
import {
  logger,
  parseDependencySpec,
  setVersionPin,
  showError,
  VersionPinConflictError,
} from '../utils';
import { resolveCommandPackageItem, resolvePinManifestEntry } from './packageIdentity';
import { clearMutationProgress, markPackageCapabilities, runRowMutation } from './rowMutation';
import type { RowMutationExecution, RowMutationProgress } from './rowMutation';

interface PinInput {
  readonly item: unknown;
  readonly provider: PackagesProvider;
}

interface PinMutation {
  readonly capability: ResolvedPackageItem;
  readonly provider: PackagesProvider;
}

interface PinChecked {
  readonly capability: ResolvedPackageItem;
  readonly shouldPin: boolean;
}

interface PinMarked extends PinChecked {
  readonly progress: RowMutationProgress;
}

type PinExecution = RowMutationExecution<PinChecked, PinMarked, void>;

export async function pinVersionCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  await runRowMutation<PinInput, PinMutation, PinChecked, PinMarked, void>({ item, provider }, {
    guard: input => guardPinItem(input.item),
    resolve: async (input) => {
      const capability = await resolveCommandPackageItem(input.item, input.provider);
      return capability === undefined ? undefined : { capability, provider: input.provider };
    },
    lockTargets: ({ capability }) => [capability.packageFilePath],
    revalidate: async ({ capability, provider: currentProvider }) => {
      const checked = await resolvePinManifestEntry(capability, currentProvider);
      if (checked === undefined) {
        return undefined;
      }
      const parsed = parseDependencySpec(checked.item.currentVersion);
      if (!parsed.supported) {
        showError(vscode.l10n.t(
          'cannot toggle version pin for {0} — {1}',
          checked.item.packageName,
          parsed.reason,
        ));
        return undefined;
      }
      return { capability: checked, shouldPin: parsed.range !== 'exact' };
    },
    mark: checked => markPin(checked, provider),
    apply: async ({ capability: checked, shouldPin }) => {
      logger.info(`${shouldPin ? 'Pinning' : 'Unpinning'} ${checked.item.packageName} version.`);
      await provider.withWriteSuppressed(() => setVersionPin(
        checked.packageFilePath,
        checked.item.packageName,
        checked.identity.section,
        checked.item.currentVersion,
        shouldPin,
      ));
    },
    reconcile: execution => reconcilePin(execution, provider),
    reportError: error => reportPinError(error),
  });
}

function guardPinItem(item: unknown): boolean {
  if (isPackageItem(item)) {
    return true;
  }
  logger.warn(`${COMMAND_IDS.pinVersion} invoked without a valid package item; ignoring.`);
  return false;
}

function markPin(checked: PinChecked, provider: PackagesProvider): PinMarked | undefined {
  const progress = markPackageCapabilities(provider, [{ capability: checked.capability, operation: { kind: 'pin' } }]);
  return progress === undefined ? undefined : { ...checked, progress };
}

async function reconcilePin(execution: PinExecution, provider: PackagesProvider): Promise<void> {
  clearMutationProgress(execution.marked.progress);
  if (execution.kind === 'applied') {
    await provider.loadPackages();
  }
}

function reportPinError(error: unknown): void {
  if (error instanceof VersionPinConflictError) {
    showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
    return;
  }
  showError(vscode.l10n.t('failed to toggle version pin — {0}', describeError(error)), error);
}