import * as path from 'node:path';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { prepareArtifactDirectory } from './artifactDirectory';
import { acquireArtifactLock } from './artifactLock';
import { runChildProcess } from './childProcess';
import { listModifiedTrackedFiles, listTrackedFiles, listUntrackedFiles } from './gitWorktree';
import type { VsixVerifierIo } from './verifyVsix';
import { describeError, hasErrorCode } from '../shared';

/** Relative path of the vsce CLI script; both npm and pnpm materialise it here. */
export const VSCE_BIN_RELATIVE_PATH = 'node_modules/@vscode/vsce/vsce';

async function findSymlinks(resolve: (relativePath: string) => string, candidatePaths: readonly string[]): Promise<string[]> {
  const symlinks: string[] = [];
  for (const candidate of candidatePaths) {
    try {
      const stats = await lstat(resolve(candidate));
      if (stats.isSymbolicLink()) {
        symlinks.push(candidate);
      }
    }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        // A candidate that does not exist cannot be a symlink; missing
        // required files are reported by the policy, not here.
        continue;
      }
      throw new Error(`lstat ${candidate} failed: ${describeError(error)}`, { cause: error });
    }
  }
  return symlinks;
}

/** Node bindings for the verifier: vsce, git and the file system, rooted at `cwd`. */
export function createNodeVsixVerifierIo(cwd: string): VsixVerifierIo {
  const resolve = (relativePath: string): string => path.resolve(cwd, relativePath);

  return {
    async packageExtension(vsixPath: string): Promise<void> {
      await runChildProcess(
        process.execPath,
        [resolve(VSCE_BIN_RELATIVE_PATH), 'package', '--no-dependencies', '--out', vsixPath],
        cwd,
        'vsce package',
      );
    },
    readBinaryFile: (filePath: string): Promise<Uint8Array> => readFile(resolve(filePath)),
    writeTextFile: (filePath: string, contents: string): Promise<void> => writeFile(resolve(filePath), contents, 'utf8'),
    removeFile: (filePath: string): Promise<void> => rm(resolve(filePath), { force: true }),
    prepareArtifactDirectory: (dirPath: string): Promise<void> => prepareArtifactDirectory(cwd, dirPath),
    acquireArtifactLock: (lockPath: string) => acquireArtifactLock(resolve(lockPath), lockPath),
    listTrackedFiles: () => listTrackedFiles(cwd),
    listModifiedTrackedFiles: () => listModifiedTrackedFiles(cwd),
    listUntrackedFiles: () => listUntrackedFiles(cwd),
    listSymlinkPaths: (candidatePaths: readonly string[]): Promise<string[]> => findSymlinks(resolve, candidatePaths),
  };
}