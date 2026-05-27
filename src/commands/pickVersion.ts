import * as vscode from 'vscode';
import { PackageItem, PackagesProvider } from '../providers';
import {
  fetchPackageVersions,
  getUpdateType,
  logger,
  selectVersionsForPicker,
} from '../utils';
import { installUpdateCommand } from './installUpdate';

export async function pickVersionCommand(item: PackageItem, provider: PackagesProvider): Promise<void> {
  logger.info(`Fetching versions for ${item.packageName}.`);
  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
  quickPick.title = `Select version for ${item.packageName}`;
  quickPick.placeholder = 'Loading versions...';
  quickPick.busy = true;
  quickPick.show();

  try {
    const { tags, versions } = await fetchPackageVersions(item.packageName);
    const selectedVersions = selectVersionsForPicker(versions, tags, item.currentVersion);
    const tagByVersion = new Map(Object.entries(tags).map(([tag, version]) => [version, tag]));
    const normalizedCurrent = normalizeCurrentVersion(item.currentVersion);

    quickPick.items = selectedVersions.map(version => ({
      label: version === normalizedCurrent ? `★ ${version}` : version,
      description: tagByVersion.get(version),
      detail: version === normalizedCurrent ? 'Current version' : undefined,
    }));
    quickPick.busy = false;
    quickPick.placeholder = 'Type to filter versions...';
    quickPick.onDidAccept(() => {
      void handleVersionSelection(quickPick, item, provider, normalizedCurrent);
    });
  }
  catch (err) {
    quickPick.hide();
    showVersionPickerError(item.packageName, err);
  }
}

async function handleVersionSelection(
  quickPick: vscode.QuickPick<vscode.QuickPickItem>,
  item: PackageItem,
  provider: PackagesProvider,
  normalizedCurrent: string,
): Promise<void> {
  const choice = quickPick.selectedItems[0];
  quickPick.hide();
  if (choice === undefined) {
    return;
  }

  const selectedVersion = choice.label.replace(/^★ /, '');
  if (selectedVersion === normalizedCurrent) {
    return;
  }

  const syntheticItem = new PackageItem(
    item.packageName,
    item.currentVersion,
    selectedVersion,
    getUpdateType(normalizedCurrent, selectedVersion),
    false,
    item.vulnerabilitySeverity,
    item.packageFilePath,
  );
  await installUpdateCommand(syntheticItem, provider);
}

function normalizeCurrentVersion(currentVersion: string): string {
  return currentVersion.replace(/^workspace:/, '').replace(/^([~^]|>=|>|<=|<)/, '');
}

function showVersionPickerError(packageName: string, err: unknown): void {
  void vscode.window.showErrorMessage(`Failed to fetch versions for ${packageName}.`);
  logger.error(`Failed to fetch versions for ${packageName}.`, err);
}