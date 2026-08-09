import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCleanVsixFixture, CLEAN_PACKAGE_MANIFEST, CLEAN_TRACKED_SOURCE_PATHS, toBytes } from './fixtures';

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));
const fsMock = vi.hoisted(() => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = (): never => {
    throw new Error('the callback form of execFile is not used');
  };
  return { execFile: Object.assign(execFile, { [promisify.custom]: execFileAsyncMock }) };
});

vi.mock('node:fs/promises', () => fsMock);

const {
  createNodeCliDependencies,
  createNodeVsixVerifierIo,
  createStreamLineWriter,
  main,
  parseGitStatusPaths,
} = await import('../tools');

const CWD = '/repo';

function childFailure(message: string, output: { stdout?: string; stderr?: string } = {}): Error {
  return Object.assign(new Error(message), output);
}

function mockSafeArtifactFilesystem(): void {
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(candidate));
  fsMock.open.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  fsMock.unlink.mockResolvedValue(undefined);
}

describe('createNodeVsixVerifierIo()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeArtifactFilesystem();
  });

  it('runs the repository-local vsce CLI through the current node binary', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    await createNodeVsixVerifierIo(CWD).packageExtension('dist/nestro-0.4.2.vsix');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies', '--out', 'dist/nestro-0.4.2.vsix'],
      expect.objectContaining({ cwd: CWD }),
    );
  });

  it.each([
    ['includes the captured child output', { stdout: 'ERROR  secret found', stderr: '' }, 'ERROR  secret found'],
    ['falls back to the raw reason', {}, 'vsce package failed: exit 1'],
  ])('reports a failed package and %s', async (_label, output, expected) => {
    execFileAsyncMock.mockRejectedValue(childFailure('exit 1', output));

    await expect(createNodeVsixVerifierIo(CWD).packageExtension('dist/x.vsix')).rejects.toThrow(expected);
  });

  it('reads and writes files relative to the repository root', async () => {
    fsMock.readFile.mockResolvedValue(toBytes('{}'));
    const io = createNodeVsixVerifierIo(CWD);

    await io.readBinaryFile('package.json');
    await io.writeTextFile('dist/manifest.txt', 'line\n');
    await io.removeFile('dist/rejected.vsix');

    expect(fsMock.readFile).toHaveBeenCalledWith('/repo/package.json');
    expect(fsMock.writeFile).toHaveBeenCalledWith('/repo/dist/manifest.txt', 'line\n', 'utf8');
    expect(fsMock.rm).toHaveBeenCalledWith('/repo/dist/rejected.vsix', { force: true });
  });

  it('prepares a nested artifact directory only after proving realpath containment', async () => {
    await createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('build/verified');

    expect(fsMock.realpath).toHaveBeenCalledWith('/repo');
    expect(fsMock.realpath).toHaveBeenCalledWith('/repo/build/verified');
    expect(fsMock.mkdir).toHaveBeenCalledWith('/repo/build/verified', { recursive: true });
  });

  it('rejects an existing output symlink that resolves outside the repository before mkdir', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(
      candidate === '/repo/dist' ? '/outside/dist' : candidate,
    ));

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('dist'))
      .rejects.toThrow('resolves outside the repository');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('rejects an existing output symlink that resolves to the repository root before mkdir', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(
      candidate === '/repo/dist' ? '/repo' : candidate,
    ));

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('dist'))
      .rejects.toThrow('must resolve to a proper subdirectory');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('rejects an existing output symlink alias within the repository before mkdir', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(
      candidate === '/repo/artifact-link' ? '/repo/build/actual' : candidate,
    ));

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('artifact-link'))
      .rejects.toThrow('must not resolve through a symlink alias');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('allows a symlinked cwd while proving the output against the canonical repository path', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(
      candidate === '/repo-link'
        ? '/real/repo'
        : candidate.replace('/repo-link/', '/real/repo/'),
    ));

    await expect(createNodeVsixVerifierIo('/repo-link').prepareArtifactDirectory('build/verified'))
      .resolves.toBeUndefined();
    expect(fsMock.mkdir).toHaveBeenCalledWith('/repo-link/build/verified', { recursive: true });
  });

  it('allows a missing child whose deepest existing ancestor is the repository root', async () => {
    let requestedReads = 0;
    fsMock.realpath.mockImplementation((candidate: string) => {
      if (candidate === '/repo/build/verified') {
        requestedReads++;
        return requestedReads === 1
          ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
          : Promise.resolve(candidate);
      }
      if (candidate === '/repo/build') {
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      }
      return Promise.resolve(candidate);
    });

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('build/verified'))
      .resolves.toBeUndefined();
    expect(fsMock.mkdir).toHaveBeenCalledWith('/repo/build/verified', { recursive: true });
  });

  it('rejects a missing nested output whose existing symlink ancestor resolves outside', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => {
      if (candidate === '/repo/build/verified') {
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      }
      return Promise.resolve(candidate === '/repo/build' ? '/outside/build' : candidate);
    });

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('build/verified'))
      .rejects.toThrow('resolves outside the repository');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('rejects a missing nested output whose existing ancestor is an in-repository symlink alias', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => {
      if (candidate === '/repo/artifact-link/verified') {
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      }
      return Promise.resolve(candidate === '/repo/artifact-link' ? '/repo/build/actual' : candidate);
    });

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('artifact-link/verified'))
      .rejects.toThrow('must not resolve through a symlink alias');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('fails closed when an output ancestor cannot be resolved for a non-ENOENT reason', async () => {
    fsMock.realpath.mockImplementation((candidate: string) => candidate === '/repo'
      ? Promise.resolve(candidate)
      : Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })));

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('build/verified'))
      .rejects.toThrow('permission denied');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('fails closed if every lexical ancestor disappears during containment resolution', async () => {
    let repositoryReads = 0;
    fsMock.realpath.mockImplementation((candidate: string) => {
      if (candidate === '/repo' && repositoryReads++ === 0) {
        return Promise.resolve(candidate);
      }
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    });

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('build/verified'))
      .rejects.toThrow('missing');
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('rechecks containment after creating a previously missing nested output directory', async () => {
    let requestedReads = 0;
    fsMock.realpath.mockImplementation((candidate: string) => {
      if (candidate === '/repo/build/verified') {
        requestedReads++;
        return requestedReads === 1
          ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
          : Promise.resolve('/outside/verified');
      }
      return Promise.resolve(candidate === '/repo/build' ? '/repo/build' : '/repo');
    });

    await expect(createNodeVsixVerifierIo(CWD).prepareArtifactDirectory('build/verified'))
      .rejects.toThrow('resolves outside the repository');
    expect(fsMock.mkdir).toHaveBeenCalledWith('/repo/build/verified', { recursive: true });
  });

  it('acquires an exclusive lock and releases it by closing before unlinking', async () => {
    const calls: string[] = [];
    const close = vi.fn().mockImplementation(() => {
      calls.push('close');
      return Promise.resolve();
    });
    fsMock.open.mockResolvedValue({ close });
    fsMock.unlink.mockImplementation(() => {
      calls.push('unlink');
      return Promise.resolve();
    });

    const lock = await createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock');
    await lock.release();

    expect(fsMock.open).toHaveBeenCalledWith('/repo/dist/nestro-1.0.0.vsix.lock', 'wx');
    expect(calls).toEqual(['close', 'unlink']);
    expect(fsMock.unlink).toHaveBeenCalledWith('/repo/dist/nestro-1.0.0.vsix.lock');
  });

  it('fails fast on an existing lock and never removes it automatically', async () => {
    fsMock.open.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));

    await expect(createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock'))
      .rejects.toThrow(/another verifier may be active.*remove.*manually/i);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('permission denied'), 'permission denied'],
    ['lock device failed', 'lock device failed'],
  ])('describes a non-EEXIST lock acquisition failure %#', async (failure, message) => {
    fsMock.open.mockRejectedValue(failure);

    await expect(createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock'))
      .rejects.toThrow(`Failed to acquire VSIX artifact lock dist/nestro-1.0.0.vsix.lock: ${message}`);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('does not unlink a lock when closing its active handle fails', async () => {
    fsMock.open.mockResolvedValue({ close: vi.fn().mockRejectedValue(new Error('close failed')) });
    const lock = await createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock');

    await expect(lock.release()).rejects.toThrow('close failed');
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('describes a non-Error lock close failure without unlinking the active lock', async () => {
    fsMock.open.mockResolvedValue({ close: vi.fn().mockRejectedValue('close device failed') });
    const lock = await createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock');

    await expect(lock.release()).rejects.toThrow('close device failed');
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('surfaces lock unlink failure so a successful run cannot be reported', async () => {
    fsMock.unlink.mockRejectedValue(new Error('unlink failed'));
    const lock = await createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock');

    await expect(lock.release()).rejects.toThrow('unlink failed');
  });

  it('describes a non-Error lock unlink failure', async () => {
    fsMock.unlink.mockRejectedValue('unlink device failed');
    const lock = await createNodeVsixVerifierIo(CWD).acquireArtifactLock('dist/nestro-1.0.0.vsix.lock');

    await expect(lock.release()).rejects.toThrow('unlink device failed');
  });

  it('lists tracked files from NUL-separated git output', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'README.md\0package.json\0', stderr: '' });

    await expect(createNodeVsixVerifierIo(CWD).listTrackedFiles()).resolves.toEqual(['README.md', 'package.json']);
    expect(execFileAsyncMock).toHaveBeenCalledWith('git', ['ls-files', '-z'], expect.objectContaining({ cwd: CWD }));
  });

  it('lists tracked files that differ from HEAD and skips untracked entries', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: ' M README.md\0?? scratch.txt\0M  package.json\0', stderr: '' });

    await expect(createNodeVsixVerifierIo(CWD).listModifiedTrackedFiles())
      .resolves.toEqual(['README.md', 'package.json']);
    expect(execFileAsyncMock)
      .toHaveBeenCalledWith(
        'git',
        ['status', '--porcelain', '-z', '--untracked-files=no'],
        expect.objectContaining({ cwd: CWD }),
      );
  });

  it('lists untracked files without including ignored paths', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'src/generatedBuildInput.ts\0notes.txt\0', stderr: '' });

    await expect(createNodeVsixVerifierIo(CWD).listUntrackedFiles())
      .resolves.toEqual(['src/generatedBuildInput.ts', 'notes.txt']);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      expect.objectContaining({ cwd: CWD }),
    );
  });

  it('fails closed when git cannot report the working tree state', async () => {
    execFileAsyncMock.mockRejectedValue(childFailure('not a git repository'));

    await expect(createNodeVsixVerifierIo(CWD).listModifiedTrackedFiles())
      .rejects.toThrow('git status failed: not a git repository');
  });

  it('fails closed when git cannot list tracked files', async () => {
    execFileAsyncMock.mockRejectedValue(childFailure('not a git repository'));

    await expect(createNodeVsixVerifierIo(CWD).listTrackedFiles())
      .rejects.toThrow('git ls-files failed: not a git repository');
  });

  it('describes a non-Error git failure without losing its reason', async () => {
    execFileAsyncMock.mockRejectedValue('spawn failed');

    await expect(createNodeVsixVerifierIo(CWD).listTrackedFiles())
      .rejects.toThrow('git ls-files failed: spawn failed');
  });

  it('fails closed when git cannot list untracked files', async () => {
    execFileAsyncMock.mockRejectedValue(childFailure('not a git repository'));

    await expect(createNodeVsixVerifierIo(CWD).listUntrackedFiles())
      .rejects.toThrow('git ls-files --others failed: not a git repository');
  });

  it('returns only the candidates that are symlinks and ignores missing paths', async () => {
    fsMock.lstat.mockImplementation((candidate: string) => candidate === '/repo/absent'
      ? Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
      : Promise.resolve({ isSymbolicLink: (): boolean => candidate === '/repo/images' }));

    await expect(createNodeVsixVerifierIo(CWD).listSymlinkPaths(['images', 'images/a.png', 'absent']))
      .resolves.toEqual(['images']);
  });

  it('fails closed when a symlink candidate cannot be inspected', async () => {
    fsMock.lstat.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(createNodeVsixVerifierIo(CWD).listSymlinkPaths(['images']))
      .rejects.toThrow('lstat images failed: permission denied');
  });

  it('describes a non-Error symlink inspection failure', async () => {
    fsMock.lstat.mockRejectedValue('device failure');

    await expect(createNodeVsixVerifierIo(CWD).listSymlinkPaths(['images']))
      .rejects.toThrow('lstat images failed: device failure');
  });
});

describe('parseGitStatusPaths()', () => {
  it.each([
    ['an unmodified worktree', '', []],
    ['a rename, consuming the source path field', 'R  new.md\0old.md\0', ['new.md']],
    ['a copy, consuming the source path field', 'C  copy.md\0origin.md\0', ['copy.md']],
    ['a staged and an unstaged change', 'MM a.md\0 D b.md\0', ['a.md', 'b.md']],
    ['a trailing empty field', ' M a.md\0', ['a.md']],
    ['untracked entries only', '?? junk.txt\0', []],
  ])('reads %s', (_label, stdout, expected) => {
    expect(parseGitStatusPaths(stdout)).toEqual(expected);
  });
});

describe('createStreamLineWriter()', () => {
  interface FakeStream {
    write: (chunk: string) => boolean;
    on: (event: 'error', listener: (error: Error) => void) => unknown;
    emit: (error: NodeJS.ErrnoException) => void;
  }

  function fakeStream(write: (chunk: string) => boolean): FakeStream {
    const listeners: ((error: Error) => void)[] = [];
    return {
      write,
      on: (_event, listener): unknown => {
        listeners.push(listener);
        return undefined;
      },
      emit: (error): void => listeners.forEach(listener => listener(error)),
    };
  }

  function epipe(): NodeJS.ErrnoException {
    return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  }

  it('appends a newline to every line it writes', () => {
    const written: string[] = [];
    const stream = fakeStream((chunk) => {
      written.push(chunk);
      return true;
    });

    createStreamLineWriter(stream)('out/extension.cjs');

    expect(written).toEqual(['out/extension.cjs\n']);
  });

  it('swallows the asynchronous EPIPE a consumer causes by closing the pipe early', () => {
    const stream = fakeStream(() => true);
    createStreamLineWriter(stream);

    expect(() => stream.emit(epipe())).not.toThrow();
  });

  it('swallows a synchronous EPIPE thrown by the write itself', () => {
    const stream = fakeStream(() => {
      throw epipe();
    });
    const writeLine = createStreamLineWriter(stream);

    expect(() => writeLine('out/extension.cjs')).not.toThrow();
  });

  it.each([
    ['an asynchronous error that is not EPIPE', 'ENOSPC'],
    ['an asynchronous error with no code at all', undefined],
  ])('still surfaces %s', (_label, code) => {
    const stream = fakeStream(() => true);
    createStreamLineWriter(stream);
    const error = Object.assign(new Error('disk full'), code === undefined ? {} : { code });

    expect(() => stream.emit(error)).toThrow('disk full');
  });

  it('still surfaces a synchronous write error that is not EPIPE', () => {
    const stream = fakeStream(() => {
      throw new Error('stream destroyed');
    });
    const writeLine = createStreamLineWriter(stream);

    expect(() => writeLine('x')).toThrow('stream destroyed');
  });
});

describe('createNodeCliDependencies()', () => {
  it('writes stdout and stderr lines with a trailing newline and tolerates a closed pipe', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const deps = createNodeCliDependencies(CWD);
    deps.writeOut('out/extension.cjs');
    deps.writeError('VSIX verified');

    expect(stdout).toHaveBeenCalledWith('out/extension.cjs\n');
    expect(stderr).toHaveBeenCalledWith('VSIX verified\n');
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe('main()', () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeArtifactFilesystem();
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('verifies a clean package end to end through the node bindings', async () => {
    fsMock.readFile.mockImplementation((filePath: string) =>
      Promise.resolve(filePath.endsWith('.vsix') ? buildCleanVsixFixture() : toBytes(CLEAN_PACKAGE_MANIFEST)));
    fsMock.lstat.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
    execFileAsyncMock.mockImplementation((file: string, args: readonly string[]) => Promise.resolve(
      file === 'git' && args[0] === 'ls-files'
        ? { stdout: `${CLEAN_TRACKED_SOURCE_PATHS.join('\0')}\0`, stderr: '' }
        : { stdout: '', stderr: '' },
    ));

    await expect(main([], CWD)).resolves.toBe(0);

    expect(fsMock.mkdir).toHaveBeenCalledWith('/repo/dist', { recursive: true });
    expect(stdout).toHaveBeenCalledWith('out/extension.cjs\n');
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      '/repo/dist/nestro-9.9.9.vsix.sha256',
      expect.stringContaining('  nestro-9.9.9.vsix\n'),
      'utf8',
    );
  });

  it.each([
    ['outside the repository', '/outside/dist', 'resolves outside the repository'],
    ['to the repository root', '/repo', 'must resolve to a proper subdirectory'],
    ['to an in-repository alias', '/repo/build/actual', 'must not resolve through a symlink alias'],
  ])('rejects an output symlink %s before remove, lock, or package', async (_label, resolvedPath, message) => {
    fsMock.readFile.mockResolvedValue(toBytes(CLEAN_PACKAGE_MANIFEST));
    fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(
      candidate === '/repo/dist' ? resolvedPath : candidate,
    ));

    await expect(main([], CWD)).resolves.toBe(1);

    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.rm).not.toHaveBeenCalled();
    expect(fsMock.open).not.toHaveBeenCalled();
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(message));
  });
});