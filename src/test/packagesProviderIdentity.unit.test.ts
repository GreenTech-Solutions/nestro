import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { mockNestroConfiguration } from './fixtures/config';
import { setWorkspaceFolders } from './fixtures/workspaceFolders';
import { buildPackageItem } from './fixtures/packageItem';
import {
  FilterManager,
  GroupItem,
  PACKAGE_IDENTITY_REJECTED_MESSAGE,
  PackageItem,
  PackagesProvider,
  StatusItem,
  WorkspaceFolderItem,
} from '../providers';
import { resolveCanonicalPackageLocation } from '../providers/packageLocationResolution';
import { LoadingItem } from '../providers/LoadingItem';
import {
  fetchAllLatestVersions,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import { getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';
// LoadingItem is not part of the providers barrel's public surface (used only internally by
// PackagesProvider), so it must be imported directly from its implementation file.

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
beforeEach(() => {
  resetPackagesProviderDefaults();
});
describe('package identity boundary', () => {
  it('rejects a manifest replaced after materialization before the first mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-baseline-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: manifest,
      }]);
      vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      await provider.checkUpdates();
      const item = getPackageItems(provider)[0];
      await rename(manifest, `${manifest}.original`);
      await writeFile(manifest, JSON.stringify({ name: 'replacement', dependencies: { react: '^1.0.0' } }));
      mockNestroConfiguration({ deferInstallAfterUpdate: true });
      const { installUpdateCommand } = await import('../commands/installUpdate');

      await installUpdateCommand(item, provider);

      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith(
        PACKAGE_IDENTITY_REJECTED_MESSAGE,
      );
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an in-place manifest rewrite with the original inode before mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-in-place-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      const beforeRewrite = await stat(manifest);
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: manifest,
      }]);
      vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      await provider.checkUpdates();
      const item = getPackageItems(provider)[0];

      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^9.0.0' } }));
      const afterRewrite = await stat(manifest);
      expect(afterRewrite.ino).toBe(beforeRewrite.ino);
      mockNestroConfiguration({ deferInstallAfterUpdate: true });
      const { installUpdateCommand } = await import('../commands/installUpdate');

      await installUpdateCommand(item, provider);

      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith(
        PACKAGE_IDENTITY_REJECTED_MESSAGE,
      );
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not issue a progress capability when tree refresh starts a reload synchronously', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-reload-race-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([{
        name: 'react',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: manifest,
      }]);
      vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));
      mockNestroConfiguration({ deferInstallAfterUpdate: true });
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      await provider.checkUpdates();
      const item = getPackageItems(provider)[0];

      let reloadPromise: Promise<void> | undefined;
      let reloadStarted = false;
      const subscription = provider.onDidChangeTreeData(() => {
        if (!reloadStarted) {
          reloadStarted = true;
          reloadPromise = provider.loadPackages();
        }
      });
      const { installUpdateCommand } = await import('../commands/installUpdate');
      const command = installUpdateCommand(item, provider);
      await command;
      await reloadPromise;
      subscription.dispose();

      expect(reloadStarted).toBe(true);
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(provider.getChildren().some(entry => entry instanceof LoadingItem)).toBe(false);
      expect(getPackageItems(provider).find(entry => entry.packageName === 'react')?.installing).toBe(false);
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale and forged rows while ignoring mutations of a provider-owned row object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-rows-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      const entry = {
        name: 'react',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: manifest,
      };
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([entry]);
      vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '2.0.0']]));
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      const renderedBeforeReload = getPackageItems(provider)[0];
      await provider.loadPackages();
      await expect(provider.resolvePackageItem(renderedBeforeReload)).resolves.toEqual({
        ok: false,
        reason: 'not-current',
      });

      const current = getPackageItems(provider)[0];
      const forged = buildPackageItem({ name: 'react', currentVersion: '^1.0.0', latest: '9.9.9', updateType: 'breaking', packageFilePath: manifest, versionPrefix: '^' });
      await expect(provider.resolvePackageItem(forged)).resolves.toEqual({
        ok: false,
        reason: 'not-current',
      });

      const currentWithMutation = current as unknown as {
        packageName: string;
        packageFilePath: string;
        latest: string | undefined;
      };
      currentWithMutation.packageName = 'attacker-controlled-name';
      currentWithMutation.packageFilePath = join(root, 'outside', 'package.json');
      currentWithMutation.latest = '9.9.9';
      const resolved = await provider.resolvePackageItem(current);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.identity.packageName).toBe('react');
        expect(resolved.value.packageFilePath).toBe(await realpath(manifest));
        expect(resolved.value.item.packageName).toBe('react');
        expect(resolved.value.item.latest).toBeUndefined();
        expect(Object.isFrozen(resolved.value)).toBe(true);
        expect(Object.isFrozen(resolved.value.item)).toBe(true);
        expect(Object.isFrozen(resolved.value.identity)).toBe(true);
        expect(Object.isFrozen(resolved.value.fileStamp)).toBe(true);
        try {
          (resolved.value.identity as { packageName: string }).packageName = 'forged';
          (resolved.value.fileStamp as { ino: number }).ino = 99;
        }
        catch {
          // Frozen capability fields are expected to reject mutation in strict mode.
        }
        expect(resolved.value.identity.packageName).toBe('react');
        expect(resolved.value.fileStamp.ino).not.toBe(99);
        await expect(provider.revalidatePackageItem(resolved.value)).resolves.toMatchObject({ ok: true });
        await expect(provider.revalidatePackageItem({ ...resolved.value })).resolves.toEqual({
          ok: false,
          reason: 'invalid-item',
        });
      }
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes duplicate package names by dependency section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-sections-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({
        dependencies: { react: '^1.0.0' },
        devDependencies: { react: '~1.1.0' },
      }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: manifest },
        { name: 'react', current: '~1.1.0', dev: true, versionPrefix: '~', packageFilePath: manifest },
      ]);
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      const rows = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries.map(entry => entry.item);
      expect(rows).toHaveLength(2);
      const resolutions = await Promise.all(rows.map(row => provider.resolvePackageItem(row)));
      expect(resolutions.every(result => result.ok)).toBe(true);
      expect(resolutions.map(result => result.ok ? result.value.identity.section : undefined)).toEqual([
        'dependencies',
        'devDependencies',
      ]);
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a row issued by a different provider instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-foreign-provider-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([{
        name: 'react',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: manifest,
      }]);
      const firstProvider = new PackagesProvider(new FilterManager('all'));
      const secondProvider = new PackagesProvider(new FilterManager('all'));
      await firstProvider.loadPackages();
      await secondProvider.loadPackages();

      const firstItem = getPackageItems(firstProvider)[0];
      await expect(secondProvider.resolvePackageItem(firstItem)).resolves.toEqual({
        ok: false,
        reason: 'not-current',
      });
      firstProvider.dispose();
      secondProvider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps provider-issued capabilities current across progress, baseline refresh, and update marks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-capability-lifecycle-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: manifest,
      }]);
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();

      const row = getPackageItems(provider)[0];
      expect(provider.getTreeItem(row)).toBe(row);
      const group = new GroupItem('Dependencies', [row], 1, 0, false);
      expect(provider.getChildren(group)).toEqual([row]);
      expect(provider.getChildren(new StatusItem('status', '', 'info'))).toEqual([]);
      const folder = new WorkspaceFolderItem('root', root, [group]);
      expect(provider.getChildren(folder)).toEqual([group]);
      const treeView = { badge: undefined, message: 'stale' } as unknown as vscode.TreeView<vscode.TreeItem>;
      provider.attachTreeView(treeView);
      expect(treeView.message).toBeUndefined();

      await expect(provider.resolvePackageItem(undefined)).resolves.toEqual({
        ok: false,
        reason: 'invalid-item',
      });
      const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile'); } });
      await expect(provider.resolvePackageItem(hostile)).resolves.toEqual({
        ok: false,
        reason: 'invalid-item',
      });

      const resolved = await provider.resolvePackageItem(row);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        throw new Error('expected a canonical capability');
      }
      await expect(provider.revalidatePackageItem(resolved.value)).resolves.toMatchObject({ ok: true });

      const active = provider.markPackageUpdatingForCapability(resolved.value, { kind: 'update', target: '1.0.0' });
      expect(active).toBeDefined();
      if (active === undefined) {
        throw new Error('expected an active capability');
      }
      const inactive = provider.markPackageUpdatingForCapability(active, undefined);
      expect(inactive).toBeDefined();
      if (inactive === undefined) {
        throw new Error('expected a replacement capability');
      }
      expect(provider.markPackageUpdatingForCapability(resolved.value, { kind: 'update', target: '1.0.0' })).toBeUndefined();
      await expect(provider.reissuePackageCapability(inactive)).resolves.toBeDefined();

      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.1' } }));
      const refreshed = await provider.refreshPackageBaselineForCapability(inactive, '^1.0.1');
      expect(refreshed).toBeDefined();
      if (refreshed === undefined) {
        throw new Error('expected a refreshed capability');
      }
      provider.markPackageUpdatedForCapability(refreshed, '1.0.1');
      expect(provider.markPackageUpdatedForCapability(inactive, '9.9.9')).toBeUndefined();
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps duplicate names in separate manifests tied to their exact paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-duplicate-manifests-'));
    const firstRoot = join(root, 'first');
    const secondRoot = join(root, 'second');
    const firstManifest = join(firstRoot, 'package.json');
    const secondManifest = join(secondRoot, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await mkdir(firstRoot);
      await mkdir(secondRoot);
      await writeFile(firstManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      await writeFile(secondManifest, JSON.stringify({ dependencies: { react: '~1.1.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: firstManifest },
        { name: 'react', current: '~1.1.0', dev: false, versionPrefix: '~', packageFilePath: secondManifest },
      ]);
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      const rows = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries.map(entry => entry.item);
      const resolutions = await Promise.all(rows.map(row => provider.resolvePackageItem(row)));

      expect(resolutions.every(result => result.ok)).toBe(true);
      expect(resolutions.map(result => result.ok ? result.value.identity.packageFilePath : undefined)).toEqual([
        firstManifest,
        secondManifest,
      ]);
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a case-only manifest alias only when the filesystem resolves it to the owned file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-case-alias-'));
    const manifest = join(root, 'package.json');
    const caseAliasRoot = join(dirname(root), basename(root).toUpperCase());
    const caseAlias = join(caseAliasRoot, 'package.json');
    const distinctCaseSymlinkRoot = caseAliasRoot;
    const distinctCaseSymlink = join(distinctCaseSymlinkRoot, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    let createdDistinctCaseSymlink = false;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      const result = await resolveCanonicalPackageLocation(caseAlias);
      const aliasExists = await stat(caseAlias).then(() => true).catch(() => false);
      if (aliasExists) {
        expect(result).toEqual(expect.objectContaining({ ok: true }));
        if (result.ok) {
          expect(result.value.packageFilePath).toBe(await realpath(manifest));
        }
      }
      else {
        // On a case-sensitive filesystem this is a distinct/nonexistent path;
        // accepting it would weaken the ownership boundary.
        expect(result.ok).toBe(false);
      }

      try {
        await symlink(root, distinctCaseSymlinkRoot);
        createdDistinctCaseSymlink = true;
      }
      catch {
        // A case-insensitive filesystem already resolves this spelling to root.
      }
      if (createdDistinctCaseSymlink) {
        await expect(resolveCanonicalPackageLocation(distinctCaseSymlink)).resolves.toEqual({
          ok: false,
          reason: 'cross-workspace',
        });
      }

      const symlinkWorkspaceRoot = join(dirname(root), `${basename(root)}-workspace-link`);
      const symlinkWorkspaceAliasRoot = join(dirname(root), `${basename(root).toUpperCase()}-WORKSPACE-LINK`);
      const symlinkWorkspaceAlias = join(symlinkWorkspaceAliasRoot, 'package.json');
      let createdWorkspaceSymlink = false;
      try {
        await symlink(root, symlinkWorkspaceRoot);
        createdWorkspaceSymlink = true;
        setWorkspaceFolders([{ uri: { fsPath: symlinkWorkspaceRoot } }]);
        const symlinkAliasResult = await resolveCanonicalPackageLocation(symlinkWorkspaceAlias);
        const symlinkAliasExists = await stat(symlinkWorkspaceAlias).then(() => true).catch(() => false);
        if (symlinkAliasExists) {
          expect(symlinkAliasResult).toEqual(expect.objectContaining({ ok: true }));
        }
        else {
          expect(symlinkAliasResult.ok).toBe(false);
        }
      }
      catch {
        // A platform may not permit creating this temporary alias; the direct
        // case-spelling test above still covers the filesystem's native policy.
      }
      finally {
        if (createdWorkspaceSymlink) {
          await rm(symlinkWorkspaceRoot, { recursive: true, force: true });
        }
      }
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
      if (createdDistinctCaseSymlink) {
        await rm(distinctCaseSymlinkRoot, { recursive: true, force: true });
      }
    }
  });

  it('accepts an internal symlink while rejecting a symlink into another workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-symlink-'));
    const workspaceRoot = join(root, 'workspace');
    const targetRoot = join(workspaceRoot, 'target');
    const aliasRoot = join(workspaceRoot, 'alias');
    const otherRoot = join(root, 'other');
    const internalManifest = join(aliasRoot, 'package.json');
    const otherManifest = join(otherRoot, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await mkdir(targetRoot, { recursive: true });
      await mkdir(otherRoot, { recursive: true });
      await writeFile(join(targetRoot, 'package.json'), JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      await writeFile(otherManifest, JSON.stringify({ dependencies: { react: '^2.0.0' } }));
      await symlink(targetRoot, aliasRoot);

      setWorkspaceFolders([{ uri: { fsPath: workspaceRoot } }]);
      const internal = await resolveCanonicalPackageLocation(internalManifest);
      expect(internal.ok).toBe(true);
      if (internal.ok) {
        expect(internal.value.packageFilePath).toBe(await realpath(join(targetRoot, 'package.json')));
      }

      setWorkspaceFolders([{ uri: { fsPath: workspaceRoot } }, { uri: { fsPath: otherRoot } }]);
      const foreignPath = join(workspaceRoot, 'foreign', 'package.json');
      await mkdir(join(workspaceRoot, 'foreign'));
      await symlink(otherManifest, foreignPath);
      const foreign = await resolveCanonicalPackageLocation(foreignPath);
      expect(foreign).toEqual({ ok: false, reason: 'cross-workspace' });
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects two lexical manifest paths that resolve to one canonical file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-canonical-collision-'));
    const targetRoot = join(root, 'target');
    const aliasRoot = join(root, 'alias');
    const targetManifest = join(targetRoot, 'package.json');
    const aliasManifest = join(aliasRoot, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await mkdir(targetRoot);
      await writeFile(targetManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      await symlink(targetRoot, aliasRoot);
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: targetManifest },
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: aliasManifest },
      ]);
      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();
      const rows = (provider as unknown as { allEntries: { item: PackageItem }[] }).allEntries.map(entry => entry.item);
      const resolutions = await Promise.all(rows.map(row => provider.resolvePackageItem(row)));

      expect(resolutions).toEqual([
        { ok: false, reason: 'path-replaced' },
        { ok: false, reason: 'path-replaced' },
      ]);
      provider.dispose();
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['symlink escape', 'workspace-escape'],
    ['broken manifest path', 'unresolvable-path'],
  ] as const)('fails closed for %s', async (_label, reason) => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-path-'));
    const outside = await mkdtemp(join(tmpdir(), 'nestro-identity-outside-'));
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      const manifest = join(root, 'package.json');
      const outsideManifest = join(outside, 'package.json');
      if (reason === 'workspace-escape') {
        await writeFile(outsideManifest, '{}');
        await mkdir(join(root, 'link'));
        await symlink(outsideManifest, manifest);
      }
      setWorkspaceFolders([{ uri: { fsPath: root } }]);
      const result = await resolveCanonicalPackageLocation(manifest);
      expect(result).toEqual({ ok: false, reason });
    }
    finally {
      setWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});