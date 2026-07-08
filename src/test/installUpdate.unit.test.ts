import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { installUpdateCommand, runInstallCommand, updateAllVisibleCommand } from '../commands';
import { PackageItem } from '../providers/PackageItem';
import { PackagesProvider } from '../providers';

describe('installUpdateCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue({ id: 'task-execution' } as unknown as vscode.TaskExecution);
  });

  it('uses the detected package manager in the update task command', async () => {
    const provider = {
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider;
    vi.mocked(vscode.workspace.findFiles)
      .mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[])
      .mockResolvedValueOnce([{ path: '/workspace/pnpm-lock.yaml' }] as vscode.Uri[]);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

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
    const provider = {
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider;
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);

    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3', '/workspace/package.json');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('shows package update progress while the task runs', async () => {
    const provider = {
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider;
    const execution = { id: 'task-execution' } as unknown as vscode.TaskExecution;
    vi.mocked(vscode.tasks.executeTask).mockResolvedValueOnce(execution);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(provider.markPackageUpdating).toHaveBeenCalledWith('typescript', true, '/workspace/package.json');

    const listener = vi.mocked(vscode.tasks.onDidEndTaskProcess).mock.calls[0][0];
    listener({ execution, exitCode: 1 } as vscode.TaskProcessEndEvent);

    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith('typescript', false, '/workspace/package.json');
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
    const provider = {
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider;

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({ dependencies: { typescript: '^5.9.3' } });
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3', '/workspace/package.json');
  });

  it('updates the clicked devDependencies row when deferred install is enabled', async () => {
    mockDeferredInstall(true);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    }, undefined, 2)));
    const provider = {
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider;

    await installUpdateCommand(
      new PackageItem('typescript', '~5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', true, '~'),
      provider,
    );

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.9.3' },
    });
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3', '/workspace/package.json');
  });

  it('preserves devDependencies when updating through the package manager', async () => {
    const provider = {
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider;
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'pnpm@11.0.8' })),
    );

    await installUpdateCommand(
      new PackageItem('vitest', '^4.0.0', '4.1.0', 'minor', false, undefined, '/workspace/package.json', true, '^'),
      provider,
    );

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe('pnpm add vitest@4.1.0 --save-dev');
  });
});

describe('runInstallCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ fsPath: '/workspace/package.json', path: '/workspace/package.json' }] as vscode.Uri[]);
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

  it('asks for a package root when the workspace has multiple package.json files', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/workspace/package.json', path: '/workspace/package.json' },
      { fsPath: '/workspace/apps/web/package.json', path: '/workspace/apps/web/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: '/workspace/apps/web',
      description: '/workspace/apps/web/package.json',
      packageFilePath: '/workspace/apps/web/package.json',
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );

    await runInstallCommand();

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.options).toEqual({ cwd: '/workspace/apps/web' });
  });
});

describe('updateAllVisibleCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ path: '/workspace/package.json' }] as vscode.Uri[]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{"packageManager":"pnpm@11.0.8"}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue({ id: 'task-execution' } as unknown as vscode.TaskExecution);
  });

  it('runs one batch task for visible outdated packages in immediate mode', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe('pnpm add react@19.0.0 typescript@5.9.3');
  });

  it('updates package.json for all visible outdated packages in deferred mode', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }, undefined, 2)));
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', true, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^19.0.0' },
      devDependencies: { typescript: '^5.9.3' },
    });
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('react', '19.0.0', '/workspace/package.json');
    expect(provider.markPackageUpdated).toHaveBeenCalledWith('typescript', '5.9.3', '/workspace/package.json');
  });

  it('does nothing when there are no visible outdated packages', async () => {
    const provider = makeProvider([]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('updates after confirmation when bulk confirmation is enabled', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: true });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Update All' as never);
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Update 2 packages? This cannot be undone.',
      { modal: true },
      'Update All',
    );
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
  });

  it('does nothing when bulk confirmation is cancelled', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: true });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Update 1 package? This cannot be undone.',
      { modal: true },
      'Update All',
    );
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('skips confirmation when bulk confirmation is disabled', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
  });

  it('splits immediate bulk updates by dependency section', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('vitest', '^4.0.0', '4.1.0', 'minor', false, undefined, '/workspace/package.json', true, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(2);
    const commands = vi.mocked(vscode.tasks.executeTask).mock.calls.map(([task]) => (
      (task.execution as vscode.ShellExecution).commandLine
    ));
    expect(commands).toEqual([
      'pnpm add react@19.0.0',
      'pnpm add vitest@4.1.0 --save-dev',
    ]);
  });
});

function mockDeferredInstall(enabled: boolean): void {
  mockNestroConfiguration({ deferInstallAfterUpdate: enabled });
}

function mockNestroConfiguration(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}

function makeProvider(packages: PackageItem[]): PackagesProvider {
  return {
    getVisibleOutdatedPackages: vi.fn(() => packages),
    invalidateUpdateCache: vi.fn(),
    markPackageUpdated: vi.fn(),
    markPackageUpdating: vi.fn(),
    withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
  } as unknown as PackagesProvider;
}
