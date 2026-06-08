import * as vscode from 'vscode';
import { FilterBarItem } from './FilterBarItem';
import { FilterCounts, FilterType } from './FilterManager';
import { GroupItem } from './GroupItem';
import { MessageItem } from './MessageItem';
import { PackageItem } from './PackageItem';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';
import type { UpdateType } from '../utils';

const UPDATE_ORDER: Record<UpdateType, number> = {
  breaking: 0,
  minor: 1,
  patch: 2,
  none: 3,
};

export interface PackageTreeEntry {
  item: PackageItem;
  dev: boolean;
  packageFilePath: string;
}

export function buildTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search: string,
  workspaceRoot?: string,
): vscode.TreeItem[] {
  if (entries.length === 0) {
    return [];
  }

  const packageFiles = new Set(entries.map(entry => entry.packageFilePath));
  if (packageFiles.size <= 1 || workspaceRoot === undefined) {
    return buildFlatTree(entries, filterType, search);
  }

  return [
    new FilterBarItem(getFilterCounts(entries), filterType, search),
    ...buildWorkspaceGroups(entries, filterType, search, workspaceRoot),
  ];
}

export function toRelativeLabel(packageFilePath: string, workspaceRoot: string): string {
  const packageFile = packageFilePath.replace(/\\/g, '/');
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const packageJsonSuffix = '/package.json';
  const folderPath = packageFile.endsWith(packageJsonSuffix)
    ? packageFile.slice(0, -packageJsonSuffix.length)
    : packageFile;
  if (folderPath === root) {
    return '(root)';
  }
  if (folderPath.startsWith(`${root}/`)) {
    return folderPath.slice(root.length + 1);
  }
  return folderPath.split('/').at(-1) ?? folderPath;
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
  search = '',
): PackageTreeEntry[] {
  const filteredByType = filterType === 'all'
    ? [...entries]
    : filterType === 'hasUpdates'
      ? entries.filter(e => e.item.updateType !== 'none')
      : entries.filter(e => e.item.updateType === filterType);

  if (search === '') {
    return filteredByType;
  }

  return filteredByType.filter(entry => entry.item.packageName.toLocaleLowerCase().includes(search));
}

function buildGroups(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search: string,
): vscode.TreeItem[] {
  const filtered = getFilteredEntries(entries, filterType, search);
  if (filtered.length === 0) {
    return [new MessageItem(search === '' ? 'No packages match the current filter.' : 'No packages match the current search.')];
  }

  if (filterType === 'hasUpdates') {
    filtered.sort((left, right) => UPDATE_ORDER[left.item.updateType] - UPDATE_ORDER[right.item.updateType]);
  }

  const deps = filtered.filter(e => !e.dev).map(e => e.item);
  const devDeps = filtered.filter(e => e.dev).map(e => e.item);
  const groups: GroupItem[] = [];
  if (deps.length > 0) {
    const outdatedDeps = filtered.filter(e => !e.dev && e.item.updateType !== 'none').length;
    groups.push(new GroupItem('Dependencies', deps, deps.length, outdatedDeps, false));
  }
  if (devDeps.length > 0) {
    const outdatedDevDeps = filtered.filter(e => e.dev && e.item.updateType !== 'none').length;
    groups.push(new GroupItem('Dev Dependencies', devDeps, devDeps.length, outdatedDevDeps, true));
  }
  return groups;
}

function buildFlatTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search: string,
): vscode.TreeItem[] {
  return [
    new FilterBarItem(getFilterCounts(entries), filterType, search),
    ...buildGroups(entries, filterType, search),
  ];
}

function buildWorkspaceGroups(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search: string,
  workspaceRoot: string,
): vscode.TreeItem[] {
  const byFile = new Map<string, PackageTreeEntry[]>();
  for (const entry of entries) {
    byFile.set(entry.packageFilePath, [...(byFile.get(entry.packageFilePath) ?? []), entry]);
  }

  const folders: WorkspaceFolderItem[] = [];
  for (const [packageFilePath, fileEntries] of byFile) {
    const groups: GroupItem[] = buildGroups(fileEntries, filterType, search)
      .filter((item): item is GroupItem => item instanceof GroupItem);
    if (groups.length > 0) {
      folders.push(new WorkspaceFolderItem(
        toRelativeLabel(packageFilePath, workspaceRoot),
        packageFilePath,
        groups,
      ));
    }
  }

  return folders.length > 0
    ? folders
    : [new MessageItem(search === '' ? 'No packages match the current filter.' : 'No packages match the current search.')];
}
