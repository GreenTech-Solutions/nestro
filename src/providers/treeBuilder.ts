import * as vscode from 'vscode';
import { FilterBarItem } from './FilterBarItem';
import { FilterCounts, FilterType } from './FilterManager';
import { GroupItem } from './GroupItem';
import { MessageItem } from './MessageItem';
import { PackageItem } from './PackageItem';

export interface PackageTreeEntry {
  item: PackageItem;
  dev: boolean;
}

export function buildTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
): vscode.TreeItem[] {
  if (entries.length === 0) {
    return [];
  }

  return [
    new FilterBarItem(getFilterCounts(entries), filterType),
    ...buildGroups(entries, filterType),
  ];
}

export function getFilterCounts(entries: readonly PackageTreeEntry[]): FilterCounts {
  return {
    all: entries.length,
    hasUpdates: entries.filter(e => e.item.updateType !== 'none').length,
    patch: entries.filter(e => e.item.updateType === 'patch').length,
    minor: entries.filter(e => e.item.updateType === 'minor').length,
    breaking: entries.filter(e => e.item.updateType === 'breaking').length,
  };
}

export function getFilteredEntries(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
): PackageTreeEntry[] {
  return filterType === 'all'
    ? [...entries]
    : filterType === 'hasUpdates'
      ? entries.filter(e => e.item.updateType !== 'none')
      : entries.filter(e => e.item.updateType === filterType);
}

function buildGroups(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
): vscode.TreeItem[] {
  const filtered = getFilteredEntries(entries, filterType);
  if (filtered.length === 0) {
    return [new MessageItem('No packages match the current filter.')];
  }

  const deps = filtered.filter(e => !e.dev).map(e => e.item);
  const devDeps = filtered.filter(e => e.dev).map(e => e.item);
  const groups: GroupItem[] = [];
  if (deps.length > 0) {
    groups.push(new GroupItem('Dependencies', deps));
  }
  if (devDeps.length > 0) {
    groups.push(new GroupItem('Dev Dependencies', devDeps));
  }
  return groups;
}