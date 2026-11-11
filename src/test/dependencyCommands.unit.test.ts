import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { makeProvider } from './fixtures/providerStub';
import { buildPackageItem } from './fixtures';
import { pinVersionCommand } from '../commands/pinVersion';
import { removePackageCommand } from '../commands/removePackage';
import { switchDepTypeCommand } from '../commands/switchDepType';
import { installUpdateCommand, updateAllVisibleCommand } from '../commands/installUpdate';
import { runInstallCommand } from '../commands/runInstall';
import { PackageItem } from '../providers/PackageItem';
import {
  DependencyTypeConflictError,
  logger,
  setVersionPin,
  showError,
  switchDependencyType,
} from '../utils';

const identityMocks = vi.hoisted(() => {
  const makeCapability = (item: {
    packageName: string;
    packageFilePath: string;
    dev: boolean;
    versionPrefix?: string;
  }) => ({
    item,
    identity: {
      packageName: item.packageName,
      packageFilePath: item.packageFilePath,
      section: item.dev ? 'devDependencies' : 'dependencies',
    },
    packageFilePath: item.packageFilePath,
    packageDirectory: item.packageFilePath.replace(/\/package\.json$/, ''),
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  });
  return {
    resolveCommandPackageItem: vi.fn((item: {
      packageName: string;
      packageFilePath: string;
      dev: boolean;
      versionPrefix?: string;
    }) => item.packageFilePath === '' ? undefined : makeCapability(item)),
    resolveManifestEntry: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
    revalidateCommandPackageItem: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
  };
});

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), realpath: (value: string) => Promise.resolve(value) }));

vi.mock('../commands/packageIdentity', () => identityMocks);

const executeTaskMock = vi.mocked(vscode.tasks.executeTask);
const onDidEndTaskProcessMock = vi.mocked(vscode.tasks.onDidEndTaskProcess);
const onDidEndTaskMock = vi.mocked(vscode.tasks.onDidEndTask);
let taskProcessEndListener: ((event: vscode.TaskProcessEndEvent) => unknown) | undefined;
let taskEndListener: ((event: vscode.TaskEndEvent) => unknown) | undefined;
let taskExecutionCount = 0;

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    setVersionPin: vi.fn(),
    showError: vi.fn(),
    switchDependencyType: vi.fn(),
  };
});

vi.mock('../clients', async () => {
  const actual = await vi.importActual<typeof import('../clients')>('../clients');
  return {
    ...actual,
    ClientManager: vi.fn(function (this: { getClient: ReturnType<typeof vi.fn> }) {
      this.getClient = vi.fn(() => Promise.resolve(new actual.PackageManagerClient('npm', '/workspace')));
    }),
  };
});

describe('switchDepTypeCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves the package between dependency buckets and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
    });

    await switchDepTypeCommand(item, provider);

    expect(switchDependencyType).toHaveBeenCalledWith('/workspace/package.json', 'react', false, '^18.0.0');
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('stops before switching when progress marking loses the row', async () => {
    const provider = makeProvider();
    provider.markPackageUpdatingForCapability = vi.fn(() => undefined);

    await switchDepTypeCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }),
      provider,
    );

    expect(switchDependencyType).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
  });

  it('moves a devDependency back to dependencies', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      dev: true,
      versionPrefix: '^',
    });

    await switchDepTypeCommand(item, provider);

    expect(switchDependencyType).toHaveBeenCalledWith('/workspace/package.json', 'react', true, '^18.0.0');
  });

  it('stops before a write when the provider cannot resolve the current row', async () => {
    identityMocks.resolveCommandPackageItem.mockResolvedValueOnce(undefined);
    const provider = makeProvider();

    await switchDepTypeCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }),
      provider,
    );

    expect(switchDependencyType).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
  });

  it('stops before a write when final dependency-type revalidation fails', async () => {
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeProvider();

    await switchDepTypeCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }),
      provider,
    );

    expect(switchDependencyType).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('write failed'), 'write failed'],
    ['a non-Error value', 'write boom', 'write boom'],
  ] as const)('shows an error without reloading when switching fails with %s', async (_label, rejection, expectedMessage) => {
    vi.mocked(switchDependencyType).mockRejectedValueOnce(rejection);
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
    });

    await switchDepTypeCommand(item, provider);

    expect(showError).toHaveBeenCalledWith(`failed to switch dependency type — ${expectedMessage}`, rejection);
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it('shows both specs and does not reload when the target section already contains the package', async () => {
    const conflict = new DependencyTypeConflictError('react', '^18.0.0', '^18.0.0', '~17.0.0');
    vi.mocked(switchDependencyType).mockRejectedValueOnce(conflict);
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
    });

    await switchDepTypeCommand(item, provider);

    expect(showError).toHaveBeenCalledWith(expect.stringContaining('^18.0.0'));
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('~17.0.0'));
    expect(showError).toHaveBeenCalledWith(expect.not.stringContaining('/workspace/package.json'));
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react', packageFilePath: '/workspace/package.json' }],
  ] as const)('safely no-ops instead of dereferencing %s', async (_label, malformedItem) => {
    const provider = makeProvider();

    await switchDepTypeCommand(malformedItem as unknown as PackageItem, provider);

    expect(switchDependencyType).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('pinVersionCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pins a caret-prefixed package and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
    });

    await pinVersionCommand(item, provider);

    expect(identityMocks.resolveManifestEntry).toHaveBeenCalledWith(expect.any(Object), provider, 'allow');
    expect(identityMocks.resolveManifestEntry).not.toHaveBeenCalledWith(expect.any(Object), provider, 'reject');
    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', 'dependencies', '^18.0.0', true);
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('unpins a bare package and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '18.0.0',
      packageFilePath: '/workspace/package.json',
    });

    await pinVersionCommand(item, provider);

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', 'dependencies', '18.0.0', false);
  });

  it('pins a caret-prefixed devDependency using the devDependencies section explicitly', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'vitest',
      currentVersion: '^2.0.0',
      packageFilePath: '/workspace/package.json',
      dev: true,
      versionPrefix: '^',
    });

    await pinVersionCommand(item, provider);

    expect(identityMocks.resolveManifestEntry).toHaveBeenCalledWith(expect.any(Object), provider, 'allow');
    expect(identityMocks.resolveManifestEntry).not.toHaveBeenCalledWith(expect.any(Object), provider, 'reject');
    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'vitest', 'devDependencies', '^2.0.0', true);
  });

  it('pins a caret-prefixed workspace: range without corrupting the protocol', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'internal-lib',
      currentVersion: 'workspace:^1.2.3',
      packageFilePath: '/workspace/package.json',
    });

    await pinVersionCommand(item, provider);

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'internal-lib', 'dependencies', 'workspace:^1.2.3', true);
  });

  it.each([
    ['workspace:*', 'workspace range is not a concrete version (wildcard version range)'],
    ['file:../local-pkg', 'local file dependency'],
    ['git+https://github.com/foo/bar.git', 'git dependency'],
    ['npm:real-pkg@^1.2.3', 'npm alias dependency'],
    ['>=1.2.3 <2.0.0', 'compound version range'],
  ] as const)('leaves the file untouched and reports why for unsupported spec %s', async (currentVersion, reason) => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'pkg',
      currentVersion,
      packageFilePath: '/workspace/package.json',
    });

    await pinVersionCommand(item, provider);

    expect(setVersionPin).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(`cannot toggle version pin for pkg — ${reason}`);
  });

  it('stops before pinning when identity or manifest validation fails', async () => {
    identityMocks.resolveCommandPackageItem.mockResolvedValueOnce(undefined);
    const provider = makeProvider();
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' });

    await pinVersionCommand(item, provider);
    expect(setVersionPin).not.toHaveBeenCalled();

    identityMocks.resolveManifestEntry.mockResolvedValueOnce(undefined as never);
    await pinVersionCommand(item, provider);
    expect(setVersionPin).not.toHaveBeenCalled();
  });

  it('stops before pinning when progress marking loses the row', async () => {
    const provider = makeProvider();
    provider.markPackageUpdatingForCapability = vi.fn(() => undefined);

    await pinVersionCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }),
      provider,
    );

    expect(setVersionPin).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('pin write failed'), 'pin write failed'],
    ['a non-Error value', 'pin boom', 'pin boom'],
  ] as const)('shows an error without reloading when pinning fails with %s', async (_label, rejection, expectedMessage) => {
    vi.mocked(setVersionPin).mockRejectedValueOnce(rejection);
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
    });

    await pinVersionCommand(item, provider);

    expect(showError).toHaveBeenCalledWith(`failed to toggle version pin — ${expectedMessage}`, rejection);
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react', versionPrefix: '^' }],
  ] as const)('safely no-ops instead of dereferencing %s', async (_label, malformedItem) => {
    const provider = makeProvider();

    await pinVersionCommand(malformedItem as unknown as PackageItem, provider);

    expect(setVersionPin).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('removePackageCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskListeners();
    mockNextTaskExit(0);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Remove Package' as never);
  });

  it('runs the package manager remove command and reloads packages after success', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      packageFilePath: '/workspace/package.json',
      dev: false,
      versionPrefix: '^',
    });
    const execution = {} as vscode.TaskExecution;
    executeTaskMock.mockImplementationOnce(() => {
      setTimeout(() => {
        taskProcessEndListener?.({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);
      }, 0);
      return Promise.resolve(execution);
    });

    await removePackageCommand(item, provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Remove react from dependencies?',
      { modal: true },
      'Remove Package',
    );
    expect(executeTaskMock).toHaveBeenCalledTimes(1);
    const task = executeTaskMock.mock.calls[0][0];
    expect(task.definition).toEqual({ type: 'shell' });
    expect(task.name).toBe('Remove react');
    expect(provider.markPackageUpdating).toHaveBeenCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, { kind: 'remove' });
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the user cancels removal', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

    await removePackageCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }),
      makeProvider(),
    );

    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('shows an error and reloads packages when remove exits with a non-zero code', async () => {
    const provider = makeProvider();
    mockNextTaskExit(1);

    await removePackageCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json', dev: false }),
      provider,
    );

    expect(showError).toHaveBeenCalledWith('task "Remove react" failed with exit code 1.');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('shows an error and reloads packages when remove ends without an exit code', async () => {
    const provider = makeProvider();
    mockNextTaskExit(undefined);

    await removePackageCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json', dev: false }),
      provider,
    );

    expect(showError).toHaveBeenCalledWith('task "Remove react" ended without an exit code.');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('clears remove progress and skips the error when the user cancels the task', async () => {
    const provider = makeProvider();
    const execution = { id: 'cancelled-remove', terminate: vi.fn() } as unknown as vscode.TaskExecution;
    const cancellation = mockProgressCancellation();
    executeTaskMock.mockResolvedValueOnce(execution);

    const removal = removePackageCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json', dev: false }),
      provider,
    );

    await vi.waitFor(() => expect(executeTaskMock).toHaveBeenCalledTimes(1));
    cancellation.cancel();
    await removal;

    expect(execution.terminate).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Cancelled remove task "Remove react".');
  });

  it('removes a devDependency and prompts with the matching confirmation wording', async () => {
    const provider = makeProvider();
    const item = buildPackageItem({ name: 'eslint', currentVersion: '^8.0.0', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' });
    const execution = {} as vscode.TaskExecution;
    executeTaskMock.mockImplementationOnce(() => {
      setTimeout(() => {
        taskProcessEndListener?.({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);
      }, 0);
      return Promise.resolve(execution);
    });

    await removePackageCommand(item, provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Remove eslint from dev dependencies?',
      { modal: true },
      'Remove Package',
    );
    expect(provider.markPackageUpdating).toHaveBeenCalledWith({
      packageName: 'eslint',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, { kind: 'remove' });
  });

  it('rejects removal when the manifest entry is ambiguous or the final row is stale', async () => {
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' });
    const provider = makeProvider();
    identityMocks.resolveManifestEntry.mockResolvedValueOnce(undefined as never);
    identityMocks.resolveManifestEntry.mockImplementationOnce(capability => capability);

    await removePackageCommand(item, provider);
    expect(identityMocks.resolveManifestEntry).toHaveBeenCalledWith(expect.any(Object), provider, 'reject');
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();

    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    await removePackageCommand(item, provider);
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
  });

  it('stops removal before task launch when progress marking loses the row', async () => {
    const provider = makeProvider();
    provider.markPackageUpdatingForCapability = vi.fn(() => undefined);

    await removePackageCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }),
      provider,
    );

    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('rejects an item without a canonical package file path before any side effect', async () => {
    const provider = makeProvider();

    await removePackageCommand(
      buildPackageItem({ name: 'orphan', currentVersion: '^1.0.0', packageFilePath: '', versionPrefix: '^' }),
      provider,
    );

    expect(showError).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('shows a fallback error message when removal fails with a non-Error value', async () => {
    const provider = makeProvider();
    executeTaskMock.mockRejectedValueOnce('remove boom');

    await removePackageCommand(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json', dev: false }),
      provider,
    );

    expect(showError).toHaveBeenCalledWith('failed to remove package — remove boom', 'remove boom');
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react', packageFilePath: '/workspace/package.json' }],
  ] as const)('safely no-ops instead of dereferencing %s', async (_label, malformedItem) => {
    const provider = makeProvider();

    await removePackageCommand(malformedItem as unknown as PackageItem, provider);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('rejects an option-shaped manifest key before the remove task ever launches', async () => {
    const provider = makeProvider();

    await removePackageCommand(
      buildPackageItem({ name: '--global', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      provider,
    );

    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining('cannot start with a hyphen'),
      expect.anything(),
    );
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: '--global',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
  });
});

describe('cancelled update commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskListeners();
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
  });

  it('clears update progress, reloads state, and skips the error when the task is cancelled', async () => {
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' });
    const provider = makeProvider();
    const execution = { id: 'cancelled-update', terminate: vi.fn() } as unknown as vscode.TaskExecution;
    const cancellation = mockProgressCancellation();
    executeTaskMock.mockResolvedValueOnce(execution);

    const update = installUpdateCommand(item, provider);
    await vi.waitFor(() => expect(executeTaskMock).toHaveBeenCalledTimes(1));
    cancellation.cancel();
    await update;

    expect(execution.terminate).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Cancelled update task "Update react".');
  });

  it('clears install progress and skips the error when the task is cancelled', async () => {
    const provider = makeProvider();
    const identity = {
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies' as const,
    };
    provider.getPackageIdentitiesForFile = vi.fn(() => [identity]);
    const execution = { id: 'cancelled-install', terminate: vi.fn() } as unknown as vscode.TaskExecution;
    const cancellation = mockProgressCancellation();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([
      { fsPath: '/workspace/package.json', path: '/workspace/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    executeTaskMock.mockResolvedValueOnce(execution);

    const install = runInstallCommand(provider);
    await vi.waitFor(() => expect(executeTaskMock).toHaveBeenCalledTimes(1));
    cancellation.cancel();
    await install;

    expect(execution.terminate).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith(identity, undefined);
    expect(showError).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Cancelled install task "Install Dependencies".');
  });

  it('stops Update All with a cancellation message and no error toast', async () => {
    const first = Object.assign(
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^', releaseAge: { kind: 'accepted' } }),
      { releaseAge: { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-11-12T00:00:00.000Z' } },
    );
    const second = Object.assign(
      buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^', releaseAge: { kind: 'accepted' } }),
      { releaseAge: { kind: 'held-back', version: '5.1.0', eligibleAt: '2026-11-12T00:00:00.000Z' } },
    );
    const provider = makeProvider();
    provider.getVisibleOutdatedPackages = vi.fn(() => [first, second]);
    provider.reissuePackageCapability = vi.fn(capability => Promise.resolve(capability));
    const execution = { id: 'cancelled-update-all', terminate: vi.fn() } as unknown as vscode.TaskExecution;
    const cancellation = mockProgressCancellation();
    vi.mocked(vscode.window.showWarningMessage)
      .mockResolvedValueOnce('Update All' as never)
      .mockResolvedValueOnce('Update Risky Packages' as never);
    executeTaskMock.mockResolvedValueOnce(execution);

    const update = updateAllVisibleCommand(provider);
    await vi.waitFor(() => expect(executeTaskMock).toHaveBeenCalledTimes(1));
    cancellation.cancel();
    await update;

    expect(execution.terminate).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Package update was cancelled'),
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('The selected updates are inside the minimum release-age window'),
      { modal: true },
      'Update Risky Packages',
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });
});

function mockTaskListeners(): void {
  taskProcessEndListener = undefined;
  taskEndListener = undefined;
  taskExecutionCount = 0;
  onDidEndTaskProcessMock.mockImplementation((listener) => {
    taskProcessEndListener = listener;
    return { dispose: vi.fn() } as vscode.Disposable;
  });
  onDidEndTaskMock.mockImplementation((listener) => {
    taskEndListener = listener;
    return { dispose: vi.fn() } as vscode.Disposable;
  });
}

function mockNextTaskExit(exitCode: number | undefined): void {
  executeTaskMock.mockImplementation(() => {
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