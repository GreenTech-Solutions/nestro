import { describe, expect, it, vi } from 'vitest';
import type { UpdateCheckProgressSink } from '../providers/updateCheckProgress';
import { createUpdateCheckProgressReporter, formatUpdateCheckProgressMessage } from '../providers/updateCheckProgress';
import type { UpdateCheckProgress } from '../providers/updateOrchestrationTypes';

interface ProgressReport {
  readonly message?: string;
  readonly increment?: number;
}

function createSink(): { readonly sink: UpdateCheckProgressSink; readonly reports: ProgressReport[] } {
  const reports: ProgressReport[] = [];
  return {
    sink: { report: value => reports.push(value) },
    reports,
  };
}

describe('updateCheckProgress', () => {
  it('formats each progress message', () => {
    const labelOf = vi.fn((packageFilePath: string) => packageFilePath.replace('/workspace/', ''));

    expect(formatUpdateCheckProgressMessage({
      phase: 'versions',
      completedFiles: 1,
      totalFiles: 2,
      packageCount: 5,
      lastPackageFilePath: '/workspace/apps/web/package.json',
    }, labelOf)).toBe('Finding new versions — 1 of 2: apps/web/package.json');
    expect(formatUpdateCheckProgressMessage({
      phase: 'versions',
      completedFiles: 0,
      totalFiles: 2,
      packageCount: 5,
      lastPackageFilePath: undefined,
    }, labelOf)).toBe('Finding new versions — 0 of 2');
    expect(formatUpdateCheckProgressMessage({
      phase: 'versions',
      completedFiles: 0,
      totalFiles: 1,
      packageCount: 3,
      lastPackageFilePath: undefined,
    }, labelOf)).toBe('Finding new versions for 3 packages');
    expect(formatUpdateCheckProgressMessage({ phase: 'release-dates', completed: 4, total: 9 }, labelOf))
      .toBe('Checking release dates — 4 of 9');
    expect(labelOf).toHaveBeenCalledOnce();
  });

  it('allocates half the notification progress to each phase', () => {
    const { sink, reports } = createSink();
    const report = createUpdateCheckProgressReporter(sink, () => 'app', true);
    const events: UpdateCheckProgress[] = [
      { phase: 'versions', completedFiles: 0, totalFiles: 2, packageCount: 2, lastPackageFilePath: undefined },
      { phase: 'versions', completedFiles: 1, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/app/package.json' },
      { phase: 'versions', completedFiles: 2, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/lib/package.json' },
      { phase: 'release-dates', completed: 0, total: 2 },
      { phase: 'release-dates', completed: 1, total: 2 },
      { phase: 'release-dates', completed: 2, total: 2 },
    ];

    events.forEach(report);

    let total = 0;
    const percentages = reports.map(({ increment = 0 }) => (total += increment));
    expect(percentages).toEqual([0, 25, 50, 50, 75, 100]);
    expect(reports.every(({ message }) => message !== undefined)).toBe(true);
  });

  it('uses the whole notification progress when release dates are disabled', () => {
    const { sink, reports } = createSink();
    const report = createUpdateCheckProgressReporter(sink, () => 'app', false);

    report({ phase: 'versions', completedFiles: 0, totalFiles: 2, packageCount: 2, lastPackageFilePath: undefined });
    report({ phase: 'versions', completedFiles: 1, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/app/package.json' });
    report({ phase: 'versions', completedFiles: 2, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/lib/package.json' });

    let total = 0;
    expect(reports.map(({ increment = 0 }) => (total += increment))).toEqual([0, 50, 100]);
  });

  it('keeps increments monotonic and within the notification range', () => {
    const { sink, reports } = createSink();
    const report = createUpdateCheckProgressReporter(sink, () => 'app', true);
    const events: UpdateCheckProgress[] = [
      { phase: 'versions', completedFiles: 1, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/app/package.json' },
      { phase: 'versions', completedFiles: 2, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/lib/package.json' },
      { phase: 'versions', completedFiles: 1, totalFiles: 2, packageCount: 2, lastPackageFilePath: '/app/package.json' },
      { phase: 'release-dates', completed: 1, total: 2 },
      { phase: 'release-dates', completed: 2, total: 2 },
      { phase: 'release-dates', completed: 2, total: 2 },
    ];

    events.forEach(report);

    const increments = reports.flatMap(({ increment }) => increment === undefined ? [] : [increment]);
    expect(increments.every(increment => increment > 0)).toBe(true);
    expect(increments.reduce((sum, increment) => sum + increment, 0)).toBe(100);
    expect(reports).toHaveLength(events.length);
  });

  it('handles empty phase totals without producing non-finite increments', () => {
    const { sink, reports } = createSink();
    const report = createUpdateCheckProgressReporter(sink, () => 'app', true);

    report({ phase: 'versions', completedFiles: 0, totalFiles: 0, packageCount: 0, lastPackageFilePath: undefined });
    report({ phase: 'release-dates', completed: 0, total: 0 });

    expect(reports.map(({ increment = 0 }) => increment).every(Number.isFinite)).toBe(true);
    expect(reports[1]?.increment).toBe(100);
  });
});