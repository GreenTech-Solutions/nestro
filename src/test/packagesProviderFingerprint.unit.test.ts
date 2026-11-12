import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { mockNestroConfiguration } from './fixtures/config';
import { setWorkspaceFolders } from './fixtures/workspaceFolders';
import { FilterManager, PackagesProvider } from '../providers';
import { PackageItem } from '../providers/PackageItem';
import { WorkspaceFolderItem } from '../providers/WorkspaceFolderItem';
import {
  fetchAllLatestVersions,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import { getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
beforeEach(() => {
  resetPackagesProviderDefaults();
});
describe('update fingerprint', () => {
  let root: string;
  let manifest: string;
  let previousFolders: typeof vscode.workspace.workspaceFolders;

  beforeEach(async () => {
    vi.clearAllMocks();
    // A config override installs a persistent mock that clearAllMocks() leaves in place.
    mockNestroConfiguration({});
    root = await realpath(await mkdtemp(join(tmpdir(), 'nestro-update-fingerprint-')));
    manifest = join(root, 'package.json');
    await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
    previousFolders = vscode.workspace.workspaceFolders;
    setWorkspaceFolders([{ uri: { fsPath: root } }]);
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([{
      name: 'react',
      current: '^1.0.0',
      dev: false,
      versionPrefix: '^',
      packageFilePath: manifest,
    }]);
    // A once-queued mock left unconsumed by a rejected fetch in one test must not
    // leak into the next test's own queued implementation.
    vi.mocked(fetchAllLatestVersions).mockReset();
  });

  afterEach(async () => {
    setWorkspaceFolders(previousFolders);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a fetch when the manifest changes while it is in flight, with no explicit invalidation', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    const fetchGate = new Promise<void>((resolveGate) => {
      vi.mocked(fetchAllLatestVersions).mockImplementationOnce(async () => {
        await writeFile(manifest, JSON.stringify({ dependencies: { react: '^9.0.0' } }));
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    releaseFetch(new Map([['react', '2.0.0']]));
    await check;

    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBeUndefined();

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([{
      name: 'react',
      current: '^9.0.0',
      dev: false,
      versionPrefix: '^',
      packageFilePath: manifest,
    }]);
    await provider.loadPackages();
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '9.5.0']]));
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('9.5.0');
  });

  it('rejects a fetch when a reload starts while it is in flight', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    const fetchGate = new Promise<void>((resolveGate) => {
      vi.mocked(fetchAllLatestVersions).mockImplementationOnce(async () => {
        await provider.loadPackages();
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    releaseFetch(new Map([['react', '2.0.0']]));
    await check;

    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '3.0.0']]));
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('3.0.0');
  });

  it('rejects a fetch when the update policy changes while it is in flight', async () => {
    mockNestroConfiguration({ updateTarget: 'latest' });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    const fetchGate = new Promise<void>((resolveGate) => {
      vi.mocked(fetchAllLatestVersions).mockImplementationOnce(async () => {
        mockNestroConfiguration({ updateTarget: 'minor' });
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    releaseFetch(new Map([['react', '2.0.0']]));
    await check;

    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBeUndefined();

    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.5.0']]));
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('1.5.0');
  });

  it('keeps an installing row and its known latest when a stale fetch is rejected', async () => {
    mockNestroConfiguration({ checkUpdatesForceAlways: true });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));
    await provider.checkUpdates();
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('2.0.0');

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    const fetchGate = new Promise<void>((resolveGate) => {
      vi.mocked(fetchAllLatestVersions).mockImplementationOnce(async () => {
        await writeFile(manifest, JSON.stringify({ dependencies: { react: '^9.0.0' } }));
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    provider.markPackageUpdating({ packageName: 'react', packageFilePath: manifest, section: 'dependencies' }, { kind: 'update', target: '2.0.0' });
    releaseFetch(new Map([['react', '3.0.0']]));
    await check;

    const react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react?.operation).toEqual({ kind: 'update', target: '2.0.0' });
    expect(react?.latest).toBe('2.0.0');
  });

  it('rejects a fetch when two sections swap the specs of the same package name', async () => {
    await writeFile(manifest, JSON.stringify({
      dependencies: { react: '^1.0.0' },
      devDependencies: { react: '^2.0.0' },
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: manifest },
      { name: 'react', current: '^2.0.0', dev: true, versionPrefix: '^', packageFilePath: manifest },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    const fetchGate = new Promise<void>((resolveGate) => {
      vi.mocked(fetchAllLatestVersions).mockImplementationOnce(async () => {
        await writeFile(manifest, JSON.stringify({
          dependencies: { react: '^2.0.0' },
          devDependencies: { react: '^1.0.0' },
        }));
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    releaseFetch(new Map([['react', '5.0.0']]));
    await check;

    expect(getPackageItems(provider).every(item => item.latest === undefined)).toBe(true);
  });

  it('treats a manifest that parses to a non-object as having no specs', async () => {
    await writeFile(manifest, 'null');
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));

    await provider.checkUpdates();

    expect(showError).not.toHaveBeenCalled();
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('2.0.0');
  });

  it('rejects a fetch when a manifest stops resolving while it is in flight', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      { name: 'ghost', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: manifest },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    const fetchGate = new Promise<void>((resolveGate) => {
      vi.mocked(fetchAllLatestVersions).mockImplementationOnce(async () => {
        await rm(manifest, { force: true });
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    releaseFetch(new Map([['ghost', '5.0.0']]));
    await check;

    expect(getPackageItems(provider).find(item => item.packageName === 'ghost')?.latest).toBeUndefined();
  });

  it('rejects a fetch when two manifests swap the specs of the same dependency', async () => {
    const otherManifest = join(root, 'apps', 'web', 'package.json');
    await mkdir(dirname(otherManifest), { recursive: true });
    await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
    await writeFile(otherManifest, JSON.stringify({ dependencies: { react: '^2.0.0' } }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: manifest },
      { name: 'react', current: '^2.0.0', dev: false, versionPrefix: '^', packageFilePath: otherManifest },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    let releaseFetch: (value: Map<string, string>) => void = () => {};
    let fetchCount = 0;
    const fetchGate = new Promise<void>((resolveGate) => {
      // Two manifests mean two fetches; only the first one swaps and gates, and the
      // second must still resolve or the check would fail for the wrong reason.
      vi.mocked(fetchAllLatestVersions).mockImplementation(async () => {
        fetchCount += 1;
        if (fetchCount > 1) {
          return new Map([['react', '5.0.0']]);
        }
        await writeFile(manifest, JSON.stringify({ dependencies: { react: '^2.0.0' } }));
        await writeFile(otherManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
        return await new Promise<Map<string, string>>((resolve) => {
          releaseFetch = resolve;
          resolveGate();
        });
      });
    });
    const check = provider.checkUpdates();
    await fetchGate;
    releaseFetch(new Map([['react', '5.0.0']]));
    await check;

    // Two manifests nest the rows under a workspace folder, so the flat helper misses them.
    const folders = provider.getChildren().filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    const rows = folders
      .flatMap(folder => folder.children)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    expect(rows).toHaveLength(2);
    expect(rows.every(item => item.latest === undefined)).toBe(true);
  });
});