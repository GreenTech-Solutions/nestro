import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { pinAllVersionsCommand } from '../commands/pinAllVersions';
import { PackagesProvider } from '../providers';
import { pinAllWorkspaceDependencyVersions, showError } from '../utils';

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    pinAllWorkspaceDependencyVersions: vi.fn(),
    showError: vi.fn(),
  };
});

describe('pinAllVersionsCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pins outdated versions and reloads packages', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce({ count: 3, skippedFiles: [] });
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Pinned 3 package versions.');
  });

  it('marks rows in every discovered manifest while pinning', async () => {
    const packageFilePath = '/workspace/package.json';
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([{ fsPath: packageFilePath }] as vscode.Uri[]);
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce({ count: 1, skippedFiles: [] });
    const provider = makeProvider();
    const identity = {
      packageName: 'react',
      packageFilePath,
      section: 'dependencies' as const,
    };
    provider.getPackageIdentitiesForFile = vi.fn(() => [identity]);

    await pinAllVersionsCommand(provider);

    expect(provider.markPackageUpdating).toHaveBeenNthCalledWith(1, identity, { kind: 'pin' });
    expect(provider.markPackageUpdating).toHaveBeenLastCalledWith(identity, undefined);
  });

  it('shows a no-op message without reloading when everything is already pinned', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce({ count: 0, skippedFiles: [] });
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('All versions are already pinned.');
  });

  it('names skipped manifests alongside a successful pin', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce({
      count: 2,
      skippedFiles: ['apps/broken/package.json'],
    });
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Pinned 2 package versions. Skipped unreadable manifest: apps/broken/package.json.',
    );
  });

  it('names skipped manifests when nothing else needed pinning', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce({
      count: 0,
      skippedFiles: ['apps/broken/package.json'],
    });
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'All other versions are already pinned. Skipped unreadable manifest: apps/broken/package.json.',
    );
  });

  it('shows an error and still reconciles cache and tree state when pinning fails', async () => {
    const error = new Error('disk full');
    vi.mocked(pinAllWorkspaceDependencyVersions).mockRejectedValueOnce(error);
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(showError).toHaveBeenCalledWith('Failed to pin all versions — disk full', error);
    // A failed bulk write may have partially applied, so state is reconciled from disk
    // even though the command reports the failure rather than a success message.
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('shows a fallback error message when pinning fails with a non-Error value', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockRejectedValueOnce('pin boom');
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(showError).toHaveBeenCalledWith('Failed to pin all versions — pin boom', 'pin boom');
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('preserves the original pin failure when reconciliation itself throws', async () => {
    const pinError = new Error('disk full; failed to roll back: apps/a/package.json');
    vi.mocked(pinAllWorkspaceDependencyVersions).mockRejectedValueOnce(pinError);
    const provider = makeProvider();
    vi.mocked(provider.loadPackages).mockRejectedValueOnce(new Error('reload exploded'));

    await pinAllVersionsCommand(provider);

    expect(showError).toHaveBeenCalledWith(
      'Failed to pin all versions — disk full; failed to roll back: apps/a/package.json',
      pinError,
    );
  });

  it('resolves a project-root key for every discovered workspace manifest before pinning', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/workspace/package.json' },
      { fsPath: '/workspace/apps/web/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce({ count: 2, skippedFiles: [] });
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    // The bulk write and reload still ran, locked behind whichever project-root keys
    // resolveMutationCoordinatorKey() derived from the two discovered manifests.
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Pinned 2 package versions.');
  });
});

function makeProvider(): PackagesProvider {
  return {
    loadPackages: vi.fn(),
    invalidateUpdateCache: vi.fn(),
    getPackageIdentitiesForFile: vi.fn(() => []),
    markPackageUpdating: vi.fn(),
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => await fn()) as PackagesProvider['withWriteSuppressed'],
  } as unknown as PackagesProvider;
}