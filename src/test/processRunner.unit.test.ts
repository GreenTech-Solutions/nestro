import { getEventListeners } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWindowsTaskkillPath, runBoundedProcess } from '../utils';

// This suite deliberately does NOT mock `node:child_process` (contrast with
// auditClient.unit.test.ts / yarnAuditClient.unit.test.ts / bunAuditClient.unit.test.ts,
// which all mock the exec boundary). runBoundedProcess() is the one place a hung/broken
// audit process actually gets bounded and killed (ARC-07); asserting that against a real
// `node` child process is the only way to prove the timeout, cancellation and buffer cap
// genuinely terminate a subprocess rather than merely rejecting a promise while the real
// process keeps running in the background.

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

  it('kills the whole process tree, not just the direct child, when a timeout fires (N1)', async () => {
    const marker = markerPath();
    // The direct child forks a grandchild of its own — the shape every real audit
    // command (npm/pnpm/yarn/bun) can take when they delegate to a worker process.
    // A direct-pid-only kill (the pre-fix behaviour) terminates the parent but leaves
    // this grandchild to write its marker once its own 500ms delay elapses.
    const grandchildCode = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 500)`;
    const parentCode = `require('node:child_process').spawn('node', ['-e', ${JSON.stringify(grandchildCode)}], `
      + `{ stdio: 'ignore' }); setTimeout(() => {}, 60000);`;

    const outcome = await runBoundedProcess('node', ['-e', parentCode], { cwd, timeoutMs: 200, maxBufferBytes: 1024 * 1024 });

    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 200 });
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(existsSync(marker)).toBe(false);
  });

  it('escalates to a forceful kill when a process traps the initial termination signal (N2)', async () => {
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

  it('terminates and reports overflow when stderr alone exceeds the per-stream limit (N8)', async () => {
    // stdout stays far under the limit on its own; only stderr crosses it. Node's
    // `maxBuffer` (and this runner's own cap) is enforced per stream, not against a
    // There is no shared stdout/stderr budget — this input distinguishes per-stream
    // enforcement from an incorrect aggregate cap.
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