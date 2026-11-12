import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildPackageItem } from './fixtures/packageItem';
import { FilterManager, PackagesProvider } from '../providers';
import { PackageItem } from '../providers/PackageItem';
import {
  readAllWorkspaceDependencies,
} from '../utils';
import { getPackageItems, resetPackagesProviderDefaults, setProviderState } from './fixtures/packagesProviderHarness';

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
  });
  it('preserves the version prefix when a package is marked updated', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    setProviderState(provider, {
      allEntries: [{
        item: buildPackageItem({ name: 'react', currentVersion: '^18.0.0', latest: '19.0.0', updateType: 'breaking', packageFilePath: '/workspace/package.json', dev: false, versionPrefix: '^' }),
        dev: false,
        packageFilePath: '/workspace/package.json',
      }],
    });

    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, '19.0.0');

    const entry = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries[0];
    expect(entry.item.currentVersion).toBe('^19.0.0');
    expect(entry.item.versionPrefix).toBe('^');
    expect(entry.item.updateType).toBe('none');
  });

  it('targets package mutations by exact package file path', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    setProviderState(provider, {
      allEntries: [
        {
          item: buildPackageItem({
            name: 'react',
            currentVersion: '^18.0.0',
            latest: '19.0.0',
            updateType: 'breaking',
            packageFilePath: '/workspace/apps/web/package.json',
            dev: false,
            versionPrefix: '^',
          }),
          dev: false,
          packageFilePath: '/workspace/apps/web/package.json',
        },
        {
          item: buildPackageItem({
            name: 'react',
            currentVersion: '~18.0.0',
            latest: '18.3.1',
            updateType: 'minor',
            packageFilePath: '/workspace/packages/ui/package.json',
            dev: false,
            versionPrefix: '~',
          }),
          dev: false,
          packageFilePath: '/workspace/packages/ui/package.json',
        },
      ],
    });

    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '/workspace/packages/ui/package.json',
      section: 'dependencies',
    }, '18.3.1');
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/packages/ui/package.json',
      section: 'dependencies',
    }, { kind: 'update', target: '18.3.1' });
    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '',
      section: 'dependencies',
    }, '20.0.0');
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '',
      section: 'dependencies',
    }, undefined);

    const entries = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries;

    expect(entries.map(entry => ({
      currentVersion: entry.item.currentVersion,
      operation: entry.item.operation,
      packageFilePath: entry.item.packageFilePath,
      updateType: entry.item.updateType,
    }))).toEqual([
      {
        currentVersion: '^18.0.0',
        operation: undefined,
        packageFilePath: '/workspace/apps/web/package.json',
        updateType: 'breaking',
      },
      {
        currentVersion: '~18.3.1',
        operation: { kind: 'update', target: '18.3.1' },
        packageFilePath: '/workspace/packages/ui/package.json',
        updateType: 'none',
      },
    ]);
  });

  it('targets package state mutations by dependency section', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'react',
        current: '~18.1.0',
        dev: true,
        versionPrefix: '~',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, { kind: 'update', target: '19.0.0' });

    let packages = getPackageItems(provider);
    expect(packages.map(item => ({
      currentVersion: item.currentVersion,
      dev: item.dev,
      operation: item.operation,
    }))).toEqual([
      { currentVersion: '^18.0.0', dev: false, operation: undefined },
      { currentVersion: '~18.1.0', dev: true, operation: { kind: 'update', target: '19.0.0' } },
    ]);

    await provider.loadPackages();
    packages = getPackageItems(provider);
    expect(packages.map(item => ({
      dev: item.dev,
      operation: item.operation,
    }))).toEqual([
      { dev: false, operation: undefined },
      { dev: true, operation: { kind: 'update', target: '19.0.0' } },
    ]);

    provider.markPackageUpdated({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'devDependencies',
    }, '19.0.0');

    packages = getPackageItems(provider);
    expect(packages.map(item => ({
      currentVersion: item.currentVersion,
      dev: item.dev,
      operation: item.operation,
      updateType: item.updateType,
    }))).toEqual([
      { currentVersion: '^18.0.0', dev: false, operation: undefined, updateType: 'breaking' },
      { currentVersion: '~19.0.0', dev: true, operation: undefined, updateType: 'none' },
    ]);
  });

  it('reconciles a failed update after reload sees the target current version', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, { kind: 'update', target: '19.0.0' });

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '19.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await provider.loadPackages();

    let react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react).toMatchObject({
      currentVersion: '19.0.0',
      latest: '19.0.0',
      updateType: 'breaking',
      operation: { kind: 'update', target: '19.0.0' },
    });
    expect(provider.getVisibleOutdatedPackages()).toEqual([]);

    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, undefined);

    react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react).toMatchObject({
      currentVersion: '19.0.0',
      latest: '19.0.0',
      updateType: 'none',
      operation: undefined,
    });
    expect(provider.getVisibleOutdatedPackages()).toEqual([]);
  });

  it('clears active update state after successful completion following a changed-version reload', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const identity = {
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies' as const,
    };
    provider.markPackageUpdating(identity, { kind: 'update', target: '19.0.0' });

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '19.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await provider.loadPackages();

    provider.markPackageUpdated(identity, '19.0.0');

    expect(getPackageItems(provider).map(item => ({
      currentVersion: item.currentVersion,
      latest: item.latest,
      updateType: item.updateType,
      operation: item.operation,
    }))).toEqual([
      { currentVersion: '19.0.0', latest: undefined, updateType: 'none', operation: undefined },
    ]);
  });
});