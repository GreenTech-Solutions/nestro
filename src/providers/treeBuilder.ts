import * as vscode from 'vscode';
import { FilterBarItem } from './FilterBarItem';
import { FilterCounts, FilterType } from './FilterManager';
import { GroupItem } from './GroupItem';
import { MessageItem } from './MessageItem';
import { PackageItem } from './PackageItem';
import { SearchQueryItem } from './SearchQueryItem';
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

/** A workspace folder as plain data: no live `vscode` state, safe for pure functions. */
export interface WorkspaceFolderDescriptor {
  readonly path: string;
  readonly name: string;
  readonly index: number;
}

export interface PackageOwnerLabel {
  readonly label: string;
  /** Owning folder's `WorkspaceFolder.index`, or `Number.MAX_SAFE_INTEGER` when unowned. */
  readonly folderIndex: number;
  readonly isRoot: boolean;
  readonly relativeLabel: string;
}

export interface PackageFileLabel {
  readonly packageFilePath: string;
  readonly owner: PackageOwnerLabel;
}

export interface PackageLabelFormatting {
  readonly rootLabel: string;
  readonly formatUnicodeDiscriminator: (base: string, ordinal: number) => string;
}

interface PackageLabelRow {
  packageFilePath: string;
  owner: PackageOwnerLabel;
  needsUnicodeDiscriminator: boolean;
}

const UNOWNED_FOLDER_INDEX = Number.MAX_SAFE_INTEGER;
const UNSAFE_LABEL_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DEFAULT_PACKAGE_LABEL_FORMATTING: PackageLabelFormatting = {
  rootLabel: '(root)',
  formatUnicodeDiscriminator: (base, ordinal) => `${base} [unicode #${ordinal}]`,
};

export function getLocalizedPackageLabelFormatting(): PackageLabelFormatting {
  return {
    rootLabel: vscode.l10n.t('(root)'),
    formatUnicodeDiscriminator: (base, ordinal) => vscode.l10n.t('{0} [unicode #{1}]', base, ordinal),
  };
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

  return [
    new SearchQueryItem(search),
    new FilterBarItem(projection.filterCounts, filterType),
    ...buildWorkspaceGroups(projection, workspaceFolders, allPackageFilePaths),
  ];
}

/** Builds plain owner descriptors from live `vscode.WorkspaceFolder` values. */
export function toWorkspaceFolderDescriptors(
  folders: readonly { readonly uri: { readonly fsPath: string }; readonly name?: string; readonly index?: number }[],
): WorkspaceFolderDescriptor[] {
  return folders.map((folder, position) => ({
    path: folder.uri.fsPath,
    name: folder.name !== undefined && folder.name !== '' ? folder.name : lastPathSegment(folder.uri.fsPath),
    index: folder.index ?? position,
  }));
}

/** Deepest workspace folder that contains `packageFilePath`, or `undefined` when none does. */
export function findOwningWorkspaceFolder(
  packageFilePath: string,
  folders: readonly WorkspaceFolderDescriptor[],
): WorkspaceFolderDescriptor | undefined {
  const directory = getPathInfo(normalizedPackageFileDirectory(packageFilePath));
  return folders
    .map((folder, position) => ({ folder, position, path: getPathInfo(folder.path) }))
    .filter(candidate => isPathWithin(directory, candidate.path))
    .sort((left, right) => {
      if (left.path.displaySegments.length !== right.path.displaySegments.length) {
        return right.path.displaySegments.length - left.path.displaySegments.length;
      }
      if (left.folder.index !== right.folder.index) {
        return left.folder.index - right.folder.index;
      }
      return left.position - right.position;
    })
    .at(0)?.folder;
}

/** Resolves display names with shortest path suffixes and stable folder-index fallbacks. */
export function resolveWorkspaceFolderDisplayNames(
  folders: readonly WorkspaceFolderDescriptor[],
): Map<string, string> {
  const byName = new Map<string, WorkspaceFolderDescriptor[]>();
  for (const folder of folders) {
    const name = sanitizeLabelText(folder.name);
    byName.set(name, [...(byName.get(name) ?? []), folder]);
  }

  const displayNames = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length === 1) {
      displayNames.set(group[0].path, sanitizeLabelText(group[0].name));
      continue;
    }
    assignDisambiguatedNames(group, displayNames);
  }

  ensureUniqueDisplayNames(folders, displayNames);
  return displayNames;
}

/** Owner-qualified label plus the sort keys needed to group by owning workspace. */
export function resolvePackageOwnerLabel(
  packageFilePath: string,
  folders: readonly WorkspaceFolderDescriptor[],
  displayNames: ReadonlyMap<string, string>,
  formatting: PackageLabelFormatting = DEFAULT_PACKAGE_LABEL_FORMATTING,
): PackageOwnerLabel {
  const owner = findOwningWorkspaceFolder(packageFilePath, folders);
  if (owner === undefined) {
    const relativeLabel = sanitizeLabelText(getPathInfo(normalizedPackageFileDirectory(packageFilePath)).displayPath);
    return { label: relativeLabel, folderIndex: UNOWNED_FOLDER_INDEX, isRoot: false, relativeLabel };
  }

  const rawRelativeLabel = toRelativeLabel(packageFilePath, owner.path);
  const isRoot = getPathInfo(normalizedPackageFileDirectory(packageFilePath)).comparisonPath
    === getPathInfo(owner.path).comparisonPath;
  const relativeLabel = sanitizeLabelText(isRoot ? formatting.rootLabel : rawRelativeLabel);
  const displayName = displayNames.get(owner.path) ?? sanitizeLabelText(owner.name);
  return {
    label: `${displayName} — ${relativeLabel}`,
    folderIndex: owner.index,
    isRoot,
    relativeLabel,
  };
}

/** Resolves, deduplicates, and sorts package-file labels for a picker or tree. */
export function resolvePackageFileLabels(
  packageFilePaths: readonly string[],
  folders: readonly WorkspaceFolderDescriptor[],
  formatting: PackageLabelFormatting = DEFAULT_PACKAGE_LABEL_FORMATTING,
): PackageFileLabel[] {
  const uniquePaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const packageFilePath of packageFilePaths) {
    const pathKey = getPathInfo(packageFilePath).comparisonPath;
    if (!seenPaths.has(pathKey)) {
      seenPaths.add(pathKey);
      uniquePaths.push(packageFilePath);
    }
  }

  const displayNames = resolveWorkspaceFolderDisplayNames(folders);
  const rows = uniquePaths.map(packageFilePath => ({
    packageFilePath,
    owner: resolvePackageOwnerLabel(packageFilePath, folders, displayNames, formatting),
    needsUnicodeDiscriminator: packageLabelNeedsUnicodeDiscriminator(packageFilePath, folders, displayNames),
  }));
  ensureUniquePackageLabels(rows);
  ensureUnicodeDiscriminators(rows, formatting);
  ensureUniquePackageLabels(rows);
  rows.sort((left, right) => comparePackageOwnerLabels(left.owner, right.owner)
    || compareText(getPathInfo(left.packageFilePath).comparisonPath, getPathInfo(right.packageFilePath).comparisonPath));
  return rows;
}

export function comparePackageOwnerLabels(left: PackageOwnerLabel, right: PackageOwnerLabel): number {
  if (left.folderIndex !== right.folderIndex) {
    return left.folderIndex - right.folderIndex;
  }
  if (left.isRoot !== right.isRoot) {
    return left.isRoot ? -1 : 1;
  }
  return compareText(left.relativeLabel, right.relativeLabel);
}

export function toRelativeLabel(packageFilePath: string, workspaceRoot: string): string {
  const folderPath = getPathInfo(normalizedPackageFileDirectory(packageFilePath));
  const root = getPathInfo(workspaceRoot);
  if (folderPath.comparisonPath === root.comparisonPath) {
    return '(root)';
  }
  if (isPathWithin(folderPath, root)) {
    return folderPath.displaySegments.slice(root.displaySegments.length).join('/') || '(root)';
  }
  return folderPath.displaySegments.at(-1) ?? folderPath.displayPath;
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

export function getFilteredEntries(
  entries: readonly PackageTreeEntry[],
  filterType: FilterType,
  search = '',
): PackageTreeEntry[] {
  return [...projectPackageTree(entries, filterType, search).visibleEntries];
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
  return [
    new SearchQueryItem(projection.search),
    new FilterBarItem(projection.filterCounts, projection.filterType),
    ...buildGroups(projection.groups, projection.search),
  ];
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

function assignDisambiguatedNames(
  group: readonly WorkspaceFolderDescriptor[],
  displayNames: Map<string, string>,
): void {
  const paths = group.map(folder => getPathInfo(folder.path));
  const suffixes = group.map((_folder, index) => shortestUniqueSuffix(paths, index));

  const suffixCounts = new Map<string, number>();
  for (const suffix of suffixes) {
    suffixCounts.set(suffix.key, (suffixCounts.get(suffix.key) ?? 0) + 1);
  }

  group.forEach((folder, index) => {
    const suffix = suffixes[index];
    const label = (suffixCounts.get(suffix.key) ?? 0) > 1
      ? `${suffix.display} #${folder.index}`
      : suffix.display;
    displayNames.set(folder.path, sanitizeLabelText(label));
  });
}

/** Shortest trailing run of path segments that no other folder in the group shares. */
function shortestUniqueSuffix(
  paths: readonly PathInfo[],
  targetIndex: number,
): { display: string; key: string } {
  const target = paths[targetIndex];
  for (let length = 1; length <= target.displaySegments.length; length++) {
    const candidate = target.displaySegments.slice(-length).join('/');
    const key = target.comparisonSegments.slice(-length).join('/');
    const collides = paths.some((path, index) => index !== targetIndex
      && path.comparisonSegments.slice(-length).join('/') === key);
    if (!collides) {
      return { display: candidate, key };
    }
  }
  return { display: target.displaySegments.join('/') || '/', key: target.comparisonPath };
}

function normalizePathSeparators(value: string): string {
  return isWindowsPath(value) ? value.replace(/\\/g, '/') : value;
}

function getPathInfo(value: string): PathInfo {
  const normalized = normalizePathSeparators(value);
  const windows = isWindowsPath(value);
  let prefix = '';
  let remainder = normalized;
  if (/^[A-Za-z]:\//.test(normalized)) {
    prefix = normalized.slice(0, 2);
    remainder = normalized.slice(2);
  }
  else if (normalized.startsWith('//')) {
    prefix = '//';
    remainder = normalized.slice(2);
  }
  else if (normalized.startsWith('/')) {
    prefix = '/';
    remainder = normalized.slice(1);
  }

  const displaySegments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..' && displaySegments.length > 0 && displaySegments.at(-1) !== '..') {
      displaySegments.pop();
      continue;
    }
    if (segment !== '..' || prefix === '') {
      displaySegments.push(segment);
    }
  }

  const joined = displaySegments.join('/');
  const displayPath = prefix === '/'
    ? joined === '' ? '/' : `/${joined}`
    : prefix === '//'
      ? joined === '' ? '//' : `//${joined}`
      : prefix !== ''
        ? joined === '' ? `${prefix}/` : `${prefix}/${joined}`
        : joined;
  const comparisonSegments = windows
    ? displaySegments.map(segment => segment.toLowerCase())
    : [...displaySegments];
  const comparisonPath = windows ? displayPath.toLowerCase() : displayPath;
  return { displayPath, comparisonPath, displaySegments, comparisonSegments, windows };
}

function normalizedPackageFileDirectory(packageFilePath: string): string {
  const normalized = normalizePathSeparators(packageFilePath);
  const windows = isWindowsPath(packageFilePath);
  const suffix = '/package.json';
  const normalizedForSuffix = windows ? normalized.toLowerCase() : normalized;
  const withoutFile = normalizedForSuffix.endsWith(suffix)
    ? normalized.slice(0, -suffix.length)
    : normalized;
  if (withoutFile === '') {
    return normalized.startsWith('/') ? '/' : normalized;
  }
  if (windows && normalized.startsWith('//') && withoutFile === '/') {
    return '//';
  }
  return /^[A-Za-z]:$/.test(withoutFile) ? `${withoutFile}/` : withoutFile;
}

function lastPathSegment(value: string): string {
  return getPathInfo(value).displaySegments.at(-1) ?? value;
}

function sanitizeLabelText(value: string): string {
  let sanitized = '';
  for (const character of value.normalize('NFC')) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isUnsafeLabelCodePoint(codePoint) || character === '\\' || character === '—') {
      sanitized += `\\u{${codePoint.toString(16)}}`;
    }
    else {
      sanitized += character;
    }
  }
  return sanitized;
}

function packageLabelNeedsUnicodeDiscriminator(
  packageFilePath: string,
  folders: readonly WorkspaceFolderDescriptor[],
  displayNames: ReadonlyMap<string, string>,
): boolean {
  const owner = findOwningWorkspaceFolder(packageFilePath, folders);
  if (owner === undefined) {
    return containsNonAsciiText(getPathInfo(normalizedPackageFileDirectory(packageFilePath)).displayPath);
  }

  const relativeLabel = toRelativeLabel(packageFilePath, owner.path);
  const displayName = displayNames.get(owner.path) ?? owner.name;
  const defaultDisplayName = sanitizeLabelText(owner.name);
  const derivedDisplayPath = displayName !== defaultDisplayName ? getPathInfo(owner.path).displayPath : '';
  return containsNonAsciiText(relativeLabel)
    || containsNonAsciiText(displayName)
    || containsNonAsciiText(owner.name)
    || containsNonAsciiText(derivedDisplayPath);
}

function containsNonAsciiText(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return true;
    }
  }
  return false;
}

interface PathInfo {
  readonly displayPath: string;
  readonly comparisonPath: string;
  readonly displaySegments: string[];
  readonly comparisonSegments: string[];
  readonly windows: boolean;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function isPathWithin(path: PathInfo, root: PathInfo): boolean {
  if (path.windows !== root.windows) {
    return false;
  }
  if (path.comparisonPath === root.comparisonPath) {
    return true;
  }
  if (root.comparisonPath === '/') {
    return path.comparisonPath.startsWith('/');
  }
  if (root.comparisonPath === '//') {
    return path.comparisonPath.startsWith('//');
  }
  if (root.comparisonPath.endsWith('/') && /^[a-z]:\/$/i.test(root.comparisonPath)) {
    return path.comparisonPath.startsWith(root.comparisonPath);
  }
  return path.comparisonPath.startsWith(`${root.comparisonPath}/`);
}

function ensureUniqueDisplayNames(
  folders: readonly WorkspaceFolderDescriptor[],
  displayNames: Map<string, string>,
): void {
  const candidates = folders.map(folder => ({
    folder,
    label: displayNames.get(folder.path) ?? sanitizeLabelText(folder.name),
  }));
  const used = new Set<string>();

  candidates.sort((left, right) => compareFolders(left.folder, right.folder) || compareText(left.label, right.label));
  candidates.forEach(({ folder, label: base }, position) => {
    let label = base;
    if (used.has(label)) {
      label = base.endsWith(`#${folder.index}`)
        ? `${base}-${position}`
        : `${base} #${folder.index}`;
      let suffix = 1;
      while (used.has(label)) {
        label = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    used.add(label);
    displayNames.set(folder.path, label);
  });
}

function ensureUniquePackageLabels(rows: PackageLabelRow[]): void {
  const sorted = [...rows].sort((left, right) => compareText(left.owner.label, right.owner.label)
    || compareText(getPathInfo(left.packageFilePath).comparisonPath, getPathInfo(right.packageFilePath).comparisonPath));
  const used = new Set<string>();
  const counts = new Map<string, number>();
  sorted.forEach(row => counts.set(row.owner.label, (counts.get(row.owner.label) ?? 0) + 1));

  sorted.forEach((row, position) => {
    const base = row.owner.label;
    let label = base;
    if ((counts.get(base) ?? 0) > 1 || used.has(label)) {
      label = `${base} #${position + 1}`;
      let suffix = position + 2;
      while (used.has(label)) {
        label = `${base} #${suffix}`;
        suffix += 1;
      }
      row.owner = { ...row.owner, label };
    }
    used.add(label);
  });
}

function ensureUnicodeDiscriminators(
  rows: PackageLabelRow[],
  formatting: PackageLabelFormatting,
): void {
  const unicodeRows = rows
    .filter(row => row.needsUnicodeDiscriminator)
    .sort((left, right) => compareText(
      getPathInfo(left.packageFilePath).comparisonPath,
      getPathInfo(right.packageFilePath).comparisonPath,
    ));

  unicodeRows.forEach((row, position) => {
    const ordinal = position + 1;
    const base = row.owner.label;
    row.owner = { ...row.owner, label: formatting.formatUnicodeDiscriminator(base, ordinal) };
  });
}

function compareFolders(left: WorkspaceFolderDescriptor, right: WorkspaceFolderDescriptor): number {
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return compareText(getPathInfo(left.path).comparisonPath, getPathInfo(right.path).comparisonPath);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUnsafeLabelCodePoint(codePoint: number): boolean {
  return UNSAFE_LABEL_CODE_POINT.test(String.fromCodePoint(codePoint))
    || (codePoint >= 0xd800 && codePoint <= 0xdfff);
}