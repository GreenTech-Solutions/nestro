import { describe, expect, it } from 'vitest';
import {
  buildTree,
  FilterBarItem,
  findOwningWorkspaceFolder,
  getFilterCounts,
  getFilteredEntries,
  GroupItem,
  MessageItem,
  PackageItem,
  PackageTreeEntry,
  projectPackageTree,
  resolvePackageFileLabels,
  resolvePackageOwnerLabel,
  resolveWorkspaceFolderDisplayNames,
  SearchQueryItem,
  toRelativeLabel,
  toWorkspaceFolderDescriptors,
  WorkspaceFolderDescriptor,
  WorkspaceFolderItem,
} from '../providers';
import * as vscode from 'vscode';
import type { PackageOperation } from '../providers';
import type { AuditSeverity } from '../utils';

describe('buildTree', () => {
  it('returns no tree items when there are no packages', () => {
    expect(buildTree([], 'all', '')).toEqual([]);
  });

  it('builds a filter row and dependency groups', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', '19.0.0', 'breaking', false),
      makeEntry('eslint', '8.0.0', undefined, 'none', true),
    ], 'all', '');

    expect(tree[0]).toBeInstanceOf(SearchQueryItem);
    expect(tree[1]).toBeInstanceOf(FilterBarItem);
    const groups = tree.slice(2).filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups.map(group => group.label)).toEqual(['Dependencies', 'Dev Dependencies']);
    expect(groups[0].description).toBe('1 package · 1 outdated');
    expect(groups[1].description).toBe('1 package');
    expect(groups[0].iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect(groups[1].iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((groups[0].iconPath as vscode.ThemeIcon).id).toBe('package');
    expect((groups[1].iconPath as vscode.ThemeIcon).id).toBe('tools');
    expect(groups.flatMap(group => group.children.map(child => child.label))).toEqual(['react', 'eslint']);
  });

  it('shows an empty-filter message when no packages match', () => {
    const tree = buildTree([
      makeEntry('eslint', '8.0.0', undefined, 'none', true),
    ], 'breaking', '');

    expect(tree[0]).toBeInstanceOf(SearchQueryItem);
    expect(tree[1]).toBeInstanceOf(FilterBarItem);
    expect(tree[2]).toBeInstanceOf(MessageItem);
    expect(tree[2].label).toBe('No packages match the current filter.');
  });

  it('filters packages by update type', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', '18.0.1', 'patch', false),
      makeEntry('typescript', '5.0.0', '6.0.0', 'breaking', true),
    ], 'patch', '');

    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('sorts hasUpdates packages by severity', () => {
    const tree = buildTree([
      makeEntry('patch-package', '1.0.0', '1.0.1', 'patch', false),
      makeEntry('breaking-package', '1.0.0', '2.0.0', 'breaking', false),
      makeEntry('minor-package', '1.0.0', '1.1.0', 'minor', false),
    ], 'hasUpdates', '');

    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual([
      'breaking-package',
      'minor-package',
      'patch-package',
    ]);
  });

  it('keeps the flat tree shape for a single package file', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', undefined, 'none', false, '/workspace/package.json'),
    ], 'all', '', [makeFolder('/workspace', 'workspace', 0)]);

    expect(tree[0]).toBeInstanceOf(SearchQueryItem);
    expect(tree[1]).toBeInstanceOf(FilterBarItem);
    expect(tree.some(item => item instanceof WorkspaceFolderItem)).toBe(false);
  });

  it('groups packages by workspace folder for multiple package files', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', undefined, 'none', false, '/workspace/apps/frontend/package.json'),
      makeEntry('ui-lib', '1.0.0', undefined, 'none', false, '/workspace/packages/ui/package.json'),
    ], 'all', '', [makeFolder('/workspace', 'workspace', 0)]);

    expect(tree[0]).toBeInstanceOf(SearchQueryItem);
    const folders = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(folders.map(folder => folder.label)).toEqual(['workspace — apps/frontend', 'workspace — packages/ui']);
    expect(folders[0].children[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('reuses full manifest labels across filters and includes non-visible manifests', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const entries = [
      makeEntry('alpha', '1.0.0', undefined, 'none', false, '/workspace/α/package.json'),
      makeEntry('beta', '1.0.0', '1.1.0', 'minor', false, '/workspace/β/package.json'),
    ];
    const allPackageFilePaths = [
      '/workspace/0-é-empty/package.json',
      '/workspace/α/package.json',
      '/workspace/β/package.json',
    ];
    const labels = (tree: readonly vscode.TreeItem[]): string[] => tree
      .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem)
      .map(item => String(item.label));

    expect(labels(buildTree(entries, 'all', '', folders, allPackageFilePaths))).toEqual([
      'workspace — α [unicode #2]',
      'workspace — β [unicode #3]',
    ]);
    expect(labels(buildTree(entries, 'hasUpdates', '', folders, allPackageFilePaths))).toEqual([
      'workspace — β [unicode #3]',
    ]);
    expect(labels(buildTree(entries, 'all', 'beta', folders, allPackageFilePaths))).toEqual([
      'workspace — β [unicode #3]',
    ]);
  });

  it('sorts workspace folders with root first and the rest alphabetically', () => {
    const tree = buildTree([
      makeEntry('ui-lib', '1.0.0', undefined, 'none', false, '/workspace/packages/ui/package.json'),
      makeEntry('root-dep', '1.0.0', undefined, 'none', false, '/workspace/package.json'),
      makeEntry('frontend', '1.0.0', undefined, 'none', false, '/workspace/apps/frontend/package.json'),
    ], 'all', '', [makeFolder('/workspace', 'workspace', 0)]);

    const folders = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(folders.map(folder => folder.label)).toEqual([
      'workspace — (root)',
      'workspace — apps/frontend',
      'workspace — packages/ui',
    ]);
  });

  it('groups by owning workspace folder order, not alphabetically across roots', () => {
    const folders = [makeFolder('/ws/zebra', 'zebra', 0), makeFolder('/ws/alpha', 'alpha', 1)];
    // Both roots share the relativeLabel '(root)', and this entry order is the reverse
    // of folder index order — only a real index-based sort can produce zebra first.
    const tree = buildTree([
      makeEntry('from-alpha', '1.0.0', undefined, 'none', false, '/ws/alpha/package.json'),
      makeEntry('from-zebra', '1.0.0', undefined, 'none', false, '/ws/zebra/package.json'),
    ], 'all', '', folders);

    const items = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    // Alphabetically "alpha" sorts before "zebra"; grouping by folder index keeps
    // "zebra" (index 0) first instead, proving the sort follows owning workspace order.
    expect(items.map(item => item.label)).toEqual(['zebra — (root)', 'alpha — (root)']);
  });

  it('disambiguates a nested package with the same relative path under two roots', () => {
    const folders = [makeFolder('/ws/alpha', 'alpha', 0), makeFolder('/ws/beta', 'beta', 1)];
    // Both packages share the relativeLabel 'packages/app', and this entry order is the
    // reverse of folder index order — only a real index-based sort keeps alpha first.
    const tree = buildTree([
      makeEntry('beta-app', '1.0.0', undefined, 'none', false, '/ws/beta/packages/app/package.json'),
      makeEntry('alpha-app', '1.0.0', undefined, 'none', false, '/ws/alpha/packages/app/package.json'),
    ], 'all', '', folders);

    const items = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(items.map(item => item.label)).toEqual(['alpha — packages/app', 'beta — packages/app']);
  });

  it('sorts nested package rows alphabetically within one owning workspace', () => {
    const tree = buildTree([
      makeEntry('z-package', '1.0.0', undefined, 'none', false, '/workspace/packages/z/package.json'),
      makeEntry('a-package', '1.0.0', undefined, 'none', false, '/workspace/packages/a/package.json'),
    ], 'all', '', [makeFolder('/workspace', 'workspace', 0)]);
    const items = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(items.map(item => item.label)).toEqual(['workspace — packages/a', 'workspace — packages/z']);
  });

  it('deduplicates equivalent package paths after normalization', () => {
    const tree = buildTree([
      makeEntry('root-dep', '1.0.0', undefined, 'none', false, '/workspace/apps/../package.json'),
      makeEntry('same-root', '1.0.0', undefined, 'none', false, '/workspace/package.json'),
    ], 'all', '', [makeFolder('/workspace', 'workspace', 0)]);
    const items = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('workspace — (root)');
    expect(items[0].children[0].children.map(child => child.label)).toEqual(['root-dep', 'same-root']);
  });

  it('filters packages by a search query', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', '19.0.0', 'breaking', false),
      makeEntry('react-dom', '18.0.0', '19.0.0', 'breaking', false),
      makeEntry('vite', '5.0.0', undefined, 'none', true),
    ], 'all', 'react');

    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react', 'react-dom']);
  });

  it('shows the current search query in a dedicated item', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', '19.0.0', 'breaking', false),
    ], 'all', 'react');

    expect(tree[0]).toEqual(expect.objectContaining({
      label: 'Search query',
      description: 'react',
    }));
  });

  it('keeps busy rows in All while excluding them from update rows and group outdated counts', () => {
    const entries = [
      makeEntry(
        'react-busy',
        '18.0.0',
        '19.0.0',
        'breaking',
        false,
        '/workspace/package.json',
        { kind: 'remove' },
      ),
      makeEntry('react-ready', '1.0.0', '1.1.0', 'minor', false),
    ];

    const allTree = buildTree(entries, 'all', 'react');
    const allFilter = allTree[1] as FilterBarItem;
    const allGroups = allTree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(allFilter.description).toBe('All (2) | Has Updates (1) | Patch (0) | Minor (1) | Breaking (0)');
    expect(allGroups[0].description).toBe('2 packages · 1 outdated');
    expect(allGroups[0].children.map(child => child.label)).toEqual(['react-busy', 'react-ready']);

    const updateTree = buildTree(entries, 'hasUpdates', 'react');
    const updateGroups = updateTree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(updateGroups[0].description).toBe('1 package · 1 outdated');
    expect(updateGroups[0].children.map(child => child.label)).toEqual(['react-ready']);
  });

  it('keeps workspace label qualifiers stable when search hides package files', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const tree = buildTree([
      makeEntry('other', '1.0.0', undefined, 'none', false, '/workspace/0-é-empty/package.json'),
      makeEntry('alpha', '1.0.0', undefined, 'none', false, '/workspace/α/package.json'),
      makeEntry('beta', '1.0.0', undefined, 'none', false, '/workspace/β/package.json'),
    ], 'all', 'beta', folders);

    const workspaceItems = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(workspaceItems.map(item => item.label)).toEqual(['workspace — β [unicode #3]']);
  });
});

describe('toRelativeLabel', () => {
  it('returns a relative folder label for nested package files', () => {
    expect(toRelativeLabel('/workspace/apps/frontend/package.json', '/workspace')).toBe('apps/frontend');
  });

  it('labels the workspace root package file', () => {
    expect(toRelativeLabel('/workspace/package.json', '/workspace')).toBe('(root)');
  });
});

describe('toWorkspaceFolderDescriptors', () => {
  it('keeps the given name and index', () => {
    expect(toWorkspaceFolderDescriptors([{ uri: { fsPath: '/workspace' }, name: 'My App', index: 3 }]))
      .toEqual([{ path: '/workspace', name: 'My App', index: 3 }]);
  });

  it('derives the name from the folder basename and the index from array position when absent', () => {
    expect(toWorkspaceFolderDescriptors([{ uri: { fsPath: '/workspace/apps/web' } }]))
      .toEqual([{ path: '/workspace/apps/web', name: 'web', index: 0 }]);
  });

  it('falls back to the path basename when a folder name is empty', () => {
    expect(toWorkspaceFolderDescriptors([{ uri: { fsPath: '/workspace/apps/web' }, name: '' }]))
      .toEqual([{ path: '/workspace/apps/web', name: 'web', index: 0 }]);
  });
});

describe('findOwningWorkspaceFolder', () => {
  it('matches the workspace folder that contains the package file', () => {
    const folders = [makeFolder('/workspace/app', 'app', 0), makeFolder('/workspace/app-mobile', 'app-mobile', 1)];
    expect(findOwningWorkspaceFolder('/workspace/app-mobile/package.json', folders)).toBe(folders[1]);
  });

  it('picks the deepest folder when workspace folders nest', () => {
    const outer = makeFolder('/workspace', 'workspace', 0);
    const inner = makeFolder('/workspace/nested', 'nested', 1);
    expect(findOwningWorkspaceFolder('/workspace/nested/pkg/package.json', [outer, inner])).toBe(inner);
  });

  it('uses workspace index and input position as deterministic tie-breakers', () => {
    const first = makeFolder('/workspace', 'first', 2);
    const second = makeFolder('/workspace/', 'second', 1);
    expect(findOwningWorkspaceFolder('/workspace/package.json', [first, second])).toBe(second);

    const sameIndexFirst = makeFolder('/workspace', 'first', 1);
    const sameIndexSecond = makeFolder('/workspace/', 'second', 1);
    expect(findOwningWorkspaceFolder('/workspace/package.json', [sameIndexFirst, sameIndexSecond]))
      .toBe(sameIndexFirst);
  });

  it('normalizes backslash paths before matching', () => {
    const folder = makeFolder('C:\\workspace\\app', 'app', 0);
    expect(findOwningWorkspaceFolder('C:\\workspace\\app\\package.json', [folder])).toBe(folder);
  });

  it('returns undefined for a package file outside every workspace folder', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    expect(findOwningWorkspaceFolder('/external/project/package.json', folders)).toBeUndefined();
  });

  it('ignores a trailing slash on the folder path when matching the root', () => {
    const folder = makeFolder('/workspace/', 'workspace', 0);
    expect(findOwningWorkspaceFolder('/workspace/package.json', [folder])).toBe(folder);
  });
});

describe('resolveWorkspaceFolderDisplayNames', () => {
  it('uses a unique custom name verbatim, never a path-derived one', () => {
    const folders = [makeFolder('/repo/x', 'Custom Display', 0)];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/repo/x')).toBe('Custom Display');
  });

  it('preserves long display names so distinct folders do not collide', () => {
    const commonPrefix = 'a'.repeat(250);
    const folders = [
      makeFolder('/ws/app-a', `${commonPrefix}a`, 0),
      makeFolder('/ws/app-b', `${commonPrefix}b`, 1),
    ];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/ws/app-a')).toHaveLength(251);
    expect(names.get('/ws/app-a')).not.toBe(names.get('/ws/app-b'));
  });

  it('keeps unique folder names as-is', () => {
    const folders = [makeFolder('/ws/app', 'app', 0), makeFolder('/ws/app-mobile', 'app-mobile', 1)];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/ws/app')).toBe('app');
    expect(names.get('/ws/app-mobile')).toBe('app-mobile');
  });

  it('disambiguates same-name folders by their shortest unique path suffix', () => {
    const folders = [
      makeFolder('/repos/team-a/app', 'app', 0),
      makeFolder('/repos/team-b/app', 'app', 1),
    ];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/repos/team-a/app')).toBe('team-a/app');
    expect(names.get('/repos/team-b/app')).toBe('team-b/app');
  });

  it('falls back to a stable folder index when the normalized path still collides', () => {
    // Different raw paths (distinct map keys) that normalize to the same segments,
    // so the suffix search alone can never tell them apart.
    const folders = [makeFolder('/ws/dup', 'dup', 0), makeFolder('/ws/dup/', 'dup', 1)];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/ws/dup')).toBe('ws/dup #0');
    expect(names.get('/ws/dup/')).toBe('ws/dup #1');
  });

  it('adds a deterministic position when duplicate folders also share an index', () => {
    const folders = [makeFolder('/ws/dup', 'dup', 0), makeFolder('/ws/dup/', 'dup', 0)];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/ws/dup')).toBe('ws/dup #0');
    expect(names.get('/ws/dup/')).toBe('ws/dup #0-1');
  });

  it('escapes control characters in a folder name without collapsing labels', () => {
    const folders = [makeFolder('/ws/app', 'app\u0007name', 0)];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/ws/app')).toBe('app\\u{7}name');
  });

  it('keeps ANSI sequences visible only as escaped text', () => {
    const folders = [makeFolder('/ws/app', '\u001b[31mapp\u001b[0m', 0)];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/ws/app')).toBe('\\u{1b}[31mapp\\u{1b}[0m');
    expect(names.get('/ws/app')).not.toContain('\u001b');
  });

  it('escapes the label separator inside a workspace name', () => {
    const names = resolveWorkspaceFolderDisplayNames([
      makeFolder('/ws/app', 'app — branch', 0),
    ]);
    expect(names.get('/ws/app')).toBe('app \\u{2014} branch');
    expect(names.get('/ws/app')).not.toContain(' — ');
  });

  it('uses path suffixes when normalized display names collide', () => {
    const folders = [
      makeFolder('/repos/team-a/app', 'e\u0301', 0),
      makeFolder('/repos/team-b/app', 'é', 1),
    ];
    const names = resolveWorkspaceFolderDisplayNames(folders);
    expect(names.get('/repos/team-a/app')).toBe('team-a/app');
    expect(names.get('/repos/team-b/app')).toBe('team-b/app');
  });
});

describe('resolvePackageOwnerLabel', () => {
  it('labels a root package file with the owning folder display name', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const displayNames = resolveWorkspaceFolderDisplayNames(folders);
    const result = resolvePackageOwnerLabel('/workspace/package.json', folders, displayNames);
    expect(result).toEqual({
      label: 'workspace — (root)',
      folderIndex: 0,
      isRoot: true,
      relativeLabel: '(root)',
    });
  });

  it('labels a nested package file with its relative path', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const displayNames = resolveWorkspaceFolderDisplayNames(folders);
    const result = resolvePackageOwnerLabel('/workspace/apps/web/package.json', folders, displayNames);
    expect(result.label).toBe('workspace — apps/web');
    expect(result.isRoot).toBe(false);
  });

  it('falls back to a sanitized unprefixed path when no workspace folder owns the file', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const displayNames = resolveWorkspaceFolderDisplayNames(folders);
    const result = resolvePackageOwnerLabel('/external/project/package.json', folders, displayNames);
    expect(result).toEqual({
      label: '/external/project',
      folderIndex: Number.MAX_SAFE_INTEGER,
      isRoot: false,
      relativeLabel: '/external/project',
    });
  });

  it('canonicalizes an unowned path before displaying its fallback label', () => {
    const result = resolvePackageOwnerLabel(
      '/external/./project/../other/package.json',
      [makeFolder('/workspace', 'workspace', 0)],
      new Map([['/workspace', 'workspace']]),
    );
    expect(result.label).toBe('/external/other');
  });

  it('keeps labels distinct when path sanitization would otherwise collapse them', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const rows = resolvePackageFileLabels([
      '/workspace/packages/a\u0007b/package.json',
      '/workspace/packages/a b/package.json',
    ], folders);
    expect(rows.map(row => row.owner.label)).toEqual([
      'workspace — packages/a b',
      'workspace — packages/a\\u{7}b',
    ]);
    expect(new Set(rows.map(row => row.owner.label)).size).toBe(rows.length);
  });

  it('qualifies the Terra Latin/Cyrillic root pair while keeping ASCII quiet', () => {
    const folders = [
      makeFolder('/repos/latin/scope', 'scope', 0),
      makeFolder('/repos/cyrillic/scope', '\u0455cope', 1),
    ];
    const rows = resolvePackageFileLabels([
      '/repos/cyrillic/scope/package.json',
      '/repos/latin/scope/package.json',
    ], folders);
    expect(rows.map(row => row.owner.label)).toEqual([
      'scope — (root)',
      '\u0455cope — (root) [unicode #1]',
    ]);
  });

  it('qualifies two different non-ASCII Terra confusables', () => {
    const folders = [
      makeFolder('/repos/a', '\u0441ode', 0),
      makeFolder('/repos/b', '\u03f2ode', 1),
    ];
    const rows = resolvePackageFileLabels([
      '/repos/b/package.json',
      '/repos/a/package.json',
    ], folders);
    expect(rows.map(row => row.owner.label)).toEqual([
      '\u0441ode — (root) [unicode #1]',
      '\u03f2ode — (root) [unicode #2]',
    ]);
  });

  it('qualifies fullwidth and mathematical forms with ASCII discriminators', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const rows = resolvePackageFileLabels([
      '/workspace/\u{1d42c}cope/package.json',
      '/workspace/\uff53cope/package.json',
      '/workspace/scope/package.json',
    ], folders);
    const labels = new Map(rows.map(row => [row.packageFilePath, row.owner.label]));
    expect(labels.get('/workspace/scope/package.json')).toBe('workspace — scope');
    expect(labels.get('/workspace/\u{1d42c}cope/package.json')).toMatch(
      /^workspace — .+ \[unicode #[12]\]$/,
    );
    expect(labels.get('/workspace/\uff53cope/package.json')).toMatch(
      /^workspace — .+ \[unicode #[12]\]$/,
    );
    expect(new Set(rows.map(row => row.owner.label)).size).toBe(3);
  });

  it('qualifies relative paths with the same Unicode sequence and ASCII-confusable suffixes', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const rows = resolvePackageFileLabels([
      '/workspace/\u0455cope-\u0441/package.json',
      '/workspace/\u0455cope-c/package.json',
    ], folders);
    expect(rows.map(row => row.owner.label)).toEqual([
      'workspace — \u0455cope-c [unicode #1]',
      'workspace — \u0455cope-\u0441 [unicode #2]',
    ]);
  });

  it('qualifies ambiguous whitespace in owner and relative labels', () => {
    const ownerRows = resolvePackageFileLabels([
      '/repos/ascii/package.json',
      '/repos/nbsp/package.json',
    ], [
      makeFolder('/repos/ascii', 'app root', 0),
      makeFolder('/repos/nbsp', 'app\u00a0root', 1),
    ]);
    expect(ownerRows.map(row => row.owner.label)).toEqual([
      'app root — (root)',
      'app\u00a0root — (root) [unicode #1]',
    ]);

    const relativeRows = resolvePackageFileLabels([
      '/workspace/app root/package.json',
      '/workspace/app\u00a0root/package.json',
    ], [makeFolder('/workspace', 'workspace', 0)]);
    expect(relativeRows.map(row => row.owner.label)).toEqual([
      'workspace — app root',
      'workspace — app\u00a0root [unicode #1]',
    ]);
  });

  it('qualifies non-confusable international Unicode as an explicit discriminator', () => {
    const rows = resolvePackageFileLabels(
      ['/workspace/資料/package.json'],
      [makeFolder('/workspace', '東京', 0)],
    );
    expect(rows[0].owner.label).toBe('東京 — 資料 [unicode #1]');
  });

  it('keeps post-qualifier literal suffix chains unique and permutation-stable', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const paths = [
      '/workspace/Kfoo [unicode #1]/package.json',
      '/workspace/Kfoo [unicode #1] #1/package.json',
      '/workspace/Kfoo/package.json',
    ];
    const labels = resolveLabels(paths, folders);

    expect(new Set(labels.values()).size).toBe(paths.length);
    expect(labels).toEqual(resolveLabels([...paths].reverse(), folders));
    expect(labels.get(paths[0])).toBe('workspace — Kfoo [unicode #1] #1');
    expect(labels.get(paths[1])).toBe('workspace — Kfoo [unicode #1] #1 #3');
    expect(labels.get(paths[2])).toBe('workspace — Kfoo [unicode #1] #2');
  });

  it('assigns unique discriminators to three non-ASCII relative paths', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const rows = resolvePackageFileLabels([
      '/workspace/資料-a/package.json',
      '/workspace/資料-b/package.json',
      '/workspace/資料-c/package.json',
    ], folders);
    expect(rows.map(row => row.owner.label)).toEqual([
      'workspace — 資料-a [unicode #1]',
      'workspace — 資料-b [unicode #2]',
      'workspace — 資料-c [unicode #3]',
    ]);
  });

  it('qualifies unowned non-ASCII rows', () => {
    const rows = resolvePackageFileLabels([
      '/external/資料/package.json',
      '/external/東京/package.json',
    ], []);
    expect(rows.map(row => row.owner.label)).toEqual([
      '/external/東京 [unicode #1]',
      '/external/資料 [unicode #2]',
    ]);
  });

  it('keeps Unicode discriminators stable across package-set permutations', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const paths = [
      '/workspace/\u0455cope/package.json',
      '/workspace/\u0441ode/package.json',
      '/workspace/資料/package.json',
    ];
    expect(resolveLabels(paths, folders)).toEqual(resolveLabels([...paths].reverse(), folders));
  });

  it('deduplicates canonical Unicode path spellings before assigning a discriminator', () => {
    const rows = resolvePackageFileLabels([
      '/workspace/資料/package.json',
      '/workspace/./資料/package.json',
    ], [makeFolder('/workspace', 'workspace', 0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].packageFilePath).toBe('/workspace/資料/package.json');
    expect(rows[0].owner.label).toBe('workspace — 資料 [unicode #1]');
  });

  it('keeps NFC/NFD and long Unicode labels unique without truncation', () => {
    const longUnicodeSegment = '資料'.repeat(120);
    const rows = resolvePackageFileLabels([
      '/workspace/e\u0301/package.json',
      '/workspace/é/package.json',
      '/workspace/' + longUnicodeSegment + '/package.json',
    ], [makeFolder('/workspace', 'workspace', 0)]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.owner.label)).size).toBe(3);
    expect(rows.every(row => row.owner.label.includes('[unicode #'))).toBe(true);
    expect(rows.some(row => row.owner.label.includes(longUnicodeSegment))).toBe(true);
  });

  it('keeps long relative paths distinct without truncation', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const commonPrefix = 'a'.repeat(250);
    const rows = resolvePackageFileLabels([
      `/workspace/${commonPrefix}a/package.json`,
      `/workspace/${commonPrefix}b/package.json`,
    ], folders);
    expect(rows.map(row => row.owner.label)).toEqual([
      `workspace — ${commonPrefix}a`,
      `workspace — ${commonPrefix}b`,
    ]);
  });

  it('deduplicates equivalent package paths for picker labels', () => {
    const labels = resolvePackageFileLabels([
      '/workspace/package.json',
      '/workspace/./package.json',
    ], [makeFolder('/workspace', 'workspace', 0)]);
    expect(labels).toHaveLength(1);
    expect(labels[0].packageFilePath).toBe('/workspace/package.json');
  });

  it('disambiguates the root sentinel from a real nested folder with that name', () => {
    const folders = [makeFolder('/workspace', 'workspace', 0)];
    const rows = resolvePackageFileLabels([
      '/workspace/package.json',
      '/workspace/(root)/package.json',
    ], folders);
    expect(new Set(rows.map(row => row.owner.label)).size).toBe(2);
  });

  it('localizes only the semantic root, not a nested folder named like the root sentinel', () => {
    const rows = resolvePackageFileLabels([
      '/workspace/package.json',
      '/workspace/(root)/package.json',
    ], [makeFolder('/workspace', 'workspace', 0)], {
      rootLabel: '(localized root)',
      formatUnicodeDiscriminator: (base, ordinal) => `${base} [localized unicode #${ordinal}]`,
    });

    expect(rows.map(row => row.owner.label)).toEqual([
      'workspace — (localized root)',
      'workspace — (root)',
    ]);
  });

  it('sorts the actual root before a nested folder named like the root sentinel', () => {
    const rows = resolvePackageFileLabels([
      '/workspace/(root)/package.json',
      '/workspace/package.json',
    ], [makeFolder('/workspace', 'workspace', 0)]);
    expect(rows.map(row => row.packageFilePath)).toEqual([
      '/workspace/package.json',
      '/workspace/(root)/package.json',
    ]);
    expect(rows.map(row => row.owner.isRoot)).toEqual([true, false]);
  });
});

describe('path normalization', () => {
  it('handles workspace and package paths at the filesystem root', () => {
    const folder = makeFolder('/', 'root', 0);
    expect(findOwningWorkspaceFolder('/package.json', [folder])).toBe(folder);
    expect(toRelativeLabel('/package.json', '/')).toBe('(root)');
    expect(toRelativeLabel('/packages/app/package.json', '/')).toBe('packages/app');
  });

  it('matches Windows paths case-insensitively while preserving POSIX case sensitivity', () => {
    const windowsFolder = makeFolder('C:\\Workspace\\App', 'app', 0);
    expect(findOwningWorkspaceFolder('c:/workspace/app/package.json', [windowsFolder])).toBe(windowsFolder);
    expect(toRelativeLabel('c:/workspace/app/packages/ui/package.json', 'C:\\Workspace\\App'))
      .toBe('packages/ui');
    expect(resolvePackageFileLabels([
      'C:\\Workspace\\App\\package.json',
      'c:/workspace/app/PACKAGE.JSON',
    ], [windowsFolder])).toHaveLength(1);

    const posixFolder = makeFolder('/workspace/App', 'App', 0);
    expect(findOwningWorkspaceFolder('/workspace/app/package.json', [posixFolder])).toBeUndefined();
  });

  it('keeps a POSIX backslash inside a path segment instead of treating it as a separator', () => {
    const folder = makeFolder('/workspace', 'workspace', 0);
    const result = resolvePackageOwnerLabel('/workspace/app\\name/package.json', [folder], new Map([['/workspace', 'workspace']]));
    expect(result.label).toBe('workspace — app\\u{5c}name');
  });

  it('normalizes dot segments and reports relative paths without package.json', () => {
    expect(toRelativeLabel('/workspace/apps/../packages', '/workspace/./')).toBe('packages');
    expect(toRelativeLabel('/workspace/packages/app', '/workspace')).toBe('packages/app');
  });

  it('handles UNC roots without mixing them with POSIX paths', () => {
    const folder = makeFolder('\\\\Server\\Share\\repo', 'repo', 0);
    expect(findOwningWorkspaceFolder('\\\\server\\share\\repo\\package.json', [folder])).toBe(folder);
    expect(toRelativeLabel('\\\\server\\share\\repo\\packages\\app\\package.json', folder.path))
      .toBe('packages/app');
    expect(findOwningWorkspaceFolder('/server/share/repo/package.json', [folder])).toBeUndefined();

    const uncRoot = makeFolder('\\\\', 'unc', 0);
    expect(findOwningWorkspaceFolder('\\\\server\\package.json', [uncRoot])).toBe(uncRoot);
    expect(findOwningWorkspaceFolder('\\\\package.json', [uncRoot])).toBe(uncRoot);
    expect(toRelativeLabel('\\\\package.json', '\\\\')).toBe('(root)');

    const windowsRoot = makeFolder('C:\\', 'drive', 0);
    expect(findOwningWorkspaceFolder('C:/package.json', [windowsRoot])).toBe(windowsRoot);
    expect(findOwningWorkspaceFolder('C:/packages/app/package.json', [windowsRoot])).toBe(windowsRoot);
    expect(findOwningWorkspaceFolder('\\\\server\\package.json', [makeFolder('/', 'posix', 0)])).toBeUndefined();
  });

  it('uses the final segment for a package path outside the requested root', () => {
    expect(toRelativeLabel('/external/project/package.json', '/workspace')).toBe('project');
    expect(toRelativeLabel('C:/package.json', 'C:/')).toBe('(root)');
  });
});

describe('getFilterCounts', () => {
  it('excludes installing packages from update-related counters but keeps them in all', () => {
    expect(getFilterCounts([
      makeEntry('patch-installing', '1.0.0', '1.0.1', 'patch', false, '/workspace/package.json', { kind: 'update', target: '1.0.1' }),
      makeEntry('minor-ready', '1.0.0', '1.1.0', 'minor', false),
      makeEntry('breaking-ready', '1.0.0', '2.0.0', 'breaking', false),
      makeEntry('current', '1.0.0', undefined, 'none', false),
    ])).toEqual({
      all: 4,
      hasUpdates: 2,
      patch: 0,
      minor: 1,
      breaking: 1,
    });
  });
});

describe('projectPackageTree', () => {
  it('uses one search-scoped projection for rows, counters, groups, and update capability', () => {
    const entries = [
      makeEntry(
        'react-busy',
        '18.0.0',
        '19.0.0',
        'breaking',
        false,
        '/workspace/package.json',
        { kind: 'update', target: '19.0.0' },
      ),
      makeEntry('react-ready', '1.0.0', '1.1.0', 'minor', false),
      makeEntry('react-vulnerable', '2.0.0', '3.0.0', 'breaking', false, '/workspace/package.json', undefined, 'high'),
      makeEntry('react-unknown', '1.0.0', undefined, 'patch', false),
    ];

    const all = projectPackageTree(entries, 'all', 'React');

    expect(all.searchMatchedEntries.map(entry => entry.item.packageName)).toEqual([
      'react-busy',
      'react-ready',
      'react-vulnerable',
      'react-unknown',
    ]);
    expect(all.visibleEntries.map(entry => entry.item.packageName)).toEqual([
      'react-busy',
      'react-ready',
      'react-vulnerable',
      'react-unknown',
    ]);
    expect(all.filterCounts).toEqual({
      all: 4,
      hasUpdates: 2,
      patch: 0,
      minor: 1,
      breaking: 1,
    });
    expect(all.groups.map(group => ({
      dev: group.dev,
      totalCount: group.totalCount,
      outdatedCount: group.outdatedCount,
      names: group.entries.map(entry => entry.item.packageName),
    }))).toEqual([{
      dev: false,
      totalCount: 4,
      outdatedCount: 2,
      names: ['react-busy', 'react-ready', 'react-vulnerable', 'react-unknown'],
    }]);
    expect(all.visibleOutdatedEntries.map(entry => entry.item.packageName)).toEqual([
      'react-ready',
      'react-vulnerable',
    ]);
    expect(all.canUpdateVisiblePackages).toBe(true);

    const updates = projectPackageTree(entries, 'hasUpdates', 'react');
    expect(updates.visibleEntries.map(entry => entry.item.packageName)).toEqual([
      'react-vulnerable',
      'react-ready',
    ]);
    expect(updates.groups[0]).toMatchObject({ totalCount: 2, outdatedCount: 2 });
    expect(updates.canUpdateVisiblePackages).toBe(true);

    const busyOnly = projectPackageTree(entries, 'hasUpdates', 'busy');
    expect(busyOnly.visibleEntries).toEqual([]);
    expect(busyOnly.groups).toEqual([]);
    expect(busyOnly.canUpdateVisiblePackages).toBe(false);

    const allBusy = projectPackageTree(entries, 'all', 'busy');
    expect(allBusy.visibleEntries.map(entry => entry.item.packageName)).toEqual(['react-busy']);
    expect(allBusy.groups[0]).toMatchObject({ totalCount: 1, outdatedCount: 0 });
    expect(allBusy.visibleOutdatedEntries).toEqual([]);
    expect(allBusy.canUpdateVisiblePackages).toBe(false);
  });

  it('keeps the filtered-entry helper on the same projection contract', () => {
    const entries = [
      makeEntry('busy', '1.0.0', '2.0.0', 'breaking', false, '/workspace/package.json', { kind: 'install' }),
      makeEntry('ready', '1.0.0', '1.1.0', 'minor', false),
    ];

    expect(getFilteredEntries(entries, 'all', 'ready').map(entry => entry.item.packageName)).toEqual(['ready']);
    expect(getFilteredEntries(entries, 'hasUpdates').map(entry => entry.item.packageName)).toEqual(['ready']);
  });
});

function makeEntry(
  name: string,
  current: string,
  latest: string | undefined,
  updateType: PackageTreeEntry['item']['updateType'],
  dev: boolean,
  packageFilePath = '/workspace/package.json',
  operation: PackageOperation | undefined = undefined,
  vulnerabilitySeverity: AuditSeverity | undefined = undefined,
): PackageTreeEntry {
  return {
    item: new PackageItem(name, current, latest, updateType, operation, vulnerabilitySeverity, packageFilePath),
    dev,
    packageFilePath,
  };
}

function makeFolder(path: string, name: string, index: number): WorkspaceFolderDescriptor {
  return { path, name, index };
}

function resolveLabels(
  packageFilePaths: readonly string[],
  folders: readonly WorkspaceFolderDescriptor[],
): Map<string, string> {
  return new Map(resolvePackageFileLabels(packageFilePaths, folders)
    .map(row => [row.packageFilePath, row.owner.label]));
}