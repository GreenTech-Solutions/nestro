import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runVerifyVsixCli, VSCE_BIN_RELATIVE_PATH } from './verifyVsix';
import type { VerifyVsixCliDependencies, VsixVerifierIo } from './verifyVsix';

/**
 * Node bindings for the VSIX verifier. Everything that touches the process or
 * the file system lives here; the policy and the orchestration are pure and
 * injectable so they can be exercised without packaging anything.
 */

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

function describeChildFailure(command: string, error: unknown): Error {
  const details = error as { stdout?: string; stderr?: string; message?: string };
  const output = [details.stdout, details.stderr].filter(part => !!part).join('\n').trim();
  const reason = details.message ?? String(error);
  return new Error(output.length > 0 ? `${command} failed: ${reason}\n${output}` : `${command} failed: ${reason}`);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function isPathContained(repositoryPath: string, candidatePath: string): boolean {
  const relative = path.relative(repositoryPath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

interface ExistingArtifactAncestor {
  readonly lexicalPath: string;
  readonly realPath: string;
}

async function resolveExistingAncestor(candidatePath: string): Promise<ExistingArtifactAncestor> {
  let current = candidatePath;
  while (true) {
    try {
      return { lexicalPath: current, realPath: await realpath(current) };
    }
    catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function assertArtifactDirectoryContained(
  repositoryPath: string,
  candidatePath: string,
  dirPath: string,
  allowRepositoryRoot: boolean,
): void {
  if (!isPathContained(repositoryPath, candidatePath)) {
    throw new Error(`VSIX output directory ${dirPath} resolves outside the repository`);
  }
  if (!allowRepositoryRoot && path.relative(repositoryPath, candidatePath) === '') {
    throw new Error(`VSIX output directory ${dirPath} must resolve to a proper subdirectory of the repository`);
  }
}

function assertArtifactDirectoryNotAliased(
  lexicalRepositoryPath: string,
  canonicalRepositoryPath: string,
  lexicalCandidatePath: string,
  canonicalCandidatePath: string,
  dirPath: string,
): void {
  const expectedCanonicalPath = path.resolve(
    canonicalRepositoryPath,
    path.relative(lexicalRepositoryPath, lexicalCandidatePath),
  );
  if (path.relative(expectedCanonicalPath, canonicalCandidatePath) !== '') {
    throw new Error(`VSIX output directory ${dirPath} must not resolve through a symlink alias below the repository`);
  }
}

/**
 * Parses `git status --porcelain -z --untracked-files=no` into tracked paths that differ from
 * HEAD. Untracked entries (`??`) are skipped — collected separately by `listUntrackedFiles()` —
 * and a rename/copy record's extra NUL-separated source-path field is consumed and ignored.
 */
export function parseGitStatusPaths(stdout: string): string[] {
  const fields = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    if (status !== '??') {
      paths.push(field.slice(3));
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      index++;
    }
  }
  return paths;
}

export function createNodeVsixVerifierIo(cwd: string): VsixVerifierIo {
  const resolve = (relativePath: string): string => path.resolve(cwd, relativePath);

  return {
    async packageExtension(vsixPath: string): Promise<void> {
      const vsceBin = resolve(VSCE_BIN_RELATIVE_PATH);
      try {
        await execFileAsync(
          process.execPath,
          [vsceBin, 'package', '--no-dependencies', '--out', vsixPath],
          { cwd, maxBuffer: MAX_CHILD_OUTPUT_BYTES },
        );
      }
      catch (error) {
        throw describeChildFailure('vsce package', error);
      }
    },

    readBinaryFile(filePath: string): Promise<Uint8Array> {
      return readFile(resolve(filePath));
    },

    async writeTextFile(filePath: string, contents: string): Promise<void> {
      await writeFile(resolve(filePath), contents, 'utf8');
    },

    async removeFile(filePath: string): Promise<void> {
      await rm(resolve(filePath), { force: true });
    },

    async prepareArtifactDirectory(dirPath: string): Promise<void> {
      const lexicalRepositoryPath = path.resolve(cwd);
      const repositoryPath = await realpath(cwd);
      const requestedPath = resolve(dirPath);
      const existingAncestor = await resolveExistingAncestor(requestedPath);
      assertArtifactDirectoryContained(
        repositoryPath,
        existingAncestor.realPath,
        dirPath,
        existingAncestor.lexicalPath !== requestedPath,
      );
      assertArtifactDirectoryNotAliased(
        lexicalRepositoryPath,
        repositoryPath,
        existingAncestor.lexicalPath,
        existingAncestor.realPath,
        dirPath,
      );
      await mkdir(requestedPath, { recursive: true });
      const preparedPath = await realpath(requestedPath);
      assertArtifactDirectoryContained(repositoryPath, preparedPath, dirPath, false);
      assertArtifactDirectoryNotAliased(
        lexicalRepositoryPath,
        repositoryPath,
        requestedPath,
        preparedPath,
        dirPath,
      );
    },

    async acquireArtifactLock(lockPath: string) {
      const resolvedLockPath = resolve(lockPath);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(resolvedLockPath, 'wx');
      }
      catch (error) {
        if (isErrno(error, 'EEXIST')) {
          throw new Error(
            `VSIX artifact lock already exists: ${lockPath}; another verifier may be active. `
            + 'If the lock is stale, remove it manually only after confirming no verifier is running.',
            { cause: error },
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to acquire VSIX artifact lock ${lockPath}: ${reason}`, { cause: error });
      }

      return {
        release: async (): Promise<void> => {
          try {
            await handle.close();
          }
          catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to close VSIX artifact lock ${lockPath}: ${reason}`, { cause: error });
          }
          try {
            await unlink(resolvedLockPath);
          }
          catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Failed to remove VSIX artifact lock ${lockPath}: ${reason}; remove the stale lock manually`,
              { cause: error },
            );
          }
        },
      };
    },

    async listTrackedFiles(): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
          cwd,
          maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        });
        return stdout.split('\0').filter(entry => entry.length > 0);
      }
      catch (error) {
        throw describeChildFailure('git ls-files', error);
      }
    },

    async listModifiedTrackedFiles(): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=no'], {
          cwd,
          maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        });
        return parseGitStatusPaths(stdout);
      }
      catch (error) {
        throw describeChildFailure('git status', error);
      }
    },

    async listUntrackedFiles(): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd,
          maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        });
        return stdout.split('\0').filter(entry => entry.length > 0);
      }
      catch (error) {
        throw describeChildFailure('git ls-files --others', error);
      }
    },

    async listSymlinkPaths(candidatePaths: readonly string[]): Promise<string[]> {
      const symlinks: string[] = [];
      for (const candidate of candidatePaths) {
        try {
          const stats = await lstat(resolve(candidate));
          if (stats.isSymbolicLink()) {
            symlinks.push(candidate);
          }
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            // A candidate that does not exist cannot be a symlink; missing
            // required files are reported by the policy, not here.
            continue;
          }
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`lstat ${candidate} failed: ${reason}`, { cause: error });
        }
      }
      return symlinks;
    },
  };
}

/** The part of a writable stream this CLI needs; keeps the writer testable. */
export interface LineWritableStream {
  write(chunk: string): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function isBrokenPipe(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE';
}

/**
 * Wraps a stream in a line writer that tolerates the consumer hanging up: a piped consumer
 * (e.g. `grep -Fxq`) that exits early closes the pipe mid-write, and Node's EPIPE error would
 * otherwise crash the process. EPIPE is swallowed; every other write error still surfaces.
 */
export function createStreamLineWriter(stream: LineWritableStream): (line: string) => void {
  stream.on('error', (error: Error) => {
    if (!isBrokenPipe(error)) {
      throw error;
    }
  });
  return (line: string): void => {
    try {
      stream.write(`${line}\n`);
    }
    catch (error) {
      if (!isBrokenPipe(error)) {
        throw error;
      }
    }
  };
}

export function createNodeCliDependencies(cwd: string): VerifyVsixCliDependencies {
  return {
    io: createNodeVsixVerifierIo(cwd),
    writeOut: createStreamLineWriter(process.stdout),
    writeError: createStreamLineWriter(process.stderr),
  };
}

export function main(argv: readonly string[], cwd: string): Promise<number> {
  return runVerifyVsixCli(argv, createNodeCliDependencies(cwd));
}

/* v8 ignore start -- process bootstrap: only reachable when node runs this file directly */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2), process.cwd()).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */