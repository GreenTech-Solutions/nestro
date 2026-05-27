import { describe, expect, it } from 'vitest';
import { buildTree, FilterBarItem, GroupItem, MessageItem, PackageItem, PackageTreeEntry } from '../providers';

describe('buildTree', () => {
  it('returns no tree items when there are no packages', () => {
    expect(buildTree([], 'all')).toEqual([]);
  });

  it('builds a filter row and dependency groups', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', '19.0.0', 'breaking', false),
      makeEntry('eslint', '8.0.0', undefined, 'none', true),
    ], 'all');

    expect(tree[0]).toBeInstanceOf(FilterBarItem);
    const groups = tree.slice(1).filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups.map(group => group.label)).toEqual(['Dependencies', 'Dev Dependencies']);
    expect(groups.flatMap(group => group.children.map(child => child.label))).toEqual(['react', 'eslint']);
  });

  it('shows an empty-filter message when no packages match', () => {
    const tree = buildTree([
      makeEntry('eslint', '8.0.0', undefined, 'none', true),
    ], 'breaking');

    expect(tree[0]).toBeInstanceOf(FilterBarItem);
    expect(tree[1]).toBeInstanceOf(MessageItem);
    expect(tree[1].label).toBe('No packages match the current filter.');
  });

  it('filters packages by update type', () => {
    const tree = buildTree([
      makeEntry('react', '18.0.0', '18.0.1', 'patch', false),
      makeEntry('typescript', '5.0.0', '6.0.0', 'breaking', true),
    ], 'patch');

    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });
});

function makeEntry(
  name: string,
  current: string,
  latest: string | undefined,
  updateType: PackageTreeEntry['item']['updateType'],
  dev: boolean,
): PackageTreeEntry {
  return {
    item: new PackageItem(name, current, latest, updateType),
    dev,
  };
}