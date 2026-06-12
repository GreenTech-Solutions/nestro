import { describe, expect, it } from 'vitest';
import {
  buildTree,
  FilterBarItem,
  getFilterCounts,
  GroupItem,
  MessageItem,
  PackageItem,
  PackageTreeEntry,
  SearchQueryItem,
  toRelativeLabel,
  WorkspaceFolderItem,
} from '../providers';
import * as vscode from 'vscode';

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
    expect(groups[0].description).toBe('1 packages · 1 outdated');
    expect(groups[1].description).toBe('1 packages');
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
    ], 'all', '', '/workspace');

    expect(tree[0]).toBeInstanceOf(SearchQueryItem);
    expect(tree[1]).toBeInstanceOf(FilterBarItem);
    expect(tree.some(item => item instanceof WorkspaceFolderItem)).toBe(false);
  });

  it('groups packages by workspace folder for multiple package files', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', undefined, 'none', false, '/workspace/apps/frontend/package.json'),
      makeEntry('ui-lib', '1.0.0', undefined, 'none', false, '/workspace/packages/ui/package.json'),
    ], 'all', '', '/workspace');

    expect(tree[0]).toBeInstanceOf(SearchQueryItem);
    const folders = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(folders.map(folder => folder.label)).toEqual(['apps/frontend', 'packages/ui']);
    expect(folders[0].children[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('sorts workspace folders with root first and the rest alphabetically', () => {
    const tree = buildTree([
      makeEntry('ui-lib', '1.0.0', undefined, 'none', false, '/workspace/packages/ui/package.json'),
      makeEntry('root-dep', '1.0.0', undefined, 'none', false, '/workspace/package.json'),
      makeEntry('frontend', '1.0.0', undefined, 'none', false, '/workspace/apps/frontend/package.json'),
    ], 'all', '', '/workspace');

    const folders = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(folders.map(folder => folder.label)).toEqual(['(root)', 'apps/frontend', 'packages/ui']);
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
});

describe('toRelativeLabel', () => {
  it('returns a relative folder label for nested package files', () => {
    expect(toRelativeLabel('/workspace/apps/frontend/package.json', '/workspace')).toBe('apps/frontend');
  });

  it('labels the workspace root package file', () => {
    expect(toRelativeLabel('/workspace/package.json', '/workspace')).toBe('(root)');
  });
});

describe('getFilterCounts', () => {
  it('excludes installing packages from update-related counters but keeps them in all', () => {
    expect(getFilterCounts([
      makeEntry('patch-installing', '1.0.0', '1.0.1', 'patch', false, '/workspace/package.json', true),
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

function makeEntry(
  name: string,
  current: string,
  latest: string | undefined,
  updateType: PackageTreeEntry['item']['updateType'],
  dev: boolean,
  packageFilePath = '/workspace/package.json',
  installing = false,
): PackageTreeEntry {
  return {
    item: new PackageItem(name, current, latest, updateType, installing, undefined, packageFilePath),
    dev,
    packageFilePath,
  };
}