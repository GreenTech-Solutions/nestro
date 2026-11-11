import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { installUpdateCommand } from '../commands/installUpdate';
import { pinVersionCommand } from '../commands/pinVersion';
import { pinAllVersionsCommand } from '../commands/pinAllVersions';
import { PackageItem, PackagesProvider } from '../providers';
import { runRowMutation } from '../commands/rowMutation';
import { showError } from '../utils';

const mutationMocks = vi.hoisted(() => {
  const lockError = new Error('Cannot lock /workspace/package.json: project root could not be resolved.');
  const resolveLockKey = vi.fn(() => Promise.resolve('/workspace'));
  const runShellTask = vi.fn(() => Promise.resolve(0));
  const packageFilePaths = ['/workspace/a/package.json', '/workspace/b/package.json'];
  const pinAllResult = { count: 0, skippedFiles: packageFilePaths };
  const capability = {
    item: {
      packageName: 'react',
      currentVersion: '^18.0.0',
      latest: '18.0.1',
      updateType: 'none' as const,
      operation: undefined,
      vulnerabilitySeverity: undefined,
      packageFilePath: '/workspace/package.json',
      dev: false,
      versionPrefix: '^',
    },
    identity: {
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies' as const,
    },
    packageFilePath: '/workspace/package.json',
    packageDirectory: '/workspace',
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  };
  const updateClient = { buildUpdateCommand: vi.fn(() => ({ command: 'npm', args: [] })) };
  const resolvePackageItem = vi.fn(() => Promise.resolve(capability));
  const revalidatePackageItem = vi.fn(() => Promise.resolve(capability));
  return {
    capability,
    lockError,
    resolveLockKey,
    runShellTask,
    packageFilePaths,
    pinAllResult,
    updateClient,
    resolvePackageItem,
    revalidatePackageItem,
  };
});

vi.mock('../clients', async () => {
  const actual = await vi.importActual<typeof import('../clients')>('../clients');
  return {
    ...actual,
    ClientManager: class {
      getClient = vi.fn(() => Promise.resolve(mutationMocks.updateClient));
    },
    resolveMutationCoordinatorKey: mutationMocks.resolveLockKey,
  };
});

vi.mock('../commands/packageIdentity', () => ({
  resolveCommandPackageItem: mutationMocks.resolvePackageItem,
  resolveManifestEntry: vi.fn(),
  revalidateCommandPackageItem: mutationMocks.revalidatePackageItem,
}));

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    getWorkspacePackageFilePaths: vi.fn(() => Promise.resolve(mutationMocks.packageFilePaths)),
    pinAllWorkspaceDependencyVersions: vi.fn(() => Promise.resolve(mutationMocks.pinAllResult)),
    runShellTaskAndWait: mutationMocks.runShellTask,
    showError: vi.fn(),
  };
});

describe('row mutation pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationMocks.resolveLockKey.mockResolvedValue('/workspace');
    mutationMocks.runShellTask.mockResolvedValue(0);
    mutationMocks.resolvePackageItem.mockResolvedValue(mutationMocks.capability);
    mutationMocks.revalidatePackageItem.mockResolvedValue(mutationMocks.capability);
  });

  it('reports a coordinator-key rejection through the command before marking a row', async () => {
    mutationMocks.resolveLockKey.mockRejectedValue(mutationMocks.lockError);
    const provider = {
      markPackageUpdatingForCapability: vi.fn(),
      withWriteSuppressed: vi.fn(),
      loadPackages: vi.fn(),
    } as unknown as PackagesProvider;

    await pinVersionCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json', false, '^'),
      provider,
    );

    expect(showError).toHaveBeenCalledWith(
      `failed to toggle version pin — ${mutationMocks.lockError.message}`,
      mutationMocks.lockError,
    );
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('reports a revalidation error before marking any package row', async () => {
    const error = new Error('manifest could not be read');
    const mark = vi.fn(() => ({ marked: true }));
    const reportError = vi.fn();

    await runRowMutation('input', {
      guard: () => true,
      resolve: () => ({ packageFilePath: '/workspace/package.json' }),
      lockTargets: mutation => [mutation.packageFilePath],
      revalidate: () => { throw error; },
      mark,
      apply: () => Promise.resolve(),
      reconcile: vi.fn(),
      reportError,
    });

    expect(reportError).toHaveBeenCalledWith(error);
    expect(mark).not.toHaveBeenCalled();
  });

  it('reports a marking error without applying or reconciling an unmarked row', async () => {
    const error = new Error('row could not be marked');
    const apply = vi.fn(() => Promise.resolve());
    const reconcile = vi.fn();
    const reportError = vi.fn();

    await runRowMutation('input', {
      guard: () => true,
      resolve: () => ({ packageFilePath: '/workspace/package.json' }),
      lockTargets: mutation => [mutation.packageFilePath],
      revalidate: () => ({ checked: true }),
      mark: () => { throw error; },
      apply,
      reconcile,
      reportError,
    });

    expect(reportError).toHaveBeenCalledWith(error);
    expect(apply).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reconciles and reports an immediate single update that cannot be verified', async () => {
    const provider = {
      markPackageUpdatingForCapability: vi.fn(() => mutationMocks.capability),
      refreshPackageBaselineForCapability: vi.fn(() => Promise.resolve(undefined)),
      markPackageUpdatedForCapability: vi.fn(),
      invalidateUpdateCache: vi.fn(),
      loadPackages: vi.fn(),
    } as unknown as PackagesProvider;

    await installUpdateCommand(
      new PackageItem('react', '^18.0.0', '18.0.1', 'minor', false, undefined, '/workspace/package.json', false, '^'),
      provider,
    );

    expect(mutationMocks.runShellTask).toHaveBeenCalledOnce();
    expect(provider.markPackageUpdatingForCapability).toHaveBeenCalledWith(mutationMocks.capability, undefined);
    expect(provider.loadPackages).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('failed to install update'), expect.any(Error));
  });

  it('names skipped Pin All manifests by their tree labels, not absolute paths', async () => {
    const provider = {
      getPackageIdentitiesForFile: vi.fn(() => []),
      markPackageUpdating: vi.fn(),
      withWriteSuppressed: vi.fn(async (write: () => Promise<unknown>) => await write()),
      loadPackages: vi.fn(),
      invalidateUpdateCache: vi.fn(),
    } as unknown as PackagesProvider;

    await pinAllVersionsCommand(provider);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'All other versions are already pinned. Skipped unreadable manifests: workspace — a, workspace — b.',
    );
  });
});