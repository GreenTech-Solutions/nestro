import { parseExtensionIdentity } from './extensionIdentity';
import type { ExtensionIdentity } from './extensionIdentity';
import { compareCodeUnits, isRecord } from '../shared';

export const RUNTIME_FILE_PATTERN = /^extension\/(?:package\.json|out\/[A-Za-z0-9._$@-]+\.cjs)$/u;

export interface ArtifactRuntimeFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What a packaged VSIX contributes to its SBOM: identity, delivered runtime files and declared dependencies. */
export interface PackagedSbomInputs {
  readonly identity: ExtensionIdentity;
  readonly runtimeFiles: readonly ArtifactRuntimeFile[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

export function selectDeliveredRuntimeFiles(entries: readonly { path: string; bytes: Uint8Array }[]): ArtifactRuntimeFile[] {
  return entries
    .filter(entry => RUNTIME_FILE_PATTERN.test(entry.path))
    .map(entry => ({ path: entry.path, bytes: entry.bytes }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}

export function readRuntimeDependencies(manifest: unknown): {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
} {
  if (!isRecord(manifest)) {
    throw new Error('packaged package.json must be an object');
  }
  const read = (key: string): Record<string, string> => {
    const value = manifest[key];
    if (value === undefined) {
      return {};
    }
    if (!isRecord(value)) {
      throw new Error(`packaged package.json ${key} must be an object`);
    }
    const result: Record<string, string> = {};
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== 'string' || version.length === 0) {
        throw new Error(`packaged package.json ${key}.${name} must be a non-empty version spec`);
      }
      result[name] = version;
    }
    return result;
  };
  return { dependencies: read('dependencies'), optionalDependencies: read('optionalDependencies') };
}

/** Reads the SBOM inputs out of a verified archive's `extension/package.json` and runtime files. */
export function readPackagedSbomInputs(entries: readonly { path: string; bytes: Uint8Array }[]): PackagedSbomInputs {
  const manifestEntry = entries.find(entry => entry.path === 'extension/package.json');
  if (manifestEntry === undefined) {
    throw new Error('VSIX must contain extension/package.json for the SBOM');
  }
  const identity = parseExtensionIdentity(manifestEntry.bytes, 'extension/package.json');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.bytes)) as unknown;
  return { identity, runtimeFiles: selectDeliveredRuntimeFiles(entries), ...readRuntimeDependencies(manifest) };
}