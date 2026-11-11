import {
  compareNumericSemvers,
  parseNumericSemverComparator,
  parsePlainNumericSemver,
  unwrapNpmAlias,
} from '../shared';

type ParsedVersion = NonNullable<ReturnType<typeof parsePlainNumericSemver>>;

/** True when `resolvedVersion` satisfies an exact, caret, or tilde spec, including an npm alias target. */
export function matchesManifestVersion(spec: string, resolvedVersion: string): boolean {
  const resolved = parsePlainNumericSemver(resolvedVersion.trim());
  if (resolved === undefined) {
    return false;
  }
  const normalizedSpec = unwrapNpmAlias(spec.trim());
  const exact = parsePlainNumericSemver(normalizedSpec.replace(/^=/, '').trim());
  if (exact !== undefined) {
    return compareNumericSemvers(resolved, exact) === 0;
  }
  const operator = normalizedSpec[0];
  if (operator !== '^' && operator !== '~') {
    return false;
  }
  const base = parsePlainNumericSemver(normalizedSpec.slice(1).trim());
  if (base === undefined || compareNumericSemvers(resolved, base) < 0) {
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
  const parsedVersion = parsePlainNumericSemver(version.trim());
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
  const comparator = parseNumericSemverComparator(token);
  if (comparator === undefined) {
    return false;
  }
  const comparison = compareNumericSemvers(version, comparator.version);
  switch (comparator.operator ?? '=') {
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