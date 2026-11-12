// `@scope/name` (scope optional) with exactly one separating slash.
const SCOPED_NAME_PATTERN = /^(?:@([^/]+)\/)?([^/]+)$/;

export type PackageNameProblem
  = | { readonly kind: 'empty' }
    | { readonly kind: 'leading-hyphen' }
    | { readonly kind: 'malformed' }
    | { readonly kind: 'unsafe-scope'; readonly segment: string }
    | { readonly kind: 'unsafe-name'; readonly segment: string };

/**
 * Rejects only what makes an operand option-like or unresolvable — leading hyphen,
 * empty name, malformed scope, or URL-unsafe characters. Mixed case and length past
 * 214 pass as real legacy names; leading `.`/`_` pass only as inert, not real, ones.
 */
export function classifyPackageName(name: string): PackageNameProblem | undefined {
  if (name.length === 0) {
    return { kind: 'empty' };
  }
  if (name.startsWith('-')) {
    return { kind: 'leading-hyphen' };
  }

  const match = SCOPED_NAME_PATTERN.exec(name);
  if (match === null) {
    return { kind: 'malformed' };
  }

  const [, scope, unscopedName] = match;
  if (scope !== undefined && !isUrlSafeSegment(scope)) {
    return { kind: 'unsafe-scope', segment: scope };
  }
  if (!isUrlSafeSegment(unscopedName)) {
    return { kind: 'unsafe-name', segment: unscopedName };
  }
  return undefined;
}

/** True when `classifyPackageName()` finds nothing wrong with the name. */
export function isValidPackageName(name: string): boolean {
  return classifyPackageName(name) === undefined;
}

function isUrlSafeSegment(segment: string): boolean {
  try {
    return encodeURIComponent(segment) === segment;
  }
  catch {
    // An unpaired surrogate makes encodeURIComponent() throw instead of encoding.
    return false;
  }
}