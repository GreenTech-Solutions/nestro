import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = (): never => {
    throw new Error('the callback form of execFile is not used');
  };
  return { execFile: Object.assign(execFile, { [promisify.custom]: execFileAsyncMock }) };
});

const {
  createNodeSignatureAuditCliDependencies,
  createNodeSignatureAuditRunner,
  mainSignatureAudit,
} = await import('../tools');

const CWD = '/repo';
const VERIFIED_REPORT = '{"audited":846,"invalid":[],"missing":[],"verified":846}';

function childFailure(properties: Record<string, unknown>): Error {
  return Object.assign(new Error('Command failed'), properties);
}

describe('createNodeSignatureAuditRunner()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs pnpm audit signatures --json in the repository root', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: VERIFIED_REPORT, stderr: '[WARN] ignored field' });

    const result = await createNodeSignatureAuditRunner(CWD, 'darwin')();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['audit', 'signatures', '--json'],
      expect.objectContaining({ cwd: CWD }),
    );
    expect(result).toStrictEqual({
      command: 'pnpm audit signatures --json',
      stdout: VERIFIED_REPORT,
      stderr: '[WARN] ignored field',
      exitCode: 0,
    });
  });

  it('uses the Windows launcher shim, which execFile cannot start without its extension', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: VERIFIED_REPORT, stderr: '' });

    const result = await createNodeSignatureAuditRunner(CWD, 'win32')();

    expect(execFileAsyncMock).toHaveBeenCalledWith('pnpm.cmd', expect.anything(), expect.anything());
    expect(result.command).toBe('pnpm.cmd audit signatures --json');
  });

  it.each([
    [
      'a failed audit, so the evaluator decides what its output means',
      childFailure({ code: 1, stdout: '{"audited":1,"invalid":[{}],"missing":[],"verified":0}', stderr: 'ELIFECYCLE' }),
      { stdout: '{"audited":1,"invalid":[{}],"missing":[],"verified":0}', stderr: 'ELIFECYCLE', exitCode: 1 },
    ],
    [
      'a failed audit that wrote nothing',
      childFailure({ code: 1 }),
      { stdout: '', stderr: '', exitCode: 1 },
    ],
    [
      'a spawn failure, which leaves the exit code undefined',
      childFailure({ code: 'ENOENT' }),
      { stdout: '', stderr: 'pnpm could not run: Command failed', exitCode: undefined },
    ],
  ])('reports %s', async (_label, error, expected) => {
    execFileAsyncMock.mockRejectedValue(error);

    const result = await createNodeSignatureAuditRunner(CWD, 'darwin')();

    expect(result).toStrictEqual({ command: 'pnpm audit signatures --json', ...expected });
  });

  it('describes a non-Error spawn failure without losing it', async () => {
    execFileAsyncMock.mockRejectedValue('pnpm vanished');

    const result = await createNodeSignatureAuditRunner(CWD, 'darwin')();

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('pnpm could not run: pnpm vanished');
  });
});

describe('createNodeSignatureAuditCliDependencies()', () => {
  it('wires the runner to the process streams', () => {
    const deps = createNodeSignatureAuditCliDependencies(CWD, 'darwin');

    expect(typeof deps.runAudit).toBe('function');
    expect(typeof deps.writeOut).toBe('function');
    expect(typeof deps.writeError).toBe('function');
  });

  /**
   * The guard is meant to be piped (e.g. `| head -1`), which can close the pipe mid-write;
   * a plain `stream.write()` would then throw an unhandled EPIPE, turning a verified run into
   * a crash. The tolerant writer is asserted directly here, not borrowed as an implementation detail.
   */
  it.each([
    ['writeOut', process.stdout],
    ['writeError', process.stderr],
  ] as const)('lets %s survive a consumer that closed the pipe', (channel, stream) => {
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const writeSpy = vi.spyOn(stream, 'write').mockImplementation(() => {
      throw brokenPipe;
    });

    try {
      const deps = createNodeSignatureAuditCliDependencies(CWD, 'darwin');

      expect(() => deps[channel]('verdict')).not.toThrow();
      expect(writeSpy).toHaveBeenCalledWith('verdict\n');
    }
    finally {
      writeSpy.mockRestore();
    }
  });

  it('still propagates a write failure that is not a closed pipe', () => {
    const denied = Object.assign(new Error('write EACCES'), { code: 'EACCES' });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw denied;
    });

    try {
      const deps = createNodeSignatureAuditCliDependencies(CWD, 'darwin');

      expect(() => deps.writeOut('verdict')).toThrow('write EACCES');
    }
    finally {
      writeSpy.mockRestore();
    }
  });
});

describe('mainSignatureAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['0 when every audited package has a verified signature', { stdout: VERIFIED_REPORT, stderr: '' }, 0],
    ['1 when the run degraded into an advisory report', { stdout: '{"advisories":{},"metadata":{}}', stderr: '' }, 1],
  ])('exits with %s', async (_label, child, expected) => {
    execFileAsyncMock.mockResolvedValue(child);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errorSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      await expect(mainSignatureAudit([], CWD, 'darwin')).resolves.toBe(expected);
    }
    finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});