import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { pinVersionCommand } from '../commands/pinVersion';
import { removePackageCommand } from '../commands/removePackage';
import { switchDepTypeCommand } from '../commands/switchDepType';
import { PackageItem, PackagesProvider } from '../providers';
import {
  DependencyTypeConflictError,
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
    resolvePinManifestEntry: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
    resolveUnambiguousManifestEntry: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
    revalidateCommandPackageItem: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
  };
});

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
      this.getClient = vi.fn(() => Promise.resolve(new actual.NpmClient('/workspace')));
    }),
  };
});

describe('switchDepTypeCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves the package between dependency buckets and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

    await switchDepTypeCommand(item, provider);

    expect(switchDependencyType).toHaveBeenCalledWith('/workspace/package.json', 'react', false, '^18.0.0');
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('moves a devDependency back to dependencies', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      true,
      '^',
    );

    await switchDepTypeCommand(item, provider);

    expect(switchDependencyType).toHaveBeenCalledWith('/workspace/package.json', 'react', true, '^18.0.0');
  });

  it('stops before a write when the provider cannot resolve the current row', async () => {
    identityMocks.resolveCommandPackageItem.mockResolvedValueOnce(undefined);
    const provider = makeProvider();

    await switchDepTypeCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      provider,
    );

    expect(switchDependencyType).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
  });

  it('stops before a write when final dependency-type revalidation fails', async () => {
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    const provider = makeProvider();

    await switchDepTypeCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
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
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

    await switchDepTypeCommand(item, provider);

    expect(showError).toHaveBeenCalledWith(`failed to switch dependency type — ${expectedMessage}`, rejection);
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it('shows both specs and does not reload when the target section already contains the package', async () => {
    const conflict = new DependencyTypeConflictError('react', '^18.0.0', '^18.0.0', '~17.0.0');
    vi.mocked(switchDependencyType).mockRejectedValueOnce(conflict);
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

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
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

    await pinVersionCommand(item, provider);

    expect(identityMocks.resolvePinManifestEntry).toHaveBeenCalledTimes(1);
    expect(identityMocks.resolveUnambiguousManifestEntry).not.toHaveBeenCalled();
    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', 'dependencies', '^18.0.0', true);
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('unpins a bare package and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '',
    );

    await pinVersionCommand(item, provider);

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', 'dependencies', '18.0.0', false);
  });

  it('pins a caret-prefixed devDependency using the devDependencies section explicitly', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'vitest',
      '^2.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      true,
      '^',
    );

    await pinVersionCommand(item, provider);

    expect(identityMocks.resolvePinManifestEntry).toHaveBeenCalledWith(expect.any(Object), provider);
    expect(identityMocks.resolveUnambiguousManifestEntry).not.toHaveBeenCalled();
    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'vitest', 'devDependencies', '^2.0.0', true);
  });

  it('pins a caret-prefixed workspace: range without corrupting the protocol', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'internal-lib',
      'workspace:^1.2.3',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '',
    );

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
    const item = new PackageItem(
      'pkg',
      currentVersion,
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '',
    );

    await pinVersionCommand(item, provider);

    expect(setVersionPin).not.toHaveBeenCalled();
    expect(provider.withWriteSuppressed).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(`cannot toggle version pin for pkg — ${reason}`);
  });

  it('stops before pinning when identity or manifest validation fails', async () => {
    identityMocks.resolveCommandPackageItem.mockResolvedValueOnce(undefined);
    const provider = makeProvider();
    const item = new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json');

    await pinVersionCommand(item, provider);
    expect(setVersionPin).not.toHaveBeenCalled();

    identityMocks.resolvePinManifestEntry.mockResolvedValueOnce(undefined as never);
    await pinVersionCommand(item, provider);
    expect(setVersionPin).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('pin write failed'), 'pin write failed'],
    ['a non-Error value', 'pin boom', 'pin boom'],
  ] as const)('shows an error without reloading when pinning fails with %s', async (_label, rejection, expectedMessage) => {
    vi.mocked(setVersionPin).mockRejectedValueOnce(rejection);
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

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
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );
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
    }, true);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the user cancels removal', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

    await removePackageCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      makeProvider(),
    );

    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('shows an error and reloads packages when remove exits with a non-zero code', async () => {
    const provider = makeProvider();
    mockNextTaskExit(1);

    await removePackageCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      provider,
    );

    expect(showError).toHaveBeenCalledWith('task "Remove react" failed with exit code 1.');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, false);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('shows an error and reloads packages when remove ends without an exit code', async () => {
    const provider = makeProvider();
    mockNextTaskExit(undefined);

    await removePackageCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      provider,
    );

    expect(showError).toHaveBeenCalledWith('task "Remove react" ended without an exit code.');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, false);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('removes a devDependency and prompts with the matching confirmation wording', async () => {
    const provider = makeProvider();
    const item = new PackageItem('eslint', '^8.0.0', undefined, 'none', false, undefined, '/workspace/package.json', true, '^');
    const execution = {} as vscode.TaskExecution;
    executeTaskMock.mockImplementationOnce(() => {
      setTimeout(() => {
        taskProcessEndListener?.({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);
      }, 0);
      return Promise.resolve(execution);
    });

    await removePackageCommand(item, provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Remove eslint from devDependencies?',
      { modal: true },
      'Remove Package',
    );
    expect(provider.markPackageUpdating).toHaveBeenCalledWith({
      packageName: 'eslint',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, true);
  });

  it('rejects removal when the manifest entry is ambiguous or the final row is stale', async () => {
    const item = new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json');
    const provider = makeProvider();
    identityMocks.resolveUnambiguousManifestEntry.mockResolvedValueOnce(undefined as never);

    await removePackageCommand(item, provider);
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();

    identityMocks.resolveUnambiguousManifestEntry.mockImplementationOnce(capability => capability);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    await removePackageCommand(item, provider);
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
  });

  it('stops removal before task launch when progress marking loses the row', async () => {
    const provider = makeProvider();
    provider.markPackageUpdatingForCapability = vi.fn(() => undefined);

    await removePackageCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      provider,
    );

    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('rejects an item without a canonical package file path before any side effect', async () => {
    const provider = makeProvider();

    await removePackageCommand(
      new PackageItem('orphan', '^1.0.0', undefined, 'none', false, undefined, '', false, '^'),
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
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      provider,
    );

    expect(showError).toHaveBeenCalledWith('failed to remove package — remove boom', 'remove boom');
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, false);
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
      new PackageItem('--global', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json', false, '^'),
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
    }, false);
  });
});

function makeProvider(): PackagesProvider {
  const provider = {
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => await fn()) as PackagesProvider['withWriteSuppressed'],
    loadPackages: vi.fn(),
    invalidateUpdateCache: vi.fn(),
    markPackageUpdating: vi.fn(),
  } as unknown as PackagesProvider;
  provider.refreshPackageBaselineForCapability = vi.fn(capability => Promise.resolve(capability));
  provider.markPackageUpdated = vi.fn();
  provider.markPackageUpdatedForCapability = vi.fn((capability, version) => {
    provider.markPackageUpdated(capability.identity, version);
  });
  provider.markPackageUpdatingForCapability = vi.fn((capability, installing) => {
    provider.markPackageUpdating(capability.identity, installing);
    return capability;
  });
  return provider;
}

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