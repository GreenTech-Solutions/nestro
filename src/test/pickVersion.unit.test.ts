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
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  onDidAccept: ReturnType<typeof vi.fn>;
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
    quickPick.selectedItems = [quickPick.items[0]];
    quickPick.onDidAccept.mock.calls[0][0]();
    await Promise.resolve();

    expect(installUpdateCommand).toHaveBeenCalledTimes(1);
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
  });
});

function makeQuickPick(): QuickPickMock {
  return {
    busy: false,
    items: [],
    selectedItems: [],
    show: vi.fn(),
    hide: vi.fn(),
    onDidAccept: vi.fn(),
  };
}

function makeProvider(): PackagesProvider {
  return {} as PackagesProvider;
}
