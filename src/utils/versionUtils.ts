export type UpdateType = 'none' | 'patch' | 'minor' | 'breaking';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  preRelease: string[];
}

export function getUpdateType(current: string, latest: string): UpdateType {
  const currentVersion = parseVersion(current);
  const latestVersion = parseVersion(latest);

  if (currentVersion === undefined || latestVersion === undefined) {
    return 'none';
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return 'none';
  }

  if (latestVersion.major > currentVersion.major) { return 'breaking'; }
  if (latestVersion.minor > currentVersion.minor) { return 'minor'; }
  return 'patch';
}

export function isVersionOutdated(current: string, latest: string): boolean {
  return getUpdateType(current, latest) !== 'none';
}

export function getGreatestVersion(versions: string[], includePreReleases: boolean): string | undefined {
  let greatest: { raw: string; parsed: ParsedVersion } | undefined;

  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (parsed === undefined || (!includePreReleases && parsed.preRelease.length > 0)) {
      continue;
    }

    if (greatest === undefined || compareVersions(parsed, greatest.parsed) > 0) {
      greatest = { raw, parsed };
    }
  }

  return greatest?.raw;
}

export function compareRawVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  if (leftVersion === undefined && rightVersion === undefined) {
    return left.localeCompare(right);
  }
  if (leftVersion === undefined) {
    return -1;
  }
  if (rightVersion === undefined) {
    return 1;
  }

  return compareVersions(leftVersion, rightVersion);
}

export function isPreReleaseVersion(raw: string): boolean {
  return (parseVersion(raw)?.preRelease.length ?? 0) > 0;
}

function parseVersion(raw: string): ParsedVersion | undefined {
  const match = raw.trim().match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/);
  if (match === null) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    preRelease: match[4]?.split('.') ?? [],
  };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const major = compareNumbers(a.major, b.major);
  if (major !== 0) { return major; }

  const minor = compareNumbers(a.minor, b.minor);
  if (minor !== 0) { return minor; }

  const patch = compareNumbers(a.patch, b.patch);
  if (patch !== 0) { return patch; }

  return comparePreRelease(a.preRelease, b.preRelease);
}

function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function comparePreRelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) { return 0; }
  if (a.length === 0) { return 1; }
  if (b.length === 0) { return -1; }

  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = a[index];
    const right = b[index];

    if (left === undefined) { return -1; }
    if (right === undefined) { return 1; }
    if (left === right) { continue; }

    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === left;
    const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === right;

    if (leftIsNumber && rightIsNumber) {
      return compareNumbers(leftNumber, rightNumber);
    }
    if (leftIsNumber) { return -1; }
    if (rightIsNumber) { return 1; }
    return left > right ? 1 : -1;
  }

  return 0;
}