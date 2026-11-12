import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { getWindowsSystemExecutablePath } from '../shared';

/** Resolves the Windows system taskkill executable without consulting PATH. */
export function getWindowsTaskkillPath(systemRoot: string | undefined = process.env.SystemRoot): string {
  return getWindowsSystemExecutablePath('taskkill.exe', systemRoot);
}

/**
 * Terminates a child's whole process tree: an initial termination signal, then a forceful kill
 * after the grace period if the child ignored it. Idempotent — only the first `terminate()` of
 * racing timeout/abort/overflow triggers anything.
 */
export class ProcessTerminator {
  private terminating = false;
  private closed = false;
  private escalationTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly killGracePeriodMs: number,
    private readonly onEscalatedAfterClose: () => void,
  ) {}

  get isTerminating(): boolean {
    return this.terminating;
  }

  /** True while the forceful kill is still scheduled, so the run must stay pending. */
  get isEscalationPending(): boolean {
    return this.escalationTimer !== undefined;
  }

  /** Records that the child's stdio has closed, so an escalation firing later can settle the run. */
  markClosed(): void {
    this.closed = true;
  }

  terminate(): void {
    if (this.terminating) {
      return;
    }
    this.terminating = true;
    killProcessGroup(this.child, 'SIGTERM');
    this.escalationTimer = setTimeout(() => {
      this.escalationTimer = undefined;
      killProcessGroup(this.child, 'SIGKILL');
      if (this.closed) {
        this.onEscalatedAfterClose();
      }
    }, this.killGracePeriodMs);
    this.escalationTimer.unref();
  }

  dispose(): void {
    clearTimeout(this.escalationTimer);
  }
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