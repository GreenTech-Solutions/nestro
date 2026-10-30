import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWindowsTaskkillPath, runBoundedProcess } from '../utils';

// Pass-through wrappers: every real-process test below still reaches the real functions, while
// the Windows wiring tests substitute a single call.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

// This suite deliberately does NOT mock `node:child_process`, unlike the audit client suites
// that mock the exec boundary: `runBoundedProcess()` is the one place a hung/broken process
// gets bounded and killed, so only a real `node` child process proves it actually terminates.

const cwd = process.cwd();
const markerFiles: string[] = [];

describe('getWindowsTaskkillPath()', () => {
  it.each([
    [undefined, 'C:\\Windows\\System32\\taskkill.exe'],
    ['', 'C:\\Windows\\System32\\taskkill.exe'],
    ['relative-system-root', 'C:\\Windows\\System32\\taskkill.exe'],
    ['\\\\server\\share\\Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['\\\\?\\C:\\Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['\\Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['/Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:\\Windows\\..\\Temp', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:/Windows/../Temp', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:\\Windows/..\\Temp', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:/Windows\\.\\Temp', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:\\Windows\\\u0000Temp', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:\\Windows\\\nTemp', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:\\Windows\\\\System32', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:\\Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['C:/Windows', 'C:\\Windows\\System32\\taskkill.exe'],
    ['D:\\CustomWindows', 'D:\\CustomWindows\\System32\\taskkill.exe'],
    ['D:/CustomWindows', 'D:\\CustomWindows\\System32\\taskkill.exe'],
  ] as const)('uses an absolute SystemRoot or the safe fallback', (systemRoot, expected) => {
    expect(getWindowsTaskkillPath(systemRoot)).toBe(expected);
  });
});

function markerPath(): string {
  const file = join(tmpdir(), `nestro-processRunner-${Date.now()}-${Math.random().toString(36).slice(2)}.marker`);
  markerFiles.push(file);
  return file;
}

afterEach(() => {
  while (markerFiles.length > 0) {
    const file = markerFiles.pop();
    if (file !== undefined && existsSync(file)) {
      rmSync(file);
    }
  }
});

describe('runBoundedProcess() — real child process', () => {
  it('captures stdout/stderr and the exit code for a normal successful run', async () => {
    const outcome = await runBoundedProcess(
      'node',
      ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024 },
    );

    expect(outcome).toEqual({ kind: 'exit', stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('recovers stdout written before a non-zero exit, matching the advisory-exit shape', async () => {
    const outcome = await runBoundedProcess(
      'node',
      ['-e', 'process.stdout.write("{\\"advisory\\":true}"); process.exitCode = 1'],
      { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024 },
    );

    expect(outcome).toEqual({ kind: 'exit', stdout: '{"advisory":true}', stderr: '', exitCode: 1 });
  });

  it('classifies a missing executable as a command-not-found spawn error', async () => {
    const outcome = await runBoundedProcess(
      'this-command-does-not-exist-nestro-test',
      [],
      { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024 },
    );

    expect(outcome).toMatchObject({ kind: 'spawn-error', reason: 'command-not-found' });
    if (outcome.kind === 'spawn-error') {
      expect(outcome.detail).not.toContain('audit');
    }
  });

  it('terminates a process that outlives the timeout and reports it as timeout, not exit', async () => {
    const marker = markerPath();
    const outcome = await runBoundedProcess(
      'node',
      ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 400)`],
      { cwd, timeoutMs: 60, maxBufferBytes: 1024 * 1024 },
    );

    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 60 });

    // Mutation guard: if the runner only rejected the promise without actually killing
    // the process, the marker file would still appear once the real 400ms delay elapses.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(existsSync(marker)).toBe(false);
  });

  it('kills the whole process tree, not just the direct child, when a timeout fires', async () => {
    const marker = markerPath();
    // The direct child forks a grandchild of its own — the shape every real audit command
    // (npm/pnpm/yarn/bun) can take when delegating to a worker process. Killing only the
    // direct pid would leave this grandchild to write its marker once its delay elapses.
    const grandchildCode = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 500)`;
    const parentCode = `require('node:child_process').spawn('node', ['-e', ${JSON.stringify(grandchildCode)}], `
      + `{ stdio: 'ignore' }); setTimeout(() => {}, 60000);`;

    const outcome = await runBoundedProcess('node', ['-e', parentCode], { cwd, timeoutMs: 200, maxBufferBytes: 1024 * 1024 });

    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 200 });
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(existsSync(marker)).toBe(false);
  });

  it('escalates to a forceful kill when a process traps the initial termination signal', async () => {
    const marker = markerPath();
    // Records its own pid, then makes SIGTERM inert — the runner's first termination
    // signal alone must not be enough for this test to observe a dead process.
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); `
      + `process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);`;

    const outcome = await runBoundedProcess('node', ['-e', script], {
      cwd, timeoutMs: 150, maxBufferBytes: 1024 * 1024, killGracePeriodMs: 250,
    });

    // The outcome stays `timeout` — the escalation does not change what the caller is
    // told, only whether the process tree actually ends up dead.
    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 150 });

    // Mutation guard: runBoundedProcess() only settles from the child's `close` event,
    // so a broken escalation would hang this whole test (it has no other way to
    // resolve) rather than merely leave a live process behind.
    const pid = Number(readFileSync(marker, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('never spawns a process when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await runBoundedProcess(
      'node',
      ['-e', 'process.exit(0)'],
      { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024, signal: controller.signal },
    );

    expect(outcome).toEqual({ kind: 'aborted' });
  });

  it('terminates a running process when the caller cancels mid-flight', async () => {
    const marker = markerPath();
    const controller = new AbortController();
    const promise = runBoundedProcess(
      'node',
      ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 400)`],
      { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024, signal: controller.signal },
    );

    // Give the child process a moment to actually spawn before cancelling it.
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();

    await expect(promise).resolves.toEqual({ kind: 'aborted' });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(existsSync(marker)).toBe(false);
  });

  it('terminates and reports overflow when stdout alone exceeds the buffer limit', async () => {
    const outcome = await runBoundedProcess(
      'node',
      ['-e', 'process.stdout.write("x".repeat(1_000_000))'],
      { cwd, timeoutMs: 5000, maxBufferBytes: 100 },
    );

    expect(outcome).toEqual({ kind: 'overflow', maxBufferBytes: 100 });
  });

  it('terminates and reports overflow when stderr alone exceeds the per-stream limit', async () => {
    // stdout stays far under the limit on its own; only stderr crosses it. There is no shared
    // stdout/stderr budget — Node's `maxBuffer` (and this runner's own cap) is enforced per
    // stream, so this input distinguishes per-stream enforcement from an incorrect aggregate cap.
    const outcome = await runBoundedProcess(
      'node',
      ['-e', 'process.stdout.write("12345"); process.stderr.write("x".repeat(1_000_000))'],
      { cwd, timeoutMs: 5000, maxBufferBytes: 200 },
    );

    expect(outcome).toEqual({ kind: 'overflow', maxBufferBytes: 200 });
  });

  it('clears its timers on every settlement path (success, timeout, overflow, spawn error)', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const before = clearTimeoutSpy.mock.calls.length;

    await runBoundedProcess('node', ['-e', ''], { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024 });
    await runBoundedProcess('node', ['-e', 'setTimeout(() => {}, 5000)'], { cwd, timeoutMs: 40, maxBufferBytes: 1024 * 1024 });
    await runBoundedProcess('this-command-does-not-exist-nestro-test', [], { cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024 });

    // Two timers per run — the timeout detector and the (possibly-never-scheduled)
    // kill escalation — are cleared on every settlement path, three runs above.
    expect(clearTimeoutSpy.mock.calls).toHaveLength(before + 6);
    clearTimeoutSpy.mockRestore();
  });

  it('removes its abort listener from a caller signal reused across sequential calls', async () => {
    const controller = new AbortController();

    await runBoundedProcess('node', ['-e', ''], {
      cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024, signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    await runBoundedProcess('node', ['-e', ''], {
      cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024, signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    // Proves the earlier, already-completed calls left no stale listener behind to
    // mis-fire: aborting now must only affect a *new* call, never something already done.
    controller.abort();
    const finalOutcome = await runBoundedProcess('node', ['-e', ''], {
      cwd, timeoutMs: 5000, maxBufferBytes: 1024 * 1024, signal: controller.signal,
    });
    expect(finalOutcome).toEqual({ kind: 'aborted' });
  });
});

describe('runBoundedProcess() — Windows launch wiring', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalPath = process.env.PATH;
  const originalSystemRoot = process.env.SystemRoot;

  function asWindows(path: string): void {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.PATH = path;
    process.env.SystemRoot = 'C:\\Windows';
  }

  afterEach(() => {
    if (originalPlatform !== undefined) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    process.env.PATH = originalPath;
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot;
    }
    else {
      process.env.SystemRoot = originalSystemRoot;
    }
    vi.mocked(statSync).mockReset();
    vi.mocked(spawn).mockReset();
    vi.mocked(execFile).mockReset();
  });

  function fakeChild(exitCode: number, stdout: string): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      child.stdout?.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode, null);
    });
    return child;
  }

  it('starts an npm .cmd shim through cmd.exe with verbatim arguments instead of spawning "npm"', async () => {
    asWindows('C:\\Program Files\\nodejs');
    vi.mocked(statSync).mockImplementation(((filePath: string) => ({
      isFile: () => filePath === 'C:\\Program Files\\nodejs\\npm.cmd',
    })) as unknown as typeof statSync);
    vi.mocked(spawn).mockImplementationOnce((() => fakeChild(0, '{"metadata":{}}')) as unknown as typeof spawn);

    const outcome = await runBoundedProcess('npm', ['audit', '--json'], { cwd, timeoutMs: 5000, maxBufferBytes: 1024 });

    expect(outcome).toEqual({ kind: 'exit', stdout: '{"metadata":{}}', stderr: '', exitCode: 0 });
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" audit --json"'],
      expect.objectContaining({ cwd, windowsVerbatimArguments: true }),
    );
  });

  it('reports a manager missing from PATH as command-not-found without spawning anything', async () => {
    asWindows('');

    const outcome = await runBoundedProcess('pnpm', ['audit', '--json'], { cwd, timeoutMs: 5000, maxBufferBytes: 1024 });

    expect(outcome).toEqual({
      kind: 'spawn-error',
      reason: 'command-not-found',
      detail: 'pnpm could not run: pnpm was not found on PATH.',
      message: 'pnpm was not found on PATH.',
      cause: undefined,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a shell-significant argument as a process failure without spawning anything', async () => {
    asWindows('C:\\tools');
    vi.mocked(statSync).mockImplementation(((filePath: string) => ({
      isFile: () => filePath === 'C:\\tools\\npm.cmd',
    })) as unknown as typeof statSync);

    const outcome = await runBoundedProcess('npm', ['view', 'x&calc', '--json'], { cwd, timeoutMs: 5000, maxBufferBytes: 1024 });

    expect(outcome).toMatchObject({ kind: 'spawn-error', reason: 'process-failed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('terminates the tree with taskkill /t, then escalates to taskkill /f when the timeout fires', async () => {
    asWindows('C:\\tools');
    vi.mocked(statSync).mockImplementation(((filePath: string) => ({
      isFile: () => filePath === 'C:\\tools\\node.exe',
    })) as unknown as typeof statSync);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
    vi.mocked(spawn).mockImplementationOnce((() => child) as unknown as typeof spawn);
    vi.mocked(execFile).mockImplementation((() => undefined) as unknown as typeof execFile);
    setTimeout(() => child.emit('close', null, 'SIGTERM'), 30);

    const outcome = await runBoundedProcess('node', ['-e', ''], { cwd, timeoutMs: 10, maxBufferBytes: 1024, killGracePeriodMs: 60 });

    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 10 });
    const taskkill = 'C:\\Windows\\System32\\taskkill.exe';
    expect(vi.mocked(execFile).mock.calls.map(([file, flags]) => [file, flags])).toEqual([
      [taskkill, ['/pid', '4242', '/t']],
      [taskkill, ['/pid', '4242', '/t', '/f']],
    ]);
  });
});