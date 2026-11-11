import { parseVsixManifestIdentity } from './vsixManifest';
import { VSIX_EXTENSION_PREFIX } from './vsixRules';
import { isRecord, parseConcreteSemver } from '../shared';

/** The `publisher.name@version` identity an extension declares in `package.json`. */
export interface ExtensionIdentity {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
}

interface IdentityBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/** Reads the non-empty `name`, `version` and `publisher` strings of a `package.json`. */
export function parseExtensionIdentity(manifestBytes: Uint8Array, label = 'extension/package.json'): ExtensionIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)
    || typeof parsed.name !== 'string' || parsed.name.length === 0
    || typeof parsed.version !== 'string' || parsed.version.length === 0
    || typeof parsed.publisher !== 'string' || parsed.publisher.length === 0) {
    throw new Error(`${label} must be a non-null JSON object with non-empty string "name", "version", and "publisher" fields`);
  }
  return { name: parsed.name, version: parsed.version, publisher: parsed.publisher };
}

function isValidSemver(version: string): boolean {
  return parseConcreteSemver(version) !== undefined;
}

function assertSafeExtensionIdentity(identity: ExtensionIdentity, label: string): void {
  if (!EXTENSION_NAME_PATTERN.test(identity.name)) {
    throw new Error(`${label} extension name must contain only lowercase ASCII letters, digits, and hyphens`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(identity.version) || /[\\/]/u.test(identity.version)) {
    throw new Error(`${label} extension version is not a safe artifact component`);
  }
  if (!isValidSemver(identity.version)) {
    throw new Error(`${label} extension version must be valid SemVer`);
  }
}

/** Parses the repository `package.json` and requires an identity safe to use in artifact names. */
export function readSourceExtensionIdentity(manifestBytes: Uint8Array): ExtensionIdentity {
  const identity = parseExtensionIdentity(manifestBytes, 'package.json');
  assertSafeExtensionIdentity(identity, 'package.json');
  return identity;
}

/** Requires the packaged `extension/package.json` and the outer `extension.vsixmanifest` to match the source identity. */
export function assertPackagedIdentityMatches(entries: readonly IdentityBytes[], sourceIdentity: ExtensionIdentity): void {
  assertInnerManifestIdentity(entries, sourceIdentity);
  assertOuterManifestIdentity(entries, sourceIdentity);
}

function assertInnerManifestIdentity(entries: readonly IdentityBytes[], sourceIdentity: ExtensionIdentity): void {
  const manifestEntries = entries.filter(entry => entry.path === `${VSIX_EXTENSION_PREFIX}package.json`);
  if (manifestEntries.length !== 1) {
    throw new Error(`VSIX must contain exactly one ${VSIX_EXTENSION_PREFIX}package.json`);
  }
  const packagedIdentity = parseExtensionIdentity(manifestEntries[0].bytes, 'packaged extension/package.json');
  if (packagedIdentity.name !== sourceIdentity.name
    || packagedIdentity.version !== sourceIdentity.version
    || packagedIdentity.publisher !== sourceIdentity.publisher) {
    throw new Error(
      `packaged extension identity ${packagedIdentity.publisher}.${packagedIdentity.name}`
      + `@${packagedIdentity.version} does not match source package.json `
      + `${sourceIdentity.publisher}.${sourceIdentity.name}@${sourceIdentity.version}`,
    );
  }
}

function assertOuterManifestIdentity(entries: readonly IdentityBytes[], sourceIdentity: ExtensionIdentity): void {
  const outerManifestEntries = entries.filter(entry => entry.path === 'extension.vsixmanifest');
  if (outerManifestEntries.length !== 1) {
    throw new Error('VSIX must contain exactly one extension.vsixmanifest');
  }
  const outerIdentity = parseVsixManifestIdentity(outerManifestEntries[0].bytes, 'extension.vsixmanifest');
  if (outerIdentity.id !== sourceIdentity.name
    || outerIdentity.version !== sourceIdentity.version
    || outerIdentity.publisher !== sourceIdentity.publisher) {
    throw new Error(
      `outer VSIX identity ${outerIdentity.publisher}.${outerIdentity.id}@${outerIdentity.version} `
      + `does not match source package.json ${sourceIdentity.publisher}.${sourceIdentity.name}`
      + `@${sourceIdentity.version}`,
    );
  }
}