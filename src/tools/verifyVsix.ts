import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  collectSymlinkCandidates,
  compareNormalizedPaths,
  COMPRESSED_SIZE_BUDGET_BYTES,
  evaluateVsixPolicy,
  PACKAGED_FILE_COUNT_BUDGET,
  VSIX_EXTENSION_PREFIX,
} from './vsixPolicy';
import type { PolicyViolation, VsixPolicyReport } from './vsixPolicy';
import { readVsixArchive } from './vsixArchive';
import { parseVsixManifestIdentity } from './vsixManifest';

/**
 * `check:vsce` entrypoint. It packages the extension, then verifies the bytes
 * that were actually produced against the allowlist in `vsixPolicy.ts`, and
 * only publishes the verified `.vsix`, its normalized manifest and the SHA-256
 * digests when nothing was flagged. A rejected package is deleted so it can
 * never be mistaken for a verified artifact by a later step.
 */

/** Relative path of the vsce CLI script; both npm and pnpm materialise it here. */
export const VSCE_BIN_RELATIVE_PATH = 'node_modules/@vscode/vsce/vsce';
export const DEFAULT_OUT_DIR = 'dist';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const SEMVER_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/u;

export interface VsixArtifactLock {
  release(): Promise<void>;
}

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

export interface VerifyVsixCliDependencies {
  readonly io: VsixVerifierIo;
  readonly writeOut: (line: string) => void;
  readonly writeError: (line: string) => void;
}

interface ExtensionIdentity {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
}

interface ArtifactCleanupFailure {
  readonly path: string;
  readonly error: Error;
}

type LockedVerificationOutcome
  = | { readonly ok: true; readonly result: VerifyVsixResult }
    | { readonly ok: false; readonly error: unknown };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseExtensionIdentity(manifestBytes: Uint8Array, label: string): ExtensionIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(manifestBytes));
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a non-null JSON object with string "name", "version", and "publisher" fields`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.version !== 'string' || manifest.version.length === 0
    || typeof manifest.publisher !== 'string' || manifest.publisher.length === 0) {
    throw new Error(`${label} must be a non-null JSON object with string "name", "version", and "publisher" fields`);
  }
  return { name: manifest.name, version: manifest.version, publisher: manifest.publisher };
}

function isValidNumericSemverIdentifier(identifier: string): boolean {
  return /^\d+$/u.test(identifier) && (identifier === '0' || !identifier.startsWith('0'));
}

function isValidSemverIdentifiers(value: string, forbidNumericLeadingZero: boolean): boolean {
  if (value.length === 0) {
    return false;
  }
  return value.split('.').every(identifier => SEMVER_IDENTIFIER_PATTERN.test(identifier)
    && (!forbidNumericLeadingZero || !/^\d+$/u.test(identifier) || isValidNumericSemverIdentifier(identifier)));
}

function isValidSemver(version: string): boolean {
  const buildSeparator = version.indexOf('+');
  if (buildSeparator !== -1 && version.indexOf('+', buildSeparator + 1) !== -1) {
    return false;
  }
  const coreAndPrerelease = buildSeparator === -1 ? version : version.slice(0, buildSeparator);
  const build = buildSeparator === -1 ? null : version.slice(buildSeparator + 1);
  if (build !== null && !isValidSemverIdentifiers(build, false)) {
    return false;
  }

  const prereleaseSeparator = coreAndPrerelease.indexOf('-');
  const core = prereleaseSeparator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease = prereleaseSeparator === -1 ? null : coreAndPrerelease.slice(prereleaseSeparator + 1);
  const coreIdentifiers = core.split('.');
  return coreIdentifiers.length === 3
    && coreIdentifiers.every(isValidNumericSemverIdentifier)
    && (prerelease === null || isValidSemverIdentifiers(prerelease, true));
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

function readSourceExtensionIdentity(manifestBytes: Uint8Array): ExtensionIdentity {
  const identity = parseExtensionIdentity(manifestBytes, 'package.json');
  assertSafeExtensionIdentity(identity, 'package.json');
  return identity;
}

function assertPackagedExtensionIdentity(
  entries: readonly { path: string; bytes: Uint8Array }[],
  sourceIdentity: ExtensionIdentity,
): void {
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

function assertOuterVsixManifestIdentity(
  entries: readonly { path: string; bytes: Uint8Array }[],
  sourceIdentity: ExtensionIdentity,
): void {
  const outerManifestEntries = entries.filter(entry => entry.path === 'extension.vsixmanifest');
  if (outerManifestEntries.length !== 1) {
    throw new Error('VSIX must contain exactly one extension.vsixmanifest');
  }
  const outerIdentity = parseVsixManifestIdentity(
    outerManifestEntries[0].bytes,
    'extension.vsixmanifest',
  );
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

export function normalizeArtifactOutDir(outDir: string): string {
  if (outDir.length === 0
    || CONTROL_CHARACTER_PATTERN.test(outDir)
    || path.posix.isAbsolute(outDir)
    || path.win32.isAbsolute(outDir)
    || /^[A-Za-z]:/u.test(outDir)) {
    throw new Error('VSIX --out-dir must be a safe relative subdirectory of the repository');
  }
  const portablePath = outDir.replaceAll('\\', '/');
  if (portablePath.split('/').includes('..')) {
    throw new Error('VSIX --out-dir must be a safe relative subdirectory of the repository');
  }
  let normalized = path.posix.normalize(portablePath);
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new Error('VSIX --out-dir must be a safe relative subdirectory of the repository');
  }
  return normalized;
}

export function parseVerifyVsixArgs(argv: readonly string[]): VerifyVsixOptions {
  let outDir = DEFAULT_OUT_DIR;
  let requireCleanWorktree = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--require-clean-worktree') {
      requireCleanWorktree = true;
      continue;
    }
    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--out-dir requires a directory argument');
      }
      outDir = normalizeArtifactOutDir(value);
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { outDir, requireCleanWorktree };
}

/** `<sha256>  <archive path>`, ordered by path so the manifest is comparable across builds. */
function buildManifestLines(entries: readonly { path: string; bytes: Uint8Array }[]): string[] {
  return [...entries]
    .sort((left, right) => compareNormalizedPaths(left.path, right.path))
    .map(entry => `${sha256Hex(entry.bytes)}  ${entry.path}`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function collectArtifactCleanupFailures(
  io: VsixVerifierIo,
  artifactPaths: readonly string[],
): Promise<ArtifactCleanupFailure[]> {
  const failures: ArtifactCleanupFailure[] = [];
  for (const artifactPath of artifactPaths) {
    try {
      await io.removeFile(artifactPath);
    }
    catch (error) {
      failures.push({ path: artifactPath, error: toError(error) });
    }
  }
  return failures;
}

function artifactCleanupError(
  context: string,
  failures: readonly ArtifactCleanupFailure[],
  originalError?: unknown,
): AggregateError {
  const original = originalError === undefined ? null : toError(originalError);
  const cleanupDetails = failures.map(failure => `${failure.path}: ${failure.error.message}`).join('; ');
  const message = original === null
    ? `VSIX artifact cleanup failed ${context}: ${cleanupDetails}`
    : `${original.message}; VSIX artifact cleanup also failed ${context}: ${cleanupDetails}`;
  return new AggregateError(
    original === null ? failures.map(failure => failure.error) : [original, ...failures.map(failure => failure.error)],
    message,
  );
}

async function removeArtifactsOrThrow(
  io: VsixVerifierIo,
  artifactPaths: readonly string[],
  context: string,
): Promise<void> {
  const failures = await collectArtifactCleanupFailures(io, artifactPaths);
  if (failures.length > 0) {
    throw artifactCleanupError(context, failures);
  }
}

async function rethrowAfterArtifactCleanup(
  io: VsixVerifierIo,
  artifactPaths: readonly string[],
  originalError: unknown,
): Promise<never> {
  const failures = await collectArtifactCleanupFailures(io, artifactPaths);
  if (failures.length > 0) {
    throw artifactCleanupError('after verification failed', failures, originalError);
  }
  throw originalError;
}

function artifactLockReleaseError(
  lockPath: string,
  releaseError: unknown,
  outcome: LockedVerificationOutcome,
  cleanupFailures: readonly ArtifactCleanupFailure[],
): AggregateError {
  const release = toError(releaseError);
  const original = outcome.ok ? null : toError(outcome.error);
  const cleanupDetails = cleanupFailures.map(failure => `${failure.path}: ${failure.error.message}`).join('; ');
  const message = [
    original?.message,
    `VSIX artifact lock release failed for ${lockPath}: ${release.message}`,
    cleanupFailures.length === 0
      ? 'current VSIX artifacts were removed'
      : `VSIX artifact cleanup also failed: ${cleanupDetails}`,
  ].filter((part): part is string => part !== undefined).join('; ');
  return new AggregateError(
    [original, release, ...cleanupFailures.map(failure => failure.error)].filter(error => error !== null),
    message,
  );
}

async function verifyVsixPackageWhileLocked(
  io: VsixVerifierIo,
  options: VerifyVsixOptions,
  identity: ExtensionIdentity,
  vsixPath: string,
  manifestPath: string,
  digestPath: string,
  lockPath: string,
): Promise<VerifyVsixResult> {
  const artifactPaths = [vsixPath, manifestPath, digestPath];
  await removeArtifactsOrThrow(io, artifactPaths, 'before packaging');

  try {
    await io.packageExtension(vsixPath);

    const archiveBytes = await io.readBinaryFile(vsixPath);
    const entries = readVsixArchive(archiveBytes);
    assertPackagedExtensionIdentity(entries, identity);
    assertOuterVsixManifestIdentity(entries, identity);
    const packagePaths = entries
      .filter(entry => entry.path.startsWith(VSIX_EXTENSION_PREFIX))
      .map(entry => entry.path.slice(VSIX_EXTENSION_PREFIX.length));

    const untrackedWorktreePaths = options.requireCleanWorktree
      ? (await io.listUntrackedFiles()).filter(worktreePath => worktreePath !== lockPath)
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

    const digest = sha256Hex(archiveBytes);
    const manifestLines = buildManifestLines(entries);
    const artifactsWritten = report.violations.length === 0;
    if (artifactsWritten) {
      await io.writeTextFile(manifestPath, `${manifestLines.join('\n')}\n`);
      await io.writeTextFile(digestPath, `${digest}  ${path.posix.basename(vsixPath)}\n`);
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
  const manifestPath = `${vsixPath}.manifest.txt`;
  const digestPath = `${vsixPath}.sha256`;
  const artifactPaths = [vsixPath, manifestPath, digestPath];
  const lockPath = `${vsixPath}.lock`;

  await io.prepareArtifactDirectory(outDir);
  const lock = await io.acquireArtifactLock(lockPath);

  let outcome: LockedVerificationOutcome;
  try {
    const result = await verifyVsixPackageWhileLocked(
      io,
      options,
      identity,
      vsixPath,
      manifestPath,
      digestPath,
      lockPath,
    );
    outcome = { ok: true, result };
  }
  catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await lock.release();
  }
  catch (releaseError) {
    const cleanupFailures = await collectArtifactCleanupFailures(io, artifactPaths);
    throw artifactLockReleaseError(lockPath, releaseError, outcome, cleanupFailures);
  }

  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.result;
}

function formatViolation(violation: PolicyViolation): string {
  return `  [${violation.kind}] ${violation.path} — ${violation.detail}`;
}

/**
 * Writes every diagnostic to stderr and the normalized source-path manifest to
 * stdout — but only once the package has been accepted.
 *
 * The ordering is load-bearing, not cosmetic. A consumer that pipes this
 * command and greps the manifest for the entrypoint takes its exit status from
 * the grep, not from this process. Emitting the manifest before the verdict
 * would therefore let a rejected package — one this very run deletes from disk
 * — still answer "out/extension.cjs is present" to that consumer. Stdout means
 * "verified"; a rejection leaves it empty.
 */
export async function runVerifyVsixCli(
  argv: readonly string[],
  deps: VerifyVsixCliDependencies,
): Promise<number> {
  let options: VerifyVsixOptions;
  try {
    options = parseVerifyVsixArgs(argv);
  }
  catch (error) {
    deps.writeError(`VSIX verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let result: VerifyVsixResult;
  try {
    result = await verifyVsixPackage(deps.io, options);
  }
  catch (error) {
    deps.writeError(`VSIX verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // Warnings are reported before the verdict branches: a rejected package is
  // the run where diagnostics matter most, and stderr never feeds the manifest
  // stream, so this cannot weaken the stdout contract above.
  for (const warning of result.report.warnings) {
    deps.writeError(`VSIX warning: ${warning}`);
  }

  if (result.report.violations.length > 0) {
    deps.writeError(`VSIX policy rejected ${result.report.violations.length} finding(s):`);
    for (const violation of result.report.violations) {
      deps.writeError(formatViolation(violation));
    }
    deps.writeError(
      `Rejected VSIX artifacts removed: ${result.vsixPath}, ${result.manifestPath}, ${result.digestPath}`,
    );
    return 1;
  }

  for (const sourcePath of result.report.sourcePaths) {
    deps.writeOut(sourcePath);
  }

  deps.writeError(
    `VSIX verified: ${result.report.packagedFileCount}/${PACKAGED_FILE_COUNT_BUDGET} files, `
    + `${result.compressedBytes}/${COMPRESSED_SIZE_BUDGET_BYTES} compressed bytes, `
    + `${result.report.bundleClosure.length} bundle files reachable from the entrypoint.`,
  );
  deps.writeError(`  package:  ${result.vsixPath}`);
  deps.writeError(`  manifest: ${result.manifestPath}`);
  deps.writeError(`  sha256:   ${result.digest}`);
  return 0;
}