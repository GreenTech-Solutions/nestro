import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageCapabilityOperations } from '../providers/packageCapabilityOperations';
import { PackageProviderState } from '../providers/packageProviderState';
import { resolveCanonicalPackageLocation } from '../providers/packageIdentity';

const temporaryRoots: string[] = [];

afterEach(async () => {
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
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: vscode.Uri.file(root), index: 0, name: 'workspace' }],
    });
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
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: previousFolders,
      });
    }
  });
});

function createState(): PackageProviderState {
  const state = new PackageProviderState();
  state.loading = false;
  state.packageSnapshotGeneration = 1;
  return state;
}