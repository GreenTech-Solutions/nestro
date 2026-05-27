import * as vscode from 'vscode';
import { FilterBarItem } from './FilterBarItem';
import { FilterCounts, FilterType } from './FilterManager';
import { GroupItem } from './GroupItem';
import { MessageItem } from './MessageItem';
import { PackageItem } from './PackageItem';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';

export interface PackageTreeEntry {
  item: PackageItem;
  dev: boolean;
  packageFilePath: string;
}

export function buildTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  workspaceRoot?: string,
): vscode.TreeItem[] {
  if (entries.length === 0) {
    return [];
  }

  const packageFiles = new Set(entries.map(entry => entry.packageFilePath));
  if (packageFiles.size <= 1 || workspaceRoot === undefined) {
    return buildFlatTree(entries, filterType);
  }

  return [
    new FilterBarItem(getFilterCounts(entries), filterType),
    ...buildWorkspaceGroups(entries, filterType, workspaceRoot),
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

function buildFlatTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
): vscode.TreeItem[] {
  return [
    new FilterBarItem(getFilterCounts(entries), filterType),
    ...buildGroups(entries, filterType),
  ];
}

function buildWorkspaceGroups(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  workspaceRoot: string,
): vscode.TreeItem[] {
  const byFile = new Map<string, PackageTreeEntry[]>();
  for (const entry of entries) {
    byFile.set(entry.packageFilePath, [...(byFile.get(entry.packageFilePath) ?? []), entry]);
  }

  const folders: WorkspaceFolderItem[] = [];
  for (const [packageFilePath, fileEntries] of byFile) {
    const groups: GroupItem[] = buildGroups(fileEntries, filterType)
      .filter((item): item is GroupItem => item instanceof GroupItem);
    if (groups.length > 0) {
      folders.push(new WorkspaceFolderItem(
        toRelativeLabel(packageFilePath, workspaceRoot),
        packageFilePath,
        groups,
      ));
    }
  }

  return folders.length > 0 ? folders : [new MessageItem('No packages match the current filter.')];
}