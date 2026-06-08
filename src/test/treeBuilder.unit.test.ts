import { describe, expect, it } from 'vitest';
import {
  buildTree,
  FilterBarItem,
  GroupItem,
  MessageItem,
  PackageItem,
  PackageTreeEntry,
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

    expect(tree[0]).toBeInstanceOf(FilterBarItem);
    const groups = tree.slice(1).filter((item): item is GroupItem => item instanceof GroupItem);
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

    expect(tree[0]).toBeInstanceOf(FilterBarItem);
    expect(tree[1]).toBeInstanceOf(MessageItem);
    expect(tree[1].label).toBe('No packages match the current filter.');
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

    expect(tree[0]).toBeInstanceOf(FilterBarItem);
    expect(tree.some(item => item instanceof WorkspaceFolderItem)).toBe(false);
  });

  it('groups packages by workspace folder for multiple package files', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', undefined, 'none', false, '/workspace/apps/frontend/package.json'),
      makeEntry('ui-lib', '1.0.0', undefined, 'none', false, '/workspace/packages/ui/package.json'),
    ], 'all', '', '/workspace');

    const folders = tree.filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    expect(folders.map(folder => folder.label)).toEqual(['apps/frontend', 'packages/ui']);
    expect(folders[0].children[0].children.map(child => child.label)).toEqual(['react']);
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
});

describe('toRelativeLabel', () => {
  it('returns a relative folder label for nested package files', () => {
    expect(toRelativeLabel('/workspace/apps/frontend/package.json', '/workspace')).toBe('apps/frontend');
  });

  it('labels the workspace root package file', () => {
    expect(toRelativeLabel('/workspace/package.json', '/workspace')).toBe('(root)');
  });
});

function makeEntry(
  name: string,
  current: string,
  latest: string | undefined,
  updateType: PackageTreeEntry['item']['updateType'],
  dev: boolean,
  packageFilePath = '/workspace/package.json',
): PackageTreeEntry {
  return {
    item: new PackageItem(name, current, latest, updateType, false, undefined, packageFilePath),
    dev,
    packageFilePath,
  };
}
