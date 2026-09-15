import { createHash } from 'node:crypto';
import { buildNormalizedManifest, parseNormalizedManifest, parsePackagedIdentity } from './artifactProvenance';
import { readVsixArchive } from './vsixArchive';
import { parseVsixManifestIdentity } from './vsixManifest';

export type PublishedArtifactComparisonMode = 'exact' | 'repacked';

export interface PublishedArtifactComparison {
  readonly mode: PublishedArtifactComparisonMode;
  readonly candidateSha256: string;
  readonly publishedSha256: string;
  readonly normalizedManifest: string;
  readonly identity: {
    readonly name: string;
    readonly version: string;
    readonly publisher: string;
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeEntryPath(path: string): void {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '..' || segment.length === 0)) {
    throw new Error(`published VSIX contains an unsafe archive path: ${path}`);
  }
}

function archiveIdentity(entries: ReturnType<typeof readVsixArchive>): PublishedArtifactComparison['identity'] {
  for (const entry of entries) {
    assertSafeEntryPath(entry.path);
    if (entry.isSymlink) {
      throw new Error(`published VSIX contains a symlink: ${entry.path}`);
    }
  }
  const packageEntry = entries.find(entry => entry.path === 'extension/package.json');
  const outerEntry = entries.find(entry => entry.path === 'extension.vsixmanifest');
  if (packageEntry === undefined || outerEntry === undefined) {
    throw new Error('published VSIX is missing its package and outer manifests');
  }
  const identity = parsePackagedIdentity(packageEntry.bytes);
  const outer = parseVsixManifestIdentity(outerEntry.bytes, 'published extension.vsixmanifest');
  if (outer.id !== identity.name || outer.version !== identity.version || outer.publisher !== identity.publisher) {
    throw new Error('published VSIX package and outer manifest identities do not match');
  }
  return identity;
}

function normalizedArchive(entries: ReturnType<typeof readVsixArchive>): string {
  const contents = buildNormalizedManifest(entries);
  parseNormalizedManifest(contents);
  return contents;
}

/**
 * Compares a registry copy with the candidate. Registry services may re-pack ZIP
 * containers, so byte differences are accepted only after safe parsing and exact
 * identity plus normalized path/content-digest equality.
 */
export function comparePublishedVsix(candidateBytes: Uint8Array, publishedBytes: Uint8Array): PublishedArtifactComparison {
  const candidateEntries = readVsixArchive(candidateBytes);
  const publishedEntries = readVsixArchive(publishedBytes);
  const candidateIdentity = archiveIdentity(candidateEntries);
  const publishedIdentity = archiveIdentity(publishedEntries);
  const candidateManifest = normalizedArchive(candidateEntries);
  const publishedManifest = normalizedArchive(publishedEntries);
  const candidateSha256 = sha256Hex(candidateBytes);
  const publishedSha256 = sha256Hex(publishedBytes);
  if (candidateIdentity.name !== publishedIdentity.name
    || candidateIdentity.version !== publishedIdentity.version
    || candidateIdentity.publisher !== publishedIdentity.publisher) {
    throw new Error('published VSIX identity does not match the candidate');
  }
  if (candidateManifest !== publishedManifest) {
    throw new Error('published VSIX normalized path/content digest manifest does not match the candidate');
  }
  return {
    mode: candidateSha256 === publishedSha256 ? 'exact' : 'repacked',
    candidateSha256,
    publishedSha256,
    normalizedManifest: candidateManifest,
    identity: candidateIdentity,
  };
}