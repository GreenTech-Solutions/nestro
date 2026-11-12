import { describe, expect, it } from 'vitest';
import { buildPackageItem } from './fixtures';
import { formatViewDescription, projectPackageTree } from '../providers/treeBuilder';
import type { PackageTreeEntry } from '../providers/treeBuilder';
import type { AuditSeverity } from '../utils';

describe('vulnerable package filter', () => {
  it('filters rows by severity in stable order and reports the count', () => {
    const entries = [
      makeEntry('moderate-first', 'moderate'),
      makeEntry('critical', 'critical'),
      makeEntry('low', 'low'),
      makeEntry('safe'),
      makeEntry('info', 'info'),
      makeEntry('moderate-second', 'moderate'),
      makeEntry('high', 'high'),
    ];
    const projection = projectPackageTree(entries, 'vulnerable');

    expect(projection.visibleEntries.map(entry => entry.item.packageName)).toEqual([
      'critical', 'high', 'moderate-first', 'moderate-second', 'low', 'info',
    ]);
    expect(projection.filterCounts).toEqual({
      all: 7, hasUpdates: 0, patch: 0, minor: 0, breaking: 0, vulnerable: 6,
    });
    expect(formatViewDescription('vulnerable', '', projection.filterCounts)).toBe('Vulnerable (6)');
  });
});

function makeEntry(name: string, vulnerabilitySeverity?: AuditSeverity): PackageTreeEntry {
  const packageFilePath = '/workspace/package.json';
  return {
    item: buildPackageItem({ name, currentVersion: '1.0.0', vulnerabilitySeverity, packageFilePath }),
    dev: false,
    packageFilePath,
  };
}