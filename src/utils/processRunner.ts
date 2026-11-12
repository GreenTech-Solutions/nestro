import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { DEFAULT_KILL_GRACE_PERIOD_MS } from '../config';
import { describeError, resolveSpawnTarget } from '../shared';
import { BoundedOutput } from './boundedOutput';
import { ProcessTerminator } from './processTermination';

export { getWindowsTaskkillPath } from './processTermination';

export interface BoundedProcessOptions {
  cwd: string;
  /** Process is terminated and classified as `timeout` once this many milliseconds elapse. */
  timeoutMs: number;
  /** Size, per stream (stdout and stderr each checked independently), beyond which the process is terminated and classified as `overflow`. */
  maxBufferBytes: number;
  /** External cancellation; already-aborted signals short-circuit before a process is spawned. */
  signal?: AbortSignal;
  /**
   * Pause between the initial termination signal (`SIGTERM` on posix, a non-forceful `taskkill`
   * on win32) and escalating to a forceful kill (`SIGKILL` / `taskkill /f`) of a child that
   * ignored it. Overridable so tests don't have to wait out the production default.
   */
  killGracePeriodMs?: number;
}

/** The process ran to completion (any exit code) and its full output was captured. */
export interface BoundedProcessExit {
  kind: 'exit';
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The process did not finish within `timeoutMs` and was terminated. */
export interface BoundedProcessTimeout {
  kind: 'timeout';
  timeoutMs: number;
}

/** The caller's `signal` fired before the process finished; it was terminated (or never spawned). */
export interface BoundedProcessAborted {
  kind: 'aborted';
}

/** One stream's output exceeded `maxBufferBytes`; the process was terminated. */
export interface BoundedProcessOverflow {
  kind: 'overflow';
  maxBufferBytes: number;
}

/** The process never produced a numeric exit code — it could not be spawned or was killed by a signal. */
export interface BoundedProcessSpawnError {
  kind: 'spawn-error';
  reason: 'command-not-found' | 'process-failed';
  detail: string;
  /**
   * Raw, untruncated underlying error text with no domain wrapping. Callers that build
   * their own message (e.g. a package-manager-family-qualified summary) read this
   * instead of re-parsing `detail`.
   */
  message: string;
  /** The raw error this outcome was derived from, if any, for callers that want a stack trace. */
  cause: unknown;
}

export type BoundedProcessOutcome
  = | BoundedProcessExit
    | BoundedProcessTimeout
    | BoundedProcessAborted
    | BoundedProcessOverflow
    | BoundedProcessSpawnError;

/**
 * Classifies the run into a typed outcome: a non-`exit` outcome means the process was
 * terminated, so callers must not treat `timeout`/`aborted`/`overflow` as success or trust
 * their truncated output. Spawns directly (not via `execFile`) so the child can lead its own
 * process group, letting termination reach worker processes package managers commonly fork.
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessOutcome> {
  const { cwd, timeoutMs, maxBufferBytes, signal, killGracePeriodMs = DEFAULT_KILL_GRACE_PERIOD_MS } = options;

  if (signal?.aborted === true) {
    return Promise.resolve({ kind: 'aborted' });
  }

  const target = resolveSpawnTarget(command, args);
  if (target.kind === 'unresolved') {
    return Promise.resolve(spawnFailure(command, target.message, target.reason, undefined));
  }

  return new Promise<BoundedProcessOutcome>((resolve) => {
    const child = spawn(target.command, target.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      // Own process group on posix so termination can reach the whole tree; win32 has
      // no equivalent concept and `ProcessTerminator` uses `taskkill /t` there instead.
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });
    supervise(child, { command, timeoutMs, maxBufferBytes, killGracePeriodMs, signal }, resolve);
  });
}

interface SupervisionContext {
  command: string;
  timeoutMs: number;
  maxBufferBytes: number;
  killGracePeriodMs: number;
  signal: AbortSignal | undefined;
}

interface TerminationCause {
  externallyAborted: boolean;
  timedOut: boolean;
  overflowed: boolean;
}

/** Wires a spawned child to its timeout, caller signal and buffer cap, and resolves exactly once. */
function supervise(
  child: ChildProcess,
  ctx: SupervisionContext,
  resolve: (outcome: BoundedProcessOutcome) => void,
): void {
  const cause: TerminationCause = { externallyAborted: false, timedOut: false, overflowed: false };
  const output = new BoundedOutput(ctx.maxBufferBytes);
  let settled = false;

  const finish = (outcome: BoundedProcessOutcome): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeoutTimer);
    terminator.dispose();
    ctx.signal?.removeEventListener('abort', onExternalAbort);
    resolve(outcome);
  };
  const terminator = new ProcessTerminator(child, ctx.killGracePeriodMs, () => {
    finish(terminationOutcome(ctx, cause));
  });
  const onExternalAbort = (): void => {
    cause.externallyAborted = true;
    terminator.terminate();
  };
  ctx.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const timeoutTimer = setTimeout(() => {
    cause.timedOut = true;
    terminator.terminate();
  }, ctx.timeoutMs);

  const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
    if (cause.overflowed) {
      return;
    }
    if (!output.capture(stream, chunk)) {
      cause.overflowed = true;
      terminator.terminate();
    }
  };
  child.stdout?.on('data', capture('stdout'));
  child.stderr?.on('data', capture('stderr'));

  // The process could not be spawned at all (e.g. `ENOENT`), so there is nothing to terminate.
  child.on('error', (err) => {
    finish(spawnFailure(ctx.command, describeError(err), isCommandNotFound(err) ? 'command-not-found' : 'process-failed', err));
  });

  // `close` (not `exit`) so stdio has fully flushed before stdout/stderr are read.
  child.on('close', (code, signal) => {
    terminator.markClosed();
    if (terminator.isTerminating) {
      // A direct child can close while a grandchild ignores SIGTERM. Keep the promise
      // pending until the grace timer has sent SIGKILL to the whole group.
      if (!terminator.isEscalationPending) {
        finish(terminationOutcome(ctx, cause));
      }
      return;
    }
    finish(closeOutcome(ctx.command, code, signal, output));
  });
}

/** Reports an explicit caller cancellation even if the timeout or buffer cap also tripped in the same tick. */
function terminationOutcome(ctx: SupervisionContext, cause: TerminationCause): BoundedProcessOutcome {
  if (cause.externallyAborted) {
    return { kind: 'aborted' };
  }
  if (cause.timedOut) {
    return { kind: 'timeout', timeoutMs: ctx.timeoutMs };
  }
  if (cause.overflowed) {
    return { kind: 'overflow', maxBufferBytes: ctx.maxBufferBytes };
  }
  return {
    kind: 'spawn-error',
    reason: 'process-failed',
    detail: `${ctx.command} terminated unexpectedly.`,
    message: 'process terminated unexpectedly.',
    cause: undefined,
  };
}

function closeOutcome(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  output: BoundedOutput,
): BoundedProcessOutcome {
  if (code !== null) {
    return { kind: 'exit', stdout: output.text('stdout'), stderr: output.text('stderr'), exitCode: code };
  }
  // Terminated by a signal nothing in this runner accounts for (e.g. something outside
  // killed it), so no numeric exit code exists.
  const reason = signal === null ? 'no exit code' : `terminated by ${signal}`;
  return {
    kind: 'spawn-error',
    reason: 'process-failed',
    detail: `${command} exited with ${reason}.`,
    message: `exited with ${reason}`,
    cause: undefined,
  };
}

function spawnFailure(
  command: string,
  message: string,
  reason: BoundedProcessSpawnError['reason'],
  cause: unknown,
): BoundedProcessSpawnError {
  return { kind: 'spawn-error', reason, detail: `${command} could not run: ${message}`, message, cause };
}

function isCommandNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}