import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { installUpdateCommand, runInstallCommand, updateAllVisibleCommand } from '../commands';
import { PackageItem } from '../providers/PackageItem';
import { PackagesProvider } from '../providers';

describe('installUpdateCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
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

  it('updates package.json without running a task when deferred install is enabled', async () => {
    mockDeferredInstall(true);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from([
      '{',
      '  "dependencies": {',
      '    "typescript": "^5.0.0"',
      '  }',
      '}',
      '',
    ].join('\n')));
    const provider = { markPackageUpdated: vi.fn(), markPackageUpdating: vi.fn() } as unknown as PackagesProvider;

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'), provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({ dependencies: { typescript: '5.9.3' } });
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3');
  });
});

describe('runInstallCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ path: '/workspace/package.json' }] as vscode.Uri[]);
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue({ id: 'task-execution' } as unknown as vscode.TaskExecution);
  });

  it.each([
    ['npm', 'npm install'],
    ['pnpm', 'pnpm install'],
    ['yarn', 'yarn install'],
    ['bun', 'bun install'],
  ] as const)('runs %s install', async (packageManager, command) => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: `${packageManager}@1.0.0` })),
    );

    await runInstallCommand();

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe(command);
  });
});

describe('updateAllVisibleCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ path: '/workspace/package.json' }] as vscode.Uri[]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{"packageManager":"pnpm@11.0.8"}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue({ id: 'task-execution' } as unknown as vscode.TaskExecution);
  });

  it('runs one batch task for visible outdated packages in immediate mode', async () => {
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking'),
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'),
    ]);

    await updateAllVisibleCommand(provider);

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe('pnpm add react@19.0.0 typescript@5.9.3');
  });

  it('updates package.json for all visible outdated packages in deferred mode', async () => {
    mockDeferredInstall(true);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }, undefined, 2)));
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking'),
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '19.0.0' },
      devDependencies: { typescript: '5.9.3' },
    });
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('react', '19.0.0');
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3');
  });

  it('does nothing when there are no visible outdated packages', async () => {
    const provider = makeProvider([]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});

function mockDeferredInstall(enabled: boolean): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => key === 'deferInstallAfterUpdate' ? enabled : defaultValue),
  } as unknown as vscode.WorkspaceConfiguration);
}

function makeProvider(packages: PackageItem[]): PackagesProvider {
  return {
    getVisibleOutdatedPackages: vi.fn(() => packages),
    markPackageUpdated: vi.fn(),
    markPackageUpdating: vi.fn(),
  } as unknown as PackagesProvider;
}