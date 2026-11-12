import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { expectErrorNotification, expectLocalizedErrorNotification, getIdentityMocks, makeInstallUpdateProvider, mockDeferredInstall, mockNextTaskExit, mockTaskListeners } from './fixtures/installUpdateHarness';
import { mockWorkspaceFiles } from './fixtures/workspaceFs';
import { runInstallCommand } from '../commands';
import { formatShellTaskFailureMessage, logger } from '../utils';

const loggerErrorMock = vi.spyOn(logger, 'error');

const identityMocks = getIdentityMocks();

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), realpath: (value: string) => Promise.resolve(value) }));

vi.mock('../commands/packageIdentity', async () => (await import('./fixtures/installUpdateHarness')).getIdentityMocks());

describe('runInstallCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identityMocks.resolveCommandPackageItem.mockImplementation(item => item.packageFilePath === '' ? undefined : identityMocks.makeCapability(item));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => capability);
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
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
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: `${packageManager}@1.0.0` }),
    });

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
    const provider = makeInstallUpdateProvider([]);
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
    setWorkspaceFolders([
      { uri: { fsPath: '/workspace/app' } },
      { uri: { fsPath: '/workspace/app-mobile' } },
    ]);
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
    setWorkspaceFolders([
      { uri: { fsPath: '/repos/team-a/service' }, name: 'service', index: 0 },
      { uri: { fsPath: '/repos/team-b/service' }, name: 'service', index: 1 },
    ]);
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
    setWorkspaceFolders([
      { uri: { fsPath: '/repos/first' }, name: 'first', index: 0 },
      { uri: { fsPath: '/repos/second' }, name: 'second', index: 1 },
    ]);
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

    expectErrorNotification(formatShellTaskFailureMessage('Install Dependencies', 1));
  });

  it('shows an error when the install task ends without an exit code', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'npm@11.0.0' })),
    );
    mockNextTaskExit(undefined);

    await runInstallCommand();

    expectErrorNotification(formatShellTaskFailureMessage('Install Dependencies', undefined));
  });

  it('shows an error when no workspace package.json is found', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([]);

    await runInstallCommand();

    expectErrorNotification(vscode.l10n.t('failed to run install — {0}', vscode.l10n.t('No workspace package.json found.')));
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

    expectLocalizedErrorNotification('failed to run install — {0}', 'workspace search failed');
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

    expectLocalizedErrorNotification('failed to run install — {0}', 'install boom');
  });
});