export const WORKSPACE_PROTOCOL = 'workspace:';

const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_SOURCE = `(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})`
  + `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const CONCRETE_SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);
const NPM_ALIAS = /^npm:(?:@[^/@]+\/)?[^/@]+@(.+)$/;
const RANGE_PREFIX = /^(?:[~^]|[<>]=?)/;
const COMPARATOR_PREFIX = /^(?:[~^]|[<>]=?|=)/;
const RANGE_BASE_PREFIX = /^(?:[~^]|[<>]=?|=)?v?/;
const SEMVER_RANGE = `[~^]?${SEMVER_SOURCE}`;
const DIST_TAG = '[A-Za-z][A-Za-z0-9._-]*';
const WORKSPACE_FORM = `${WORKSPACE_PROTOCOL}(?:[*~^]|${SEMVER_RANGE})`;
const VERSION_OPERAND = new RegExp(`^(?:${SEMVER_RANGE}|${DIST_TAG}|${WORKSPACE_FORM})$`);

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly preRelease: readonly string[];
}

/** Parses an exact SemVer (no range prefix, no surrounding text); anything else is `undefined`. */
export function parseConcreteSemver(raw: string): ParsedSemver | undefined {
  const match = CONCRETE_SEMVER.exec(raw);
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

export function isConcreteSemver(raw: string): boolean {
  return CONCRETE_SEMVER.test(raw);
}

/** The leading range operator of a dependency spec; `workspace:` specs carry none. */
export function extractRangePrefix(spec: string): string {
  if (spec.startsWith(WORKSPACE_PROTOCOL)) {
    return '';
  }
  return RANGE_PREFIX.exec(spec)?.[0] ?? '';
}

/** Removes a leading `workspace:` and one range operator, leaving the bare version text. */
export function stripVersionDecorations(spec: string): string {
  const withoutProtocol = spec.startsWith(WORKSPACE_PROTOCOL) ? spec.slice(WORKSPACE_PROTOCOL.length) : spec;
  return withoutProtocol.replace(RANGE_PREFIX, '');
}

/** The version spec an `npm:<name>@<spec>` alias points at; any other spec is returned unchanged. */
export function unwrapNpmAlias(spec: string): string {
  return NPM_ALIAS.exec(spec)?.[1] ?? spec;
}

/**
 * Parses a current/latest version string: an optional `workspace:`, an optional comparator
 * operator, then an exact SemVer. Aliases, tags, wildcards and compound ranges are `undefined`.
 */
export function parseVersionString(raw: string): ParsedSemver | undefined {
  const trimmed = raw.trim();
  const withoutProtocol = trimmed.startsWith(WORKSPACE_PROTOCOL) ? trimmed.slice(WORKSPACE_PROTOCOL.length) : trimmed;
  return parseConcreteSemver(withoutProtocol.replace(COMPARATOR_PREFIX, ''));
}

/** The base version of a range: its first comparator in its first `||` alternative, when that is an exact SemVer. */
export function rangeBaseVersion(spec: string): ParsedSemver | undefined {
  const trimmed = spec.trim();
  const withoutProtocol = trimmed.startsWith(WORKSPACE_PROTOCOL) ? trimmed.slice(WORKSPACE_PROTOCOL.length) : trimmed;
  const alternative = (withoutProtocol.split('||', 1)[0] ?? '').trim();
  const comparator = alternative.split(/\s+/, 1)[0] ?? '';
  return parseConcreteSemver(comparator.replace(RANGE_BASE_PREFIX, ''));
}

/** True for a version/range, dist-tag or `workspace:` form that is safe as an install operand. */
export function isVersionOperand(spec: string): boolean {
  return VERSION_OPERAND.test(spec);
}