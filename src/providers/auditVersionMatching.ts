interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** True when `resolvedVersion` satisfies the manifest spec: an exact version or a `^`/`~` range. */
export function matchesManifestVersion(spec: string, resolvedVersion: string): boolean {
  const resolved = parseVersion(resolvedVersion);
  if (resolved === undefined) {
    return false;
  }
  const normalizedSpec = spec.trim();
  const exact = parseVersion(normalizedSpec.replace(/^=/, ''));
  if (exact !== undefined) {
    return compareVersions(resolved, exact) === 0;
  }
  const operator = normalizedSpec[0];
  if (operator !== '^' && operator !== '~') {
    return false;
  }
  const base = parseVersion(normalizedSpec.slice(1));
  if (base === undefined || compareVersions(resolved, base) < 0) {
    return false;
  }
  if (operator === '~') {
    return resolved.major === base.major && resolved.minor === base.minor;
  }
  if (base.major > 0) {
    return resolved.major === base.major;
  }
  if (base.minor > 0) {
    return resolved.major === 0 && resolved.minor === base.minor;
  }
  return resolved.major === 0 && resolved.minor === 0 && resolved.patch === base.patch;
}

/** True when `version` lies in at least one advisory range; unions (`||`) never match. */
export function isVersionInAffectedRange(version: string, ranges: readonly string[]): boolean {
  const parsedVersion = parseVersion(version);
  if (parsedVersion === undefined) {
    return false;
  }
  return ranges.some((range) => {
    const normalizedRange = range.trim();
    if (normalizedRange === '*' || normalizedRange === '') {
      return normalizedRange === '*';
    }
    if (normalizedRange.includes('||')) {
      return false;
    }
    const tokens = normalizedRange.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(token => matchesComparator(parsedVersion, token));
  });
}

function matchesComparator(version: ParsedVersion, token: string): boolean {
  const match = /^(<=|>=|<|>|=)?(\d+\.\d+\.\d+)$/.exec(token);
  if (match === null) {
    return false;
  }
  const expected = parseVersion(match[2]);
  if (expected === undefined) {
    return false;
  }
  const comparison = compareVersions(version, expected);
  switch (match[1] ?? '=') {
    case '<':
      return comparison < 0;
    case '<=':
      return comparison <= 0;
    case '>':
      return comparison > 0;
    case '>=':
      return comparison >= 0;
    default:
      return comparison === 0;
  }
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}