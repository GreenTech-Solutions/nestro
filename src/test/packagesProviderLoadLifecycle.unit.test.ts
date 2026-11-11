import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as vscode from 'vscode';
import { FilterManager, PackagesProvider } from '../providers';
import type { PackageLoadingServiceContract, PackageLoadingSnapshot } from '../providers';
import { LoadingItem } from '../providers/LoadingItem';
import {
  readAllWorkspaceDependencies,
} from '../utils';
import type { PackageFileEntry } from '../utils';
import { packagesProviderMocks } from './fixtures/packagesProviderMocks';
import { getLastContextValue, getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';
// LoadingItem is not part of the providers barrel's public surface (used only internally by
// PackagesProvider), so it must be imported directly from its implementation file.
const { createClient: createClientMock } = packagesProviderMocks;

function createLoadingSnapshot(packageName: string): PackageLoadingSnapshot {
  const packageFilePath = '/workspace/package.json';
  const entries: PackageFileEntry[] = [{
    name: packageName,
    current: '1.0.0',
    dev: false,
    versionPrefix: '',
    packageFilePath,
  }];
  return {
    entries,
    packageFilePaths: [packageFilePath],
    readablePackageFilePaths: [packageFilePath],
    failedPackageReadPaths: [],
    packageLocationBaselines: new Map(),
    packageReadFailed: false,
  };
}

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());

describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
  });

  describe('loading service contract', () => {
    it('aborts a superseded service load and applies only the current snapshot', async () => {
      const oldSnapshot = createLoadingSnapshot('old-package');
      const currentSnapshot = createLoadingSnapshot('current-package');
      let loadInvocation = 0;
      let oldSignal: AbortSignal | undefined;
      let resolveOld: ((snapshot: PackageLoadingSnapshot) => void) | undefined;
      const load = vi.fn((signal?: AbortSignal): Promise<PackageLoadingSnapshot> => {
        if (loadInvocation === 0) {
          loadInvocation += 1;
          oldSignal = signal;
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        }
        loadInvocation += 1;
        return Promise.resolve(currentSnapshot);
      });
      const service: PackageLoadingServiceContract = {
        load,
        readPackageEntries: vi.fn().mockResolvedValue([]),
        discoverPackageFilePaths: vi.fn().mockResolvedValue([]),
      };
      const provider = new PackagesProvider(new FilterManager('all'), service);

      const oldLoad = provider.loadPackages();
      expect(load).toHaveBeenCalledTimes(1);
      const currentLoad = provider.loadPackages();

      expect(oldSignal).toBeInstanceOf(AbortSignal);
      expect(oldSignal?.aborted).toBe(true);
      expect(load).toHaveBeenNthCalledWith(1, oldSignal);
      expect(load.mock.calls[1]?.[0]).toBeInstanceOf(AbortSignal);
      expect(load.mock.calls[1]?.[0]).not.toBe(oldSignal);

      await currentLoad;
      expect(getPackageItems(provider).map(item => item.packageName)).toEqual(['current-package']);

      const finishOldLoad = resolveOld;
      if (finishOldLoad === undefined) {
        throw new Error('The superseded load resolver was not initialized.');
      }
      finishOldLoad(oldSnapshot);
      await oldLoad;

      expect(getPackageItems(provider).map(item => item.packageName)).toEqual(['current-package']);
      provider.dispose();
    });

    it('publishes the full context map on the first emit, then only the keys that changed at settle', async () => {
      const load = vi.fn().mockResolvedValue(createLoadingSnapshot('current-package'));
      const service: PackageLoadingServiceContract = {
        load,
        readPackageEntries: vi.fn().mockResolvedValue([]),
        discoverPackageFilePaths: vi.fn().mockResolvedValue([]),
      };
      const provider = new PackagesProvider(new FilterManager('all'), service);
      const contextKeys = [
        'nestro.canUpdateVisiblePackages',
        'nestro.hasPackageFiles',
        'nestro.hasReadablePackageFiles',
        'nestro.hasDependencyEntries',
        'nestro.hasAuditableProjects',
        'nestro.canRunInstall',
        'nestro.canRunAudit',
        'nestro.canSearchPackages',
        'nestro.canFilterPackages',
        'nestro.canPinAllVersions',
        'nestro.noWorkspace',
        'nestro.hasSearchQuery',
      ] as const;
      let treeChangeCount = 0;
      const treeChangeSubscription = provider.onDidChangeTreeData(() => {
        treeChangeCount += 1;
      });

      const loadPromise = provider.loadPackages();

      // The first-ever emit (loadPackages()'s synchronous start) has no previous
      // publication to diff against, so it must publish every key exactly once.
      const startCalls = (vi.mocked(vscode.commands.executeCommand).mock.calls as unknown as readonly unknown[][])
        .filter(call => call[0] === 'setContext');
      expect(startCalls).toHaveLength(contextKeys.length);
      const startValues = new Map(contextKeys.map(key => [key, getLastContextValue(key)]));
      for (const contextKey of contextKeys) {
        expect(startCalls.filter(call => call[1] === contextKey)).toHaveLength(1);
      }

      await loadPromise;

      expect(load).toHaveBeenCalledOnce();
      expect(load.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
      expect(treeChangeCount).toBe(2);

      // The settle emit only re-publishes keys whose resolved value actually changed;
      // every unchanged key keeps the value from the first publication above.
      const settleValues = new Map(contextKeys.map(key => [key, getLastContextValue(key)]));
      const changedKeys = contextKeys.filter(key => settleValues.get(key) !== startValues.get(key));
      expect(changedKeys.length).toBeGreaterThan(0);
      const allCalls = (vi.mocked(vscode.commands.executeCommand).mock.calls as unknown as readonly unknown[][])
        .filter(call => call[0] === 'setContext');
      expect(allCalls).toHaveLength(contextKeys.length + changedKeys.length);
      for (const contextKey of contextKeys) {
        expect(allCalls.filter(call => call[1] === contextKey)).toHaveLength(changedKeys.includes(contextKey) ? 2 : 1);
      }

      treeChangeSubscription.dispose();
      provider.dispose();
    });
  });

  describe('stale-safe reload', () => {
    it('does not let an older load overwrite a newer one that already finished', async () => {
      let resolveOld: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      let resolveNew: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      vi.mocked(readAllWorkspaceDependencies)
        .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
        .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve; }));
      const provider = new PackagesProvider(new FilterManager('all'));

      const oldLoad = provider.loadPackages();
      const newLoad = provider.loadPackages();

      resolveNew([{
        name: 'new-package',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await newLoad;
      resolveOld([{
        name: 'old-package',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await oldLoad;

      expect(getPackageItems(provider).map(item => item.packageName)).toEqual(['new-package']);
    });

    it('does not let an older load with no discovered packages overwrite a newer one that already finished', async () => {
      let resolveOld: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      let resolveNew: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      vi.mocked(readAllWorkspaceDependencies)
        .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
        .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve; }));
      const provider = new PackagesProvider(new FilterManager('all'));

      const oldLoad = provider.loadPackages();
      const newLoad = provider.loadPackages();

      resolveNew([{
        name: 'new-package',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await newLoad;
      resolveOld([]);
      await oldLoad;

      expect(getPackageItems(provider).map(item => item.packageName)).toEqual(['new-package']);
    });

    it('keeps only the later of two reloads started back to back, such as a watcher tick racing a manual refresh', async () => {
      let resolveWatcherRead: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      vi.mocked(readAllWorkspaceDependencies).mockReturnValueOnce(new Promise((resolve) => {
        resolveWatcherRead = resolve;
      }));
      const provider = new PackagesProvider(new FilterManager('all'));

      const watcherReload = provider.loadPackages();
      const manualRefresh = provider.loadPackages();
      resolveWatcherRead([{
        name: 'stale-watcher-result',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await Promise.all([watcherReload, manualRefresh]);

      expect(getPackageItems(provider).map(item => item.packageName)).toEqual(['react', 'eslint']);
      expect(provider.getChildren().some(item => item instanceof LoadingItem)).toBe(false);
    });

    it('discards a load that finishes after the provider has been disposed', async () => {
      let resolveRead: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      vi.mocked(readAllWorkspaceDependencies).mockReturnValueOnce(new Promise((resolve) => {
        resolveRead = resolve;
      }));
      const provider = new PackagesProvider(new FilterManager('all'));

      const loadPromise = provider.loadPackages();
      provider.dispose();
      resolveRead([{
        name: 'late-package',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await loadPromise;

      expect(provider.getChildren().some(item => item instanceof LoadingItem)).toBe(true);
    });

    it('keeps the current cancellation token when an older, already-superseded load finishes first', async () => {
      let resolveOld: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      let resolveNew: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
      vi.mocked(readAllWorkspaceDependencies)
        .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
        .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve; }));
      const provider = new PackagesProvider(new FilterManager('all'));

      const oldLoad = provider.loadPackages();
      const newLoad = provider.loadPackages();

      resolveOld([{
        name: 'old-package',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await oldLoad;
      provider.dispose();
      resolveNew([{
        name: 'new-package',
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      }]);
      await newLoad;

      expect(provider.getChildren().some(item => item instanceof LoadingItem)).toBe(true);
    });

    it('does not open a second audit guard when a reload runs while an audit is in progress', async () => {
      let resolveFirstAudit: (value: Map<string, string>) => void = () => {};
      const runAuditMock = vi.fn().mockReturnValue(new Promise<Map<string, string>>((resolve) => {
        resolveFirstAudit = resolve;
      }));
      createClientMock.mockReturnValue({ runAudit: runAuditMock });
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();

      const firstAudit = provider.runAudit();
      await vi.waitFor(() => expect(runAuditMock).toHaveBeenCalledTimes(1));
      expect(createClientMock).toHaveBeenCalledTimes(1);

      await provider.loadPackages();
      void provider.runAudit();
      await Promise.resolve();
      await Promise.resolve();

      expect(createClientMock).toHaveBeenCalledTimes(1);

      resolveFirstAudit(new Map([['react', 'high']]));
      await firstAudit;
    });
  });
});