import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { pickVersionCommand } from '../commands/pickVersion';
import { runResolvedPackageVersion } from '../commands/installUpdate';
import { PackageItem, PackagesProvider } from '../providers';
import { fetchPackageMetadata, showError } from '../utils';
import type { PackageMetadataOutcome } from '../utils';

const identityMocks = vi.hoisted(() => {
  const makeCapability = (item: {
    packageName: string;
    packageFilePath: string;
    dev: boolean;
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
    }) => makeCapability(item)),
    revalidateCommandPackageItem: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
  };
});

vi.mock('../commands/installUpdate', () => ({
  installUpdateCommand: vi.fn(),
  runResolvedPackageVersion: vi.fn(),
}));

vi.mock('../commands/packageIdentity', () => identityMocks);

vi.mock('../utils', async () => {
  const { parseDependencySpec } = await vi.importActual<typeof import('../utils/dependencySpec')>('../utils/dependencySpec');
  const { selectVersionsForPicker: selectVersionsForPickerActual } = await vi.importActual<typeof import('../utils/registryClient')>('../utils/registryClient');
  return {
    fetchPackageMetadata: vi.fn(),
    getUpdateType: vi.fn(() => 'patch'),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    parseDependencySpec,
    showError: vi.fn(),
    selectVersionsForPicker: vi.fn(selectVersionsForPickerActual),
  };
});

interface QuickPickMock {
  title?: string;
  placeholder?: string;
  busy: boolean;
  items: vscode.QuickPickItem[];
  selectedItems: vscode.QuickPickItem[];
  acceptDisposable: vscode.Disposable;
  dispose: ReturnType<typeof vi.fn>;
  hideDisposable: vscode.Disposable;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  onDidAccept: ReturnType<typeof vi.fn>;
  onDidHide: ReturnType<typeof vi.fn>;
}

describe('pickVersionCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.getConfiguration).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(fetchPackageMetadata).mockResolvedValue({
      kind: 'success',
      result: {
        distTags: { latest: '19.0.0' },
        publishTimes: { kind: 'not-provided' },
        versions: ['19.0.0', '18.0.0'],
      },
    });
  });

  it('installs the selected version', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      makeProvider(),
    );
    expect(fetchPackageMetadata).toHaveBeenCalledWith(
      'react',
      '/workspace/package.json',
      expect.any(AbortSignal),
    );
    quickPick.selectedItems = [quickPick.items[0]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(runResolvedPackageVersion).toHaveBeenCalledTimes(1);
    expect(quickPick.acceptDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runResolvedPackageVersion).mock.calls[0][1]).toBe('19.0.0');
    expect(vi.mocked(runResolvedPackageVersion).mock.calls[0][0]).toMatchObject({
      packageFilePath: '/workspace/package.json',
    });
  });

  it('passes the prerelease setting through to the version selector', async () => {
    const quickPick = makeQuickPick();
    const { selectVersionsForPicker } = await import('../utils');
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => key === 'includePreReleases' ? false : defaultValue),
    } as unknown as vscode.WorkspaceConfiguration);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());

    expect(selectVersionsForPicker).toHaveBeenCalledWith(
      ['19.0.0', '18.0.0'],
      { latest: '19.0.0' },
      '^18.0.0',
      false,
    );
  });

  it('filters prereleases by default while retaining a prerelease current version', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({
      kind: 'success',
      result: {
        distTags: { latest: '2.0.0' },
        publishTimes: { kind: 'not-provided' },
        versions: ['2.0.0', '2.0.0-rc.1', '1.0.0', '1.0.0-beta.1'],
      },
    });

    await pickVersionCommand(new PackageItem('react', '2.0.0-rc.1', undefined, 'none'), makeProvider());

    const labels = quickPick.items.map(item => item.label);
    expect(labels).toEqual(expect.arrayContaining(['2.0.0', '1.0.0', '★ 2.0.0-rc.1']));
    expect(labels).toHaveLength(3);
    expect(labels).not.toContain('1.0.0-beta.1');
  });

  it('includes prereleases when explicitly enabled', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn((key: string, defaultValue: unknown) => key === 'includePreReleases' ? true : defaultValue),
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({
      kind: 'success',
      result: {
        distTags: { latest: '2.0.0' },
        publishTimes: { kind: 'not-provided' },
        versions: ['2.0.0', '2.0.0-rc.1'],
      },
    });

    await pickVersionCommand(new PackageItem('react', '^2.0.0', undefined, 'none'), makeProvider());

    expect(quickPick.items.map(item => item.label)).toContain('2.0.0-rc.1');
    const { selectVersionsForPicker } = await import('../utils');
    expect(selectVersionsForPicker).toHaveBeenLastCalledWith(
      ['2.0.0', '2.0.0-rc.1'],
      { latest: '2.0.0' },
      '^2.0.0',
      true,
    );
  });

  it('does not install when the current version is selected', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    quickPick.selectedItems = [quickPick.items[1]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(runResolvedPackageVersion).not.toHaveBeenCalled();
  });

  it('shows an error and hides the picker when versions fail to load', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(fetchPackageMetadata).mockRejectedValueOnce(new Error('registry unavailable'));

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to fetch versions for react.');
    expect(quickPick.hide).toHaveBeenCalledTimes(1);
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
  });

  it('shows the same error when the metadata result is incomplete', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({ kind: 'timeout', timeoutMs: 15000 });

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to fetch versions for react.');
    expect(quickPick.hide).toHaveBeenCalledTimes(1);
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
  });

  it('closes the picker and skips install when the row goes stale after fetching versions', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());

    expect(quickPick.hide).toHaveBeenCalledTimes(1);
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
    expect(quickPick.onDidAccept).not.toHaveBeenCalled();
    expect(runResolvedPackageVersion).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not create a picker when the provider rejects the rendered row', async () => {
    identityMocks.resolveCommandPackageItem.mockResolvedValueOnce(undefined as never);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());

    expect(vscode.window.createQuickPick).not.toHaveBeenCalled();
    expect(fetchPackageMetadata).not.toHaveBeenCalled();
  });

  it('disposes the picker without mutating it when cancelled while loading', async () => {
    const quickPick = makeQuickPick();
    let resolveFetch: (value: PackageMetadataOutcome) => void = () => {};
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(fetchPackageMetadata).mockReturnValueOnce(new Promise<PackageMetadataOutcome>((resolve) => {
      resolveFetch = resolve;
    }));

    const command = pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    await Promise.resolve();
    quickPick.onDidHide.mock.calls[0][0]();
    resolveFetch({
      kind: 'success',
      result: {
        distTags: { latest: '19.0.0' },
        publishTimes: { kind: 'not-provided' },
        versions: ['19.0.0', '18.0.0'],
      },
    });
    await command;

    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
    expect(quickPick.items).toEqual([]);
    expect(quickPick.busy).toBe(true);
    expect(quickPick.placeholder).toBe('Loading versions...');
    expect(quickPick.onDidAccept).not.toHaveBeenCalled();
  });

  it('does not show an error when the version fetch rejects after the picker was already cancelled', async () => {
    const quickPick = makeQuickPick();
    let rejectFetch: (err: Error) => void = () => {};
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(fetchPackageMetadata).mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectFetch = reject;
    }));

    const command = pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    await Promise.resolve();
    quickPick.onDidHide.mock.calls[0][0]();
    rejectFetch(new Error('registry unavailable'));
    await command;

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not install when the picker is accepted without a highlighted item', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    quickPick.selectedItems = [];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(quickPick.hide).toHaveBeenCalledTimes(1);
    expect(runResolvedPackageVersion).not.toHaveBeenCalled();
  });

  it('rejects a version that was not in the fetched set', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    quickPick.selectedItems = [{ label: '9.9.9' }];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(runResolvedPackageVersion).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      'Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('skips a selection when the row becomes stale on accept', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    identityMocks.revalidateCommandPackageItem.mockResolvedValueOnce(undefined as never);
    quickPick.selectedItems = [quickPick.items[0]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(runResolvedPackageVersion).not.toHaveBeenCalled();
  });

  it('sanitizes a selected-version mutation failure', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    vi.mocked(runResolvedPackageVersion).mockRejectedValueOnce(new Error('mutation failed'));
    quickPick.selectedItems = [quickPick.items[0]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
      'Package action is no longer available. Refresh the package list and try again.',
    ));

    expect(runResolvedPackageVersion).toHaveBeenCalledTimes(1);
  });

  it('re-enters cleanup idempotently when the underlying quick pick fires hide again on dispose', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    // Simulate the user pressing Escape: fires the same onDidHide listener that a real
    // QuickPick.dispose() also fires. Without the `disposed` guard in cleanup(), this would
    // recurse forever since our mock's dispose() re-fires the hide listener, matching real vscode.
    quickPick.onDidHide.mock.calls[0][0]();

    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
    expect(quickPick.acceptDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(quickPick.hideDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react' }],
  ] as const)('safely no-ops instead of dereferencing %s', async (_label, malformedItem) => {
    await expect(pickVersionCommand(malformedItem as unknown as PackageItem, makeProvider())).resolves.toBeUndefined();

    expect(vscode.window.createQuickPick).not.toHaveBeenCalled();
    expect(fetchPackageMetadata).not.toHaveBeenCalled();
  });
});

function makeQuickPick(): QuickPickMock {
  let hideListener: (() => void) | undefined;
  const acceptDisposable = { dispose: vi.fn() };
  const hideDisposable = { dispose: vi.fn() };

  return {
    acceptDisposable,
    busy: false,
    // Real vscode QuickPick.dispose() implicitly hides the picker and fires onDidHide;
    // mirroring that here is what exercises cleanup()'s re-entrancy guard.
    dispose: vi.fn(() => {
      hideListener?.();
    }),
    hide: vi.fn(() => {
      hideListener?.();
    }),
    hideDisposable,
    items: [],
    onDidAccept: vi.fn(() => acceptDisposable),
    onDidHide: vi.fn((listener: () => void) => {
      hideListener = listener;
      return hideDisposable;
    }),
    selectedItems: [],
    show: vi.fn(),
  };
}

function makeProvider(): PackagesProvider {
  return {} as PackagesProvider;
}