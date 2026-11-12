import { describe, expect, it, vi } from 'vitest';
import { buildPackageItem } from './fixtures/packageItem';
import { PackageItem } from '../providers/PackageItem';
import type { PackageOperation } from '../providers/PackageItem';
import { PackageCapabilityOperations } from '../providers/packageCapabilityOperations';
import { PackageProviderState } from '../providers/packageProviderState';
import { PackageRowMutationService } from '../providers/packageRowMutationService';
import type { ResolvedPackageItem } from '../providers/packageIdentity';
import type { PackageTreeEntry } from '../providers/treeBuilder';

const packageFilePath = '/workspace/package.json';

function createEntry(
  state: PackageProviderState,
  overrides: Partial<{
    packageName: string;
    currentVersion: string;
    latest: string | undefined;
    updateType: 'none' | 'patch' | 'minor' | 'breaking';
    operation: PackageOperation | undefined;
    packageFilePath: string;
    dev: boolean;
    versionPrefix: string;
  }> = {},
): PackageTreeEntry {
  const values = {
    packageName: 'react',
    currentVersion: '^1.0.0',
    latest: '2.0.0',
    updateType: 'breaking' as const,
    operation: undefined,
    packageFilePath,
    dev: false,
    versionPrefix: '^',
    ...overrides,
  };
  const item = state.createPackageItem(values);
  return { item, dev: values.dev, packageFilePath: values.packageFilePath };
}

function createFixture(options: { latest?: string; operation?: PackageOperation } = {}) {
  const state = new PackageProviderState();
  state.loading = false;
  state.packageSnapshotGeneration = 1;
  const entry = createEntry(state, {
    ...(options.latest !== undefined ? { latest: options.latest } : {}),
    ...(options.operation !== undefined ? { operation: options.operation } : {}),
  });
  state.rowStore.replaceAll([entry]);
  const emitTreeChanged = vi.fn();
  const capabilityOperations = new PackageCapabilityOperations(state);
  const service = new PackageRowMutationService(state, capabilityOperations, emitTreeChanged);
  const record = state.packageItemRecords.get(entry.item);
  if (record === undefined) {
    throw new Error('expected a package item record');
  }
  const capability = state.capabilities.issue(record.identity, record.row, {
    packageFilePath,
    packageDirectory: '/workspace',
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
    manifestDigest: 'digest',
  }, 1).value;
  return { state, entry, emitTreeChanged, service, record, capability };
}

function currentItem(state: PackageProviderState): PackageItem | undefined {
  return state.rowStore.allEntries[0]?.item;
}

describe('PackageRowMutationService', () => {
  it('returns identities for only the requested file and skips rows without records', () => {
    const fixture = createFixture();
    const devEntry = createEntry(fixture.state, { packageName: 'eslint', dev: true, versionPrefix: '' });
    const otherFileEntry = createEntry(fixture.state, { packageName: 'vue', packageFilePath: '/workspace/apps/web/package.json' });
    const unrecordedEntry: PackageTreeEntry = {
      item: buildPackageItem({ name: 'legacy', currentVersion: '1.0.0', packageFilePath }),
      dev: false,
      packageFilePath,
    };
    fixture.state.rowStore.replaceAll([fixture.entry, devEntry, otherFileEntry, unrecordedEntry]);

    expect(fixture.service.getPackageIdentitiesForFile(packageFilePath)).toEqual([
      { packageName: 'react', packageFilePath, section: 'dependencies' },
      { packageName: 'eslint', packageFilePath, section: 'devDependencies' },
    ]);
  });

  it('marks an exact row updated, preserves its version prefix, and ignores missing rows', () => {
    const fixture = createFixture();

    fixture.service.markPackageUpdated(fixture.record.identity, '3.0.0');
    fixture.service.markPackageUpdated({ ...fixture.record.identity, packageFilePath: '/missing/package.json' }, '4.0.0');

    expect(currentItem(fixture.state)).toMatchObject({
      currentVersion: '^3.0.0',
      updateType: 'none',
      versionPrefix: '^',
    });
    expect(fixture.emitTreeChanged).toHaveBeenCalledOnce();
  });

  it('does not emit a tree change when the row store rejects an update patch', () => {
    const fixture = createFixture();
    vi.spyOn(fixture.state.rowStore, 'patchRow').mockReturnValue(undefined);

    fixture.service.markPackageUpdated(fixture.record.identity, '3.0.0');

    expect(fixture.emitTreeChanged).not.toHaveBeenCalled();
  });

  it('resets update data while preserving the active operation and invalidates the cache', () => {
    const fixture = createFixture({ operation: { kind: 'update', target: '2.0.0' } });
    const invalidate = vi.fn();

    fixture.service.resetUpdateData(invalidate);

    expect(invalidate).toHaveBeenCalledOnce();
    expect(currentItem(fixture.state)).toMatchObject({
      currentVersion: '^1.0.0',
      latest: undefined,
      updateType: 'none',
      operation: { kind: 'update', target: '2.0.0' },
    });
    expect(fixture.emitTreeChanged).toHaveBeenCalledOnce();
  });

  it('marks exact rows installing and recalculates the update type after the operation clears', () => {
    const fixture = createFixture();
    const missing = { ...fixture.record.identity, packageName: 'missing' };

    fixture.service.markPackageUpdating(missing, true);
    fixture.service.markPackageUpdating(fixture.record.identity, true);
    expect(currentItem(fixture.state)).toMatchObject({
      operation: { kind: 'update', target: '2.0.0' },
      updateType: 'breaking',
    });

    fixture.service.markPackageUpdating(fixture.record.identity, false);

    expect(currentItem(fixture.state)).toMatchObject({ operation: undefined, updateType: 'breaking' });
    expect(fixture.emitTreeChanged).toHaveBeenCalledTimes(2);
  });

  it('updates a capability row and rejects a capability that the service did not issue', () => {
    const fixture = createFixture();
    const active = fixture.service.markPackageUpdatingForCapability(fixture.capability, { kind: 'update', target: '2.0.0' });

    expect(active).toBeDefined();
    expect(currentItem(fixture.state)).toMatchObject({ operation: { kind: 'update', target: '2.0.0' } });
    expect(fixture.service.markPackageUpdatingForCapability({} as ResolvedPackageItem, undefined)).toBeUndefined();
    fixture.service.markPackageUpdatedForCapability(active!, '2.0.0');
    fixture.service.markPackageUpdatedForCapability({} as ResolvedPackageItem, '3.0.0');

    expect(currentItem(fixture.state)).toMatchObject({
      currentVersion: '^2.0.0',
      updateType: 'none',
      operation: undefined,
    });
    expect(fixture.emitTreeChanged).toHaveBeenCalledTimes(2);
  });

  it('restores the prior operation when a reload starts during the progress notification', () => {
    const fixture = createFixture();
    fixture.emitTreeChanged.mockImplementation(() => {
      fixture.state.loading = true;
    });

    const active = fixture.service.markPackageUpdatingForCapability(fixture.capability, { kind: 'update', target: '2.0.0' });

    expect(active).toBeUndefined();
    expect(currentItem(fixture.state)).toMatchObject({ operation: undefined, currentVersion: '^1.0.0' });
    expect(fixture.emitTreeChanged).toHaveBeenCalledTimes(2);
  });

  it('restores the original entry if the progress notification removes it', () => {
    const fixture = createFixture();
    fixture.emitTreeChanged.mockImplementationOnce(() => {
      fixture.state.rowStore.replaceAll([]);
    });

    const active = fixture.service.markPackageUpdatingForCapability(fixture.capability, { kind: 'update', target: '2.0.0' });

    expect(active).toBeUndefined();
    expect(currentItem(fixture.state)).toBe(fixture.entry.item);
    expect(fixture.emitTreeChanged).toHaveBeenCalledTimes(2);
  });

  it('does not restore an old row over a replacement snapshot', () => {
    const fixture = createFixture();
    fixture.emitTreeChanged.mockImplementationOnce(() => {
      fixture.state.packageSnapshotGeneration += 1;
      fixture.state.rowStore.replaceAll([createEntry(fixture.state, {
        packageName: 'vue',
        currentVersion: '^3.0.0',
        latest: undefined,
        updateType: 'none',
      })]);
    });

    const active = fixture.service.markPackageUpdatingForCapability(fixture.capability, { kind: 'update', target: '2.0.0' });

    expect(active).toBeUndefined();
    expect(currentItem(fixture.state)).toMatchObject({ packageName: 'vue', currentVersion: '^3.0.0' });
    expect(fixture.emitTreeChanged).toHaveBeenCalledTimes(2);
  });
});