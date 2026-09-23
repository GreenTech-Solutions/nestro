export type DependencySpecRange = 'exact' | 'caret' | 'tilde';
export type DependencySpecProtocol = 'plain' | 'workspace';

/** A dependency spec whose range and concrete version this parser can safely rewrite. */
export interface PinnableDependencySpec {
  readonly supported: true;
  readonly protocol: DependencySpecProtocol;
  readonly range: DependencySpecRange;
  readonly version: string;
}

/** A dependency spec the pin toggle must leave untouched, with a user-facing reason. */
export interface UnsupportedDependencySpec {
  readonly supported: false;
  readonly reason: string;
}

export type ParsedDependencySpec = PinnableDependencySpec | UnsupportedDependencySpec;

const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const CONCRETE_SEMVER = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
// Node-semver X-ranges: one to three numeric/wildcard components with at least one wildcard.
// Deliberately does not match a dist-tag that merely contains the letter x.
const WILDCARD_COMPONENTS = /^(?:\d+|\*|[xX])(?:\.(?:\d+|\*|[xX])){0,2}$/;
const WORKSPACE_PROTOCOL = 'workspace:';

/**
 * Parses a raw `package.json` dependency spec as a tagged union: only exact, caret, and
 * tilde ranges over a concrete SemVer (plain or `workspace:`-prefixed) are pinnable.
 * Every other form (alias, git, file, tarball, tag, wildcard, compound, comparator) is
 * reported as unsupported with a reason instead of being guessed at.
 */
export function parseDependencySpec(spec: string): ParsedDependencySpec {
  if (spec.startsWith(WORKSPACE_PROTOCOL)) {
    const remainder = spec.slice(WORKSPACE_PROTOCOL.length);
    const plain = parsePlainRange(remainder);
    if (plain === undefined) {
      return { supported: false, reason: `workspace range is not a concrete version (${describeUnsupportedSpec(remainder)})` };
    }
    return { supported: true, protocol: 'workspace', range: plain.range, version: plain.version };
  }

  const plain = parsePlainRange(spec);
  if (plain === undefined) {
    return { supported: false, reason: describeUnsupportedSpec(spec) };
  }
  return { supported: true, protocol: 'plain', range: plain.range, version: plain.version };
}

/** Formats a parsed spec back into a `package.json` value, preserving its protocol. */
export function formatDependencySpec(spec: PinnableDependencySpec, pin: boolean): string {
  const protocolPrefix = spec.protocol === 'workspace' ? WORKSPACE_PROTOCOL : '';
  const rangePrefix = pin ? '' : '^';
  return `${protocolPrefix}${rangePrefix}${spec.version}`;
}

function parsePlainRange(spec: string): { range: DependencySpecRange; version: string } | undefined {
  if (CONCRETE_SEMVER.test(spec)) {
    return { range: 'exact', version: spec };
  }
  if (spec.startsWith('^') && CONCRETE_SEMVER.test(spec.slice(1))) {
    return { range: 'caret', version: spec.slice(1) };
  }
  if (spec.startsWith('~') && CONCRETE_SEMVER.test(spec.slice(1))) {
    return { range: 'tilde', version: spec.slice(1) };
  }
  return undefined;
}

function describeUnsupportedSpec(spec: string): string {
  const trimmed = spec.trim();
  if (spec !== trimmed) {
    return 'whitespace in version spec';
  }
  if (trimmed === '') {
    return 'empty version spec';
  }
  if (/^npm:/i.test(trimmed)) {
    return 'npm alias dependency';
  }
  if (isGitSpec(trimmed)) {
    return 'git dependency';
  }
  if (/^file:/i.test(trimmed)) {
    return 'local file dependency';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return 'remote tarball dependency';
  }
  if (trimmed.includes('||') || /\s/.test(trimmed)) {
    return 'compound version range';
  }
  if (isWildcardRange(trimmed)) {
    return 'wildcard version range';
  }
  if (/^(>=|<=|>|<|=)/.test(trimmed)) {
    return 'comparator version range';
  }
  if (/^[~^]/.test(trimmed)) {
    return 'partial version range';
  }
  if (/^[A-Za-z][\w.-]*$/.test(trimmed)) {
    return 'dist-tag reference';
  }
  return 'unrecognized version spec';
}

function isGitSpec(spec: string): boolean {
  const atSign = spec.indexOf('@');
  const colon = spec.indexOf(':');
  const isScpLike = atSign > 0 && colon > atSign && !spec.includes(' ');
  const pathWithoutFragment = (spec.split('#', 1)[0] ?? '').toLowerCase();
  return /^git(\+[a-z]+)?:\/\//i.test(spec)
    || /^ssh:\/\//i.test(spec)
    || /^(github|gitlab|bitbucket):/i.test(spec)
    || (/^(?:https?):\/\//i.test(spec) && pathWithoutFragment.endsWith('.git'))
    || isScpLike
    || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec);
}

function isWildcardRange(spec: string): boolean {
  return WILDCARD_COMPONENTS.test(spec) && /[xX*]/.test(spec);
}