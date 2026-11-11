import { describeError } from '../shared';

/** The one file-system operation artifact cleanup needs. */
export interface ArtifactRemover {
  removeFile(filePath: string): Promise<void>;
}

export interface ArtifactCleanupFailure {
  readonly path: string;
  readonly error: Error;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describeError(error));
}

export async function collectArtifactCleanupFailures(
  io: ArtifactRemover,
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

export async function removeArtifactsOrThrow(
  io: ArtifactRemover,
  artifactPaths: readonly string[],
  context: string,
): Promise<void> {
  const failures = await collectArtifactCleanupFailures(io, artifactPaths);
  if (failures.length > 0) {
    throw artifactCleanupError(context, failures);
  }
}

export async function rethrowAfterArtifactCleanup(
  io: ArtifactRemover,
  artifactPaths: readonly string[],
  originalError: unknown,
): Promise<never> {
  const failures = await collectArtifactCleanupFailures(io, artifactPaths);
  if (failures.length > 0) {
    throw artifactCleanupError('after verification failed', failures, originalError);
  }
  throw originalError;
}

/** Builds the error for a failed lock release, folding in the verification error and cleanup failures. */
export function artifactLockReleaseError(
  lockPath: string,
  releaseError: unknown,
  outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown },
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