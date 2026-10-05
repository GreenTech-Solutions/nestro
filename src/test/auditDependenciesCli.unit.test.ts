import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = (): never => {
    throw new Error('the callback form of execFile is not used');
  };
  return { execFile: Object.assign(execFile, { [promisify.custom]: execFileAsyncMock }) };
});

const { createNodeDependencyAuditCliDependencies, createNodePnpmRunner, mainDependencyAudit } = await import('../tools');

const CWD = '/repo';
const CLEAN_REPORT = '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}';

describe('createNodePnpmRunner()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs pnpm with the given arguments in the repository root', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: CLEAN_REPORT, stderr: '' });

    const result = await createNodePnpmRunner(CWD, 'linux')(['audit', '--prod', '--json']);

    expect(execFileAsyncMock).toHaveBeenCalledWith('pnpm', ['audit', '--prod', '--json'], expect.objectContaining({ cwd: CWD }));
    expect(result).toStrictEqual({ command: 'pnpm audit --prod --json', stdout: CLEAN_REPORT, stderr: '', exitCode: 0 });
  });
});

describe('createNodeDependencyAuditCliDependencies()', () => {
  it.each([
    [{ GITHUB_ACTIONS: 'true' }, true],
    [{ GITHUB_ACTIONS: 'false' }, false],
    [{}, false],
  ])('derives GitHub Actions output from %o', (env, expected) => {
    const deps = createNodeDependencyAuditCliDependencies(CWD, 'darwin', env);

    expect(deps.githubActions).toBe(expected);
    expect(typeof deps.runAudit).toBe('function');
    expect(typeof deps.writeOut).toBe('function');
    expect(typeof deps.writeError).toBe('function');
  });
});

describe('mainDependencyAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['0 when neither audit reports an advisory', { stdout: CLEAN_REPORT, stderr: '' }, 0],
    ['1 when pnpm reports a registry failure', { stdout: '{"error":{"message":"fetch failed"}}', stderr: '' }, 1],
  ])('exits with %s', async (_label, child, expected) => {
    execFileAsyncMock.mockResolvedValue(child);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errorSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      await expect(mainDependencyAudit([], CWD, 'darwin', {})).resolves.toBe(expected);
    }
    finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});