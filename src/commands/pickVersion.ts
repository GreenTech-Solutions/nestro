import * as vscode from 'vscode';
import { isPackageItem, PACKAGE_IDENTITY_REJECTED_MESSAGE, PackagesProvider, sanitizePackageText } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import {
  classifyVersionReleaseAge,
  DEFAULT_MINIMUM_RELEASE_AGE_DAYS,
  fetchPackageMetadata,
  formatHeldBackDate,
  logger,
  readMinimumReleaseAgeDays,
  selectVersionsForPicker,
  showError,
} from '../utils';
import type { ReleaseAgeState } from '../utils';
import { runResolvedPackageVersion } from './installUpdate';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';

interface VersionQuickPickItem extends vscode.QuickPickItem {
  readonly version: string;
}

export async function pickVersionCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn('nestro.pickVersion invoked without a valid package item; ignoring.');
    return;
  }

  let capability = await resolveCommandPackageItem(item, provider);
  if (capability === undefined) {
    return;
  }
  let current = capability.item;

  logger.info(`Fetching versions for ${current.packageName}.`);
  const quickPick = vscode.window.createQuickPick<VersionQuickPickItem>();
  quickPick.title = vscode.l10n.t('Select version for {0}', sanitizePackageText(current.packageName));
  quickPick.placeholder = vscode.l10n.t('Loading versions...');
  quickPick.busy = true;
  const disposables: vscode.Disposable[] = [];
  const abortController = new AbortController();
  let disposed = false;
  const cleanup = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    abortController.abort();
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }
    quickPick.dispose();
  };
  disposables.push(quickPick.onDidHide(cleanup));
  quickPick.show();

  try {
    const metadataOutcome = await fetchPackageMetadata(
      current.packageName,
      capability.packageFilePath,
      abortController.signal,
    );
    if (disposed) {
      return;
    }
    if (metadataOutcome.kind !== 'success') {
      quickPick.hide();
      showVersionPickerError(current.packageName, metadataOutcome);
      return;
    }

    const { distTags: tags, versions } = metadataOutcome.result;

    const fetchedCapability = await revalidateCommandPackageItem(capability, provider);
    if (fetchedCapability === undefined) {
      quickPick.hide();
      return;
    }
    capability = fetchedCapability;
    current = capability.item;
    const pickerCapability = fetchedCapability;

    const includePreReleases = vscode.workspace
      .getConfiguration('nestro')
      .get<boolean>('includePreReleases', false);
    const minimumReleaseAgeDays = readMinimumReleaseAgeDays(
      vscode.workspace
        .getConfiguration('nestro')
        .get<unknown>('minimumReleaseAgeDays', DEFAULT_MINIMUM_RELEASE_AGE_DAYS),
    );
    const selectedVersions = selectVersionsForPicker(
      versions,
      tags,
      current.currentVersion,
      includePreReleases,
    );
    const tagByVersion = new Map(Object.entries(tags).map(([tag, version]) => [version, tag]));
    const normalizedCurrent = normalizeCurrentVersion(current.currentVersion);
    const releaseAgeByVersion = new Map<string, ReleaseAgeState>();
    const releaseAgeUnavailable = metadataOutcome.result.publishTimes.kind === 'not-provided';
    if (releaseAgeUnavailable) {
      quickPick.title = vscode.l10n.t(
        'Select version for {0} — release age unknown; update is not blocked',
        sanitizePackageText(current.packageName),
      );
    }

    quickPick.items = selectedVersions.map((version) => {
      const releaseAge = classifyVersionReleaseAge(
        version,
        metadataOutcome.result.publishTimes,
        minimumReleaseAgeDays,
      );
      releaseAgeByVersion.set(version, releaseAge);
      const ageDescription = releaseAge.kind === 'held-back'
        ? vscode.l10n.t('Held back until {0}', sanitizePackageText(formatHeldBackDate(releaseAge.eligibleAt)))
        : releaseAge.kind === 'unknown' && !releaseAgeUnavailable
          ? vscode.l10n.t('Release age unknown; update is not blocked.')
          : undefined;
      return {
        label: version === normalizedCurrent ? `★ ${version}` : version,
        version,
        description: [tagByVersion.get(version), ageDescription]
          .filter((value): value is string => value !== undefined)
          .map(sanitizePackageText)
          .join(' · ') || undefined,
        detail: version === normalizedCurrent ? vscode.l10n.t('Current version') : undefined,
      };
    });
    quickPick.busy = false;
    quickPick.placeholder = vscode.l10n.t('Type to filter versions…');
    const allowedVersions = new Set(selectedVersions);
    const acceptListener = quickPick.onDidAccept(() => {
      void handleVersionSelection(quickPick, pickerCapability, allowedVersions, releaseAgeByVersion, provider);
    });
    disposables.push(acceptListener);
  }
  catch (err) {
    if (disposed) {
      return;
    }

    quickPick.hide();
    showVersionPickerError(current.packageName, err);
  }
}

async function handleVersionSelection(
  quickPick: vscode.QuickPick<VersionQuickPickItem>,
  capability: ResolvedPackageItem,
  allowedVersions: ReadonlySet<string>,
  releaseAgeByVersion: ReadonlyMap<string, ReleaseAgeState>,
  provider: PackagesProvider,
): Promise<void> {
  try {
    const choice = quickPick.selectedItems[0];
    quickPick.hide();
    if (choice === undefined) {
      return;
    }

    const selectedVersion = choice.version;
    if (!allowedVersions.has(selectedVersion)) {
      showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
      return;
    }
    const checked = await revalidateCommandPackageItem(capability, provider);
    if (checked === undefined) {
      return;
    }
    if (selectedVersion === normalizeCurrentVersion(checked.item.currentVersion)) {
      return;
    }

    await runResolvedPackageVersion(checked, selectedVersion, provider, releaseAgeByVersion.get(selectedVersion));
  }
  catch (err) {
    logger.error('Failed to apply the selected package version.', err);
    showError(PACKAGE_IDENTITY_REJECTED_MESSAGE);
  }
}

function normalizeCurrentVersion(currentVersion: string): string {
  return currentVersion.replace(/^workspace:/, '').replace(/^([~^]|>=|>|<=|<)/, '');
}

function showVersionPickerError(packageName: string, err: unknown): void {
  const safePackageName = sanitizePackageText(packageName);
  const detail = getMetadataErrorDetail(err);
  const message = detail === undefined
    ? vscode.l10n.t('Failed to fetch versions for {0}.', safePackageName)
    : vscode.l10n.t('Failed to fetch versions for {0}: {1}', safePackageName, detail);
  void vscode.window.showErrorMessage(message);
  logger.error(message, err);
}

function getMetadataErrorDetail(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const candidate = err as { kind?: unknown; message?: unknown };
  return candidate.kind === 'unavailable' && typeof candidate.message === 'string'
    ? sanitizePackageText(candidate.message)
    : undefined;
}