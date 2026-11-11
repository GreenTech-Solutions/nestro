import * as vscode from 'vscode';
import { sanitizePackageText } from '../providers';
import { formatHeldBackDate } from '../utils';
import type { ReleaseAgeState } from '../utils';
import type { PackageUpdate } from './packageUpdateSteps';

interface RiskyPackageUpdate {
  readonly update: PackageUpdate;
  readonly releaseAge: Extract<ReleaseAgeState, { readonly kind: 'held-back' }>;
}

export async function confirmRiskyUpdates(
  updates: readonly PackageUpdate[],
  confirmedRiskyUpdates: Set<string>,
): Promise<boolean> {
  const updateKey = (update: PackageUpdate): string => [
    update.capability.packageFilePath,
    update.capability.identity.section,
    update.capability.item.packageName,
    update.version,
  ].join('\u0000');
  const riskyUpdates = updates
    .map(update => getUnconfirmedRiskyUpdate(update, confirmedRiskyUpdates, updateKey))
    .filter((update): update is RiskyPackageUpdate => update !== undefined);
  if (riskyUpdates.length === 0) {
    return true;
  }

  const labels = riskyUpdates.map(({ update, releaseAge }) => formatRiskyUpdateLabel(update, releaseAge));
  const updateRiskyAction = vscode.l10n.t('Update Risky Packages');
  const riskyPrompt = labels.length === 1
    ? vscode.l10n.t(
        'The selected update is inside the minimum release-age window:\n{0}\nUpdate anyway?',
        labels.join('\n'),
      )
    : vscode.l10n.t(
        'The selected updates are inside the minimum release-age window:\n{0}\nUpdate anyway?',
        labels.join('\n'),
      );
  const answer = await vscode.window.showWarningMessage(riskyPrompt, { modal: true }, updateRiskyAction);
  if (answer !== updateRiskyAction) {
    return false;
  }
  riskyUpdates.forEach(({ update }) => confirmedRiskyUpdates.add(updateKey(update)));
  return true;
}

function getUnconfirmedRiskyUpdate(
  update: PackageUpdate,
  confirmedRiskyUpdates: Set<string>,
  updateKey: (update: PackageUpdate) => string,
): RiskyPackageUpdate | undefined {
  const releaseAge = getReleaseAge(update);
  if (releaseAge?.kind !== 'held-back') {
    return undefined;
  }
  if (releaseAge.version !== update.version || confirmedRiskyUpdates.has(updateKey(update))) {
    return undefined;
  }
  return { update, releaseAge };
}

function formatRiskyUpdateLabel(
  update: PackageUpdate,
  releaseAge: Extract<ReleaseAgeState, { readonly kind: 'held-back' }>,
): string {
  const eligibleAt = formatHeldBackDate(releaseAge.eligibleAt);
  return vscode.l10n.t(
    '{0}@{1} (held back until {2})',
    sanitizePackageText(update.capability.item.packageName),
    sanitizePackageText(update.version),
    sanitizePackageText(eligibleAt),
  );
}

function getReleaseAge(update: PackageUpdate): ReleaseAgeState | undefined {
  return update.releaseAge ?? update.capability.item.releaseAge;
}