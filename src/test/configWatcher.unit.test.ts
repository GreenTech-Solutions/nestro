import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerConfigurationWatcher } from '../extension';
import { FilterManager, GroupItem, PackageItem, PackagesProvider } from '../providers';
import { fetchAllLatestVersions, getWorkspacePackageFilePath, readWorkspaceDependencies } from '../utils';

vi.mock('../utils', () => ({
  fetchAllLatestVersions: vi.fn(),
  getUpdateType: vi.fn((current: string, latest: string) => (
    current.split('.')[0] === latest.split('.')[0] ? 'minor' : 'breaking'
  )),
  getWorkspacePackageFilePath: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  },
  readWorkspaceDependencies: vi.fn(),
  runNpmAudit: vi.fn(),
  showError: vi.fn(),
}));

describe('registerConfigurationWatcher()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies changed defaultFilter immediately', () => {
    const provider = { setFilter: vi.fn(), resetUpdateData: vi.fn(), invalidateUpdateCache: vi.fn() };
    mockNestroConfiguration({ defaultFilter: 'patch' });

    registerConfigurationWatcher(makeContext(), provider);
    const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[0][0];
    listener(makeConfigEvent(['nestro.defaultFilter']));

    expect(provider.setFilter).toHaveBeenCalledWith('patch');
    expect(provider.resetUpdateData).not.toHaveBeenCalled();
  });

  it('resets update data when updateTarget changes', () => {
    const provider = { setFilter: vi.fn(), resetUpdateData: vi.fn(), invalidateUpdateCache: vi.fn() };

    registerConfigurationWatcher(makeContext(), provider);
    const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[0][0];
    listener(makeConfigEvent(['nestro.updateTarget']));

    expect(provider.resetUpdateData).toHaveBeenCalledTimes(1);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.setFilter).not.toHaveBeenCalled();
  });

  it('resets update data when includePreReleases changes', () => {
    const provider = { setFilter: vi.fn(), resetUpdateData: vi.fn(), invalidateUpdateCache: vi.fn() };

    registerConfigurationWatcher(makeContext(), provider);
    const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[0][0];
    listener(makeConfigEvent(['nestro.includePreReleases']));

    expect(provider.resetUpdateData).toHaveBeenCalledTimes(1);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
    expect(provider.setFilter).not.toHaveBeenCalled();
  });

  it('does not react to deferInstallAfterUpdate changes', () => {
    const provider = { setFilter: vi.fn(), resetUpdateData: vi.fn(), invalidateUpdateCache: vi.fn() };

    registerConfigurationWatcher(makeContext(), provider);
    const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[0][0];
    listener(makeConfigEvent(['nestro.deferInstallAfterUpdate']));

    expect(provider.setFilter).not.toHaveBeenCalled();
    expect(provider.resetUpdateData).not.toHaveBeenCalled();
    expect(provider.invalidateUpdateCache).not.toHaveBeenCalled();
  });
});

describe('PackagesProvider.resetUpdateData()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkspacePackageFilePath).mockReturnValue('/workspace/package.json');
    vi.mocked(readWorkspaceDependencies).mockResolvedValue([
      { name: 'react', current: '18.0.0', dev: false },
      { name: 'eslint', current: '8.0.0', dev: true },
      { name: 'typescript', current: '5.0.0', dev: true },
    ]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([
      ['react', '19.0.0'],
      ['typescript', '5.9.3'],
    ]));
  });

  it('clears latest versions and update types while keeping current package versions', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.checkUpdates();
    provider.resetUpdateData();

    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packages = groups.flatMap(group => group.children).filter((item): item is PackageItem => item instanceof PackageItem);
    expect(packages.map(item => [item.packageName, item.currentVersion, item.latest, item.updateType])).toEqual([
      ['react', '18.0.0', undefined, 'none'],
      ['eslint', '8.0.0', undefined, 'none'],
      ['typescript', '5.0.0', undefined, 'none'],
    ]);
  });
});

function makeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function makeConfigEvent(changedKeys: string[]): vscode.ConfigurationChangeEvent {
  return {
    affectsConfiguration: vi.fn((key: string) => changedKeys.includes(key)),
  } as unknown as vscode.ConfigurationChangeEvent;
}

function mockNestroConfiguration(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}