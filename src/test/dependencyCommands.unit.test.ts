import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { pinVersionCommand } from '../commands/pinVersion';
import { removePackageCommand } from '../commands/removePackage';
import { switchDepTypeCommand } from '../commands/switchDepType';
import { PackageItem, PackagesProvider } from '../providers';
import { setVersionPin, switchDependencyType } from '../utils';

const executeTaskMock = vi.mocked(vscode.tasks.executeTask);
const onDidEndTaskProcessMock = vi.mocked(vscode.tasks.onDidEndTaskProcess);

vi.mock('../utils', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
  setVersionPin: vi.fn(),
  showError: vi.fn(),
  switchDependencyType: vi.fn(),
}));

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

    expect(switchDependencyType).toHaveBeenCalledWith('/workspace/package.json', 'react', false);
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
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

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', true);
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

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', false);
  });
});

describe('removePackageCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeTaskMock.mockResolvedValue({} as vscode.TaskExecution);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Remove Package' as never);
    onDidEndTaskProcessMock.mockImplementation((listener) => {
      listener({ execution: {} as vscode.TaskExecution, exitCode: 0 } as vscode.TaskProcessEndEvent);
      return { dispose: vi.fn() } as vscode.Disposable;
    });
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
    executeTaskMock.mockResolvedValueOnce(execution);
    onDidEndTaskProcessMock.mockImplementationOnce((listener) => {
      listener({ execution, exitCode: 0 } as vscode.TaskProcessEndEvent);
      return { dispose: vi.fn() } as vscode.Disposable;
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
    expect(provider.markPackageUpdating).toHaveBeenCalledWith('react', true, '/workspace/package.json');
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
});

function makeProvider(): PackagesProvider {
  return {
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => await fn()) as PackagesProvider['withWriteSuppressed'],
    loadPackages: vi.fn(),
    invalidateUpdateCache: vi.fn(),
    markPackageUpdating: vi.fn(),
  } as unknown as PackagesProvider;
}