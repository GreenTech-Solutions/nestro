import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { makeContext } from './fixtures';
import { makeProvider } from './fixtures/providerStub';
import { PACKAGE_JSON_WATCHER_DEBOUNCE_MS } from '../config';
import { registerPackageJsonWatcher } from '../extension';
import { FilterManager, PackagesProvider } from '../providers';
import type { PackageLoadingServiceContract, PackageLoadingSnapshot } from '../providers';

const contexts: vscode.ExtensionContext[] = [];
const providers: PackagesProvider[] = [];

describe('registerPackageJsonWatcher()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    contexts.forEach(context => context.subscriptions.forEach(disposable => disposable.dispose()));
    contexts.length = 0;
    providers.forEach(provider => provider.dispose());
    providers.length = 0;
    vi.useRealTimers();
  });

  it('refreshes packages after the debounce when a manifest changes', async () => {
    const provider = makeProvider();
    const uri = vscode.Uri.file('/workspace/package.json');

    registerPackageJsonWatcher(trackContext(), provider);
    getWatcherHandler('onDidChange')(uri);
    vi.advanceTimersByTime(PACKAGE_JSON_WATCHER_DEBOUNCE_MS - 1);
    expect(provider.loadPackages).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('debounces several rapid file events into one refresh', async () => {
    const provider = makeProvider();
    const uri = vscode.Uri.file('/workspace/package.json');

    registerPackageJsonWatcher(trackContext(), provider);
    getWatcherHandler('onDidChange')(uri);
    vi.advanceTimersByTime(100);
    getWatcherHandler('onDidCreate')(uri);
    vi.advanceTimersByTime(100);
    getWatcherHandler('onDidChange')(uri);
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('skips a provider write when its digest matches the recorded baseline', async () => {
    const filePath = '/workspace/package.json';
    const { provider, files } = await makeDigestProvider([filePath]);
    const invalidateUpdateCache = vi.spyOn(provider, 'invalidateUpdateCache');
    const uri = vscode.Uri.file(filePath);

    registerPackageJsonWatcher(trackContext(), provider);
    await provider.withWriteSuppressed(writeManifest(files, filePath, 'provider write'));
    getWatcherHandler('onDidChange')(uri);
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('reloads after an external edit immediately following a provider write', async () => {
    const filePath = '/workspace/package.json';
    const { provider, files } = await makeDigestProvider([filePath]);
    const invalidateUpdateCache = vi.spyOn(provider, 'invalidateUpdateCache');
    const uri = vscode.Uri.file(filePath);

    registerPackageJsonWatcher(trackContext(), provider);
    await provider.withWriteSuppressed(writeManifest(files, filePath, 'provider write'));
    files.set(filePath, 'external edit');
    getWatcherHandler('onDidChange')(uri);
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(invalidateUpdateCache).toHaveBeenCalledTimes(2);
  });

  it('reloads when a manifest is unreadable after a provider write', async () => {
    const filePath = '/workspace/package.json';
    const { provider, files } = await makeDigestProvider([filePath]);
    const uri = vscode.Uri.file(filePath);

    registerPackageJsonWatcher(trackContext(), provider);
    await provider.withWriteSuppressed(() => {
      files.delete(filePath);
      return Promise.resolve();
    });
    getWatcherHandler('onDidChange')(uri);
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('reloads when a tracked manifest becomes unreadable at debounce', async () => {
    const filePath = '/workspace/package.json';
    const { provider, files } = await makeDigestProvider([filePath]);
    const uri = vscode.Uri.file(filePath);

    registerPackageJsonWatcher(trackContext(), provider);
    await provider.withWriteSuppressed(writeManifest(files, filePath, 'provider write'));
    files.delete(filePath);
    getWatcherHandler('onDidChange')(uri);
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('does not baseline an external edit already pending when another manifest is written', async () => {
    const packageFileA = '/workspace/a/package.json';
    const packageFileB = '/workspace/b/package.json';
    const { provider, files } = await makeDigestProvider([packageFileA, packageFileB]);

    registerPackageJsonWatcher(trackContext(), provider);
    files.set(packageFileB, 'external edit');
    getWatcherHandler('onDidChange')(vscode.Uri.file(packageFileB));
    await provider.withWriteSuppressed(writeManifest(files, packageFileA, 'provider write'));
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('preserves existing baselines across nested writes', async () => {
    const packageFileA = '/workspace/a/package.json';
    const packageFileB = '/workspace/b/package.json';
    const { provider, files } = await makeDigestProvider([packageFileA, packageFileB]);

    await provider.withWriteSuppressed(writeManifest(files, packageFileA, 'first provider write'));
    await provider.withWriteSuppressed(async () => {
      await provider.withWriteSuppressed(writeManifest(files, packageFileB, 'nested provider write'));
    });

    expect(await provider.isOwnManifestWrite(vscode.Uri.file(packageFileA))).toBe(true);
    expect(await provider.isOwnManifestWrite(vscode.Uri.file(packageFileB))).toBe(true);
  });

  it('refreshes after a delete event without a matching baseline', async () => {
    const provider = makeProvider();
    const uri = vscode.Uri.file('/workspace/package.json');

    registerPackageJsonWatcher(trackContext(), provider);
    getWatcherHandler('onDidDelete')(uri);
    vi.advanceTimersByTime(PACKAGE_JSON_WATCHER_DEBOUNCE_MS - 1);
    expect(provider.loadPackages).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
    expect(provider.invalidateUpdateCache).toHaveBeenCalledTimes(1);
  });

  it('recreates watchers when refresh is called', () => {
    const provider = makeProvider();

    const watcherController = registerPackageJsonWatcher(trackContext(), provider);
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);

    watcherController.refresh();

    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
  });

  it('disposes watchers and cancels a pending debounce on dispose', async () => {
    const provider = makeProvider();
    const watcherController = registerPackageJsonWatcher(trackContext(), provider);
    const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[0].value;
    getWatcherHandler('onDidChange')(vscode.Uri.file('/workspace/package.json'));

    watcherController.dispose();
    await vi.advanceTimersByTimeAsync(PACKAGE_JSON_WATCHER_DEBOUNCE_MS);

    expect(watcher.dispose).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).not.toHaveBeenCalled();
  });
});

function writeManifest(files: Map<string, string>, filePath: string, contents: string): () => Promise<void> {
  return () => {
    files.set(filePath, contents);
    return Promise.resolve();
  };
}

async function makeDigestProvider(packageFilePaths: readonly string[]): Promise<{
  provider: PackagesProvider;
  files: Map<string, string>;
}> {
  const files = new Map(packageFilePaths.map(filePath => [filePath, 'initial content']));
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
    const contents = files.get(uri.fsPath);
    if (contents === undefined) {
      return Promise.reject(new Error(`Manifest is unavailable: ${uri.fsPath}`));
    }
    return Promise.resolve(Buffer.from(contents));
  });
  const snapshot: PackageLoadingSnapshot = {
    entries: [],
    packageFilePaths,
    readablePackageFilePaths: [],
    failedPackageReadPaths: [],
    packageLocationBaselines: new Map(),
    packageReadFailed: false,
  };
  const packageLoadingService: PackageLoadingServiceContract = {
    load: () => Promise.resolve(snapshot),
    readPackageEntries: () => Promise.resolve([]),
    discoverPackageFilePaths: () => Promise.resolve([]),
  };
  const provider = new PackagesProvider(new FilterManager('all'), packageLoadingService);
  providers.push(provider);
  await provider.loadPackages();
  vi.spyOn(provider, 'loadPackages').mockResolvedValue(undefined);
  return { provider, files };
}

function trackContext(): vscode.ExtensionContext {
  const context = makeContext();
  contexts.push(context);
  return context;
}

function getWatcherHandler(
  event: 'onDidChange' | 'onDidCreate' | 'onDidDelete',
): (uri: vscode.Uri) => void {
  const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[0].value;
  return vi.mocked(watcher[event]).mock.calls[0][0];
}