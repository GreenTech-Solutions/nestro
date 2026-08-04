import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { pickVersionCommand } from '../commands/pickVersion';
import { installUpdateCommand } from '../commands/installUpdate';
import { PackageItem, PackagesProvider } from '../providers';
import { fetchPackageVersions } from '../utils';

vi.mock('../commands/installUpdate', () => ({
  installUpdateCommand: vi.fn(),
}));

vi.mock('../utils', () => ({
  fetchPackageVersions: vi.fn(),
  getUpdateType: vi.fn(() => 'patch'),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
  selectVersionsForPicker: vi.fn((versions: string[]) => versions),
}));

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
    vi.mocked(fetchPackageVersions).mockResolvedValue({
      tags: { latest: '19.0.0' },
      versions: ['19.0.0', '18.0.0'],
    });
  });

  it('installs the selected version', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(
      new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'),
      makeProvider(),
    );
    expect(fetchPackageVersions).toHaveBeenCalledWith('react', '/workspace/package.json');
    quickPick.selectedItems = [quickPick.items[0]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(installUpdateCommand).toHaveBeenCalledTimes(1);
    expect(quickPick.acceptDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
    const syntheticItem = vi.mocked(installUpdateCommand).mock.calls[0][0];
    expect(syntheticItem.packageName).toBe('react');
    expect(syntheticItem.latest).toBe('19.0.0');
    expect(syntheticItem.packageFilePath).toBe('/workspace/package.json');
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

  it('does not install when the current version is selected', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    quickPick.selectedItems = [quickPick.items[1]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(installUpdateCommand).not.toHaveBeenCalled();
  });

  it('shows an error and hides the picker when versions fail to load', async () => {
    const quickPick = makeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(fetchPackageVersions).mockRejectedValueOnce(new Error('registry unavailable'));

    await pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to fetch versions for react.');
    expect(quickPick.hide).toHaveBeenCalledTimes(1);
    expect(quickPick.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the picker without mutating it when cancelled while loading', async () => {
    const quickPick = makeQuickPick();
    let resolveFetch: (value: { tags: Record<string, string>; versions: string[] }) => void = () => {};
    vi.mocked(vscode.window.createQuickPick).mockReturnValueOnce(quickPick as unknown as vscode.QuickPick<vscode.QuickPickItem>);
    vi.mocked(fetchPackageVersions).mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const command = pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
    quickPick.onDidHide.mock.calls[0][0]();
    resolveFetch({
      tags: { latest: '19.0.0' },
      versions: ['19.0.0', '18.0.0'],
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
    vi.mocked(fetchPackageVersions).mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectFetch = reject;
    }));

    const command = pickVersionCommand(new PackageItem('react', '^18.0.0', undefined, 'none'), makeProvider());
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
    expect(installUpdateCommand).not.toHaveBeenCalled();
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