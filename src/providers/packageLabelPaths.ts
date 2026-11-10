export interface PathInfo {
  readonly displayPath: string;
  readonly comparisonPath: string;
  readonly displaySegments: string[];
  readonly comparisonSegments: string[];
  readonly windows: boolean;
}

const UNSAFE_LABEL_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function normalizePathSeparators(value: string): string {
  return isWindowsPath(value) ? value.replace(/\\/g, '/') : value;
}

export function getPathInfo(value: string): PathInfo {
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

export function normalizedPackageFileDirectory(packageFilePath: string): string {
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

export function lastPathSegment(value: string): string {
  return getPathInfo(value).displaySegments.at(-1) ?? value;
}

export function sanitizeLabelText(value: string): string {
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

export function containsNonAsciiText(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return true;
    }
  }
  return false;
}

export function isPathWithin(path: PathInfo, root: PathInfo): boolean {
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

export function toRelativePackageFilePath(packageFilePath: string, workspaceRoot: string): string {
  const packageFile = getPathInfo(packageFilePath);
  const root = getPathInfo(workspaceRoot);
  if (!isPathWithin(packageFile, root)) {
    return packageFilePath;
  }
  return packageFile.displaySegments.slice(root.displaySegments.length).join('/') || packageFilePath;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function isUnsafeLabelCodePoint(codePoint: number): boolean {
  return UNSAFE_LABEL_CODE_POINT.test(String.fromCodePoint(codePoint))
    || (codePoint >= 0xd800 && codePoint <= 0xdfff);
}