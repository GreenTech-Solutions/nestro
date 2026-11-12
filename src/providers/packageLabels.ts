import * as vscode from 'vscode';
import { compareCodeUnits, PACKAGE_PRESENTATION } from '../shared';
import {
  containsNonAsciiText,
  getPathInfo,
  isPathWithin,
  lastPathSegment,
  normalizedPackageFileDirectory,
  sanitizeLabelText,
  toRelativePackageFilePath,
} from './packageLabelPaths';
import { assignDisambiguatedNames, ensureUniqueDisplayNames } from './packageLabelDisambiguation';

export interface WorkspaceFolderDescriptor {
  readonly path: string;
  readonly name: string;
  readonly index: number;
}

export interface PackageOwnerLabel {
  readonly label: string;
  readonly folderIndex: number;
  readonly isRoot: boolean;
  readonly relativeLabel: string;
}

export interface PackageFileLabel {
  readonly packageFilePath: string;
  readonly owner: PackageOwnerLabel;
  readonly relativePackageFilePath: string;
}

export interface PackageLabelFormatting {
  readonly rootLabel: string;
  readonly formatUnicodeDiscriminator: (base: string, ordinal: number) => string;
}

interface PackageLabelRow extends PackageFileLabel {
  owner: PackageOwnerLabel;
  readonly needsUnicodeDiscriminator: boolean;
}

const UNOWNED_FOLDER_INDEX = Number.MAX_SAFE_INTEGER;
const DEFAULT_PACKAGE_LABEL_FORMATTING: PackageLabelFormatting = {
  rootLabel: PACKAGE_PRESENTATION.rootLabel,
  formatUnicodeDiscriminator: (base, ordinal) => `${base} [unicode #${ordinal}]`,
};

export function getLocalizedPackageLabelFormatting(): PackageLabelFormatting {
  return {
    rootLabel: vscode.l10n.t(PACKAGE_PRESENTATION.rootLabel),
    formatUnicodeDiscriminator: (base, ordinal) => vscode.l10n.t('{0} [unicode #{1}]', base, ordinal),
  };
}

export function toWorkspaceFolderDescriptors(
  folders: readonly { readonly uri: { readonly fsPath: string }; readonly name?: string; readonly index?: number }[],
): WorkspaceFolderDescriptor[] {
  return folders.map((folder, position) => ({
    path: folder.uri.fsPath,
    name: folder.name !== undefined && folder.name !== '' ? folder.name : lastPathSegment(folder.uri.fsPath),
    index: folder.index ?? position,
  }));
}

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
  const rows = uniquePaths.map((packageFilePath) => {
    const ownerFolder = findOwningWorkspaceFolder(packageFilePath, folders);
    return {
      packageFilePath,
      owner: resolvePackageOwnerLabel(packageFilePath, folders, displayNames, formatting),
      relativePackageFilePath: ownerFolder === undefined
        ? packageFilePath
        : toRelativePackageFilePath(packageFilePath, ownerFolder.path),
      needsUnicodeDiscriminator: packageLabelNeedsUnicodeDiscriminator(packageFilePath, folders, displayNames),
    };
  });
  ensureUniquePackageLabels(rows);
  ensureUnicodeDiscriminators(rows, formatting);
  ensureUniquePackageLabels(rows);
  rows.sort((left, right) => comparePackageOwnerLabels(left.owner, right.owner)
    || compareCodeUnits(getPathInfo(left.packageFilePath).comparisonPath, getPathInfo(right.packageFilePath).comparisonPath));
  return rows;
}

export function comparePackageOwnerLabels(left: PackageOwnerLabel, right: PackageOwnerLabel): number {
  if (left.folderIndex !== right.folderIndex) {
    return left.folderIndex - right.folderIndex;
  }
  if (left.isRoot !== right.isRoot) {
    return left.isRoot ? -1 : 1;
  }
  return compareCodeUnits(left.relativeLabel, right.relativeLabel);
}

export function toRelativeLabel(packageFilePath: string, workspaceRoot: string): string {
  const folderPath = getPathInfo(normalizedPackageFileDirectory(packageFilePath));
  const root = getPathInfo(workspaceRoot);
  if (folderPath.comparisonPath === root.comparisonPath) {
    return PACKAGE_PRESENTATION.rootLabel;
  }
  if (isPathWithin(folderPath, root)) {
    return folderPath.displaySegments.slice(root.displaySegments.length).join('/') || PACKAGE_PRESENTATION.rootLabel;
  }
  return folderPath.displaySegments.at(-1) ?? folderPath.displayPath;
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

function ensureUniquePackageLabels(rows: PackageLabelRow[]): void {
  const sorted = [...rows].sort((left, right) => compareCodeUnits(left.owner.label, right.owner.label)
    || compareCodeUnits(getPathInfo(left.packageFilePath).comparisonPath, getPathInfo(right.packageFilePath).comparisonPath));
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
    .sort((left, right) => compareCodeUnits(
      getPathInfo(left.packageFilePath).comparisonPath,
      getPathInfo(right.packageFilePath).comparisonPath,
    ));

  unicodeRows.forEach((row, position) => {
    const ordinal = position + 1;
    const base = row.owner.label;
    row.owner = { ...row.owner, label: formatting.formatUnicodeDiscriminator(base, ordinal) };
  });
}