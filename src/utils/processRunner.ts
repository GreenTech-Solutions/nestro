import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
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
 * Pause between the initial termination signal and the forceful escalation for a process
 * that ignores it. Governs only how long an already-bounded cleanup step may take, so a
 * conservative, short default is used and left overridable per call.
 */
const DEFAULT_KILL_GRACE_PERIOD_MS = 2_000;

/** A command line ready for `spawn()` / `execFile()`. */
export interface ResolvedSpawnTarget {
  kind: 'resolved';
  command: string;
  args: string[];
  /** Set when `args` form a pre-quoted `cmd.exe` command line that must reach the child untouched. */
  windowsVerbatimArguments?: true;
}

/** The command cannot be launched safely; nothing was spawned. */
export interface UnresolvedSpawnTarget {
  kind: 'unresolved';
  reason: 'command-not-found' | 'process-failed';
  message: string;
}

export type SpawnTarget = ResolvedSpawnTarget | UnresolvedSpawnTarget;

/** Platform inputs of {@link resolveSpawnTarget}; overridable so the Windows branch is testable anywhere. */
export interface SpawnTargetEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile: (filePath: string) => boolean;
}

/** Windows launcher extensions, in lookup order within one PATH directory. */
const WINDOWS_LAUNCHER_EXTENSIONS = ['.exe', '.cmd'] as const;

/**
 * Every character a `cmd.exe` argument may contain. It excludes whitespace, quotes, `%`, `!`,
 * `^` and all command separators/redirections, so an accepted argument needs no escaping.
 */
const WINDOWS_SAFE_ARGUMENT = /^[A-Za-z0-9_.:@/+~-]+$/;

/** A launcher path is placed inside double quotes, where only `%` and `!` can still expand. */
const WINDOWS_UNSAFE_LAUNCHER_PATH = /["%!\u0000-\u001F]/;

/**
 * Resolves what to spawn for a package-manager (or any bare) command. On Windows `npm`, `pnpm`
 * and `yarn` are `.cmd` shims that `spawn()` cannot start, and a `.cmd`/`.bat` started without a
 * shell fails with EINVAL; the shim is therefore located on `PATH` (never in the working
 * directory) and hosted by the system `cmd.exe`. Elsewhere, and for real `.exe` binaries, the
 * command is returned unchanged.
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  environment: Partial<SpawnTargetEnvironment> = {},
): SpawnTarget {
  const { platform = process.platform, env = process.env, isFile = isRegularFile } = environment;
  if (platform !== 'win32') {
    return { kind: 'resolved', command, args: [...args] };
  }

  const launcher = findWindowsLauncher(command, env, isFile);
  if (launcher === undefined) {
    return { kind: 'unresolved', reason: 'command-not-found', message: `${command} was not found on PATH.` };
  }
  if (launcher.toLowerCase().endsWith('.exe')) {
    return { kind: 'resolved', command: launcher, args: [...args] };
  }

  if (WINDOWS_UNSAFE_LAUNCHER_PATH.test(launcher)) {
    return {
      kind: 'unresolved',
      reason: 'process-failed',
      message: `${command} resolves to a path that cmd.exe cannot start safely.`,
    };
  }
  const unsafeIndex = args.findIndex(arg => !WINDOWS_SAFE_ARGUMENT.test(arg));
  if (unsafeIndex >= 0) {
    return {
      kind: 'unresolved',
      reason: 'process-failed',
      message: `Argument ${unsafeIndex + 1} contains characters cmd.exe cannot receive safely.`,
    };
  }

  // `/s` strips only the outer quote pair, so the quoted launcher path inside survives intact.
  const commandLine = [`"${launcher}"`, ...args].join(' ');
  return {
    kind: 'resolved',
    command: getWindowsSystemExecutablePath('cmd.exe', readEnv(env, 'SystemRoot')),
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function findWindowsLauncher(
  command: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean,
): string | undefined {
  const isAbsolute = winPath.isAbsolute(command);
  if (!isAbsolute && /[\\/]/.test(command)) {
    return undefined;
  }
  const directories = isAbsolute
    ? [winPath.dirname(command)]
    : (readEnv(env, 'PATH') ?? '').split(';')
        .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(entry => winPath.isAbsolute(entry));
  const fileName = winPath.basename(command);
  const hasExtension = WINDOWS_LAUNCHER_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext));
  const names = hasExtension ? [fileName] : WINDOWS_LAUNCHER_EXTENSIONS.map(ext => fileName + ext);

  for (const directory of directories) {
    for (const name of names) {
      const candidate = winPath.join(directory, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Case-insensitive lookup: plain objects (unlike `process.env` on Windows) do not fold key case. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  }
  catch {
    return false;
  }
}

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

  const target = resolveSpawnTarget(command, args);
  if (target.kind === 'unresolved') {
    return Promise.resolve({
      kind: 'spawn-error',
      reason: target.reason,
      detail: `${command} could not run: ${target.message}`,
      message: target.message,
      cause: undefined,
    });
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

    const child = spawn(target.command, target.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
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

    // Sends the initial termination signal to the whole tree, then escalates to a forceful
    // kill after `killGracePeriodMs` if still alive. Idempotent — only the first of a racing
    // timeout/abort/overflow schedules anything — and the promise stays pending until `close`.
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

    // `close` (not `exit`) so stdio has fully flushed before stdout/stderr are read. Checked
    // in this order deliberately: an explicit caller cancellation is reported even if the
    // timeout timer or buffer cap also tripped in the same tick.
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
    // Negative pid targets the whole process group, not just the direct child, so
    // grandchildren spawned by npm/pnpm/yarn/bun wrapper scripts are reached too. Relies
    // on `detached: true` at spawn making the child its own group leader.
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
  return getWindowsSystemExecutablePath('taskkill.exe', systemRoot);
}

function getWindowsSystemExecutablePath(fileName: string, systemRoot: string | undefined): string {
  const root = isCanonicalLocalWindowsRoot(systemRoot)
    ? systemRoot
    : 'C:\\Windows';
  return winPath.join(root, 'System32', fileName);
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