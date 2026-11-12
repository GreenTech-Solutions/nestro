import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageCapabilityOperations } from '../providers/packageCapabilityOperations';
import { PackageProviderState } from '../providers/packageProviderState';
import { resolveCanonicalPackageLocation } from '../providers/packageLocationResolution';

const temporaryRoots: string[] = [];
const restoreWorkspaceFolders: (() => void)[] = [];

afterEach(async () => {
  restoreWorkspaceFolders.splice(0).reverse().forEach(restore => restore());
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('PackageCapabilityOperations', () => {
  it('returns path failures for invalid manifest locations', async () => {
    const state = createState();
    const operations = new PackageCapabilityOperations(state);
    const item = state.createPackageItem({
      packageName: 'react',
      currentVersion: '1.0.0',
      updateType: 'none',
      packageFilePath: '',
      dev: false,
      versionPrefix: '',
    });
    state.rowStore.replaceAll([{ item, dev: false, packageFilePath: '' }]);
    const record = state.packageItemRecords.get(item);
    expect(record).toBeDefined();

    const location = {
      packageFilePath: '',
      packageDirectory: '',
      workspaceFolderPath: '',
      fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      manifestDigest: '',
    };
    const capability = state.capabilities.issue(record!.identity, record!.row, location, 1).value;

    await expect(operations.resolvePackageItem(item)).resolves.toEqual({ ok: false, reason: 'invalid-item' });
    await expect(operations.revalidatePackageItem(capability)).resolves.toEqual({ ok: false, reason: 'invalid-item' });
    await expect(operations.refreshPackageBaselineForCapability(capability, '1.0.0')).resolves.toBeUndefined();
    await expect(operations.reissuePackageCapability(capability)).resolves.toBeUndefined();
  });

  it('rejects a manifest spec that no longer matches the rendered row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-capability-operations-'));
    temporaryRoots.push(root);
    const packageFilePath = join(root, 'package.json');
    await writeFile(packageFilePath, JSON.stringify({ dependencies: { react: '^2.0.0' } }));
    const previousFolders = vscode.workspace.workspaceFolders;
    setWorkspaceFolders([{ uri: vscode.Uri.file(root), index: 0, name: 'workspace' }]);
    try {
      const state = createState();
      const location = await resolveCanonicalPackageLocation(packageFilePath);
      expect(location.ok).toBe(true);
      if (!location.ok) {
        return;
      }
      state.packageLocationBaselines.set(packageFilePath, location.value);
      const item = state.createPackageItem({
        packageName: 'react',
        currentVersion: '^1.0.0',
        updateType: 'none',
        packageFilePath,
        dev: false,
        versionPrefix: '^',
      });
      state.rowStore.replaceAll([{ item, dev: false, packageFilePath }]);
      const record = state.packageItemRecords.get(item);
      expect(record).toBeDefined();
      const operations = new PackageCapabilityOperations(state);
      const capability = state.capabilities.issue(record!.identity, record!.row, location.value, 1).value;

      await expect(operations.resolvePackageItem(item)).resolves.toEqual({ ok: false, reason: 'path-replaced' });
      await expect(operations.revalidatePackageItem(capability)).resolves.toEqual({ ok: false, reason: 'path-replaced' });
    }
    finally {
      setWorkspaceFolders(previousFolders);
    }
  });

  it('resolves, revalidates, refreshes, and reissues a capability for the current manifest', async () => {
    const fixture = await createCapabilityFixture();

    const resolved = await fixture.operations.resolvePackageItem(fixture.item);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }

    await expect(fixture.operations.revalidatePackageItem(resolved.value)).resolves.toMatchObject({ ok: true });
    await expect(fixture.operations.refreshPackageBaselineForCapability(resolved.value, '^1.0.0')).resolves.toMatchObject({
      identity: { packageName: 'react', packageFilePath: fixture.packageFilePath, section: 'dependencies' },
    });
    expect(fixture.state.rowStore.allEntries.map(entry => (
      fixture.state.packageItemRecords.get(entry.item)?.baselineLocation?.packageFilePath
    ))).toEqual([fixture.canonicalPackageFilePath, fixture.canonicalPackageFilePath]);

    await expect(fixture.operations.refreshPackageBaselineForCapability(resolved.value, '^9.0.0')).resolves.toBeUndefined();
    await expect(fixture.operations.reissuePackageCapability(resolved.value)).resolves.toMatchObject({
      identity: { packageName: 'react', packageFilePath: fixture.packageFilePath },
    });
  });

  it('rejects loading, detached, and ambiguous package rows without resolving their paths', async () => {
    const state = createState();
    const operations = new PackageCapabilityOperations(state);
    const detachedItem = state.createPackageItem({
      packageName: 'react',
      currentVersion: '^1.0.0',
      updateType: 'none',
      packageFilePath: '/workspace/package.json',
      dev: false,
      versionPrefix: '^',
    });
    await expect(operations.resolvePackageItem(detachedItem)).resolves.toEqual({ ok: false, reason: 'not-current' });

    state.rowStore.replaceAll([{ item: detachedItem, dev: false, packageFilePath: detachedItem.packageFilePath }]);
    state.loading = true;
    await expect(operations.resolvePackageItem(detachedItem)).resolves.toEqual({ ok: false, reason: 'not-current' });

    state.loading = false;
    const duplicate = state.createPackageItem({
      packageName: 'react',
      currentVersion: '^1.0.0',
      updateType: 'none',
      packageFilePath: detachedItem.packageFilePath,
      dev: false,
      versionPrefix: '^',
    });
    state.rowStore.replaceAll([
      { item: detachedItem, dev: false, packageFilePath: detachedItem.packageFilePath },
      { item: duplicate, dev: false, packageFilePath: duplicate.packageFilePath },
    ]);

    await expect(operations.resolvePackageItem(detachedItem)).resolves.toEqual({ ok: false, reason: 'not-current' });
  });
});

function createState(): PackageProviderState {
  const state = new PackageProviderState();
  state.loading = false;
  state.packageSnapshotGeneration = 1;
  return state;
}

async function createCapabilityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nestro-capability-operations-'));
  temporaryRoots.push(root);
  const packageFilePath = join(root, 'package.json');
  await writeFile(packageFilePath, JSON.stringify({
    dependencies: { react: '^1.0.0' },
    devDependencies: { react: '^1.0.0' },
  }));
  restoreWorkspaceFolders.push(setWorkspaceFolders([{ uri: vscode.Uri.file(root), index: 0, name: 'workspace' }]));
  const location = await resolveCanonicalPackageLocation(packageFilePath);
  if (!location.ok) {
    throw new Error(`expected a canonical package location, got ${location.reason}`);
  }

  const state = createState();
  state.packageLocationBaselines.set(packageFilePath, location.value);
  const item = state.createPackageItem({
    packageName: 'react',
    currentVersion: '^1.0.0',
    updateType: 'none',
    packageFilePath,
    dev: false,
    versionPrefix: '^',
  });
  const devItem = state.createPackageItem({
    packageName: 'react',
    currentVersion: '^1.0.0',
    updateType: 'none',
    packageFilePath,
    dev: true,
    versionPrefix: '^',
  });
  state.rowStore.replaceAll([
    { item, dev: false, packageFilePath },
    { item: devItem, dev: true, packageFilePath },
  ]);
  return {
    item,
    operations: new PackageCapabilityOperations(state),
    packageFilePath,
    canonicalPackageFilePath: location.value.packageFilePath,
    state,
  };
}