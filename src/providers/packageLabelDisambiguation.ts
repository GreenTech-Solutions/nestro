import { compareCodeUnits } from '../shared';
import { getPathInfo, sanitizeLabelText } from './packageLabelPaths';
import type { WorkspaceFolderDescriptor } from './packageLabels';

export function assignDisambiguatedNames(
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

export function ensureUniqueDisplayNames(
  folders: readonly WorkspaceFolderDescriptor[],
  displayNames: Map<string, string>,
): void {
  const candidates = folders.map(folder => ({
    folder,
    label: displayNames.get(folder.path) ?? sanitizeLabelText(folder.name),
  }));
  const used = new Set<string>();

  candidates.sort((left, right) => compareFolders(left.folder, right.folder) || compareCodeUnits(left.label, right.label));
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

function shortestUniqueSuffix(
  paths: ReturnType<typeof getPathInfo>[],
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

function compareFolders(left: WorkspaceFolderDescriptor, right: WorkspaceFolderDescriptor): number {
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return compareCodeUnits(getPathInfo(left.path).comparisonPath, getPathInfo(right.path).comparisonPath);
}