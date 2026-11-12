import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildPackageItem, setWorkspaceFolders } from './fixtures';
import { expectErrorNotification, expectLocalizedErrorNotification, getIdentityMocks, getRealProviderPackages, makeInstallUpdateProvider, makeRealProvider, mockDeferredInstall, mockNextTaskExit, mockTaskListeners, unverifiedUpdateMessage } from './fixtures/installUpdateHarness';
import { mockNestroConfiguration } from './fixtures/config';
import { makeProvider } from './fixtures/providerStub';
import { mockWorkspaceFiles } from './fixtures/workspaceFs';
import { installUpdateCommand, runResolvedPackageVersion, updateAllVisibleCommand } from '../commands';
import { PackageItem } from '../providers/PackageItem';
import { formatShellTaskFailureMessage } from '../utils';

const identityMocks = getIdentityMocks();

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), realpath: (value: string) => Promise.resolve(value) }));

vi.mock('../commands/packageIdentity', async () => (await import('./fixtures/installUpdateHarness')).getIdentityMocks());

const mockWorkspaceWithLockfile = (lockfileName: 'pnpm-lock.yaml' | 'yarn.lock'): void =>
  mockWorkspaceFiles({ '/workspace/package.json': '{}', [`/workspace/${lockfileName}`]: '' });

describe('installUpdateCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identityMocks.resolveCommandPackageItem.mockImplementation(item => item.packageFilePath === '' ? undefined : identityMocks.makeCapability(item));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => capability);
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    mockTaskListeners();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    mockNextTaskExit(0);
  });

  it('uses the detected package manager in the update task command', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      loadPackages: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    mockWorkspaceWithLockfile('pnpm-lock.yaml');

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' }), provider);

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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    mockWorkspaceWithLockfile('yarn.lock');

    // A registry-valid name (apostrophe and asterisk are real, unescaped-by-URL
    // characters) that would still break out of naive shell interpolation.
    await installUpdateCommand(
      buildPackageItem({ name: 'o\'brien-toolkit*', currentVersion: '^1.0.0', latest: '1.0.1', updateType: 'patch', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      provider,
    );

    const task = vi.mocked(vscode.tasks.executeTask).mock.calls[0][0];
    const shellExecution = task.execution as vscode.ShellExecution;
    expect(shellExecution.command).toBe('yarn');
    expect(shellExecution.args).toEqual([
      'add',
      '--',
      { value: 'o\'brien-toolkit*@1.0.1', quoting: vscode.ShellQuoting.Strong },
    ]);
  });

  it('marks the package updated after the task exits successfully', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

    expect(provider.markPackageUpdated).toHaveBeenCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '5.9.3');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('shows package update progress while the task runs', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    mockNextTaskExit(1);

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    mockNextTaskExit(1);

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

    expectErrorNotification(formatShellTaskFailureMessage('Update typescript', 1));
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('shows an error when an update task ends without an exit code', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    mockNextTaskExit(undefined);

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

    expectErrorNotification(formatShellTaskFailureMessage('Update typescript', undefined));
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('clears package update progress when starting the task throws', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    const error = new Error('task launch failed');
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce(error);

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

    expectLocalizedErrorNotification('failed to install update — {0}', 'task launch failed');
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('rejects an option-shaped manifest key before the update task ever launches', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await installUpdateCommand(
      buildPackageItem({ name: '--global', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      provider,
    );

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot start with a hyphen'),
    );
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
  });

  it('does not run an explicitly resolved version after final identity revalidation fails', async () => {
    const item = buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const capability = identityMocks.makeCapability(item);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

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
    const item = buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      loadPackages: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    vi.mocked(provider.refreshPackageBaselineForCapability).mockResolvedValueOnce(undefined);

    await runResolvedPackageVersion(identityMocks.makeCapability(item), '5.9.3', provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expectErrorNotification(vscode.l10n.t('failed to install update — {0}', unverifiedUpdateMessage()));
  });

  it('does not launch a task when the second immediate identity check fails', async () => {
    const item = buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const capability = identityMocks.makeCapability(item);
    identityMocks.revalidateCommandPackageItem
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(undefined as never);
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await runResolvedPackageVersion(capability, '5.9.3', provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('cancels an explicitly selected risky deferred update before writing', async () => {
    mockDeferredInstall(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const item = buildPackageItem({
      name: 'typescript',
      currentVersion: '^5.0.0',
      latest: '5.9.3',
      updateType: 'minor',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
      releaseAge: { kind: 'held-back', version: '5.9.3', eligibleAt: '2026-06-02T00:00:00.000Z' },
    });
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await runResolvedPackageVersion(identityMocks.makeCapability(item), '5.9.3', provider);

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('cancels an explicitly selected risky immediate update before launching a task', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const item = buildPackageItem({
      name: 'typescript',
      currentVersion: '^5.0.0',
      latest: '5.9.3',
      updateType: 'minor',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
      releaseAge: { kind: 'held-back', version: '5.9.3', eligibleAt: '2026-06-02T00:00:00.000Z' },
    });
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await installUpdateCommand(
      buildPackageItem({ name: 'typescript', currentVersion: '~5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '~' }),
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
    const dependency = buildPackageItem({
      name: 'typescript',
      currentVersion: '^4.0.0',
      latest: '4.9.5',
      updateType: 'minor',
      packageFilePath: '/workspace/package.json',
      dev: false,
      versionPrefix: '^',
    });
    const devDependency = buildPackageItem({
      name: 'typescript',
      currentVersion: '~5.0.0',
      latest: '5.9.3',
      updateType: 'minor',
      packageFilePath: '/workspace/package.json',
      dev: true,
      versionPrefix: '~',
    });
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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', operation: true, packageFilePath: '/workspace/package.json', versionPrefix: '^' }), provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(provider.markPackageUpdated).not.toHaveBeenCalled();
  });

  it('does nothing when the resolved row has no current latest version', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(provider.reissuePackageCapability).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('stops a bulk update before progress when its first revalidation rejects', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('stops deferred bulk updates when the second pre-write revalidation rejects', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(identityMocks.makeCapability(provider.getVisibleOutdatedPackages()[0]));
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rolls back a partial deferred progress mark without writing', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    const first = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const second = buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([first, second]);
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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await installUpdateCommand(buildPackageItem({ name: 'orphan', currentVersion: '^1.0.0', latest: '1.1.0', updateType: 'minor', packageFilePath: '', versionPrefix: '^' }), provider);

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('shows a fallback error message when the update fails with a non-Error value', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    vi.mocked(vscode.tasks.executeTask).mockRejectedValueOnce('boom' as never);

    await installUpdateCommand(buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }), provider);

    expect(vscode.l10n.t).toHaveBeenCalledWith('failed to install update — {0}', 'boom');
    expectLocalizedErrorNotification('failed to install update — {0}', 'boom');
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'typescript',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it('preserves devDependencies when updating through the package manager', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'pnpm@11.0.8' })),
    );

    await installUpdateCommand(
      buildPackageItem({ name: 'vitest', currentVersion: '^4.0.0', latest: '4.1.0', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' }),
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
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });

    await expect(installUpdateCommand(malformedItem as unknown as PackageItem, provider)).resolves.toBeUndefined();

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('fails closed for an argument proxy whose prototype lookup throws', async () => {
    const provider = makeProvider({
      invalidateUpdateCache: vi.fn(),
      markPackageUpdated: vi.fn(),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
    });
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