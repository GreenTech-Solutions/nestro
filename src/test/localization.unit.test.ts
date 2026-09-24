import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  formatAdvisoryRows,
  formatAuditSeverityLabel,
  formatDependencySectionLabel,
  formatPackageCount,
  formatPackageGroupDescription,
  formatPackageLevelFindings,
  formatPackageUpdatesAvailable,
  formatPinnedPackageVersions,
  formatUpdateTypeLabel,
  formatVulnerablePackageCount,
} from '../utils';

const COUNTS = [
  [0, '0 packages'],
  [1, '1 package'],
  [2, '2 packages'],
  [100, '100 packages'],
] as const;

describe('localization plural helpers', () => {
  beforeEach(() => {
    vi.mocked(vscode.l10n.t).mockClear();
  });

  it.each(COUNTS)('formats %s package count as %s', (count, expected) => {
    expect(formatPackageCount(count)).toBe(expected);
  });

  it.each([
    [0, 0, '0 packages'],
    [1, 0, '1 package'],
    [2, 1, '2 packages · 1 outdated'],
    [100, 100, '100 packages · 100 outdated'],
  ] as const)('formats %s total and %s outdated packages as %s', (totalCount, outdatedCount, expected) => {
    expect(formatPackageGroupDescription(totalCount, outdatedCount)).toBe(expected);
  });

  it('passes the group description parameters in their documented order', () => {
    formatPackageGroupDescription(2, 1);

    expect(vscode.l10n.t).toHaveBeenLastCalledWith('{0} · {1} outdated', '2 packages', 1);
  });

  it.each(COUNTS)('formats %s available update count', (count) => {
    const expected = count === 1 ? '1 package update available' : `${count} package updates available`;
    expect(formatPackageUpdatesAvailable(count)).toBe(expected);
  });

  it.each(COUNTS)('formats %s vulnerable package count', (count) => {
    const expected = count === 1 ? '1 vulnerable package' : `${count} vulnerable packages`;
    expect(formatVulnerablePackageCount(count)).toBe(expected);
  });

  it.each(COUNTS)('formats %s pinned package versions', (count) => {
    const expected = count === 1 ? 'Pinned 1 package version.' : `Pinned ${count} package versions.`;
    expect(formatPinnedPackageVersions(count)).toBe(expected);
  });

  it.each(COUNTS)('formats %s advisory rows', (count) => {
    const expected = count === 1 ? '1 advisory row' : `${count} advisory rows`;
    expect(formatAdvisoryRows(count)).toBe(expected);
  });

  it.each(COUNTS)('formats %s package-level findings', (count) => {
    const expected = count === 1 ? '1 package-level finding' : `${count} package-level findings`;
    expect(formatPackageLevelFindings(count)).toBe(expected);
  });

  it.each(['dependencies', 'devDependencies'] as const)('localizes the %s dependency section label', (section) => {
    expect(formatDependencySectionLabel(section)).toBe(section === 'dependencies' ? 'dependencies' : 'dev dependencies');
  });

  it.each(['patch', 'minor', 'breaking', 'none'] as const)('localizes the %s update type label', (updateType) => {
    expect(formatUpdateTypeLabel(updateType)).toBe(updateType);
  });

  it.each(['critical', 'high', 'moderate', 'low', 'info'] as const)('localizes the %s audit severity label', (severity) => {
    expect(formatAuditSeverityLabel(severity)).toBe(severity);
  });
});