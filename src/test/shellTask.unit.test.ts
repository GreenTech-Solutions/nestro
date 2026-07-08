import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { runShellTaskAndWait } from '../utils';

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

    const result = runShellTaskAndWait('pnpm install', 'Install Dependencies', '/workspace');
    await vi.waitFor(() => expect(vscode.tasks.onDidEndTaskProcess).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);

    await expect(result).resolves.toBe(0);
    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    expect(task.execution).toBeInstanceOf(vscode.ShellExecution);
    expect((task.execution as vscode.ShellExecution).commandLine).toBe('pnpm install');
    expect((task.execution as vscode.ShellExecution).options).toEqual({ cwd: '/workspace' });
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to task end when no process exit event is emitted', async () => {
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    const processDispose = vi.fn();
    const taskDispose = vi.fn();
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValueOnce({ dispose: processDispose });
    vi.mocked(vscode.tasks.onDidEndTask).mockReturnValueOnce({ dispose: taskDispose });

    const result = runShellTaskAndWait('pnpm remove react', 'Remove react', '/workspace');
    await vi.waitFor(() => expect(vscode.tasks.onDidEndTask).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(vscode.tasks.onDidEndTask).mock.calls[0][0];
    listener({ execution } as vscode.TaskEndEvent);

    await expect(result).resolves.toBeUndefined();
    expect(processDispose).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes listeners and rethrows when task start fails', async () => {
    const error = new Error('task start failed');
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce(error);

    await expect(runShellTaskAndWait('pnpm install', 'Install Dependencies')).rejects.toThrow(error);
    expect(vscode.tasks.onDidEndTaskProcess).not.toHaveBeenCalled();
    expect(vscode.tasks.onDidEndTask).not.toHaveBeenCalled();
  });
});