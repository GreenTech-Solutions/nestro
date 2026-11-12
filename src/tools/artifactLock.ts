import { open, unlink } from 'node:fs/promises';
import { describeError, hasErrorCode } from '../shared';

export interface VsixArtifactLock {
  release(): Promise<void>;
}

async function releaseArtifactLock(
  handle: Awaited<ReturnType<typeof open>>,
  resolvedLockPath: string,
  lockPath: string,
): Promise<void> {
  try {
    await handle.close();
  }
  catch (error) {
    throw new Error(`Failed to close VSIX artifact lock ${lockPath}: ${describeError(error)}`, { cause: error });
  }
  try {
    await unlink(resolvedLockPath);
  }
  catch (error) {
    throw new Error(
      `Failed to remove VSIX artifact lock ${lockPath}: ${describeError(error)}; remove the stale lock manually`,
      { cause: error },
    );
  }
}

/** Creates the lock file exclusively; fails rather than breaking a lock another verifier may hold. */
export async function acquireArtifactLock(resolvedLockPath: string, lockPath: string): Promise<VsixArtifactLock> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolvedLockPath, 'wx');
  }
  catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(
        `VSIX artifact lock already exists: ${lockPath}; another verifier may be active. `
        + 'If the lock is stale, remove it manually only after confirming no verifier is running.',
        { cause: error },
      );
    }
    throw new Error(`Failed to acquire VSIX artifact lock ${lockPath}: ${describeError(error)}`, { cause: error });
  }
  return { release: () => releaseArtifactLock(handle, resolvedLockPath, lockPath) };
}