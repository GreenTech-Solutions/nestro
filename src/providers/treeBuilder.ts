import * as vscode from 'vscode';
import { getFilterLabel } from './FilterManager';
import type { FilterCounts, FilterType } from './FilterManager';
import { GroupItem } from './GroupItem';
import { MessageItem } from './MessageItem';
import { PackageItem } from './PackageItem';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';
import { MAX_DESCRIPTION_SEARCH_LENGTH } from '../config';
import { getPathInfo } from './packageLabelPaths';
import { getLocalizedPackageLabelFormatting, resolvePackageFileLabels } from './packageLabels';
import type { WorkspaceFolderDescriptor } from './packageLabels';
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

export interface PackageGroupProjection {
  readonly dev: boolean;
  readonly entries: readonly PackageTreeEntry[];
  readonly totalCount: number;
  readonly outdatedCount: number;
}

export interface PackageTreeProjection {
  readonly filterType: FilterType;
  readonly search: string;
  readonly allPackageFilePaths: readonly string[];
  readonly searchMatchedEntries: readonly PackageTreeEntry[];
  readonly visibleEntries: readonly PackageTreeEntry[];
  readonly visibleOutdatedEntries: readonly PackageTreeEntry[];
  readonly filterCounts: FilterCounts;
  readonly groups: readonly PackageGroupProjection[];
  readonly canUpdateVisiblePackages: boolean;
}

export function buildTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search: string,
  workspaceFolders?: readonly WorkspaceFolderDescriptor[],
  allPackageFilePaths?: readonly string[],
): vscode.TreeItem[] {
  if (entries.length === 0) {
    return [];
  }

  const projection = projectPackageTree(entries, filterType, search);
  const packageFiles = new Set(entries.map(entry => entry.packageFilePath));
  if (packageFiles.size <= 1 || workspaceFolders === undefined || workspaceFolders.length === 0) {
    return buildFlatTree(projection);
  }

  return buildWorkspaceGroups(projection, workspaceFolders, allPackageFilePaths);
}

export function projectPackageTree(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search = '',
): PackageTreeProjection {
  const normalizedSearch = search.toLocaleLowerCase();
  const allPackageFilePaths = entries.map(entry => entry.packageFilePath);
  const searchMatchedEntries = normalizedSearch === ''
    ? [...entries]
    : entries.filter(entry => entry.item.packageName.toLocaleLowerCase().includes(normalizedSearch));
  const filterCounts = buildFilterCounts(searchMatchedEntries);
  const visibleEntries = filterType === 'all'
    ? [...searchMatchedEntries]
    : searchMatchedEntries.filter(entry => matchesUpdateFilter(entry, filterType));
  if (filterType === 'hasUpdates') {
    visibleEntries.sort((left, right) => UPDATE_ORDER[left.item.updateType] - UPDATE_ORDER[right.item.updateType]);
  }
  const visibleOutdatedEntries = visibleEntries.filter(isActionableUpdate);
  const groups = buildGroupProjections(visibleEntries);
  return {
    filterType,
    search,
    allPackageFilePaths,
    searchMatchedEntries,
    visibleEntries,
    visibleOutdatedEntries,
    filterCounts,
    groups,
    canUpdateVisiblePackages: visibleOutdatedEntries.length > 0,
  };
}

export function getFilterCounts(
  entries: readonly PackageTreeEntry[],
  search = '',
): FilterCounts {
  return projectPackageTree(entries, 'all', search).filterCounts;
}

/** Compact `treeView.description` for the active filter/search state; `undefined` when both are at their defaults. */
export function formatViewDescription(
  filterType: FilterType,
  search: string,
  counts: FilterCounts,
): string | undefined {
  const filterSegment = filterType === 'all'
    ? undefined
    : vscode.l10n.t('{0} ({1})', getFilterLabel(filterType), counts[filterType]);
  const searchSegment = search === ''
    ? undefined
    : vscode.l10n.t('"{0}"', truncateSearchQuery(search));

  if (filterSegment !== undefined && searchSegment !== undefined) {
    return vscode.l10n.t('{0} · {1}', filterSegment, searchSegment);
  }
  return filterSegment ?? searchSegment;
}

/** Caps a search query to a short, screen-reader-friendly length for any label that shows it. */
export function truncateSearchQuery(search: string): string {
  const codePoints = [...search];
  return codePoints.length > MAX_DESCRIPTION_SEARCH_LENGTH
    ? `${codePoints.slice(0, MAX_DESCRIPTION_SEARCH_LENGTH).join('')}…`
    : search;
}

function buildGroups(
  groupsProjection: readonly PackageGroupProjection[],
  search: string,
): vscode.TreeItem[] {
  if (groupsProjection.length === 0) {
    return [new MessageItem(search === ''
      ? vscode.l10n.t('No packages match the current filter.')
      : vscode.l10n.t('No packages match the current search.'))];
  }

  return groupsProjection.map(group => new GroupItem(
    group.dev ? vscode.l10n.t('Dev Dependencies') : vscode.l10n.t('Dependencies'),
    group.entries.map(entry => entry.item),
    group.totalCount,
    group.outdatedCount,
    group.dev,
  ));
}

function buildFlatTree(
  projection: PackageTreeProjection,
): vscode.TreeItem[] {
  return buildGroups(projection.groups, projection.search);
}

function buildWorkspaceGroups(
  projection: PackageTreeProjection,
  workspaceFolders: readonly WorkspaceFolderDescriptor[],
  allPackageFilePaths?: readonly string[],
): vscode.TreeItem[] {
  const entries = projection.visibleEntries;
  const byFile = new Map<string, PackageTreeEntry[]>();
  for (const entry of entries) {
    const fileKey = getPathInfo(entry.packageFilePath).comparisonPath;
    byFile.set(fileKey, [...(byFile.get(fileKey) ?? []), entry]);
  }

  const fileGroups: { packageFilePath: string; groups: GroupItem[] }[] = [];
  for (const fileEntries of byFile.values()) {
    const groups: GroupItem[] = buildGroups(buildGroupProjections(fileEntries), projection.search)
      .filter((item): item is GroupItem => item instanceof GroupItem);
    if (groups.length > 0) {
      fileGroups.push({ packageFilePath: fileEntries[0].packageFilePath, groups });
    }
  }

  const visibleFileKeys = new Set(fileGroups.map(fileGroup => getPathInfo(fileGroup.packageFilePath).comparisonPath));
  const packageFilePaths = allPackageFilePaths !== undefined && allPackageFilePaths.length > 0
    ? allPackageFilePaths
    : projection.allPackageFilePaths;
  const labels = resolvePackageFileLabels(packageFilePaths, workspaceFolders, getLocalizedPackageLabelFormatting())
    .filter(({ packageFilePath }) => visibleFileKeys.has(getPathInfo(packageFilePath).comparisonPath));
  const groupsByPath = new Map(fileGroups.map(fileGroup => [
    getPathInfo(fileGroup.packageFilePath).comparisonPath,
    fileGroup,
  ]));
  const rows = labels.map(({ packageFilePath, owner }) => {
    const fileGroup = groupsByPath.get(getPathInfo(packageFilePath).comparisonPath)!;
    return new WorkspaceFolderItem(owner.label, fileGroup.packageFilePath, fileGroup.groups);
  });

  return rows.length > 0
    ? rows
    : [new MessageItem(projection.search === ''
        ? vscode.l10n.t('No packages match the current filter.')
        : vscode.l10n.t('No packages match the current search.'))];
}

function buildFilterCounts(entries: readonly PackageTreeEntry[]): FilterCounts {
  const counts: FilterCounts = {
    all: entries.length,
    hasUpdates: 0,
    patch: 0,
    minor: 0,
    breaking: 0,
  };
  for (const entry of entries) {
    if (!isActionableUpdate(entry)) {
      continue;
    }
    counts.hasUpdates += 1;
    counts[entry.item.updateType] += 1;
  }
  return counts;
}

function buildGroupProjections(entries: readonly PackageTreeEntry[]): PackageGroupProjection[] {
  const groups: PackageGroupProjection[] = [];
  for (const dev of [false, true]) {
    const groupEntries = entries.filter(entry => entry.dev === dev);
    if (groupEntries.length === 0) {
      continue;
    }
    groups.push({
      dev,
      entries: groupEntries,
      totalCount: groupEntries.length,
      outdatedCount: groupEntries.filter(isActionableUpdate).length,
    });
  }
  return groups;
}

function matchesUpdateFilter(entry: PackageTreeEntry, filterType: FilterType): boolean {
  if (!isActionableUpdate(entry)) {
    return false;
  }
  return filterType === 'hasUpdates' || entry.item.updateType === filterType;
}

function isActionableUpdate(
  entry: PackageTreeEntry,
): entry is PackageTreeEntry & {
  readonly item: PackageItem & {
    readonly updateType: Exclude<UpdateType, 'none'>;
    readonly latest: string;
    readonly operation: undefined;
  };
} {
  return entry.item.updateType !== 'none'
    && entry.item.latest !== undefined
    && entry.item.operation === undefined;
}