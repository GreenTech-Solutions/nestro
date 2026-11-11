import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as vscode from 'vscode';
import { FilterManager, PackagesProvider } from '../providers';
import { StatusItem } from '../providers/StatusItem';
import type { AuditOrchestrationServiceContract } from '../providers/auditOrchestrationService';
import { LoadingItem } from '../providers/LoadingItem';
import {
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
  resolveYarnFamily,
  showError,
} from '../utils';
import { packagesProviderMocks } from './fixtures/packagesProviderMocks';
import { getLastContextValue, getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';
// LoadingItem is not part of the providers barrel's public surface (used only internally by
// PackagesProvider), so it must be imported directly from its implementation file.
const { resolveAuditProjects: resolveAuditProjectsMock } = packagesProviderMocks;

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
  });

  it('shows a loading indicator before packages finish loading', () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    const tree = provider.getChildren();

    expect(tree.at(-1)).toBeInstanceOf(LoadingItem);
    expect(provider.getChildren(new LoadingItem())).toEqual([]);
  });

  it('publishes disabled global actions for an empty workspace', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(false);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(false);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(false);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(true);
  });

  it('keeps install and audit available for a valid empty manifest with a lockfile', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(['/workspace/package.json']);
    resolveAuditProjectsMock.mockResolvedValueOnce({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'npm',
        lockfilePath: '/workspace/package-lock.json',
        originManifests: ['/workspace/package.json'],
      }],
      rejected: [],
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(true);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(true);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(false);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(false);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(false);
  });

  it('shows a status row for a valid workspace with no dependencies', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(['/workspace/package.json']);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const children = provider.getChildren();

    const status = children.find(item => item instanceof StatusItem && item.label === 'No dependencies to manage');
    expect(status).toBeInstanceOf(StatusItem);
    expect((status as StatusItem).description).toBe('This package.json has no dependencies yet.');
    // getChildren() must not be empty: an empty array would render as a blank panel,
    // which is exactly the regression this row exists to prevent.
    expect(children.length).toBeGreaterThan(0);
  });

  it('keeps an unreadable-only workspace out of the empty-workspace state', async () => {
    const entries: Array<{
      name: string;
      current: string;
      dev: boolean;
      versionPrefix: string;
      packageFilePath: string;
    }> = [];
    Object.defineProperty(entries, 'skippedFiles', {
      value: [{ packageFilePath: '/workspace/bad/package.json', error: 'permission denied' }],
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(['/workspace/bad/package.json']);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(false);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(false);
    // The read-error status must not be shadowed by the no-dependencies status: only one
    // of the two explanations for an empty list should ever be shown at a time.
    expect(provider.getChildren().some(
      item => item instanceof StatusItem && item.label === 'No dependencies to manage',
    )).toBe(false);
  });

  it('enables dependency operations for a mixed readable and unreadable workspace', async () => {
    const entries = [{
      name: 'react',
      current: '18.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/good/package.json',
    }];
    Object.defineProperty(entries, 'skippedFiles', {
      value: [{ packageFilePath: '/workspace/bad/package.json', error: 'malformed' }],
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([
      '/workspace/good/package.json',
      '/workspace/bad/package.json',
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(true);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(true);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(true);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(true);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(false);
    expect(resolveAuditProjectsMock).toHaveBeenCalledWith(['/workspace/good/package.json']);
  });

  it('disables audit for a Yarn lockfile when the Yarn family is unsupported', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(['/workspace/package.json']);
    resolveAuditProjectsMock.mockResolvedValueOnce({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'yarn',
        lockfilePath: '/workspace/yarn.lock',
        originManifests: ['/workspace/package.json'],
      }],
      rejected: [],
    });
    vi.mocked(resolveYarnFamily).mockResolvedValueOnce({ family: 'unknown', source: 'version-probe' });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
  });

  it.each([
    ['npm', '/workspace/package-lock.json', true],
    ['pnpm', '/workspace/pnpm-lock.yaml', true],
    ['yarn', '/workspace/yarn.lock', true],
    ['bun', '/workspace/bun.lock', true],
    ['npm', undefined, false],
    ['pnpm', undefined, false],
    ['yarn', undefined, false],
    ['bun', undefined, false],
  ] as const)('derives audit capability from the %s project lockfile (%s)', async (packageManager, lockfilePath, expectedAudit) => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(['/workspace/package.json']);
    resolveAuditProjectsMock.mockResolvedValueOnce({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager,
        lockfilePath,
        originManifests: ['/workspace/package.json'],
      }],
      rejected: [],
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(true);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(expectedAudit);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(expectedAudit);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(false);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(false);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(false);
  });

  it('does not claim an empty workspace when package discovery fails', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockRejectedValueOnce(new Error('workspace read failed'));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(false);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(false);
    const status = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Workspace package loading failed'
    ));
    expect(status?.command?.command).toBe('nestro.openStatusReport');
    expect(provider.getChildren().some(item => (
      item instanceof StatusItem && item.label === 'Package read incomplete'
    ))).toBe(false);
    expect(provider.getStatusReport().packageReadFailures).toEqual([expect.objectContaining({
      packageFilePaths: [],
      reason: 'package-load-failed',
      detail: 'workspace read failed',
    })]);
    expect(showError).toHaveBeenCalledOnce();
  });

  it('resets stale capability contexts before a reload', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(true);

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(false);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(false);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(false);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(true);
  });

  it('keeps global actions enabled while a reload is already in flight', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(true);

    let resolveReload: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
    vi.mocked(readAllWorkspaceDependencies).mockReturnValueOnce(new Promise((resolve) => {
      resolveReload = resolve;
    }));
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    const reload = provider.loadPackages();

    // The reload has reset its own working state but has not resolved new capabilities yet;
    // the last settled values must stay published, not flash to false mid-load.
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(true);

    resolveReload([]);
    await reload;

    expect(getLastContextValue('nestro.canRunInstall')).toBe(false);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(false);
  });

  it('keeps global actions enabled before the first load ever settles', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    let resolveLoad: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
    vi.mocked(readAllWorkspaceDependencies).mockReturnValueOnce(new Promise((resolve) => {
      resolveLoad = resolve;
    }));

    const load = provider.loadPackages();

    // Real capabilities are not known yet — "not yet known" must not read as "impossible",
    // or these commands would stay unreachable from the Palette until the first load settles.
    expect(getLastContextValue('nestro.canRunInstall')).toBe(true);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(true);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(true);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(true);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(true);
    resolveLoad([]);
    await load;
  });

  it('resets capability contexts when disposed', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(['/workspace/package.json']);
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    provider.dispose();

    expect(getLastContextValue('nestro.hasPackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasReadablePackageFiles')).toBe(false);
    expect(getLastContextValue('nestro.hasDependencyEntries')).toBe(false);
    expect(getLastContextValue('nestro.hasAuditableProjects')).toBe(false);
    expect(getLastContextValue('nestro.canRunInstall')).toBe(false);
    expect(getLastContextValue('nestro.canRunAudit')).toBe(false);
    expect(getLastContextValue('nestro.canSearchPackages')).toBe(false);
    expect(getLastContextValue('nestro.canFilterPackages')).toBe(false);
    expect(getLastContextValue('nestro.canPinAllVersions')).toBe(false);
    expect(getLastContextValue('nestro.noWorkspace')).toBe(false);
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);
  });

  it('shows one actionable status for skipped package files while keeping valid entries', async () => {
    const entries = [{
      name: 'react',
      current: '18.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/good/package.json',
    }];
    Object.defineProperty(entries, 'skippedFiles', {
      value: [{
        packageFilePath: '/workspace/bad/package.json',
        error: 'Unexpected end of JSON input',
      }],
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    const tree = provider.getChildren();
    const readStatus = tree.find(item => item instanceof StatusItem && item.label === 'Package read incomplete');
    expect(readStatus).toBeInstanceOf(StatusItem);
    expect(readStatus?.description).toBe('1 package file failed to load');
    expect(readStatus?.command).toEqual(expect.objectContaining({ command: 'nestro.openStatusReport' }));
    expect(getPackageItems(provider).map(item => item.packageFilePath)).toEqual(['/workspace/good/package.json']);
    expect(provider.getStatusReport().packageReadFailures).toEqual([{
      packageFilePaths: ['/workspace/bad/package.json'],
      reason: 'package-read-failed',
      detail: 'Unexpected end of JSON input',
    }]);
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows all skipped paths without claiming there is no workspace', async () => {
    const entries: Array<{
      name: string;
      current: string;
      dev: boolean;
      versionPrefix: string;
      packageFilePath: string;
    }> = [];
    Object.defineProperty(entries, 'skippedFiles', {
      value: [
        { packageFilePath: '/workspace/bad/package.json', error: 'malformed' },
        { packageFilePath: '/workspace/unreadable/package.json', error: 'permission denied' },
      ],
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();

    const readStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Package read incomplete');
    expect(readStatus).toBeInstanceOf(StatusItem);
    expect(readStatus?.description).toBe('2 package files failed to load');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'nestro.noWorkspace',
      false,
    );
    expect(showError).not.toHaveBeenCalled();
  });

  it('clears read, update, and audit diagnostics when a newer lifecycle succeeds', async () => {
    const failedEntries = [{
      name: 'react',
      current: '18.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/good/package.json',
    }];
    Object.defineProperty(failedEntries, 'skippedFiles', {
      value: [{ packageFilePath: '/workspace/bad/package.json', error: 'malformed' }],
    });
    vi.mocked(readAllWorkspaceDependencies)
      .mockResolvedValueOnce(failedEntries)
      .mockResolvedValueOnce([{
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/good/package.json',
      }]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(['/workspace/good/package.json']);

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    expect(provider.getStatusReport().packageReadFailures).toHaveLength(1);

    const auditService: AuditOrchestrationServiceContract = {
      run: vi.fn().mockResolvedValue({
        kind: 'failed',
        reason: 'audit-failed',
        detail: 'audit unavailable',
      }),
    };
    const auditedProvider = new PackagesProvider(new FilterManager('all'), undefined, undefined, auditService);
    await auditedProvider.loadPackages();
    await auditedProvider.runAudit();
    expect(auditedProvider.getStatusReport().auditFailures).toHaveLength(1);
    await auditedProvider.loadPackages();
    expect(auditedProvider.getStatusReport().auditFailures).toEqual([]);
    auditedProvider.dispose();

    await provider.loadPackages();
    expect(provider.getStatusReport().packageReadFailures).toEqual([]);
    provider.dispose();
  });
});