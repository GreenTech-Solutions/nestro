import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import { getIncludePreReleases, getMinimumReleaseAgeDays } from '../config';
import { isPackageItem, PACKAGE_IDENTITY_REJECTED_MESSAGE, PackagesProvider, sanitizePackageText } from '../providers';
import type { ResolvedPackageItem } from '../providers';
import { COMMAND_IDS } from '../shared';
import {
  classifyVersionReleaseAge,
  fetchPackageMetadata,
  formatHeldBackDate,
  logger,
  selectVersionsForPicker,
  showError,
} from '../utils';
import type { PackageMetadataOutcome, ReleaseAgeState } from '../utils';
import { stripVersionDecorations } from '../shared';
import { runResolvedPackageVersion } from './installUpdate';
import { resolveCommandPackageItem, revalidateCommandPackageItem } from './packageIdentity';

const clientManager = new ClientManager();

function detectPackageManager(cwd: string | undefined) {
  return clientManager.detectPackageManager(cwd);
}

interface VersionQuickPickItem extends vscode.QuickPickItem {
  readonly version: string;
}

interface VersionPickerSession {
  readonly quickPick: vscode.QuickPick<VersionQuickPickItem>;
  readonly signal: AbortSignal;
  isDisposed(): boolean;
  hide(): void;
  addDisposable(disposable: vscode.Disposable): void;
}

interface VersionPickerContent {
  readonly items: VersionQuickPickItem[];
  readonly allowedVersions: ReadonlySet<string>;
  readonly releaseAgeByVersion: ReadonlyMap<string, ReleaseAgeState>;
  readonly releaseAgeUnavailable: boolean;
}

type SuccessfulPackageMetadata = Extract<PackageMetadataOutcome, { readonly kind: 'success' }>['result'];

export async function pickVersionCommand(item: unknown, provider: PackagesProvider): Promise<void> {
  if (!isPackageItem(item)) {
    logger.warn(`${COMMAND_IDS.pickVersion} invoked without a valid package item; ignoring.`);
    return;
  }

  const capability = await resolveCommandPackageItem(item, provider);
  if (capability === undefined) {
    return;
  }

  logger.info(`Fetching versions for ${capability.item.packageName}.`);
  const session = createVersionPickerSession(capability.item.packageName);
  await loadVersionPicker(capability, provider, session);
}

function createVersionPickerSession(packageName: string): VersionPickerSession {
  const quickPick = vscode.window.createQuickPick<VersionQuickPickItem>();
  quickPick.title = vscode.l10n.t('Select version for {0}', sanitizePackageText(packageName));
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

  return {
    quickPick,
    signal: abortController.signal,
    isDisposed: () => disposed,
    hide: () => quickPick.hide(),
    addDisposable: disposable => disposables.push(disposable),
  };
}

async function loadVersionPicker(
  capability: ResolvedPackageItem,
  provider: PackagesProvider,
  session: VersionPickerSession,
): Promise<void> {
  try {
    const metadataOutcome = await fetchPackageMetadata(
      detectPackageManager,
      capability.item.packageName,
      capability.packageFilePath,
      session.signal,
    );
    if (session.isDisposed()) {
      return;
    }
    if (metadataOutcome.kind !== 'success') {
      session.hide();
      showVersionPickerError(capability.item.packageName, metadataOutcome);
      return;
    }

    await showVersionChoices(metadataOutcome.result, capability, provider, session);
  }
  catch (err) {
    if (session.isDisposed()) {
      return;
    }

    session.hide();
    showVersionPickerError(capability.item.packageName, err);
  }
}

async function showVersionChoices(
  metadata: SuccessfulPackageMetadata,
  capability: ResolvedPackageItem,
  provider: PackagesProvider,
  session: VersionPickerSession,
): Promise<void> {
  const fetchedCapability = await revalidateCommandPackageItem(capability, provider);
  if (session.isDisposed()) {
    return;
  }
  if (fetchedCapability === undefined) {
    session.hide();
    return;
  }

  const current = fetchedCapability.item;
  const content = createVersionPickerContent(
    metadata,
    current.currentVersion,
    getIncludePreReleases(),
    getMinimumReleaseAgeDays(),
  );
  if (content.releaseAgeUnavailable) {
    session.quickPick.title = vscode.l10n.t(
      'Select version for {0} — release age unknown; update is not blocked',
      sanitizePackageText(current.packageName),
    );
  }

  session.quickPick.items = content.items;
  session.quickPick.busy = false;
  session.quickPick.placeholder = vscode.l10n.t('Type to filter versions…');
  session.addDisposable(session.quickPick.onDidAccept(() => {
    void handleVersionSelection(
      session.quickPick,
      fetchedCapability,
      content.allowedVersions,
      content.releaseAgeByVersion,
      provider,
    );
  }));
}

function createVersionPickerContent(
  metadata: SuccessfulPackageMetadata,
  currentVersion: string,
  includePreReleases: boolean,
  minimumReleaseAgeDays: number,
): VersionPickerContent {
  const selectedVersions = selectVersionsForPicker(
    metadata.versions,
    metadata.distTags,
    currentVersion,
    includePreReleases,
  );
  const tagByVersion = new Map(Object.entries(metadata.distTags).map(([tag, version]) => [version, tag]));
  const normalizedCurrent = normalizeCurrentVersion(currentVersion);
  const releaseAgeByVersion = new Map<string, ReleaseAgeState>();
  const releaseAgeUnavailable = metadata.publishTimes.kind === 'not-provided';
  const items = selectedVersions.map((version) => {
    const releaseAge = classifyVersionReleaseAge(version, metadata.publishTimes, minimumReleaseAgeDays);
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

  return {
    items,
    allowedVersions: new Set(selectedVersions),
    releaseAgeByVersion,
    releaseAgeUnavailable,
  };
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
  return stripVersionDecorations(currentVersion);
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