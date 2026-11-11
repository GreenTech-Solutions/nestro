import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import {
  getLocalizedPackageLabelFormatting,
  resolvePackageFileLabels,
  toWorkspaceFolderDescriptors,
} from '../providers';
import type { PackagesProvider } from '../providers';
import { describeError } from '../shared';
import {
  formatShellTaskCommandForLog,
  formatShellTaskFailureMessage,
  getPackageDirectory,
  getWorkspacePackageFilePaths,
  logger,
  runShellTaskAndWait,
  showError,
} from '../utils';
import type { ShellTaskCommand, ShellTaskOutcome } from '../utils';
import { clearMutationProgress, markPackageIdentities, runRowMutation } from './rowMutation';
import type { IdentityMutationProgress } from './rowMutation';

const clientManager = new ClientManager();

interface InstallPackageSelection {
  readonly kind: 'selected';
  readonly packageFilePath: string;
}

interface CancelledInstallPackageSelection {
  readonly kind: 'cancelled';
}

interface InstallTaskChecked {
  readonly command: ShellTaskCommand;
  readonly taskName: string;
  readonly cwd: string;
  readonly packageFilePath: string;
}

type InstallTaskMarked = { readonly progress: IdentityMutationProgress | undefined };

export async function runInstallCommand(provider?: PackagesProvider): Promise<void> {
  await runRowMutation<PackagesProvider | undefined, InstallPackageSelection, InstallTaskChecked, InstallTaskMarked, ShellTaskOutcome>(provider, {
    guard: () => true,
    resolve: async () => {
      const selection = await resolveInstallPackageSelection();
      if (selection === undefined) {
        throw new Error(vscode.l10n.t('No workspace package.json found.'));
      }
      return selection.kind === 'cancelled' ? undefined : selection;
    },
    lockTargets: selection => [selection.packageFilePath],
    revalidate: async (selection) => {
      const cwd = getPackageDirectory(selection.packageFilePath);
      const client = await clientManager.getClient(cwd);
      const command = client.buildInstallCommand();
      logger.info(`Running install command: ${formatShellTaskCommandForLog(command)}`);
      return { command, taskName: vscode.l10n.t('Install Dependencies'), cwd, packageFilePath: selection.packageFilePath };
    },
    mark: checked => ({
      progress: provider === undefined
        ? undefined
        : markPackageIdentities(provider, provider.getPackageIdentitiesForFile(checked.packageFilePath), { kind: 'install' }),
    }),
    apply: async ({ command, taskName, cwd }) => {
      const taskOutcome = await runShellTaskAndWait(command, taskName, cwd);
      if (taskOutcome.kind === 'cancelled') {
        logger.info(`Cancelled install task "${taskName}".`);
      }
      else if (taskOutcome.exitCode !== 0) {
        showError(formatShellTaskFailureMessage(taskName, taskOutcome.exitCode));
      }
      return taskOutcome;
    },
    reconcile: (execution) => {
      if (execution.marked.progress !== undefined) {
        clearMutationProgress(execution.marked.progress);
      }
    },
    reportError: error => showError(vscode.l10n.t('failed to run install — {0}', describeError(error)), error),
  });
}

async function resolveInstallPackageSelection(): Promise<InstallPackageSelection | CancelledInstallPackageSelection | undefined> {
  const packageFilePaths = await getWorkspacePackageFilePaths();
  if (packageFilePaths.length === 0) {
    return undefined;
  }
  const folders = toWorkspaceFolderDescriptors(vscode.workspace.workspaceFolders ?? []);
  const labels = resolvePackageFileLabels(packageFilePaths, folders, getLocalizedPackageLabelFormatting());
  if (labels.length === 1) {
    return { kind: 'selected', packageFilePath: labels[0].packageFilePath };
  }

  const selected = await vscode.window.showQuickPick(
    labels.map(({ packageFilePath, owner }) => ({
      label: owner.label,
      packageFilePath,
    })),
    { placeHolder: vscode.l10n.t('Select the package.json to install dependencies for') },
  );
  if (selected === undefined) {
    return { kind: 'cancelled' };
  }

  return { kind: 'selected', packageFilePath: selected.packageFilePath };
}