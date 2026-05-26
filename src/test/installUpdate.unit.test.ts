import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { installUpdateCommand } from '../commands';
import { PackageItem } from '../providers/PackageItem';
import { PackagesProvider } from '../providers';

describe('installUpdateCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue({ id: 'task-execution' } as unknown as vscode.TaskExecution);
  });

  it('uses the detected package manager in the update task command', async () => {
    const provider = { markPackageUpdated: vi.fn(), markPackageUpdating: vi.fn() } as unknown as PackagesProvider;
    vi.mocked(vscode.workspace.findFiles)
      .mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[])
      .mockResolvedValueOnce([{ path: '/workspace/pnpm-lock.yaml' }] as vscode.Uri[]);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'), provider);

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    expect(task.execution).toBeInstanceOf(vscode.ShellExecution);
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe('pnpm add typescript@5.9.3');
    expect(task.presentationOptions).toEqual({
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.New,
    });
  });

  it('marks the package updated after the task exits successfully', async () => {
    const provider = { markPackageUpdated: vi.fn(), markPackageUpdating: vi.fn() } as unknown as PackagesProvider;
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'), provider);

    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);

    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3');
  });

  it('shows package update progress while the task runs', async () => {
    const provider = { markPackageUpdated: vi.fn(), markPackageUpdating: vi.fn() } as unknown as PackagesProvider;
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'), provider);

    expect(provider.markPackageUpdating).toHaveBeenCalledWith('typescript', true);

    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution, exitCode: 1 } as vscode.TaskProcessEndEvent);

    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith('typescript', false);
  });
});
