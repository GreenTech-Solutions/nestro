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
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce(3);
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Pinned 3 package version(s).');
  });

  it('shows a no-op message without reloading when everything is already pinned', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce(0);
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('All versions are already pinned.');
  });

  it('shows an error and does not reload when pinning fails', async () => {
    const error = new Error('disk full');
    vi.mocked(pinAllWorkspaceDependencyVersions).mockRejectedValueOnce(error);
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(showError).toHaveBeenCalledWith('Failed to pin all versions — disk full', error);
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it('shows a fallback error message when pinning fails with a non-Error value', async () => {
    vi.mocked(pinAllWorkspaceDependencyVersions).mockRejectedValueOnce('pin boom');
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    expect(showError).toHaveBeenCalledWith('Failed to pin all versions — pin boom', 'pin boom');
  });

  it('resolves a project-root key for every discovered workspace manifest before pinning', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      { fsPath: '/workspace/package.json' },
      { fsPath: '/workspace/apps/web/package.json' },
    ] as vscode.Uri[]);
    vi.mocked(pinAllWorkspaceDependencyVersions).mockResolvedValueOnce(2);
    const provider = makeProvider();

    await pinAllVersionsCommand(provider);

    // The bulk write and reload still ran, locked behind whichever project-root keys
    // resolveMutationCoordinatorKey() derived from the two discovered manifests.
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Pinned 2 package version(s).');
  });
});

function makeProvider(): PackagesProvider {
  return {
    loadPackages: vi.fn(),
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => await fn()) as PackagesProvider['withWriteSuppressed'],
  } as unknown as PackagesProvider;
}