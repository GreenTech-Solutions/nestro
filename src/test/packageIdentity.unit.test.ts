import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  resolveCommandPackageItem,
  resolvePinManifestEntry,
  resolveUnambiguousManifestEntry,
  revalidateCommandPackageItem,
} from '../commands/packageIdentity';
import {
  readCanonicalDependencySpec,
  readCanonicalDependencySpecs,
  resolveCanonicalPackageLocation,
} from '../providers/packageIdentity';
import type { CanonicalPackageLocation, PackagesProvider, ResolvedPackageItem } from '../providers';

function makeCapability(section: 'dependencies' | 'devDependencies' = 'dependencies'): ResolvedPackageItem {
  const packageName = 'react';
  const packageFilePath = '/workspace/package.json';
  const item = {
    packageName,
    currentVersion: section === 'dependencies' ? '^1.0.0' : '~1.1.0',
    latest: undefined,
    updateType: 'none' as const,
    installing: false,
    vulnerabilitySeverity: undefined,
    packageFilePath,
    dev: section === 'devDependencies',
    versionPrefix: section === 'dependencies' ? '^' : '~',
  };
  return {
    item,
    identity: { packageName, packageFilePath, section },
    packageFilePath,
    packageDirectory: '/workspace',
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  };
}

function makeProvider(): {
  provider: PackagesProvider;
  resolve: ReturnType<typeof vi.fn>;
  revalidate: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn();
  const revalidate = vi.fn();
  return {
    provider: { resolvePackageItem: resolve, revalidatePackageItem: revalidate } as unknown as PackagesProvider,
    resolve,
    revalidate,
  };
}

describe('package identity command helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
  });

  it('returns a provider-issued capability and reports non-invalid resolution failures safely', async () => {
    const capability = makeCapability();
    const { provider, resolve } = makeProvider();
    resolve.mockResolvedValueOnce({ ok: true, value: capability });

    await expect(resolveCommandPackageItem({ forged: true }, provider)).resolves.toBe(capability);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();

    resolve.mockResolvedValueOnce({ ok: false, reason: 'invalid-item' });
    await expect(resolveCommandPackageItem({}, provider)).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();

    resolve.mockResolvedValueOnce({ ok: false, reason: 'path-replaced' });
    await expect(resolveCommandPackageItem({}, provider)).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('returns and reports revalidation results through the same sanitized boundary', async () => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValueOnce({ ok: true, value: capability });

    await expect(revalidateCommandPackageItem(capability, provider)).resolves.toBe(capability);

    revalidate.mockResolvedValueOnce({ ok: false, reason: 'not-current' });
    await expect(revalidateCommandPackageItem(capability, provider)).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('accepts one exact dependency entry and revalidates after reading it', async () => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^1.0.0' },
      devDependencies: {},
    })));

    await expect(resolveUnambiguousManifestEntry(capability, provider)).resolves.toBe(capability);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('stops before reading when the initial manifest revalidation rejects', async () => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValueOnce({ ok: false, reason: 'path-replaced' });

    await expect(resolveUnambiguousManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('accepts the dev section while checking the opposite section for ambiguity', async () => {
    const capability = makeCapability('devDependencies');
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: {},
      devDependencies: { react: '~1.1.0' },
    })));

    await expect(resolveUnambiguousManifestEntry(capability, provider)).resolves.toBe(capability);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('allows a pin action to keep the selected dev row when the name is duplicated', async () => {
    const capability = makeCapability('devDependencies');
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^9.0.0' },
      devDependencies: { react: '~1.1.0' },
    })));

    await expect(resolvePinManifestEntry(capability, provider)).resolves.toBe(capability);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['selected section changed', { dependencies: { react: '^9.0.0' }, devDependencies: { react: '^1.1.0' } }],
    ['selected section missing', { dependencies: { react: '^9.0.0' }, devDependencies: {} }],
  ] as const)('rejects a pin row when the selected manifest entry is %s', async (_label, manifest) => {
    const capability = makeCapability('devDependencies');
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(manifest)));

    await expect(resolvePinManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('stops a pin before reading when the capability is no longer current', async () => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValueOnce({ ok: false, reason: 'not-current' });

    await expect(resolvePinManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('sanitizes a pin manifest read failure', async () => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error('read failed'));

    await expect(resolvePinManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it.each([
    ['a mismatched current spec', { dependencies: { react: '^9.0.0' } }],
    ['a duplicate alternate-section spec', {
      dependencies: { react: '^1.0.0' },
      devDependencies: { react: '~1.1.0' },
    }],
    ['a missing entry', { dependencies: {}, devDependencies: null }],
    ['a non-object section', { dependencies: 'not-an-object' }],
  ] as const)('rejects %s before the legacy writer', async (_label, manifest) => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(manifest)));

    await expect(resolveUnambiguousManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a filesystem read failure', new Error('read failed')],
    ['malformed JSON', undefined],
  ] as const)('sanitizes %s', async (_label, failure) => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate.mockResolvedValue({ ok: true, value: capability });
    if (failure === undefined) {
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from('{'));
    }
    else {
      vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(failure);
    }

    await expect(resolveUnambiguousManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('does not add a second error when the final revalidation rejects a previously checked row', async () => {
    const capability = makeCapability();
    const { provider, revalidate } = makeProvider();
    revalidate
      .mockResolvedValueOnce({ ok: true, value: capability })
      .mockResolvedValueOnce({ ok: false, reason: 'not-current' });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^1.0.0' },
    })));

    await expect(resolveUnambiguousManifestEntry(capability, provider)).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Nestro: Package action is no longer available. Refresh the package list and try again.',
    );
  });

  it('reads only an exact string dependency spec and fails closed on malformed manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-spec-'));
    const manifest = join(root, 'package.json');
    const location: CanonicalPackageLocation = {
      packageFilePath: manifest,
      packageDirectory: root,
      workspaceFolderPath: root,
      fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      manifestDigest: 'digest',
    };
    try {
      await writeFile(manifest, JSON.stringify({
        dependencies: { react: '^1.0.0', numeric: 1 },
        devDependencies: null,
      }));
      expect(await readCanonicalDependencySpec(location, {
        packageName: 'react',
        packageFilePath: manifest,
        section: 'dependencies',
      })).toBe('^1.0.0');
      await expect(readCanonicalDependencySpec(location, {
        packageName: 'missing',
        packageFilePath: manifest,
        section: 'dependencies',
      })).resolves.toBeUndefined();
      await expect(readCanonicalDependencySpec(location, {
        packageName: 'numeric',
        packageFilePath: manifest,
        section: 'dependencies',
      })).resolves.toBeUndefined();
      await expect(readCanonicalDependencySpec(location, {
        packageName: 'react',
        packageFilePath: manifest,
        section: 'devDependencies',
      })).resolves.toBeUndefined();

      await writeFile(manifest, '{');
      await expect(readCanonicalDependencySpec(location, {
        packageName: 'react',
        packageFilePath: manifest,
        section: 'dependencies',
      })).resolves.toBeUndefined();
    }
    finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid manifest names, nested workspace ambiguity, and non-manifest symlink targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-path-'));
    const child = join(root, 'child');
    const manifest = join(child, 'package.json');
    const target = join(child, 'manifest.txt');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await mkdir(child);
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      await writeFile(target, '{}');
      expect(await resolveCanonicalPackageLocation('')).toEqual({ ok: false, reason: 'invalid-item' });
      expect(await resolveCanonicalPackageLocation(join(root, 'package.yaml'))).toEqual({
        ok: false,
        reason: 'invalid-item',
      });

      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: root } }, { uri: { fsPath: child } }],
      });
      const nested = await resolveCanonicalPackageLocation(manifest);
      expect(nested).toEqual(expect.objectContaining({ ok: true }));
      if (nested.ok) {
        expect(nested.value.workspaceFolderPath).toBe(await realpath(child));
      }

      const workspaceAlias = join(root, 'alias');
      await symlink(root, workspaceAlias);
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: root } }, { uri: { fsPath: workspaceAlias } }],
      });
      await expect(resolveCanonicalPackageLocation(manifest)).resolves.toEqual({
        ok: false,
        reason: 'cross-workspace',
      });

      const nonManifestAlias = join(root, 'non-manifest', 'package.json');
      await mkdir(join(root, 'non-manifest'));
      await symlink(target, nonManifestAlias);
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: root } }],
      });
      await expect(resolveCanonicalPackageLocation(nonManifestAlias)).resolves.toEqual({
        ok: false,
        reason: 'path-replaced',
      });
    }
    finally {
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: previousFolders,
      });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readCanonicalDependencySpecs', () => {
  it('returns one spec per identity, in the order the identities were given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-specs-'));
    try {
      const packageFilePath = join(root, 'package.json');
      await writeFile(packageFilePath, JSON.stringify({
        dependencies: { react: '^1.0.0', vue: '^2.0.0' },
        devDependencies: { react: '~3.0.0' },
      }));
      const location = { packageFilePath } as CanonicalPackageLocation;

      await expect(readCanonicalDependencySpecs(location, [
        { packageName: 'vue', packageFilePath, section: 'dependencies' },
        { packageName: 'react', packageFilePath, section: 'devDependencies' },
        { packageName: 'react', packageFilePath, section: 'dependencies' },
        { packageName: 'absent', packageFilePath, section: 'dependencies' },
      ])).resolves.toEqual(['^2.0.0', '~3.0.0', '^1.0.0', undefined]);
    }
    finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns no specs when the manifest parses to a non-object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-null-'));
    try {
      const packageFilePath = join(root, 'package.json');
      await writeFile(packageFilePath, 'null');
      const location = { packageFilePath } as CanonicalPackageLocation;
      const identity = { packageName: 'react', packageFilePath, section: 'dependencies' } as const;

      await expect(readCanonicalDependencySpecs(location, [identity])).resolves.toEqual([undefined]);
      await expect(readCanonicalDependencySpec(location, identity)).resolves.toBeUndefined();
    }
    finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});