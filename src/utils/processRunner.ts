import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { win32 as winPath } from 'node:path';

export interface BoundedProcessOptions {
  cwd: string;
  /** Process is terminated and classified as `timeout` once this many milliseconds elapse. */
  timeoutMs: number;
  /** Size, per stream (stdout and stderr each checked independently), beyond which the process is terminated and classified as `overflow`. */
  maxBufferBytes: number;
  /** External cancellation; already-aborted signals short-circuit before a process is spawned. */
  signal?: AbortSignal;
  /**
   * Pause between the initial termination signal (`SIGTERM` on posix, a non-forceful
   * `taskkill` on win32) sent to the whole process tree and escalating to a forceful
   * kill (`SIGKILL` / `taskkill /f`) of a child that ignored it. Overridable so tests
   * don't have to wait out the production default.
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
 * Pause between the initial termination signal and the forceful escalation for a
 * process that ignores it (`ARC-07`/N2). Not itself a reviewed product-facing gate
 * like the audit timeout/buffer bounds — it only governs how long an already-bounded
 * cleanup step may take — so a conservative, generously short default is used and left
 * overridable per call.
 */
const DEFAULT_KILL_GRACE_PERIOD_MS = 2_000;

/**
 * Runs one child process with an explicit timeout, output cap and cancellation signal,
 * and classifies the result into a typed outcome instead of a raw exit code or thrown
 * error. Every non-`exit` outcome means the process was terminated before it produced a
 * complete, trustworthy result — callers must never treat `timeout`, `aborted` or
 * `overflow` as if they were a successful run, and must never inspect their (possibly
 * truncated) partial output (`ARC-07`).
 *
 * Spawns directly (rather than through `execFile`/`exec`) so the child can be made the
 * leader of its own process group (`detached: true` on posix): `execFile`'s options do
 * not forward `detached` at all, so it can never reach more than the direct child, and
 * package manager commands (`npm`/`pnpm`/`yarn`/`bun`) commonly fork worker processes
 * of their own that would otherwise survive a timeout, abort or overflow untouched.
 * Termination always targets the whole tree, with an escalation to a forceful kill if
 * the initial signal is ignored.
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessOutcome> {
  const {
    cwd,
    timeoutMs,
    maxBufferBytes,
    signal: externalSignal,
    killGracePeriodMs = DEFAULT_KILL_GRACE_PERIOD_MS,
  } = options;

  if (externalSignal?.aborted === true) {
    return Promise.resolve({ kind: 'aborted' });
  }

  return new Promise<BoundedProcessOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let externallyAborted = false;
    let overflowed = false;
    let terminating = false;
    let escalationTimer: NodeJS.Timeout | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on posix so termination can reach the whole tree; win32 has
      // no equivalent concept and `killProcessGroup()` uses `taskkill /t` there instead.
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });

    const finish = (outcome: BoundedProcessOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      resolve(outcome);
    };

    // Sends the initial termination signal to the whole tree immediately, then
    // escalates to a forceful kill after `killGracePeriodMs` if it's still alive — a
    // child that ignores the first signal no longer outlives the runner silently
    // (`ARC-07`/N2). `finish()` only ever fires from `close`, so this function's
    // returned promise does not settle until the process has actually exited, even
    // when that takes the full grace period. Idempotent: timeout, external abort and
    // overflow can all race to call this, but only the first one schedules anything.
    const terminate = (): void => {
      if (terminating) {
        return;
      }
      terminating = true;
      killProcessGroup(child, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        killProcessGroup(child, 'SIGKILL');
        if (childClosed) {
          finish(terminationOutcome());
        }
      }, killGracePeriodMs);
      escalationTimer.unref();
    };

    let childClosed = false;
    const terminationOutcome = (): BoundedProcessOutcome => {
      if (externallyAborted) {
        return { kind: 'aborted' };
      }
      if (timedOut) {
        return { kind: 'timeout', timeoutMs };
      }
      if (overflowed) {
        return { kind: 'overflow', maxBufferBytes };
      }
      return {
        kind: 'spawn-error',
        reason: 'process-failed',
        detail: `${command} terminated unexpectedly.`,
        message: 'process terminated unexpectedly.',
        cause: undefined,
      };
    };

    const onExternalAbort = (): void => {
      externallyAborted = true;
      terminate();
    };
    if (externalSignal?.aborted === true) {
      onExternalAbort();
    }
    else {
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflowed) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        overflowed = true;
        terminate();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (overflowed) {
        return;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) {
        overflowed = true;
        terminate();
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      // The process could not be spawned at all (e.g. `ENOENT`) — nothing was running,
      // so there is nothing to terminate.
      finish({
        kind: 'spawn-error',
        reason: isCommandNotFound(err) ? 'command-not-found' : 'process-failed',
        detail: `${command} could not run: ${describeError(err)}`,
        message: describeError(err),
        cause: err,
      });
    });

    // `close` (not `exit`) so stdio has fully flushed before stdout/stderr are read.
    // Checked in this order deliberately: an explicit caller cancellation is the most
    // specific and intentional signal available, so it is reported even if the
    // timeout timer or the buffer cap also happened to trip in the same tick.
    child.on('close', (code, signal) => {
      childClosed = true;
      if (terminating) {
        // A direct child can close while a grandchild ignores SIGTERM. Keep the
        // promise pending until the grace timer has sent SIGKILL to the whole group.
        if (escalationTimer !== undefined) {
          return;
        }
        finish(terminationOutcome());
        return;
      }
      if (code !== null) {
        finish({
          kind: 'exit',
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code,
        });
        return;
      }
      // Terminated by a signal neither `terminate()` nor a bound above accounts for
      // (e.g. something outside this runner killed it) — no numeric exit code exists.
      const reason = signal === null ? 'no exit code' : `terminated by ${signal}`;
      finish({
        kind: 'spawn-error',
        reason: 'process-failed',
        detail: `${command} exited with ${reason}.`,
        message: `exited with ${reason}`,
        cause: undefined,
      });
    });
  });
}

function killProcessGroup(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups and no `SIGTERM` a console process can trap;
    // `/t` walks the OS-reported process tree under this pid, and the non-`/f` call is
    // the closest available "please exit" step before the forceful `/f` escalation.
    const flags = signal === 'SIGKILL'
      ? ['/pid', String(child.pid), '/t', '/f']
      : ['/pid', String(child.pid), '/t'];
    execFile(getWindowsTaskkillPath(), flags, () => {
      // Best-effort: nothing actionable here if taskkill itself fails (e.g. the tree
      // is already gone).
    });
    return;
  }
  try {
    // Negative pid targets the whole process group — not just the direct child — so
    // grandchildren spawned by npm/pnpm/yarn/bun wrapper scripts are reached too
    // (`ARC-07`/N1). Relies on `detached: true` at spawn making the child its own
    // group leader instead of sharing this process's group.
    process.kill(-child.pid, signal);
  }
  catch {
    // ESRCH: the group is already gone — nothing left to signal.
  }
}

/**
 * Resolves the Windows system taskkill executable without consulting PATH. A malformed
 * or relative environment value cannot redirect the runner through the workspace; only
 * an absolute `SystemRoot` is accepted, with the standard Windows root as fallback.
 */
export function getWindowsTaskkillPath(systemRoot: string | undefined = process.env.SystemRoot): string {
  const root = isCanonicalLocalWindowsRoot(systemRoot)
    ? systemRoot
    : 'C:\\Windows';
  return winPath.join(root, 'System32', 'taskkill.exe');
}

/**
 * This is a syntactic boundary only, not proof that the caller owns the directory: accept
 * a normalized, drive-qualified local Windows path and reject namespace/root-relative,
 * traversal, malformed and control-character forms before composing the fixed suffix.
 */
function isCanonicalLocalWindowsRoot(systemRoot: string | undefined): systemRoot is string {
  if (typeof systemRoot !== 'string'
    || systemRoot.length === 0
    || systemRoot !== systemRoot.trim()
    || !/^[A-Za-z]:[\\/]/.test(systemRoot)
    || /[\u0000-\u001F\u007F"<>|?*]/.test(systemRoot)
    || systemRoot.slice(2).includes(':')
    || systemRoot.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) {
    return false;
  }
  const canonicalCandidate = systemRoot.replace(/\//g, '\\');
  return winPath.normalize(canonicalCandidate) === canonicalCandidate;
}

function isCommandNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}