import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildPackageItem, setWorkspaceFolders } from './fixtures';
import { mockNestroConfiguration } from './fixtures/config';
import { expectErrorNotification, expectLocalizedErrorNotification, getIdentityMocks, getRealProviderPackages, incrementTaskExecutionCount, makeInstallUpdateProvider, makeRealProvider, mockDeferredInstall, mockNextTaskExit, mockTaskListeners, taskExecutionCount, taskProcessEndListener, unverifiedUpdateMessage } from './fixtures/installUpdateHarness';
import { updateAllVisibleCommand } from '../commands';
import { formatDependencySectionLabel, formatHeldBackDate, formatShellTaskFailureMessage } from '../utils';

const identityMocks = getIdentityMocks();

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), realpath: (value: string) => Promise.resolve(value) }));

vi.mock('../commands/packageIdentity', async () => (await import('./fixtures/installUpdateHarness')).getIdentityMocks());

describe('updateAllVisibleCommand()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identityMocks.resolveCommandPackageItem.mockImplementation(item => item.packageFilePath === '' ? undefined : identityMocks.makeCapability(item));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => capability);
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    mockTaskListeners();
    mockDeferredInstall(false);
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([{ path: '/workspace/package.json' }] as vscode.Uri[]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{"packageManager":"pnpm@11.0.8"}'));
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    mockNextTaskExit(0);
  });

  it('runs one batch task for visible outdated packages in immediate mode', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' }),
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
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: 'react', currentVersion: '~18.1.0', latest: '18.3.1', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '~' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', dev: false, versionPrefix: '^' }),
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
    expectLocalizedErrorNotification('failed to update packages — {0}', 'second write failed');
    expect(provider.invalidateUpdateCache).toHaveBeenCalled();
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expectErrorNotification(vscode.l10n.t('failed to update packages — {0}', 'second write failed; failed to roll back: package.json'));
  });

  it('does nothing when there are no visible outdated packages', async () => {
    const provider = makeInstallUpdateProvider([]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('updates after confirmation when bulk confirmation is enabled', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: true });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Update All' as never);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
  });

  it('asks for a separate confirmation before a risky bulk update, with a localized held-back date', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Update Risky Packages' as never);
    const eligibleAt = '2026-06-02T00:00:00.000Z';
    const provider = makeInstallUpdateProvider([
      buildPackageItem({
        name: 'react',
        currentVersion: '^18.0.0',
        latest: '19.0.0',
        updateType: 'breaking',
        packageFilePath: '/workspace/package.json',
        versionPrefix: '^',
        releaseAge: { kind: 'held-back', version: '19.0.0', eligibleAt },
      }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('inside the minimum release-age window'),
      { modal: true },
      'Update Risky Packages',
    );
    const [promptText] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    const expectedDate = formatHeldBackDate(eligibleAt);
    expect(promptText).toContain(`held back until ${expectedDate}`);
    expect(promptText).not.toContain(eligibleAt);
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
  });

  it('cancels a risky bulk update before any task starts', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({
        name: 'react',
        currentVersion: '^18.0.0',
        latest: '19.0.0',
        updateType: 'breaking',
        packageFilePath: '/workspace/package.json',
        versionPrefix: '^',
        releaseAge: { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
      }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('rechecks a newly risky deferred bulk update before marking progress', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const safeItem = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
      releaseAge: { kind: 'accepted' },
    });
    const safe = identityMocks.makeCapability(safeItem);
    const risky = identityMocks.makeCapability(buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
      releaseAge: { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
    }));
    const provider = makeInstallUpdateProvider([safeItem]);
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
    const safeItem = buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
      releaseAge: { kind: 'accepted' },
    });
    const safe = identityMocks.makeCapability(safeItem);
    const risky = identityMocks.makeCapability(buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
      releaseAge: { kind: 'held-back', version: '19.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
    }));
    const provider = makeInstallUpdateProvider([safeItem]);
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: 'vitest', currentVersion: '^4.0.0', latest: '4.1.0', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: '--global', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: '--global', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: '--global', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' }),
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

  it('reports updated and failed roots and reloads when a later root fails', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    mockTaskExitSequence([0, 1]);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.l10n.t).toHaveBeenCalledWith('failed to update packages — {0}', expect.any(String));
    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expectErrorNotification(expectedPartialUpdateMessage(
      formatShellTaskFailureMessage('Update All Packages', 1), ['workspace — (root)'], ['workspace — apps/web'],
    ));
    expect(provider.invalidateUpdateCache).toHaveBeenCalled();
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('names every root as not updated when the first root fails', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    mockTaskExitSequence([1]);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    expectErrorNotification(expectedPartialUpdateMessage(
      formatShellTaskFailureMessage('Update All Packages', 1), [], ['workspace — (root)', 'workspace — apps/web'],
    ));
    expect(provider.invalidateUpdateCache).toHaveBeenCalled();
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('separates the sections of one root in the partial-failure message', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    mockTaskExitSequence([0, 1]);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: 'vitest', currentVersion: '^4.0.0', latest: '4.1.0', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expectErrorNotification(expectedPartialUpdateMessage(
      formatShellTaskFailureMessage('Update All Packages', 1),
      [`workspace — (root) (${formatDependencySectionLabel('dependencies')})`],
      [`workspace — (root) (${formatDependencySectionLabel('devDependencies')})`],
    ));
  });

  it('reports a later root that goes stale mid-run and reloads', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const first = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const second = buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([first, second]);
    const secondCapability = identityMocks.makeCapability(second);
    vi.mocked(provider.reissuePackageCapability).mockImplementation(capability => (
      Promise.resolve(capability.item.packageName === 'vite' && taskExecutionCount > 0 ? undefined : capability)
    ));
    identityMocks.revalidateCommandPackageItem.mockImplementation(capability => (
      capability.item.packageName === 'vite' && taskExecutionCount > 0 ? undefined : secondCapability
    ) as never);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    expectErrorNotification(expectedPartialUpdateMessage(
      vscode.l10n.t('the package list changed while updating.'), ['workspace — (root)'], ['workspace — apps/web'],
    ));
    expect(provider.invalidateUpdateCache).toHaveBeenCalled();
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('still shows the update failure when the reconciling reload fails', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    mockTaskExitSequence([1]);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);
    vi.mocked(provider.loadPackages).mockRejectedValue(new Error('reload boom'));

    await updateAllVisibleCommand(provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed to update packages — task "Update All Packages" failed with exit code 1.'),
    );
  });

  it('treats a declined mid-run risky confirmation as a cancel, not a failure', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const first = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^', releaseAge: { kind: 'accepted' } });
    const second = buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', versionPrefix: '^', releaseAge: { kind: 'accepted' } });
    const heldBack = { kind: 'held-back', version: '5.1.0', eligibleAt: '2026-06-02T00:00:00.000Z' } as const;
    const risky = identityMocks.makeCapability(Object.assign(
      buildPackageItem({ name: 'vite', currentVersion: '^5.0.0', latest: '5.1.0', updateType: 'minor', packageFilePath: '/workspace/apps/web/package.json', versionPrefix: '^', releaseAge: { kind: 'accepted' } }),
      { releaseAge: heldBack },
    ));
    const provider = makeInstallUpdateProvider([first, second]);
    vi.mocked(provider.reissuePackageCapability).mockImplementation(capability => (
      Promise.resolve(capability.item.packageName === 'vite' && taskExecutionCount > 0 ? risky : capability)
    ));

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it('stops an immediate group when its group revalidation rejects', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(capability).mockResolvedValueOnce(undefined);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(provider.markPackageUpdatingForCapability).not.toHaveBeenCalled();
  });

  it('stops an immediate group when its final task-bound revalidation rejects', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([item]);
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
    const first = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const second = buildPackageItem({ name: 'typescript', currentVersion: '^5.0.0', latest: '5.9.3', updateType: 'minor', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([first, second]);
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
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability)
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(capability);
    vi.mocked(provider.refreshPackageBaselineForCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expectErrorNotification(vscode.l10n.t('failed to update packages — {0}', unverifiedUpdateMessage()));
  });

  it('reloads after a deferred bulk write whose refreshed baseline cannot be verified', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    // Persistent, not "once": the coordinator resolves a project-root key
    // (reading this same manifest) before the bulk write below does.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
    })));
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([item]);
    const capability = identityMocks.makeCapability(item);
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(capability).mockResolvedValueOnce(capability);
    vi.mocked(provider.refreshPackageBaselineForCapability).mockResolvedValueOnce(undefined);

    await updateAllVisibleCommand(provider);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expectErrorNotification(vscode.l10n.t('failed to update packages — {0}', unverifiedUpdateMessage()));
  });

  it('rejects an installing row during a final bulk identity check', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const item = buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
    const provider = makeInstallUpdateProvider([item]);
    const current = identityMocks.makeCapability(item);
    const installing = identityMocks.makeCapability(buildPackageItem({
      name: 'react',
      currentVersion: '^18.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      operation: true,
      packageFilePath: '/workspace/package.json',
      versionPrefix: '^',
    }));
    vi.mocked(provider.reissuePackageCapability).mockResolvedValueOnce(current).mockResolvedValueOnce(installing);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  it('returns after a non-zero immediate bulk task without starting later groups', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    mockNextTaskExit(1);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(vscode.tasks.executeTask).toHaveBeenCalledTimes(1);
    expectErrorNotification(expectedPartialUpdateMessage(
      formatShellTaskFailureMessage('Update All Packages', 1), [], ['workspace — (root)'],
    ));
  });

  it('waits for each immediate bulk update task before starting the next one', async () => {
    mockNestroConfiguration({ confirmBulkUpdate: false });
    const firstExecution = { id: 'first-task' } as unknown as vscode.TaskExecution;
    const secondExecution = { id: 'second-task' } as unknown as vscode.TaskExecution;
    vi.mocked(vscode.tasks.executeTask)
      .mockResolvedValueOnce(firstExecution)
      .mockResolvedValueOnce(secondExecution);
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
      buildPackageItem({ name: 'vitest', currentVersion: '^4.0.0', latest: '4.1.0', updateType: 'minor', packageFilePath: '/workspace/package.json', dev: true, versionPrefix: '^' }),
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
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expectErrorNotification(expectedPartialUpdateMessage('bulk boom', [], ['workspace — (root)']));
  });

  it('rejects a bulk update when any visible row lacks a canonical package file path', async () => {
    mockNestroConfiguration({ deferInstallAfterUpdate: true, confirmBulkUpdate: false });
    const provider = makeInstallUpdateProvider([
      buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', versionPrefix: '^' }),
      buildPackageItem({ name: 'orphan', currentVersion: '^1.0.0', latest: '1.1.0', updateType: 'minor', packageFilePath: '', versionPrefix: '^' }),
    ]);

    await updateAllVisibleCommand(provider);

    expect(provider.markPackageUpdating).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});

function expectedPartialUpdateMessage(
  reason: string,
  updated: readonly string[],
  notUpdated: readonly string[],
): string {
  const reasonSentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  const updatedSentence = updated.length === 0
    ? vscode.l10n.t('Nothing was updated.')
    : vscode.l10n.t('Updated: {0}.', updated.join(', '));
  const notUpdatedSentence = vscode.l10n.t('Not updated: {0}.', notUpdated.join(', '));
  return vscode.l10n.t('failed to update packages — {0}', `${reasonSentence} ${updatedSentence} ${notUpdatedSentence}`);
}

function mockTaskExitSequence(exitCodes: readonly number[]): void {
  vi.mocked(vscode.tasks.executeTask).mockImplementation(() => {
    const exitCode = exitCodes[Math.min(taskExecutionCount, exitCodes.length - 1)];
    incrementTaskExecutionCount();
    const execution = { id: `task-execution-${taskExecutionCount}` } as unknown as vscode.TaskExecution;
    setTimeout(() => {
      taskProcessEndListener?.({ execution, exitCode } as vscode.TaskProcessEndEvent);
    }, 0);
    return Promise.resolve(execution);
  });
}

function mockReadFileByPath(contentsByPath: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
    const content = contentsByPath[uri.fsPath];
    return Promise.resolve(Buffer.from(content ?? '{}'));
  });
}