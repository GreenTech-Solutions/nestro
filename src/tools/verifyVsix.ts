import * as path from 'node:path';
import { artifactLockReleaseError, collectArtifactCleanupFailures, removeArtifactsOrThrow, rethrowAfterArtifactCleanup } from './artifactCleanup';
import type { VsixArtifactLock } from './artifactLock';
import { normalizeArtifactOutDir } from './artifactOutDir';
import { assertPackagedIdentityMatches, readSourceExtensionIdentity } from './extensionIdentity';
import type { ExtensionIdentity } from './extensionIdentity';
import { formatDigestSidecar } from './evidenceFiles';
import { buildNormalizedManifest } from './normalizedManifest';
import { bundleFileName } from './releaseContract';
import { readVsixArchive } from './vsixArchive';
import type { VsixArchiveEntry } from './vsixArchive';
import { evaluateVsixPolicy } from './vsixPolicy';
import type { VsixPolicyReport } from './vsixPolicyTypes';
import { collectSymlinkCandidates, VSIX_EXTENSION_PREFIX } from './vsixRules';
import { sha256Hex } from '../shared';

/**
 * Packages the extension, verifies the produced bytes against the allowlist in `vsixPolicy.ts`,
 * and publishes the manifest and SHA-256 digest only when nothing was flagged. A rejected package
 * is deleted so it cannot be mistaken for a verified artifact.
 */

export interface VsixVerifierIo {
  /** Runs vsce and leaves the package at `vsixPath` (relative to the repository root). */
  packageExtension(vsixPath: string): Promise<void>;
  readBinaryFile(filePath: string): Promise<Uint8Array>;
  writeTextFile(filePath: string, contents: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  /** Creates the output directory and proves its real path stays inside the repository. */
  prepareArtifactDirectory(dirPath: string): Promise<void>;
  /**
   * Atomically acquires the exact per-artifact lock or fails without touching artifacts.
   * Locks are never broken automatically; crash leftovers require manual removal after
   * confirming that no verifier still owns the lock.
   */
  acquireArtifactLock(lockPath: string): Promise<VsixArtifactLock>;
  /** `git ls-files`, used to prove every packaged file comes from a tracked checkout. */
  listTrackedFiles(): Promise<string[]>;
  /** Tracked paths that differ from HEAD, so "tracked" can be told apart from "unmodified". */
  listModifiedTrackedFiles(): Promise<string[]>;
  /** Untracked, non-ignored paths whose bytes cannot come from a clean checkout. */
  listUntrackedFiles(): Promise<string[]>;
  /** Subset of `candidatePaths` that are symlinks on disk. */
  listSymlinkPaths(candidatePaths: readonly string[]): Promise<string[]>;
}

export interface VerifyVsixOptions {
  readonly outDir: string;
  /** Require a clean checkout: tracked files match HEAD and no non-ignored untracked paths exist. */
  readonly requireCleanWorktree: boolean;
}

export interface VerifyVsixResult {
  readonly vsixPath: string;
  readonly manifestPath: string;
  readonly digestPath: string;
  readonly digest: string;
  readonly compressedBytes: number;
  readonly report: VsixPolicyReport;
  /** `<sha256>  <archive path>` per packaged entry, sorted by archive path. */
  readonly manifestLines: readonly string[];
  readonly artifactsWritten: boolean;
}

interface ArtifactPaths {
  readonly vsixPath: string;
  readonly manifestPath: string;
  readonly digestPath: string;
  readonly lockPath: string;
}

interface PackagedVsixInspection {
  readonly archiveBytes: Uint8Array;
  readonly entries: readonly VsixArchiveEntry[];
  readonly report: VsixPolicyReport;
}

type LockedVerificationOutcome
  = | { readonly ok: true; readonly result: VerifyVsixResult }
    | { readonly ok: false; readonly error: unknown };

async function inspectPackagedVsix(
  io: VsixVerifierIo,
  options: VerifyVsixOptions,
  identity: ExtensionIdentity,
  paths: ArtifactPaths,
): Promise<PackagedVsixInspection> {
  const archiveBytes = await io.readBinaryFile(paths.vsixPath);
  const entries = readVsixArchive(archiveBytes);
  assertPackagedIdentityMatches(entries, identity);
  const packagePaths = entries
    .filter(entry => entry.path.startsWith(VSIX_EXTENSION_PREFIX))
    .map(entry => entry.path.slice(VSIX_EXTENSION_PREFIX.length));

  const untrackedWorktreePaths = options.requireCleanWorktree
    ? (await io.listUntrackedFiles()).filter(worktreePath => worktreePath !== paths.lockPath)
    : [];
  const report = evaluateVsixPolicy({
    entries,
    compressedBytes: archiveBytes.length,
    trackedSourcePaths: await io.listTrackedFiles(),
    symlinkSourcePaths: await io.listSymlinkPaths(collectSymlinkCandidates(packagePaths)),
    modifiedTrackedPaths: await io.listModifiedTrackedFiles(),
    untrackedWorktreePaths,
    requireCleanWorktree: options.requireCleanWorktree,
  });
  return { archiveBytes, entries, report };
}

async function verifyVsixPackageWhileLocked(
  io: VsixVerifierIo,
  options: VerifyVsixOptions,
  identity: ExtensionIdentity,
  paths: ArtifactPaths,
): Promise<VerifyVsixResult> {
  const { vsixPath, manifestPath, digestPath } = paths;
  const artifactPaths = [vsixPath, manifestPath, digestPath];
  await removeArtifactsOrThrow(io, artifactPaths, 'before packaging');

  try {
    await io.packageExtension(vsixPath);
    const { archiveBytes, entries, report } = await inspectPackagedVsix(io, options, identity, paths);

    const digest = sha256Hex(archiveBytes);
    const manifest = buildNormalizedManifest(entries);
    const manifestLines = manifest.slice(0, -1).split('\n');
    const artifactsWritten = report.violations.length === 0;
    if (artifactsWritten) {
      await io.writeTextFile(manifestPath, manifest);
      await io.writeTextFile(digestPath, formatDigestSidecar(digest, path.posix.basename(vsixPath)));
    }
    else {
      await removeArtifactsOrThrow(io, artifactPaths, 'after policy rejection');
    }

    return {
      vsixPath,
      manifestPath,
      digestPath,
      digest,
      compressedBytes: archiveBytes.length,
      report,
      manifestLines,
      artifactsWritten,
    };
  }
  catch (error) {
    return rethrowAfterArtifactCleanup(io, artifactPaths, error);
  }
}

/** Packages the extension and evaluates the produced archive against the policy. */
export async function verifyVsixPackage(io: VsixVerifierIo, options: VerifyVsixOptions): Promise<VerifyVsixResult> {
  const outDir = normalizeArtifactOutDir(options.outDir);
  const identity = readSourceExtensionIdentity(await io.readBinaryFile('package.json'));
  const vsixPath = path.posix.join(outDir, `${identity.name}-${identity.version}.vsix`);
  const paths: ArtifactPaths = {
    vsixPath,
    manifestPath: bundleFileName('manifest', vsixPath),
    digestPath: bundleFileName('digest', vsixPath),
    lockPath: `${vsixPath}.lock`,
  };

  await io.prepareArtifactDirectory(outDir);
  const lock = await io.acquireArtifactLock(paths.lockPath);

  let outcome: LockedVerificationOutcome;
  try {
    outcome = { ok: true, result: await verifyVsixPackageWhileLocked(io, options, identity, paths) };
  }
  catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await lock.release();
  }
  catch (releaseError) {
    const cleanupFailures = await collectArtifactCleanupFailures(io, [vsixPath, paths.manifestPath, paths.digestPath]);
    throw artifactLockReleaseError(paths.lockPath, releaseError, outcome, cleanupFailures);
  }

  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.result;
}