import * as vscode from 'vscode';
import { formatPackageCount } from '../utils';
import type { UpdateCheckProgress } from './updateOrchestrationTypes';

export type UpdateCheckProgressSink = vscode.Progress<{ message?: string; increment?: number }>;

/** Formats one progress event as the notification message. */
export function formatUpdateCheckProgressMessage(
  progress: UpdateCheckProgress,
  labelOf: (packageFilePath: string) => string,
): string {
  if (progress.phase === 'release-dates') {
    return vscode.l10n.t('Checking release dates — {0} of {1}', progress.completed, progress.total);
  }
  if (progress.totalFiles > 1) {
    return progress.lastPackageFilePath === undefined
      ? vscode.l10n.t('Finding new versions — {0} of {1}', progress.completedFiles, progress.totalFiles)
      : vscode.l10n.t(
          'Finding new versions — {0} of {1}: {2}',
          progress.completedFiles,
          progress.totalFiles,
          labelOf(progress.lastPackageFilePath),
        );
  }
  return vscode.l10n.t('Finding new versions for {0}', formatPackageCount(progress.packageCount));
}

/** Returns a callback that reports messages and monotonic increments for one update check. */
export function createUpdateCheckProgressReporter(
  sink: UpdateCheckProgressSink,
  labelOf: (packageFilePath: string) => string,
  includesReleaseDates: boolean,
): (progress: UpdateCheckProgress) => void {
  let lastReportedPercent = 0;
  return (progress) => {
    const currentPercent = getUpdateCheckProgressPercent(progress, includesReleaseDates);
    const nextPercent = Math.min(100, Math.max(lastReportedPercent, currentPercent));
    const increment = nextPercent - lastReportedPercent;
    lastReportedPercent = nextPercent;
    sink.report({
      message: formatUpdateCheckProgressMessage(progress, labelOf),
      ...(increment > 0 ? { increment } : {}),
    });
  };
}

function getUpdateCheckProgressPercent(progress: UpdateCheckProgress, includesReleaseDates: boolean): number {
  if (progress.phase === 'versions') {
    const ratio = progress.totalFiles === 0 ? 0 : progress.completedFiles / progress.totalFiles;
    return (includesReleaseDates ? 50 : 100) * clampProgressRatio(ratio);
  }
  const ratio = progress.total === 0 ? 1 : progress.completed / progress.total;
  return 50 + 50 * clampProgressRatio(ratio);
}

function clampProgressRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
}