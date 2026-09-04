import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { pinVersionCommand } from '../commands/pinVersion';
import { PACKAGE_IDENTITY_REJECTED_MESSAGE, PackageItem, PackagesProvider } from '../providers';
import type { ResolvedPackageItem } from '../providers';

vi.mock('../clients', async () => {
  const actual = await vi.importActual<typeof import('../clients')>('../clients');
  return {
    ...actual,
    resolveMutationCoordinatorKey: vi.fn(() => '/workspace'),
  };
});

describe('pinVersionCommand() writer boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.readFile).mockReset();
    vi.mocked(vscode.workspace.fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(vscode.window.showErrorMessage).mockReset();
  });

  it('rejects a spec changed after final resolver validation without writing the fresh spec', async () => {
    let manifest: Manifest = { dependencies: { pkg: '1.2.3' } };
    const capability = makeCapability('1.2.3');
    const { provider, revalidate, beforeWrite } = makeProvider(capability, () => {
      expect(revalidate).toHaveBeenCalledTimes(2);
      manifest = { dependencies: { pkg: '~2.0.0' } };
    });
    const item = new PackageItem('pkg', '1.2.3', undefined, 'none');
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(() => Promise.resolve(
      Buffer.from(JSON.stringify(manifest)),
    ));

    await pinVersionCommand(item, provider);

    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(2);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Nestro: ${PACKAGE_IDENTITY_REJECTED_MESSAGE}`);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining('~2.0.0'));
  });

  it('rejects a selected entry removed after final resolver validation without writing', async () => {
    let manifest: Manifest = { dependencies: { pkg: '1.2.3' } };
    const capability = makeCapability('1.2.3');
    const { provider, revalidate, beforeWrite } = makeProvider(capability, () => {
      expect(revalidate).toHaveBeenCalledTimes(2);
      manifest = { dependencies: {} };
    });
    const item = new PackageItem('pkg', '1.2.3', undefined, 'none');
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(() => Promise.resolve(
      Buffer.from(JSON.stringify(manifest)),
    ));

    await pinVersionCommand(item, provider);

    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Nestro: ${PACKAGE_IDENTITY_REJECTED_MESSAGE}`);
  });
});

interface Manifest {
  dependencies?: Record<string, string>;
}

function makeCapability(currentVersion: string): ResolvedPackageItem {
  const packageFilePath = '/workspace/package.json';
  const packageName = 'pkg';
  return {
    item: {
      packageName,
      currentVersion,
      latest: undefined,
      updateType: 'none',
      operation: undefined,
      vulnerabilitySeverity: undefined,
      packageFilePath,
      dev: false,
      versionPrefix: '',
    },
    identity: { packageName, packageFilePath, section: 'dependencies' },
    packageFilePath,
    packageDirectory: '/workspace',
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  };
}

function makeProvider(
  capability: ResolvedPackageItem,
  onBeforeWrite: () => void,
): {
  provider: PackagesProvider;
  revalidate: ReturnType<typeof vi.fn>;
  beforeWrite: ReturnType<typeof vi.fn>;
} {
  const revalidate = vi.fn(() => ({ ok: true as const, value: capability }));
  const beforeWrite = vi.fn(onBeforeWrite);
  const provider = {
    resolvePackageItem: vi.fn(() => ({ ok: true as const, value: capability })),
    revalidatePackageItem: revalidate,
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => {
      beforeWrite();
      return await fn();
    }),
    loadPackages: vi.fn(),
    markPackageUpdatingForCapability: vi.fn((currentCapability: ResolvedPackageItem) => currentCapability),
  } as unknown as PackagesProvider;
  return { provider, revalidate, beforeWrite };
}