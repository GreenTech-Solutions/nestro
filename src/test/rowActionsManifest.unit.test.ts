import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PackageItem } from '../providers';

interface ViewItemMenuEntry {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly menus: {
      readonly 'view/item/context': readonly ViewItemMenuEntry[];
    };
  };
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
const packageRowMenus = manifest.contributes.menus['view/item/context']
  .filter(entry => entry.when.includes('viewItem =~'));

function getViewItemPattern(entry: ViewItemMenuEntry): RegExp {
  const match = /viewItem\s*=~\s*\/(.*)\/([a-z]*)$/.exec(entry.when);
  if (match === null) {
    throw new Error(`Menu entry has no viewItem regex: ${entry.command}`);
  }
  return new RegExp(match[1], match[2]);
}

function getMatchingPackageRowMenus(item: PackageItem): readonly ViewItemMenuEntry[] {
  return packageRowMenus.filter(entry => getViewItemPattern(entry).test(item.contextValue ?? ''));
}

describe('package row action manifest', () => {
  it('keeps Update and Pick Version inline and orders context actions by purpose', () => {
    expect(packageRowMenus.map(entry => [entry.command, entry.group])).toEqual([
      ['nestro.installUpdate', 'inline'],
      ['nestro.pickVersion', 'inline@2'],
      ['nestro.openOnNpm', 'navigation@1'],
      ['nestro.copyPackageName', 'navigation@2'],
      ['nestro.switchDepType', '2_manage@1'],
      ['nestro.pinVersion', '2_manage@2'],
      ['nestro.removePackage', '3_danger@1'],
    ]);

    expect(packageRowMenus.filter(entry => entry.group?.startsWith('inline') === true))
      .toHaveLength(2);
    expect(new Set(packageRowMenus.map(entry => entry.command)).size).toBe(packageRowMenus.length);
  });

  it('matches every row context entry by regex rather than an exact context value', () => {
    for (const entry of manifest.contributes.menus['view/item/context']) {
      expect(entry.when).not.toMatch(/viewItem\s*==/);
      expect(entry.when).toMatch(/viewItem\s*=~/);
    }
  });

  it.each([
    [
      'outdated vulnerable pinnable',
      new PackageItem('pkg', '^1.0.0', '1.1.0', 'minor', undefined, 'high'),
      [
        'nestro.installUpdate',
        'nestro.pickVersion',
        'nestro.openOnNpm',
        'nestro.copyPackageName',
        'nestro.switchDepType',
        'nestro.pinVersion',
        'nestro.removePackage',
      ],
      2,
    ],
    [
      'outdated vulnerable pin-unsupported',
      new PackageItem('local-pkg', 'npm:real-pkg@^1.0.0', '2.0.0', 'breaking', undefined, 'critical'),
      [
        'nestro.installUpdate',
        'nestro.pickVersion',
        'nestro.openOnNpm',
        'nestro.copyPackageName',
        'nestro.switchDepType',
        'nestro.removePackage',
      ],
      2,
    ],
    [
      'current pinnable',
      new PackageItem('stable', '^1.0.0', undefined, 'none'),
      [
        'nestro.pickVersion',
        'nestro.openOnNpm',
        'nestro.copyPackageName',
        'nestro.switchDepType',
        'nestro.pinVersion',
        'nestro.removePackage',
      ],
      1,
    ],
    [
      'installing vulnerable',
      new PackageItem('pending', '^1.0.0', '2.0.0', 'minor', { kind: 'update', target: '2.0.0' }, 'high'),
      ['nestro.openOnNpm', 'nestro.copyPackageName'],
      0,
    ],
  ] as const)('keeps commands reachable for %s rows', (_label, item, expectedCommands, expectedInlineCount) => {
    const matchingMenus = getMatchingPackageRowMenus(item);
    expect(matchingMenus.map(entry => entry.command)).toEqual(expectedCommands);
    expect(matchingMenus.filter(entry => entry.group?.startsWith('inline') === true)).toHaveLength(expectedInlineCount);
    expect(expectedInlineCount).toBeLessThanOrEqual(2);
  });
});