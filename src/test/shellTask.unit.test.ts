import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { formatShellTaskFailureMessage, mutationCoordinator, runShellTaskAndWait } from '../utils';

describe('runShellTaskAndWait()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates a shell task and resolves with the process exit code', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies', '/workspace');
    await vi.waitFor(() => expect(vscode.tasks.onDidEndTaskProcess).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);

    await expect(result).resolves.toEqual({ kind: 'ended', exitCode: 0 });
    expect(vscode.window.withProgress).toHaveBeenCalledWith({
      location: vscode.ProgressLocation.Notification,
      title: 'Install Dependencies',
      cancellable: true,
    }, expect.any(Function));
    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    expect(task.execution).toBeInstanceOf(vscode.ShellExecution);
    expect((task.execution as vscode.ShellExecution).command).toBe('pnpm');
    expect((task.execution as vscode.ShellExecution).args).toEqual(['install']);
    expect((task.execution as vscode.ShellExecution).options).toEqual({ cwd: '/workspace' });
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('terminates and resolves as cancelled without waiting for an end event', async () => {
    const execution = { id: 'task-execution', terminate: vi.fn() } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    const cancellation = mockProgressCancellation();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies');
    await vi.waitFor(() => expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1));
    cancellation.cancel();

    const outcomeBeforeEnd = await Promise.race([
      result.then(outcome => ({ settled: true, outcome })),
      wait(25).then(() => ({ settled: false as const })),
    ]);
    if (!outcomeBeforeEnd.settled) {
      vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0]({ execution, exitCode: 1 } as vscode.TaskProcessEndEvent);
      await result;
    }

    expect(outcomeBeforeEnd).toEqual({ settled: true, outcome: { kind: 'cancelled' } });
    expect(execution.terminate).toHaveBeenCalledTimes(1);
    expect(cancellation.dispose).toHaveBeenCalledTimes(1);
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('releases the coordinator key when a running task is cancelled', async () => {
    const execution = { id: 'task-execution', terminate: vi.fn() } as unknown as vscode.TaskExecution;
    const cancellation = mockProgressCancellation();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);

    const first = mutationCoordinator.runExclusive('cancelled-task-key', () => (
      runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies')
    ));
    await vi.waitFor(() => expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1));
    let secondStarted = false;
    const second = mutationCoordinator.runExclusive('cancelled-task-key', () => {
      secondStarted = true;
      return Promise.resolve();
    });
    cancellation.cancel();

    const secondSettledBeforeEnd = await Promise.race([
      second.then(() => true),
      wait(25).then(() => false),
    ]);
    if (!secondSettledBeforeEnd) {
      vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0]({ execution, exitCode: 1 } as vscode.TaskProcessEndEvent);
    }
    await Promise.all([first, second]);

    expect(secondSettledBeforeEnd).toBe(true);
    expect(secondStarted).toBe(true);
    expect(execution.terminate).toHaveBeenCalledTimes(1);
  });

  it('falls back to task end when no process exit event is emitted', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait(
      { command: 'pnpm', args: ['remove', { value: 'react', quoting: vscode.ShellQuoting.Strong }] },
      'Remove react',
      '/workspace',
    );
    await vi.waitFor(() => expect(vscode.tasks.onDidEndTask).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(vscode.tasks.onDidEndTask).mock.calls[0][0];
    listener({ execution } as vscode.TaskEndEvent);

    await expect(result).resolves.toEqual({ kind: 'ended', exitCode: undefined });
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('resolves when the process ends before task startup resolves', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });
    vi.mocked(vscode.tasks.executeTask).mockImplementationOnce(() => {
      const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
      listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);
      return Promise.resolve(execution);
    });

    await expect(
      runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies'),
    ).resolves.toEqual({ kind: 'ended', exitCode: 0 });
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes listeners and rethrows when task start fails', async () => {
    const error = new Error('task start failed');
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce(error);

    await expect(runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies')).rejects.toThrow(error);
    expect(vscode.tasks.onDidEndTaskProcess).toHaveBeenCalledTimes(1);
    expect(vscode.tasks.onDidEndTask).toHaveBeenCalledTimes(1);
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('resolves when the task ends before task startup resolves and no process event fires', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });
    vi.mocked(vscode.tasks.executeTask).mockImplementationOnce(() => {
      const listener = vi.mocked(vscode.tasks.onDidEndTask).mock.calls[0][0];
      listener({ execution } as vscode.TaskEndEvent);
      return Promise.resolve(execution);
    });

    await expect(
      runShellTaskAndWait({ command: 'pnpm', args: ['remove', 'react'] }, 'Remove react'),
    ).resolves.toEqual({ kind: 'ended', exitCode: undefined });
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a second termination event once the task has already settled', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies');
    await vi.waitFor(() => expect(vscode.tasks.onDidEndTaskProcess).toHaveBeenCalledTimes(1));
    const processListener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    const taskListener = vi.mocked(vscode.tasks.onDidEndTask).mock.calls[0][0];
    processListener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);
    taskListener({ execution } as vscode.TaskEndEvent);

    await expect(result).resolves.toEqual({ kind: 'ended', exitCode: 0 });
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a process end event reported for a different task execution', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const otherExecution = { id: 'other-task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait({ command: 'pnpm', args: ['install'] }, 'Install Dependencies');
    // Registration of both listeners happens synchronously before `executeTask` is awaited,
    // but `execution` is only assigned once that awaited promise settles. Flush a macrotask so
    // the mismatch below is checked against an already-resolved `execution`, not buffered.
    await flushMacrotask();
    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution: otherExecution, exitCode: 1 } as vscode.TaskProcessEndEvent);
    listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);

    await expect(result).resolves.toEqual({ kind: 'ended', exitCode: 0 });
    expect(processDispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a task end event reported for a different task execution', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const otherExecution = { id: 'other-task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait(
      { command: 'pnpm', args: ['remove', { value: 'react', quoting: vscode.ShellQuoting.Strong }] },
      'Remove react',
    );
    await flushMacrotask();
    const listener = vi.mocked(vscode.tasks.onDidEndTask).mock.calls[0][0];
    listener({ execution: otherExecution } as vscode.TaskEndEvent);
    listener({ execution } as vscode.TaskEndEvent);

    await expect(result).resolves.toEqual({ kind: 'ended', exitCode: undefined });
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });
});

function flushMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function mockProgressCancellation(): { cancel: () => void; dispose: ReturnType<typeof vi.fn> } {
  let cancelListener: ((event: void) => unknown) | undefined;
  const dispose = vi.fn();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: (event: void) => unknown) => {
      cancelListener = listener;
      return { dispose };
    },
  };
  vi.mocked(vscode.window.withProgress).mockImplementationOnce((_options, task) => (
    task({ report: vi.fn() }, token)
  ));
  return {
    cancel: () => {
      token.isCancellationRequested = true;
      cancelListener?.(undefined);
    },
    dispose,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe('formatShellTaskFailureMessage()', () => {
  it('formats non-zero and missing exit codes', () => {
    vi.mocked(vscode.l10n.t).mockClear();
    const failedMessage = formatShellTaskFailureMessage('Update react', 1);
    expect(vscode.l10n.t).toHaveBeenCalledWith('task "{0}" failed with exit code {1}.', 'Update react', 1);
    expect(failedMessage).toBe(vscode.l10n.t('task "{0}" failed with exit code {1}.', 'Update react', 1));

    vi.mocked(vscode.l10n.t).mockClear();
    const missingExitCodeMessage = formatShellTaskFailureMessage('Remove react', undefined);
    expect(vscode.l10n.t).toHaveBeenCalledWith('task "{0}" ended without an exit code.', 'Remove react');
    expect(missingExitCodeMessage).toBe(vscode.l10n.t('task "{0}" ended without an exit code.', 'Remove react'));
  });
});