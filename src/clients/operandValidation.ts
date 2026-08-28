// `@scope/name` (scope optional) with exactly one separating slash.
const SCOPED_NAME_PATTERN = /^(?:@([^/]+)\/)?([^/]+)$/;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Rejects only what makes an operand option-like or unresolvable — leading hyphen,
 * empty name, malformed scope, or URL-unsafe characters. Mixed case and length past
 * 214 pass as real legacy names; leading `.`/`_` pass only as inert, not real, ones.
 */
export function validatePackageName(name: string): void {
  if (name.length === 0) {
    throw new Error('Package name cannot be empty.');
  }
  if (name.startsWith('-')) {
    throw new Error(`Package name "${name}" cannot start with a hyphen.`);
  }

  const match = SCOPED_NAME_PATTERN.exec(name);
  if (match === null) {
    throw new Error(`Package name "${name}" is not a valid package or scoped package name.`);
  }

  const [, scope, unscopedName] = match;
  if (scope !== undefined && !isUrlSafeSegment(scope)) {
    throw new Error(`Package scope "${scope}" contains characters a registry URL can't carry.`);
  }
  if (!isUrlSafeSegment(unscopedName)) {
    throw new Error(`Package name "${unscopedName}" contains characters a registry URL can't carry.`);
  }
}

/**
 * Rejects only a leading hyphen or control characters: no semver, prerelease,
 * dist-tag, or `workspace:` spec ever starts with either.
 */
export function validatePackageVersionSpec(version: string): void {
  if (version.length === 0) {
    throw new Error('Package version cannot be empty.');
  }
  if (version.startsWith('-')) {
    throw new Error(`Package version "${version}" cannot start with a hyphen.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(version)) {
    throw new Error(`Package version "${version}" contains control characters.`);
  }
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