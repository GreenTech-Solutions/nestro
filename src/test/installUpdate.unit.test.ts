import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { installUpdateCommand, runInstallCommand, runResolvedPackageVersion, updateAllVisibleCommand } from '../commands';
import { FilterManager, GroupItem, PackageItem, PackagesProvider } from '../providers';
import { logger } from '../utils';
import type { ReleaseAgeState } from '../utils';

const identityMocks = vi.hoisted(() => {
  const makeCapability = (item: {
    packageName: string;
    packageFilePath: string;
    dev: boolean;
    latest?: string;
    installing?: boolean;
    currentVersion?: string;
    releaseAge?: ReleaseAgeState;
  }) => ({
    item: {
      packageName: item.packageName,
      currentVersion: item.currentVersion ?? '',
      latest: item.latest,
      updateType: 'none' as const,
      operation: item.installing
        ? { kind: 'update' as const, target: item.latest ?? item.currentVersion ?? '' }
        : undefined,
      vulnerabilitySeverity: undefined,
      packageFilePath: item.packageFilePath,
      dev: item.dev,
      versionPrefix: item.currentVersion?.match(/^[~^]/)?.[0] ?? '',
      releaseAge: item.releaseAge,
    },
    identity: {
      packageName: item.packageName,
      packageFilePath: item.packageFilePath,
      section: item.dev ? 'devDependencies' as const : 'dependencies' as const,
    },
    packageFilePath: item.packageFilePath,
    packageDirectory: item.packageFilePath.replace(/\/package\.json$/, ''),
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  });
  return {
    makeCapability,
    resolveCommandPackageItem: vi.fn((item: {
      packageName: string;
      packageFilePath: string;
      dev: boolean;
      latest?: string;
      installing?: boolean;
      currentVersion?: string;
      releaseAge?: ReleaseAgeState;
    }) => item.packageFilePath === '' ? undefined : makeCapability(item)),
    revalidateCommandPackageItem: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
  };
});

vi.mock('../commands/packageIdentity', () => identityMocks);

let taskProcessEndListener: ((event: vscode.TaskProcessEndEvent) => unknown) | undefined;
let taskEndListener: ((event: vscode.TaskEndEvent) => unknown) | undefined;
let taskExecutionCount = 0;
const loggerErrorMock = vi.spyOn(logger, 'error');

describe('installUpdateCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identityMocks.resolveCommandPackageItem.mockImplementation(item => item.packageFilePath === '' ? undefined : identityMocks.makeCapability(item));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => capability);
    resetWorkspaceFolders();
    mockTaskListeners();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    mockNextTaskExit(0);
  });

  it('uses the detected package manager in the update task command', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      loadPackages: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    vi.mocked(vscode.workspace.findFiles)
      .mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[])
      .mockResolvedValueOnce([{ path: '/workspace/pnpm-lock.yaml' }] as vscode.Uri[]);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    expect(task.execution).toBeInstanceOf(vscode.ShellExecution);
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe('pnpm add -- typescript@5.9.3');
    expect(task.presentationOptions).toEqual({
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.New,
    });
  });

  it('passes package targets as strongly quoted shell args', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    vi.mocked(vscode.workspace.findFiles)
      .mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[])
      .mockResolvedValueOnce([{ path: '/workspace/pnpm-lock.yaml' }] as vscode.Uri[]);

    // A registry-valid name (apostrophe and asterisk are real, unescaped-by-URL
    // characters) that would still break out of naive shell interpolation.
    await installUpdateCommand(
      new PackageItem('o\'brien-toolkit*', '^1.0.0', '1.0.1', 'patch', false, undefined, '/workspace/package.json', false, '^'),
      provider,
    );

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.command).toBe('pnpm');
    expect(shellExecution.args).toEqual([
      'add',
      '--',
      { value: 'o\'brien-toolkit*@1.0.1', quoting: vscode.ShellQuoting.Strong },
    ]);
  });

  it('marks the package updated after the task exits successfully', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '5.9.3');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('shows package update progress while the task runs', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    mockNextTaskExit(1);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(provider.markPackageUpdating).toHaveBeenCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, { kind: 'update', target: '5.9.3' });
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('shows an error when an update task exits with a non-zero code', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    mockNextTaskExit(1);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: task "Update typescript" failed with exit code 1.',
    );
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('shows an error when an update task ends without an exit code', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    mockNextTaskExit(undefined);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: task "Update typescript" ended without an exit code.',
    );
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('clears package update progress when starting the task throws', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    const error = new Error('task launch failed');
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce(error);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to install update — task launch failed',
    );
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('rejects an option-shaped manifest key before the update task ever launches', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await installUpdateCommand(
      new PackageItem('--global', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'),
      provider,
    );

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot start with a hyphen'),
    );
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
  });

  it('does not run an explicitly resolved version after final identity revalidation fails', async () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^');
    const capability = identityMocks.makeCapability(item);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await runResolvedPackageVersion(capability, '5.9.3', provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('reloads after a deferred write whose new baseline cannot be verified', async () => {
    mockDeferredInstall(true);
    // Persistent, not "once": coordinator key resolution reads this same
    // manifest (for its own ancestor package-manager signal) before the write below
    // does, so both reads must see this content.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
      dependencies: { typescript: '^5.0.0' },
    })));
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^');
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      loadPackages: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    vi.mocked(provider.refreshPackageBaselineForCapability).mockResolvedValueOnce(undefined);

    await runResolvedPackageVersion(identityMocks.makeCapability(item), '5.9.3', provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to install update — Package update could not be verified. Refresh the package list and try again.',
    );
  });

  it('does not launch a task when the second immediate identity check fails', async () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^');
    const capability = identityMocks.makeCapability(item);
    identityMocks.revalidateCommandPackageItem
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(undefined as never);
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await runResolvedPackageVersion(capability, '5.9.3', provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('cancels an explicitly selected risky deferred update before writing', async () => {
    mockDeferredInstall(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const item = new PackageItem(
      'typescript',
      '^5.0.0',
      '5.9.3',
      'minor',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'held-back', version: '5.9.3', eligibleAt: '2026-06-02T00:00:00.000Z' },
    );
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await runResolvedPackageVersion(identityMocks.makeCapability(item), '5.9.3', provider);

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('cancels an explicitly selected risky immediate update before launching a task', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const item = new PackageItem(
      'typescript',
      '^5.0.0',
      '5.9.3',
      'minor',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'held-back', version: '5.9.3', eligibleAt: '2026-06-02T00:00:00.000Z' },
    );
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await runResolvedPackageVersion(identityMocks.makeCapability(item), '5.9.3', provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('updates package.json without running a task when deferred install is enabled', async () => {
    mockDeferredInstall(true);
    // Persistent, not "once": coordinator key resolution reads this same
    // manifest before the write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from([
      '{',
      '  "dependencies": {',
      '    "typescript": "^5.0.0"',
      '  }',
      '}',
      '',
    ].join('\n')));
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({ dependencies: { typescript: '^5.9.3' } });
    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '5.9.3');
  });

  it('updates the clicked devDependencies row when deferred install is enabled', async () => {
    mockDeferredInstall(true);
    // Persistent, not "once": coordinator key resolution reads this same
    // manifest before the write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    }, undefined, 2)));
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

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
    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, '5.9.3');
  });

  it('keeps duplicate dependency rows independent during a deferred update', async () => {
    mockDeferredInstall(true);
    // Persistent, not "once": coordinator key resolution reads this same
    // manifest before the write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    }, undefined, 2)));
    const dependency = new PackageItem(
      'typescript',
      '^4.0.0',
      '4.9.5',
      'minor',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );
    const devDependency = new PackageItem(
      'typescript',
      '~5.0.0',
      '5.9.3',
      'minor',
      false,
      undefined,
      '/workspace/package.json',
      true,
      '~',
    );
    const provider = makeRealProvider([dependency, devDependency]);

    await installUpdateCommand(devDependency, provider);

    expect(getRealProviderPackages(provider).map(item => ({
      currentVersion: item.currentVersion,
      dev: item.dev,
      installing: item.installing,
      updateType: item.updateType,
    }))).toEqual([
      { currentVersion: '^4.0.0', dev: false, installing: false, updateType: 'minor' },
      { currentVersion: '~5.9.3', dev: true, installing: false, updateType: 'none' },
    ]);
    provider.dispose();
  });

  it('does nothing when the package is already installing', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', true, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(provider.markPackageUpdated).not.toHaveBeenCalled();
  });

  it('does nothing when the resolved row has no current latest version', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('typescript', '^5.0.0', undefined, 'none', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(provider.reissuePackageCapability).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('stops a bulk update before progress when its first revalidation rejects', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeProvider([
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'),
    ]);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('stops deferred bulk updates when the second pre-write revalidation rejects', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeProvider([
      new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'),
    ]);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(identityMocks.makeCapability(provider.getVisibleOutdatedPackages()[0]));
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rolls back a partial deferred progress mark without writing', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    const first = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const second = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([first, second]);
    const firstCapability = identityMocks.makeCapability(first);
    const secondCapability = identityMocks.makeCapability(second);
    vi.mocked(provider.reissuePackageCapability)
      .mockResolvedValueOnce(firstCapability)
      .mockResolvedValueOnce(secondCapability)
      .mockResolvedValueOnce(firstCapability)
      .mockResolvedValueOnce(secondCapability);
    vi.mocked(provider.markPackageUpdatingForCapability)
      .mockReturnValueOnce(firstCapability)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(firstCapability);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdatingForCapability).toHaveBeenLastCalledWith(firstCapability, undefined);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('rejects an item without a canonical package file path before any side effect', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await installUpdateCommand(new PackageItem('orphan', '^1.0.0', '1.1.0', 'minor', false, undefined, '', false, '^'), provider);

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('shows a fallback error message when the update fails with a non-Error value', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce('boom' as never);

    await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^'), provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to install update — boom',
    );
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('preserves devDependencies when updating through the package manager', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'pnpm@11.0.8' })),
    );

    await installUpdateCommand(
      new PackageItem('vitest', '^4.0.0', '4.1.0', 'minor', false, undefined, '/workspace/package.json', true, '^'),
      provider,
    );

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe('pnpm add --save-dev -- vitest@4.1.0');
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react', latest: '19.0.0' }],
    ['a primitive value', 'react'],
  ] as const)('safely no-ops instead of dereferencing %s', async (_label, malformedItem) => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);

    await expect(installUpdateCommand(malformedItem as unknown as PackageItem, provider)).resolves.toBeUndefined();

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('fails closed for an argument proxy whose prototype lookup throws', async () => {
    const provider = addCapabilityMethods({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    } as unknown as PackagesProvider);
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('hostile getter');
      },
    });

    await expect(installUpdateCommand(hostile as unknown as PackageItem, provider)).resolves.toBeUndefined();

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('runInstallCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identityMocks.resolveCommandPackageItem.mockImplementation(item => item.packageFilePath === '' ? undefined : identityMocks.makeCapability(item));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => capability);
    resetWorkspaceFolders();
    mockTaskListeners();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ fsPath: '/workspace/package.json', path: '/workspace/package.json' }] as vscode.Uri[]);
    mockNextTaskExit(0);
  });

  it.each([
    ['npm', 'npm install'],
    ['pnpm', 'pnpm install'],
    ['yarn', 'yarn install'],
    ['bun', 'bun install'],
  ] as const)('runs %s install', async (packageManager, command) => {
    // Persistent, not "once": coordinator key resolution reads this same
    // manifest (for its own ancestor package-manager signal) before ClientManager's
    // own detection read does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      Buffer.from(JSON.stringify({ packageManager: `${packageManager}@1.0.0` })),
    );

    await runInstallCommand();

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.commandLine).toBe(command);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('marks every row in the selected manifest while install runs', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );
    const provider = makeProvider([]);
    const identity = {
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies' as const,
    };
    provider.getPackageIdentitiesForFile = vi.fn(() => [identity]);

    await runInstallCommand(provider);

    expect(provider.markPackageUpdating).toHaveBeenNthCalledWith(1, identity, { kind: 'install' });
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith(identity, undefined);
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

  it('disambiguates sibling root manifests with the owning workspace name', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [
        { uri: { fsPath: '/workspace/app' } },
        { uri: { fsPath: '/workspace/app-mobile' } },
      ],
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/workspace/app/package.json', path: '/workspace/app/package.json' },
      { fsPath: '/workspace/app-mobile/package.json', path: '/workspace/app-mobile/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'app-mobile — (root)',
      packageFilePath: '/workspace/app-mobile/package.json',
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );

    await runInstallCommand();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
      { label: 'app — (root)', packageFilePath: '/workspace/app/package.json' },
      { label: 'app-mobile — (root)', packageFilePath: '/workspace/app-mobile/package.json' },
    ], { placeHolder: 'Select the package.json to install dependencies for' });
    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.options).toEqual({ cwd: '/workspace/app-mobile' });
  });

  it('disambiguates two workspace folders sharing the same display name by path suffix', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [
        { uri: { fsPath: '/repos/team-a/service' }, name: 'service', index: 0 },
        { uri: { fsPath: '/repos/team-b/service' }, name: 'service', index: 1 },
      ],
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/repos/team-a/service/package.json', path: '/repos/team-a/service/package.json' },
      { fsPath: '/repos/team-b/service/package.json', path: '/repos/team-b/service/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'team-b/service — (root)',
      packageFilePath: '/repos/team-b/service/package.json',
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );

    await runInstallCommand();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
      { label: 'team-a/service — (root)', packageFilePath: '/repos/team-a/service/package.json' },
      { label: 'team-b/service — (root)', packageFilePath: '/repos/team-b/service/package.json' },
    ], { placeHolder: 'Select the package.json to install dependencies for' });
  });

  it('sorts picker items by workspace index, root first within each workspace', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [
        { uri: { fsPath: '/repos/first' }, name: 'first', index: 0 },
        { uri: { fsPath: '/repos/second' }, name: 'second', index: 1 },
      ],
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/repos/second/apps/web/package.json', path: '/repos/second/apps/web/package.json' },
      { fsPath: '/repos/first/apps/web/package.json', path: '/repos/first/apps/web/package.json' },
      { fsPath: '/repos/second/package.json', path: '/repos/second/package.json' },
      { fsPath: '/repos/first/package.json', path: '/repos/first/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'first — (root)',
      packageFilePath: '/repos/first/package.json',
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );

    await runInstallCommand();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
      { label: 'first — (root)', packageFilePath: '/repos/first/package.json' },
      { label: 'first — apps/web', packageFilePath: '/repos/first/apps/web/package.json' },
      { label: 'second — (root)', packageFilePath: '/repos/second/package.json' },
      { label: 'second — apps/web', packageFilePath: '/repos/second/apps/web/package.json' },
    ], { placeHolder: 'Select the package.json to install dependencies for' });
  });

  it('keeps picker labels aligned with filtered tree labels from the full manifest set', async () => {
    const paths = [
      '/workspace/0-é-empty/package.json',
      '/workspace/α/package.json',
      '/workspace/β/package.json',
    ];
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce(
      paths.map(fsPath => ({ fsPath, path: fsPath })) as vscode.Uri[],
    );
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'workspace — β [unicode #3]',
      packageFilePath: paths[2],
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );

    await runInstallCommand();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
      { label: 'workspace — 0-é-empty [unicode #1]', packageFilePath: paths[0] },
      { label: 'workspace — α [unicode #2]', packageFilePath: paths[1] },
      { label: 'workspace — β [unicode #3]', packageFilePath: paths[2] },
    ], { placeHolder: 'Select the package.json to install dependencies for' });
    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.options).toEqual({ cwd: '/workspace/β' });
  });

  it('shows an error when the install task exits with a non-zero code', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );
    mockNextTaskExit(1);

    await runInstallCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: task "Install Dependencies" failed with exit code 1.',
    );
  });

  it('shows an error when the install task ends without an exit code', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );
    mockNextTaskExit(undefined);

    await runInstallCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: task "Install Dependencies" ended without an exit code.',
    );
  });

  it('shows an error when no workspace package.json is found', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([]);

    await runInstallCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to run install — No workspace package.json found.',
    );
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('quietly returns when the package root prompt is cancelled', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/workspace/package.json', path: '/workspace/package.json' },
      { fsPath: '/workspace/apps/web/package.json', path: '/workspace/apps/web/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    await runInstallCommand();

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('shows an error when package root discovery fails', async () => {
    const error = new Error('workspace search failed');
    vi.mocked(vscode.workspace.findFiles).mockRejectedValueOnce(error);

    await runInstallCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to run install — workspace search failed',
    );
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('uses a sanitized fallback label for a package file outside known workspace folders', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/external/project/package.json', path: '/external/project/package.json' },
      { fsPath: '/workspace/package.json', path: '/workspace/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: '/external/project',
      packageFilePath: '/external/project/package.json',
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );

    await runInstallCommand();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
      { label: 'workspace — (root)', packageFilePath: '/workspace/package.json' },
      { label: '/external/project', packageFilePath: '/external/project/package.json' },
    ], { placeHolder: 'Select the package.json to install dependencies for' });
  });

  it('shows a fallback error message when install fails with a non-Error value', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce('install boom' as never);

    await runInstallCommand();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to run install — install boom',
    );
  });
});

describe('updateAllVisibleCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identityMocks.resolveCommandPackageItem.mockImplementation(item => item.packageFilePath === '' ? undefined : identityMocks.makeCapability(item));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => capability);
    resetWorkspaceFolders();
    mockTaskListeners();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ path: '/workspace/package.json' }] as vscode.Uri[]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{"packageManager":"pnpm@11.0.8"}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    mockNextTaskExit(0);
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
    expect(shellExecution.commandLine).toBe('pnpm add -- react@19.0.0 typescript@5.9.3');
  });

  it('updates package.json for all visible outdated packages in deferred mode', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    // Persistent, not "once": the coordinator resolves a project-root key per
    // touched capability (reading this same manifest) before the bulk write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
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
    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '19.0.0');
    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, '5.9.3');
  });

  it('updates duplicate dependency rows independently in a deferred bulk update', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    // Persistent, not "once": the coordinator resolves a project-root key per
    // touched capability (reading this same manifest) before the bulk write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { react: '~18.1.0' },
    }, undefined, 2)));
    const provider = makeRealProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('react', '~18.1.0', '18.3.1', 'minor', false, undefined, '/workspace/package.json', true, '~'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(getRealProviderPackages(provider).map(item => ({
      currentVersion: item.currentVersion,
      dev: item.dev,
      installing: item.installing,
      updateType: item.updateType,
    }))).toEqual([
      { currentVersion: '^19.0.0', dev: false, installing: false, updateType: 'none' },
      { currentVersion: '~18.3.1', dev: true, installing: false, updateType: 'none' },
    ]);
    provider.dispose();
  });

  it('prevents partial writes when a deferred bulk update spans files and a write fails', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    // Path-aware, not a fixed once-chain: the coordinator resolves a
    // project-root key per touched manifest (reading each one) before the bulk write
    // below reads them again, so the same path must return the same content on every
    // call regardless of which caller or how many times it reads.
    mockReadFileByPath({
      '/workspace/package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }, undefined, 2),
      '/workspace/apps/web/package.json': JSON.stringify({ dependencies: { vite: '^5.0.0' } }, undefined, 2),
    });
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation((uri, content) => {
      writeCount++;
      if (writeCount === 2) {
        return Promise.reject(new Error('second write failed'));
      }
      return Promise.resolve();
    });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('vite', '^5.0.0', '5.1.0', 'minor', false, undefined, '/workspace/apps/web/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    const writeCalls = vi.mocked(vscode.workspace.fs.writeFile).mock.calls;
    expect(writeCount).toBe(3);
    expect(writeCalls).toHaveLength(3);
    expect(writeCalls[1][0].fsPath).toBe('/workspace/apps/web/package.json');
    expect(Buffer.from(writeCalls[1][1]).toString('utf8'))
      .toContain('"vite": "^5.1.0"');
    expect(writeCalls[2][0].fsPath)
      .toBe('/workspace/package.json');
    expect(Buffer.from(writeCalls[2][1]).toString('utf8'))
      .toContain('"react": "^18.0.0"');
    expect(provider.markPackageUpdating).toHaveBeenCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
    expect(provider.markPackageUpdating).toHaveBeenCalledWith({
      packageName: 'vite',
      packageFilePath: '/workspace/apps/web/package.json',
      section: 'dependencies',
    }, undefined);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to update packages — second write failed',
    );
  });

  it('surfaces rollback failures after a deferred bulk write failure', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    // Path-aware, not a fixed once-chain: see the previous test for why.
    mockReadFileByPath({
      '/workspace/package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }, undefined, 2),
      '/workspace/apps/web/package.json': JSON.stringify({ dependencies: { vite: '^5.0.0' } }, undefined, 2),
    });
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(() => {
      writeCount++;
      if (writeCount === 2) {
        return Promise.reject(new Error('second write failed'));
      }
      if (writeCount === 3) {
        return Promise.reject(new Error('rollback failed'));
      }
      return Promise.resolve();
    });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('vite', '^5.0.0', '5.1.0', 'minor', false, undefined, '/workspace/apps/web/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to update packages — second write failed; failed to roll back: package.json',
    );
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

  it('asks for a separate confirmation before a risky bulk update', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Update Risky Packages' as never);
    const provider = makeProvider([
      new PackageItem(
        'react',
        '^18.0.0',
        '19.0.0',
        'breaking',
        false,
        undefined,
        '/workspace/package.json',
        false,
        '^',
        { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
      ),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('inside the minimum release-age window'),
      { modal: true },
      'Update Risky Packages',
    );
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
  });

  it('cancels a risky bulk update before any task starts', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const provider = makeProvider([
      new PackageItem(
        'react',
        '^18.0.0',
        '19.0.0',
        'breaking',
        false,
        undefined,
        '/workspace/package.json',
        false,
        '^',
        { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
      ),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('rechecks a newly risky deferred bulk update before marking progress', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const safeItem = new PackageItem(
      'react',
      '^18.0.0',
      '19.0.0',
      'breaking',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );
    const safe = identityMocks.makeCapability(safeItem);
    const risky = identityMocks.makeCapability(new PackageItem(
      'react',
      '^18.0.0',
      '19.0.0',
      'breaking',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
    ));
    const provider = makeProvider([safeItem]);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(safe).mockResolvedValueOnce(risky);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('inside the minimum release-age window'),
      { modal: true },
      'Update Risky Packages',
    );
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rechecks a newly risky immediate bulk update before launching a task', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const safeItem = new PackageItem(
      'react',
      '^18.0.0',
      '19.0.0',
      'breaking',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );
    const safe = identityMocks.makeCapability(safeItem);
    const risky = identityMocks.makeCapability(new PackageItem(
      'react',
      '^18.0.0',
      '19.0.0',
      'breaking',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
    ));
    const provider = makeProvider([safeItem]);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(safe).mockResolvedValueOnce(safe).mockResolvedValueOnce(risky);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('inside the minimum release-age window'),
      { modal: true },
      'Update Risky Packages',
    );
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
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
      'pnpm add -- react@19.0.0',
      'pnpm add --save-dev -- vitest@4.1.0',
    ]);
  });

  it('rejects an option-shaped manifest key before any batch task launches', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('--global', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot start with a hyphen'),
    );
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('rejects a whole group when it mixes a valid and an option-shaped manifest key', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('--global', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot start with a hyphen'),
    );
    expect(provider.markPackageUpdated).not.toHaveBeenCalled();
  });

  it('runs an earlier valid group before a later group is rejected for an option-shaped key', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('--global', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', true, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    expect((task.execution as vscode.ShellExecution).commandLine).toBe('pnpm add -- react@19.0.0');
    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '19.0.0');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot start with a hyphen'),
    );
  });

  it('stops an immediate group when its group revalidation rejects', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(capability).mockResolvedValueOnce(undefined);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('stops an immediate group when its final task-bound revalidation rejects', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability)
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(undefined);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('clears partial immediate progress when the task boundary cannot mark every row', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const first = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const second = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([first, second]);
    const firstCapability = identityMocks.makeCapability(first);
    const secondCapability = identityMocks.makeCapability(second);
    vi.mocked(provider.reissuePackageCapability)
      .mockResolvedValueOnce(firstCapability)
      .mockResolvedValueOnce(secondCapability)
      .mockResolvedValueOnce(firstCapability)
      .mockResolvedValueOnce(secondCapability)
      .mockResolvedValueOnce(firstCapability)
      .mockResolvedValueOnce(secondCapability);
    vi.mocked(provider.markPackageUpdatingForCapability)
      .mockReturnValueOnce(firstCapability)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(firstCapability);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdatingForCapability).toHaveBeenLastCalledWith(firstCapability, undefined);
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('reports a successful task whose refreshed baseline cannot be verified', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability)
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(capability);
    vi.mocked(provider.refreshPackageBaselineForCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to update packages — Package update could not be verified. Refresh the package list and try again.',
    );
  });

  it('reloads after a deferred bulk write whose refreshed baseline cannot be verified', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    // Persistent, not "once": the coordinator resolves a project-root key
    // (reading this same manifest) before the bulk write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
    })));
    const item = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(capability).mockResolvedValueOnce(capability);
    vi.mocked(provider.refreshPackageBaselineForCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to update packages — Package update could not be verified. Refresh the package list and try again.',
    );
  });

  it('rejects an installing row during a final bulk identity check', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^');
    const provider = makeProvider([item]);
    const current = identityMocks.makeCapability(item);
    const installing = identityMocks.makeCapability(new PackageItem(
      'react', '^18.0.0', '19.0.0', 'breaking', true, undefined, '/workspace/package.json', false, '^',
    ));
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(current).mockResolvedValueOnce(installing);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('returns after a non-zero immediate bulk task without starting later groups', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    mockNextTaskExit(1);
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: task "Update All Packages" failed with exit code 1.',
    );
  });

  it('waits for each immediate bulk update task before starting the next one', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const firstExecution = { id: 'first-task' } as unknown as vscode.TaskExecution;
    const secondExecution = { id: 'second-task' } as unknown as vscode.TaskExecution;
    vi.mocked(vscode.tasks.executeTask)
      .mockResolvedValueOnce(firstExecution)
      .mockResolvedValueOnce(secondExecution);
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('vitest', '^4.0.0', '4.1.0', 'minor', false, undefined, '/workspace/package.json', true, '^'),
    ]);

    const result = updateAllVisibleCommand(provider);
    await vi.waitFor(() => expect(vscode.tasks.onDidEndTaskProcess).toHaveBeenCalledTimes(1));
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    taskProcessEndListener?.({ execution: firstExecution, exitCode: 0 } as vscode.TaskProcessEndEvent);
    await vi.waitFor(() => expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(2));
    taskProcessEndListener?.({ execution: secondExecution, exitCode: 0 } as vscode.TaskProcessEndEvent);
    await result;

    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '19.0.0');
    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'vitest',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, '4.1.0');
  });

  it('shows a fallback error message when a bulk update fails with a non-Error value', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce('bulk boom' as never);
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: failed to update packages — bulk boom',
    );
  });

  it('rejects a bulk update when any visible row lacks a canonical package file path', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    const provider = makeProvider([
      new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', false, undefined, '/workspace/package.json', false, '^'),
      new PackageItem('orphan', '^1.0.0', '1.1.0', 'minor', false, undefined, '', false, '^'),
    ]);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});

function mockTaskListeners(): void {
  taskProcessEndListener = undefined;
  taskEndListener = undefined;
  taskExecutionCount = 0;
  vi.mocked(vscode.tasks.onDidEndTaskProcess).mockImplementation((listener) => {
    taskProcessEndListener = listener;
    return { dispose: vi.fn() } as vscode.Disposable;
  });
  vi.mocked(vscode.tasks.onDidEndTask).mockImplementation((listener) => {
    taskEndListener = listener;
    return { dispose: vi.fn() } as vscode.Disposable;
  });
}

function resetWorkspaceFolders(): void {
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    value: [{ uri: { fsPath: '/workspace' } }],
  });
}

function mockNextTaskExit(exitCode: number | undefined): void {
  vi.mocked(vscode.tasks.executeTask).mockImplementation(() => {
    taskExecutionCount += 1;
    const execution = { id: `task-execution-${taskExecutionCount}` } as unknown as vscode.TaskExecution;
    setTimeout(() => {
      if (exitCode === undefined) {
        taskEndListener?.({ execution } as vscode.TaskEndEvent);
        return;
      }
      taskProcessEndListener?.({ execution, exitCode } as vscode.TaskProcessEndEvent);
    }, 0);
    return Promise.resolve(execution);
  });
}

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

/**
 * Stub `vscode.workspace.fs.readFile` by path rather than by call order. Needed
 * whenever a test spans more than one manifest: the coordinator resolves a
 * project-root key per touched manifest (reading it) before the real read/write flow
 * reads the same file again, so a fixed `mockResolvedValueOnce` chain no longer lines
 * up with which caller reads which file first.
 */
function mockReadFileByPath(contentsByPath: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
    const content = contentsByPath[uri.fsPath];
    return Promise.resolve(Buffer.from(content ?? '{}'));
  });
}

function makeProvider(packages: PackageItem[]): PackagesProvider {
  return addCapabilityMethods({
    getVisibleOutdatedPackages: vi.fn(() => packages),
    invalidateUpdateCache: vi.fn(),
    loadPackages: vi.fn(),
    markPackageUpdated: vi.fn(),
    markPackageUpdating: vi.fn(),
    withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
  } as unknown as PackagesProvider);
}

function addCapabilityMethods(provider: PackagesProvider): PackagesProvider {
  provider.refreshPackageBaselineForCapability = vi.fn(capability => Promise.resolve(capability));
  provider.reissuePackageCapability = vi.fn(capability => Promise.resolve(capability));
  provider.markPackageUpdatedForCapability = vi.fn((capability, version) => {
    provider.markPackageUpdated(capability.identity, version);
  });
  provider.markPackageUpdatingForCapability = vi.fn((capability, installing) => {
    provider.markPackageUpdating(capability.identity, installing);
    return capability;
  });
  return provider;
}

function makeRealProvider(packages: PackageItem[]): PackagesProvider {
  const provider = new PackagesProvider(new FilterManager('all'));
  Object.assign(provider as unknown as Record<string, unknown>, {
    allEntries: packages.map(item => ({
      item,
      dev: item.dev,
      packageFilePath: item.packageFilePath,
    })),
    loading: false,
  });
  provider.loadPackages = vi.fn();
  provider.refreshPackageBaselineForCapability = vi.fn(capability => Promise.resolve(capability));
  provider.reissuePackageCapability = vi.fn(capability => Promise.resolve(capability));
  provider.markPackageUpdatedForCapability = vi.fn((capability, version) => {
    provider.markPackageUpdated(capability.identity, version);
  });
  provider.markPackageUpdatingForCapability = vi.fn((capability, installing) => {
    provider.markPackageUpdating(capability.identity, installing);
    return capability;
  });
  return provider;
}

function getRealProviderPackages(provider: PackagesProvider): PackageItem[] {
  return provider.getChildren()
    .filter((item): item is GroupItem => item instanceof GroupItem)
    .flatMap(group => group.children)
    .filter((item): item is PackageItem => item instanceof PackageItem);
}