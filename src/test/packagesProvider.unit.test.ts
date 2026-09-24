import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { resolveMutationCoordinatorKey } from '../clients';
import {
  FilterManager,
  GroupItem,
  METADATA_CONCURRENCY_CAP,
  PackageDetailItem,
  PackageItem,
  PackagesProvider,
  resolvePackageFileLabels,
  StatusItem,
  WorkspaceFolderItem,
} from '../providers';
import type {
  AuditOrchestrationServiceContract,
  PackageLoadingServiceContract,
  PackageLoadingSnapshot,
} from '../providers';
import { resolveCanonicalPackageLocation } from '../providers/packageIdentity';
// LoadingItem is not part of the providers barrel's public surface (used only internally by
// PackagesProvider), so it must be imported directly from its implementation file.
import { LoadingItem } from '../providers/LoadingItem';
import {
  CHECK_CONCURRENCY_CAP,
  fetchAllLatestVersions,
  fetchPackageMetadata,
  getWorkspacePackageFilePaths,
  logger,
  MUTATION_CONCURRENCY_CAP,
  readAllWorkspaceDependencies,
  resolveMetadataRegistryKey,
  resolveYarnFamily,
  showError,
} from '../utils';
import type { AuditAdvisory, AuditResult, AuditSeverity, PackageFileEntry, PackageMetadataOutcome } from '../utils';
import { getUpdateType as realGetUpdateType } from '../utils/versionUtils';

const createClientMock = vi.fn();
const resolveAuditProjectsMock = vi.fn();
const getUpdateTypeMock = vi.hoisted(() => vi.fn());

interface ContextMenuContribution {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly menus: {
      readonly 'view/item/context': readonly ContextMenuContribution[];
    };
  };
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
const auditSeverities = ['critical', 'high', 'moderate', 'low', 'info'] as const;

function compileViewItemPattern(when: string): RegExp {
  const match = /viewItem\s*=~\s*\/(.*)\/([a-z]*)$/.exec(when);
  if (match === null) {
    throw new Error(`Manifest entry does not contain a viewItem regex: ${when}`);
  }
  return new RegExp(match[1], match[2]);
}

function getMenuPatterns(
  predicate: (entry: ContextMenuContribution) => boolean,
): RegExp[] {
  return manifest.contributes.menus['view/item/context']
    .filter(predicate)
    .map(entry => compileViewItemPattern(entry.when));
}

function getLastContextValue(context: string): unknown {
  const calls = vi.mocked(vscode.commands.executeCommand).mock.calls as unknown as readonly unknown[][];
  const contextCalls = calls.filter(call => call[0] === 'setContext' && call[1] === context);
  return contextCalls.at(-1)?.[2];
}

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

async function createRealAuditProject(packageNames: readonly string[]): Promise<{
  root: string;
  manifest: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-audit-'));
  const manifest = join(root, 'package.json');
  await writeFile(manifest, '{}');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  for (const packageName of packageNames) {
    await mkdir(join(root, 'node_modules', ...packageName.split('/')), { recursive: true });
  }
  return {
    root,
    manifest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

vi.mock('../clients', () => ({
  ClientManager: vi.fn(function (this: { createClient: typeof createClientMock }) {
    this.createClient = createClientMock;
  }),
  resolveAuditProjects: (packageFilePaths: readonly string[]) => resolveAuditProjectsMock(packageFilePaths),
  // Test double for the coordinator key: each manifest's own directory,
  // matching resolveAuditProjectsMock's default "no shared ancestor lockfile" shape.
  resolveMutationCoordinatorKey: vi.fn((packageFilePath: string) => Promise.resolve(
    packageFilePath.replace(/\/package\.json$/, ''),
  )),
}));

vi.mock('../utils', async () => {
  const { parseDependencySpec } = await vi.importActual<typeof import('../utils/dependencySpec')>('../utils/dependencySpec');
  const localization = await vi.importActual<typeof import('../utils/localization')>('../utils/localization');
  const releaseAge = await vi.importActual<typeof import('../utils/releaseAge')>('../utils/releaseAge');
  // Real scheduler primitives: this file's cap/parallelism/partial-failure/cancellation
  // tests need genuine bounded concurrency, not a trivial always-run-immediately double.
  const operationCoordinator = await vi.importActual<
    typeof import('../utils/operationCoordinator')
  >('../utils/operationCoordinator');
  const rootOperation = await vi.importActual<typeof import('../utils/rootOperation')>('../utils/rootOperation');
  const cloneAuditAdvisory = (advisory: AuditAdvisory): AuditAdvisory => ({
    ...advisory,
    sources: [...advisory.sources],
    titles: [...advisory.titles],
    urls: [...advisory.urls],
    affectedRanges: [...advisory.affectedRanges],
    resolvedPaths: [...advisory.resolvedPaths],
    resolvedVersions: [...advisory.resolvedVersions],
    via: advisory.via.map(via => ({ ...via })),
    fixAvailable: typeof advisory.fixAvailable === 'object' && advisory.fixAvailable !== null
      ? { ...advisory.fixAvailable }
      : advisory.fixAvailable,
  });
  return {
    ...releaseAge,
    ...operationCoordinator,
    ...rootOperation,
    ...localization,
    fetchAllLatestVersions: vi.fn(),
    fetchPackageMetadata: vi.fn(),
    getPackageDirectory: vi.fn((packageFilePath: string) => packageFilePath.replace(/\/package\.json$/, '')),
    getWorkspacePackageFilePaths: vi.fn(),
    getUpdateType: getUpdateTypeMock,
    inferPathAttribution: vi.fn((packageName: string, paths: readonly string[]) => (
      paths.length === 1 && (paths[0] === packageName || paths[0] === `node_modules/${packageName}`)
        ? 'direct'
        : 'unknown'
    )),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      dispose: vi.fn(),
    },
    // Test double for the coordinator: runs the given operation immediately
    // without real cross-key exclusion — this file's provider-level tests only need
    // installUpdateCommand's control flow, not coordinator concurrency semantics
    // (those are covered directly in operationCoordinator.unit.test.ts).
    mutationCoordinator: {
      runExclusive: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
      runManyExclusive: vi.fn((_keys: readonly string[], fn: () => Promise<unknown>) => fn()),
    },
    parseDependencySpec,
    readAllWorkspaceDependencies: vi.fn(),
    readWorkspaceDependencies: vi.fn(),
    resolveYarnFamily: vi.fn(),
    resolveMetadataRegistryKey: vi.fn((_packageName: string, packageFilePath?: string) => (
      Promise.resolve(packageFilePath ?? 'https://registry.npmjs.org/')
    )),
    runNpmAudit: vi.fn(),
    cloneAuditAdvisory,
    mergeAuditAdvisories: vi.fn((advisories: readonly AuditAdvisory[]) => [...advisories]),
    showError: vi.fn(),
  };
});

// Wraps the real projection in a spy so tests can assert it runs once per manifest-set
// change, not once per row — a regression back to per-row calls would fail those counts.
vi.mock('../providers/treeBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/treeBuilder')>();
  return {
    ...actual,
    resolvePackageFileLabels: vi.fn(actual.resolvePackageFileLabels),
  };
});

describe('PackagesProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNestroConfiguration({});
    getUpdateTypeMock.mockImplementation(realGetUpdateType);
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'eslint',
        current: '8.0.0',
        dev: true,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([
      ['react', '19.0.0'],
    ]));
    vi.mocked(fetchPackageMetadata).mockResolvedValue({
      kind: 'success',
      result: {
        versions: [],
        distTags: {},
        publishTimes: { kind: 'not-provided' },
      },
    });
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(['/workspace/package.json']);
    vi.mocked(resolveYarnFamily).mockResolvedValue({ family: 'classic', source: 'project-markers' });
    createClientMock.mockReset();
    resolveAuditProjectsMock.mockReset();
    // Default: every package file is its own independent project (no shared
    // ancestor lockfile), matching the real resolver when no manager signal is
    // shared between manifests. Tests that need a merged multi-manifest project
    // override this per test.
    resolveAuditProjectsMock.mockImplementation((packageFilePaths: readonly string[]) => ({
      projects: packageFilePaths.map(packageFilePath => ({
        projectRoot: packageFilePath.replace(/\/package\.json$/, ''),
        workspaceFolder: '/workspace',
        packageManager: 'npm' as const,
        lockfilePath: undefined,
        originManifests: [packageFilePath],
      })),
      rejected: [],
    }));
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

  it('starts with the configured initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.loadPackages();
    await provider.checkUpdates();

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[1]).toBeInstanceOf(GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('allows setFilter to override the initial filter', async () => {
    const provider = new PackagesProvider(new FilterManager('hasUpdates'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.setFilter('all');

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[1]).toBeInstanceOf(GroupItem);
    expect(groups.flatMap(group => group.children.map(child => child.label))).toEqual(['react', 'eslint']);
  });

  it('filters visible packages by search query', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);

    await provider.loadPackages();
    await provider.checkUpdates();
    filterManager.setSearch('react');

    const tree = provider.getChildren();
    const groups = tree.filter((item): item is GroupItem => item instanceof GroupItem);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('updates visible-update context and badge consistently through search and busy transitions', async () => {
    const filterManager = new FilterManager('all');
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'vue',
        current: '3.4.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([
      ['react', '19.0.0'],
      ['vue', '3.5.0'],
    ]));
    const provider = new PackagesProvider(filterManager);
    const treeView = { badge: undefined, message: undefined } as unknown as vscode.TreeView<vscode.TreeItem>;
    provider.attachTreeView(treeView);

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    expect(treeView.badge).toEqual({ tooltip: '2 package updates available', value: 2 });

    const identities = provider.getPackageIdentitiesForFile('/workspace/package.json');
    const react = identities.find(identity => identity.packageName === 'react');
    const vue = identities.find(identity => identity.packageName === 'vue');
    if (react === undefined || vue === undefined) {
      throw new Error('expected both package identities');
    }

    provider.markPackageUpdating(react, { kind: 'remove' });
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    expect(treeView.badge).toEqual({ tooltip: '1 package update available', value: 1 });

    filterManager.setSearch('react');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);
    filterManager.setSearch('vue');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    filterManager.set('patch');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);

    filterManager.clearSearch();
    filterManager.set('all');
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    provider.markPackageUpdating(vue, { kind: 'pin' });
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(false);
    expect(treeView.badge).toBeUndefined();

    provider.markPackageUpdating(react, undefined);
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    provider.markPackageUpdating(vue, undefined);
    expect(getLastContextValue('nestro.canUpdateVisiblePackages')).toBe(true);
    expect(treeView.badge).toEqual({ tooltip: '2 package updates available', value: 2 });

    provider.dispose();
  });

  it('reflects the active filter and search in treeView.description', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    const treeView = { badge: undefined, message: undefined, description: undefined } as unknown as vscode.TreeView<vscode.TreeItem>;
    provider.attachTreeView(treeView);

    await provider.loadPackages();
    await provider.checkUpdates();
    expect(treeView.description).toBeUndefined();

    filterManager.set('hasUpdates');
    expect(treeView.description).toBe('Has Updates (1)');

    filterManager.setSearch('react');
    expect(treeView.description).toBe('Has Updates (1) · "react"');

    filterManager.set('all');
    expect(treeView.description).toBe('"react"');

    filterManager.clearSearch();
    expect(treeView.description).toBeUndefined();

    provider.dispose();
  });

  it('publishes nestro.hasSearchQuery only while a search query is active, and resets it on dispose', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    await provider.loadPackages();

    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);

    filterManager.setSearch('react');
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(true);

    filterManager.clearSearch();
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);

    filterManager.setSearch('vue');
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(true);

    provider.dispose();
    expect(getLastContextValue('nestro.hasSearchQuery')).toBe(false);
  });

  it('shows the filter picker with counts computed over the search-matched entries', async () => {
    const filterManager = new FilterManager('all');
    const provider = new PackagesProvider(filterManager);
    await provider.loadPackages();
    await provider.checkUpdates();
    filterManager.setSearch('react');

    await provider.showFilterPicker();

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    const [items] = vi.mocked(vscode.window.showQuickPick).mock.calls[0] as [
      { label: string; description: string }[],
      unknown,
    ];
    // Only react matches the search: if the counts came from the full unfiltered
    // set (2 entries) instead of the search-matched one, "All" would read "2".
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'All', description: '1' }),
      expect.objectContaining({ label: 'Breaking', description: '1' }),
    ]));
  });

  it('does not open the filter picker when there are no packages at all', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.showFilterPicker();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('reuses fresh update check results', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('reuses update cache after debounce but before cache expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.checkUpdates();
      vi.advanceTimersByTime(61_000);
      await provider.checkUpdates();

      expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('fetches fresh updates when force-always mode is enabled', async () => {
    mockNestroConfiguration({ checkUpdatesForceAlways: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('excludes prereleases from update checks when the setting is absent', async () => {
    mockNestroConfiguration({});
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'latest',
      false,
      7,
    );
  });

  it('passes explicit prerelease opt-in to update checks', async () => {
    mockNestroConfiguration({ includePreReleases: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'latest',
      true,
      7,
    );
  });

  it('does not enable prereleases for the greatest target when the setting is absent', async () => {
    mockNestroConfiguration({ updateTarget: 'greatest' });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'greatest',
      false,
      7,
    );
  });

  it('passes zero to the NCU wrapper and skips metadata fan-out', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledWith(
      '/workspace/package.json',
      'latest',
      false,
      0,
    );
    expect(fetchPackageMetadata).not.toHaveBeenCalled();
  });

  it('deduplicates metadata by package and registry while capping concurrent requests', async () => {
    expect(CHECK_CONCURRENCY_CAP).toBe(6);
    expect(MUTATION_CONCURRENCY_CAP).toBe(8);
    const packageNames = ['react', 'vue', 'vite', 'eslint', 'typescript', 'vitest', 'react'];
    const packagePaths = packageNames.map((_, index) => `/workspace/metadata-${index}/package.json`);
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageNames.map((name, index) => ({
      name,
      current: '1.0.0',
      dev: index === packageNames.length - 1,
      versionPrefix: '',
      packageFilePath: packagePaths[index],
    })));
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packagePaths);
    vi.mocked(fetchAllLatestVersions).mockImplementation((packageFilePath) => {
      const index = packagePaths.indexOf(packageFilePath);
      return Promise.resolve(new Map([[packageNames[index] ?? 'unknown', '1.1.0']]));
    });
    vi.mocked(resolveMetadataRegistryKey).mockResolvedValue('https://registry.example.test/');
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    vi.mocked(fetchPackageMetadata).mockImplementation(async () => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      activeRequests -= 1;
      return {
        kind: 'success',
        result: {
          versions: ['1.1.0'],
          distTags: { latest: '1.1.0' },
          publishTimes: { kind: 'not-provided' },
        },
      };
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(fetchPackageMetadata).toHaveBeenCalledTimes(6);
    expect(maximumActiveRequests).toBe(METADATA_CONCURRENCY_CAP);
  });

  it('keeps an update actionable when metadata resolution or fetch fails', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.1.0']]));
    vi.mocked(resolveMetadataRegistryKey).mockRejectedValueOnce(new Error('registry lookup failed'));
    vi.mocked(resolveMutationCoordinatorKey).mockRejectedValueOnce(new Error('project key failed'));
    vi.mocked(fetchPackageMetadata).mockRejectedValueOnce(new Error('metadata unavailable'));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    expect(getPackageItems(provider).find(item => item.packageName === 'react')).toMatchObject({
      latest: '1.1.0',
      releaseAge: { kind: 'unknown', version: '1.1.0' },
    });
    expect(showError).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('resolves update progress promptly when metadata lookup is cancelled', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.1.0']]));
    let releaseRegistry!: (value: string) => void;
    vi.mocked(resolveMetadataRegistryKey).mockReturnValueOnce(new Promise((resolve) => {
      releaseRegistry = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(resolveMetadataRegistryKey).toHaveBeenCalled());
    provider.cancelCheckUpdates();
    await check;
    releaseRegistry('https://registry.example.test/');
    await vi.waitFor(() => expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Checking updates…')).toBe(false));
    provider.dispose();
  });

  it('resolves update progress promptly when metadata fetch is cancelled', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValueOnce(new Map([['react', '1.1.0']]));
    let releaseMetadata!: (value: PackageMetadataOutcome) => void;
    vi.mocked(fetchPackageMetadata).mockReturnValueOnce(new Promise((resolve) => {
      releaseMetadata = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(fetchPackageMetadata).toHaveBeenCalled());
    provider.cancelCheckUpdates();
    await check;
    releaseMetadata({
      kind: 'success',
      result: {
        versions: ['1.1.0'],
        distTags: { latest: '1.1.0' },
        publishTimes: { kind: 'not-provided' },
      },
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    provider.dispose();
  });

  it('keeps the accepted NCU version while surfacing a newer held-back release', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    try {
      mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
      vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([['react', '1.1.0']]));
      vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({
        kind: 'success',
        result: {
          versions: ['1.1.0', '2.0.0'],
          distTags: { latest: '2.0.0' },
          publishTimes: {
            kind: 'provided',
            byVersion: {
              '1.1.0': '2026-01-01T00:00:00.000Z',
              '2.0.0': '2026-05-26T00:00:00.000Z',
            },
          },
        },
      });
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.checkUpdates();

      const react = getPackageItems(provider).find(item => item.packageName === 'react');
      expect(react).toMatchObject({
        latest: '1.1.0',
        releaseAge: {
          kind: 'held-back',
          version: '2.0.0',
          eligibleAt: '2026-06-02T00:00:00.000Z',
        },
      });
      expect(react?.description).toContain('Held back 2.0.0 until 2026-06-02T00:00:00.000Z');
      expect(react?.tooltip).toContain('Held back 2.0.0 until 2026-06-02T00:00:00.000Z');
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('surfaces unknown release age without hiding an accepted update', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
      name: 'react',
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    }]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([['react', '1.1.0']]));
    vi.mocked(fetchPackageMetadata).mockResolvedValueOnce({
      kind: 'success',
      result: {
        versions: ['1.1.0', '2.0.0'],
        distTags: { latest: '2.0.0' },
        publishTimes: { kind: 'not-provided' },
      },
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();

    const react = getPackageItems(provider).find(item => item.packageName === 'react');
    expect(react).toMatchObject({
      latest: '1.1.0',
      releaseAge: { kind: 'unknown', version: '1.1.0' },
    });
    expect(react?.tooltip).toContain('Release age unknown for 1.1.0; update is not blocked.');
  });

  it('does not reuse update cache when the package-file set changes', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const existingEntries = (provider as unknown as { allEntries: unknown[] }).allEntries;
    setProviderState(provider, {
      allEntries: [
        ...existingEntries,
        {
          item: new PackageItem(
            'typescript',
            '5.0.0',
            undefined,
            'none',
            false,
            undefined,
            '/workspace/tools/package.json',
            true,
          ),
          dev: true,
          packageFilePath: '/workspace/tools/package.json',
        },
      ],
    });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(3);
    expect(fetchAllLatestVersions).toHaveBeenLastCalledWith(
      '/workspace/tools/package.json',
      'latest',
      false,
      7,
    );
  });

  it('fetches updates again after cache invalidation', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    provider.invalidateUpdateCache();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('reuses the update cache regardless of row order', async () => {
    // Debounce off: the cheap policy gate would otherwise short-circuit the second check
    // before the fingerprint that this test is about is ever computed.
    mockNestroConfiguration({ checkUpdatesDebounce: 0 });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const entries = (provider as unknown as { allEntries: unknown[] }).allEntries;
    setProviderState(provider, { allEntries: [...entries].reverse() });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('ignores concurrent update checks while a check is already running', async () => {
    let resolveFetch: (value: Map<string, string>) => void = () => {};
    vi.mocked(fetchAllLatestVersions).mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    // Both calls are issued before either can reach the fetch: the running guard,
    // set synchronously at the top of checkUpdates(), must still block the second.
    const firstCheck = provider.checkUpdates();
    const secondCheck = provider.checkUpdates();

    resolveFetch(new Map([['react', '19.0.0']]));
    await Promise.all([firstCheck, secondCheck]);

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('ignores concurrent update checks before workspace packages are loaded', async () => {
    let resolveDependencies: (value: Awaited<ReturnType<typeof readAllWorkspaceDependencies>>) => void = () => {};
    vi.mocked(readAllWorkspaceDependencies).mockReturnValueOnce(new Promise((resolve) => {
      resolveDependencies = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    const firstCheck = provider.checkUpdates();
    expect(readAllWorkspaceDependencies).toHaveBeenCalledTimes(1);

    const secondCheck = provider.checkUpdates();
    expect(readAllWorkspaceDependencies).toHaveBeenCalledTimes(1);

    resolveDependencies([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await Promise.all([firstCheck, secondCheck]);

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1);
  });

  it('bounds independent update roots at CHECK_CONCURRENCY_CAP and applies results by input order', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/apps/root-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));

    let active = 0;
    let peak = 0;
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAllLatestVersions).mockImplementation(async (packageFilePath) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(packageFilePath);
      await gate;
      active -= 1;
      const index = packageEntries.findIndex(entry => entry.packageFilePath === packageFilePath);
      return new Map([[`package-${index}`, '2.0.0']]);
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));

    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect(started).toEqual(packageEntries.slice(0, CHECK_CONCURRENCY_CAP).map(entry => entry.packageFilePath));
    release();
    await check;

    const rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.map(entry => entry.item.latest)).toEqual(roots.map(() => '2.0.0'));
    expect(rows.map(entry => entry.item.packageName)).toEqual(packageEntries.map(entry => entry.name));
    provider.dispose();
  });

  it('keeps successful update roots when another NCU root fails', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const successfulPath = '/workspace/apps/success/package.json';
    const failedPath = '/workspace/apps/failure/package.json';
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      { name: 'success-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: successfulPath },
      { name: 'failed-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: failedPath },
    ]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([successfulPath, failedPath]);
    const failure = new Error('one root unavailable');
    vi.mocked(fetchAllLatestVersions).mockImplementation((packageFilePath) => {
      if (packageFilePath === failedPath) {
        return Promise.reject(failure);
      }
      return Promise.resolve(new Map([['success-package', '2.0.0']]));
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.checkUpdates();

    const rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.map(entry => [entry.item.packageFilePath, entry.item.latest])).toEqual([
      [successfulPath, '2.0.0'],
      [failedPath, undefined],
    ]);
    const status = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Update check incomplete');
    expect(status).toBeInstanceOf(StatusItem);
    expect(status?.description).toBe('1 package root failed');
    expect(status?.command).toEqual(expect.objectContaining({ command: 'nestro.openStatusReport' }));
    expect(status?.tooltip).toContain('Open detailed diagnostics');
    expect(status?.accessibilityInformation?.label).toContain('Open detailed diagnostics');
    expect(provider.getStatusReport().updateFailures).toEqual([expect.objectContaining({
      packageFilePaths: [failedPath],
      reason: 'update-check-failed',
      detail: expect.stringContaining(failure.message),
    })]);
    expect(showError).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('clears failed roots across repeated checks while retaining fresh successes and live state', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0, checkUpdatesForceAlways: true });
    const successfulPath = '/workspace/apps/recheck-success/package.json';
    const failedPath = '/workspace/apps/recheck-failure/package.json';
    const entries = [
      { name: 'success-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: successfulPath },
      { name: 'failed-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: failedPath },
    ];
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(entries.map(entry => entry.packageFilePath));
    vi.mocked(fetchAllLatestVersions).mockImplementation(packageFilePath => Promise.resolve(
      new Map([[packageFilePath === successfulPath ? 'success-package' : 'failed-package', '2.0.0']]),
    ));
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'failed-package',
      packageFilePath: failedPath,
      section: 'dependencies',
    }, { kind: 'update', target: '2.0.0' });

    const failure = new Error('recheck root unavailable');
    vi.mocked(fetchAllLatestVersions).mockImplementation((packageFilePath) => {
      if (packageFilePath === failedPath) {
        return Promise.reject(failure);
      }
      return Promise.resolve(new Map([['success-package', '3.0.0']]));
    });
    await provider.checkUpdates();

    let rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.map(entry => [entry.item.packageFilePath, entry.item.latest])).toEqual([
      [successfulPath, '3.0.0'],
      [failedPath, undefined],
    ]);
    expect(rows[1]?.item.installing).toBe(true);
    expect(provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Update check incomplete')).toBeInstanceOf(StatusItem);

    vi.mocked(fetchAllLatestVersions).mockRejectedValue(failure);
    await provider.checkUpdates();

    rows = (provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries;
    expect(rows.every(entry => entry.item.latest === undefined)).toBe(true);
    expect(rows[1]?.item.installing).toBe(true);
    const status = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Update check incomplete');
    expect(status).toBeInstanceOf(StatusItem);
    expect(status?.description).toBe('2 package roots failed');
    expect(provider.getStatusReport().updateFailures).toHaveLength(2);
    expect(showError).toHaveBeenCalledWith(`Failed to check updates — ${failure.message}`, failure);
    provider.dispose();
  });

  it('shares the read cap and canonical root serialization between update and audit runs', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0, checkUpdatesForceAlways: true });
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/mixed-root-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `mixed-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(roots.map(root => `${root}/package.json`));
    let active = 0;
    let peak = 0;
    const rootActive = new Map<string, number>();
    const rootPeaks = new Map<string, number>();
    const enter = (root: string): void => {
      active += 1;
      peak = Math.max(peak, active);
      const next = (rootActive.get(root) ?? 0) + 1;
      rootActive.set(root, next);
      rootPeaks.set(root, Math.max(rootPeaks.get(root) ?? 0, next));
    };
    const leave = (root: string): void => {
      active -= 1;
      rootActive.set(root, (rootActive.get(root) ?? 1) - 1);
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAllLatestVersions).mockImplementation(async (packageFilePath) => {
      const root = packageFilePath.replace(/\/package\.json$/, '');
      enter(root);
      try {
        await gate;
        const index = roots.indexOf(root);
        return new Map([[`mixed-package-${index}`, '2.0.0']]);
      }
      finally {
        leave(root);
      }
    });
    createClientMock.mockImplementation((_manager: string, projectRoot: string) => ({
      runAudit: async () => {
        enter(projectRoot);
        try {
          await gate;
          return new Map<string, never>();
        }
        finally {
          leave(projectRoot);
        }
      },
    }));

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const update = provider.checkUpdates();
    const audit = provider.runAudit();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));

    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect([...rootPeaks.values()].every(value => value === 1)).toBe(true);
    release();
    await Promise.all([update, audit]);
    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect([...rootPeaks.values()].every(value => value === 1)).toBe(true);
    provider.dispose();
  });

  it('cancels queued update roots without publishing a partial or stale result', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/apps/cancel-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `cancel-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));
    let active = 0;
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAllLatestVersions).mockImplementation(async (packageFilePath) => {
      active += 1;
      started.push(packageFilePath);
      await gate;
      active -= 1;
      return new Map([['unused', '2.0.0']]);
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const check = provider.checkUpdates();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));
    provider.cancelCheckUpdates();
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Checking updates…')).toBe(false);
    await check;
    expect(started).toHaveLength(CHECK_CONCURRENCY_CAP);
    expect(active).toBe(CHECK_CONCURRENCY_CAP);
    release();
    await vi.waitFor(() => expect(active).toBe(0));
    expect(provider.getChildren().some(item => item instanceof StatusItem && (
      item.label === 'Last update check' || item.label === 'Update check incomplete'
    ))).toBe(false);
    expect((provider as unknown as { allEntries: readonly { item: PackageItem }[] }).allEntries
      .every(entry => entry.item.latest === undefined)).toBe(true);
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('does not let a cancelled check overwrite an immediately restarted check', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 0 });
    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchNumber = 0;
    vi.mocked(fetchAllLatestVersions).mockImplementation(async () => {
      fetchNumber += 1;
      if (fetchNumber === 1) {
        await firstFetchGate;
      }
      return new Map([['react', fetchNumber === 1 ? '19.0.0' : '20.0.0']]);
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const firstCheck = provider.checkUpdates();
    await vi.waitFor(() => expect(fetchAllLatestVersions).toHaveBeenCalledTimes(1));

    provider.cancelCheckUpdates();
    const secondCheck = provider.checkUpdates();
    // The second run is allowed to own the provider synchronously, before the first
    // cancelled continuation resumes. Its same-root fetch stays queued until cleanup.
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(2);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Checking updates…')).toBe(true);

    releaseFirstFetch();
    await Promise.all([firstCheck, secondCheck]);

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('20.0.0');
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Last update check')).toBe(true);
    provider.dispose();
  });

  it('allows a later manual update check after a timeout rejection', async () => {
    const timeoutError = new Error('npm-check-updates timed out');
    vi.mocked(fetchAllLatestVersions)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(new Map([['react', '19.0.0']]));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledWith(
      'Failed to check updates — npm-check-updates timed out',
      timeoutError,
    );
    expect(showError).toHaveBeenCalledTimes(1);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.latest).toBe('19.0.0');
  });

  it('preserves live installing state when update checks finish', async () => {
    let resolveFetch: (value: Map<string, string>) => void = () => {};
    vi.mocked(fetchAllLatestVersions).mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const updateCheck = provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    }, true);
    resolveFetch(new Map([['react', '19.0.0']]));
    await updateCheck;

    const packages = provider.getChildren()
      .filter((item): item is GroupItem => item instanceof GroupItem)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    const react = packages.find(item => item.packageName === 'react');

    expect(react?.latest).toBe('19.0.0');
    expect(react?.installing).toBe(true);
    expect(react?.contextValue).toBe('installing-update');
  });

  it('keeps write suppression active for overlapping suppressed writes', async () => {
    vi.useFakeTimers();
    try {
      let finishFirst: () => void = () => {};
      let finishSecond: () => void = () => {};
      const provider = new PackagesProvider(new FilterManager('all'));
      const firstWrite = provider.withWriteSuppressed(async () => {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      });
      const secondWrite = provider.withWriteSuppressed(async () => {
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      });

      finishFirst();
      await firstWrite;
      vi.advanceTimersByTime(600);

      expect(provider.suppressingWrites).toBe(true);

      finishSecond();
      await secondWrite;
      vi.advanceTimersByTime(599);
      expect(provider.suppressingWrites).toBe(true);

      vi.advanceTimersByTime(1);
      expect(provider.suppressingWrites).toBe(false);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('clears pending write suppression timers on dispose', async () => {
    vi.useFakeTimers();
    try {
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.withWriteSuppressed(async () => {});
      expect(provider.suppressingWrites).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      provider.dispose();
      expect(provider.suppressingWrites).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(600);
      expect(provider.suppressingWrites).toBe(false);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('expires update check cache after five minutes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.checkUpdates();
      vi.setSystemTime(new Date('2026-05-27T00:05:01.000Z'));
      await provider.checkUpdates();

      expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse update cache when update target changes', async () => {
    mockNestroConfiguration({ updateTarget: 'latest' });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    mockNestroConfiguration({ updateTarget: 'minor' });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('does not reuse update cache when pre-release setting changes', async () => {
    mockNestroConfiguration({ includePreReleases: true });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    mockNestroConfiguration({ includePreReleases: false });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('does not reuse update cache when minimum release age changes', async () => {
    mockNestroConfiguration({ minimumReleaseAgeDays: 7 });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    mockNestroConfiguration({ minimumReleaseAgeDays: 14 });
    await provider.checkUpdates();

    expect(fetchAllLatestVersions).toHaveBeenCalledTimes(2);
  });

  it('exposes expandable package details for package rows', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packageItem = groups.flatMap(group => group.children).find((item): item is PackageItem => item instanceof PackageItem);

    expect(packageItem).toBeDefined();
    expect(provider.getChildren(packageItem)).toEqual([
      expect.objectContaining({ label: 'Dependency' }),
      expect.objectContaining({ label: 'Current: 18.0.0' }),
      expect.objectContaining({ label: 'Update: 18.0.0 → 19.0.0 (breaking)' }),
    ]);
    expect(provider.getChildren(packageItem as PackageItem).every(item => item instanceof PackageDetailItem)).toBe(true);
  });

  it('shows the package file path for monorepo package rows', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/apps/frontend/package.json',
      },
    ]);
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.checkUpdates();
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const packageItem = groups.flatMap(group => group.children).find((item): item is PackageItem => item instanceof PackageItem);

    expect(provider.getChildren(packageItem as PackageItem)).toEqual([
      expect.objectContaining({ label: 'Dependency' }),
      expect.objectContaining({ label: 'Current: 18.0.0' }),
      expect.objectContaining({ label: 'Update: 18.0.0 → 19.0.0 (breaking)' }),
      expect.objectContaining({ label: 'File: apps/frontend/package.json' }),
    ]);
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

  it('shows status rows above the package groups', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([]);
    setProviderState(provider, {
      loading: false,
      checkState: 'done',
      lastCheckTime: new Date('2026-05-27T08:45:00.000Z'),
      auditState: 'done',
      lastAuditCount: 2,
      allEntries: [{
        item: new PackageItem('react', '18.0.0', undefined, 'none'),
        dev: false,
        packageFilePath: '/workspace/package.json',
      }],
    });

    const tree = provider.getChildren();

    expect(tree[0]).toBeInstanceOf(StatusItem);
    expect(tree[0].label).toBe('Last update check');
    expect(tree[1]).toBeInstanceOf(StatusItem);
    expect(tree[1].label).toBe('Audit complete');
    expect(tree[2]).toBeInstanceOf(GroupItem);
    expect(tree[2].label).toBe('Dependencies');
  });

  it('preserves the version prefix when a package is marked updated', () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    setProviderState(provider, {
      allEntries: [{
        item: new PackageItem('react', '^18.0.0', '19.0.0', 'breaking', undefined, undefined, '/workspace/package.json', false, '^'),
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
          item: new PackageItem(
            'react',
            '^18.0.0',
            '19.0.0',
            'breaking',
            false,
            undefined,
            '/workspace/apps/web/package.json',
            false,
            '^',
          ),
          dev: false,
          packageFilePath: '/workspace/apps/web/package.json',
        },
        {
          item: new PackageItem(
            'react',
            '~18.0.0',
            '18.3.1',
            'minor',
            false,
            undefined,
            '/workspace/packages/ui/package.json',
            false,
            '~',
          ),
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

  it.each(auditSeverities)('preserves row menu capabilities after a %s audit result', async (severity) => {
    const packageFilePath = '/workspace/package.json';
    const outdatedPackageName = `outdated-${severity}`;
    const packageEntries = [
      {
        name: outdatedPackageName,
        current: '^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
      {
        name: 'current',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
      {
        name: 'installing',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
      {
        name: 'unsupported',
        current: 'npm:real-pkg@^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
    ];
    const latestVersions = new Map<string, string>([
      [outdatedPackageName, '2.0.0'],
      ['installing', '2.0.0'],
      ['unsupported', '2.0.0'],
    ]);
    const vulnerabilities = new Map<string, AuditSeverity>([
      [outdatedPackageName, severity],
      ['current', 'high'],
      ['installing', 'high'],
      ['unsupported', 'high'],
    ]);
    const updatePatterns = getMenuPatterns(entry => entry.command === 'nestro.installUpdate');
    const pinPatterns = getMenuPatterns(entry => entry.command === 'nestro.pinVersion');
    const managePatterns = getMenuPatterns(entry => entry.group?.startsWith('2_manage') === true);
    const dangerousPatterns = getMenuPatterns(entry => entry.group?.startsWith('3_danger') === true);

    expect(updatePatterns).toHaveLength(1);
    expect(pinPatterns).toHaveLength(1);
    expect(managePatterns).toHaveLength(2);
    expect(dangerousPatterns).toHaveLength(1);
    const updatePattern = updatePatterns[0];
    if (updatePattern === undefined) {
      throw new Error('The Update menu clause is missing.');
    }

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(latestVersions);
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(vulnerabilities),
    });
    mockNestroConfiguration({ checkUpdatesForceAlways: true, minimumReleaseAgeDays: 0 });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'installing',
      packageFilePath,
      section: 'dependencies',
    }, { kind: 'update', target: '2.0.0' });
    await provider.runAudit();

    const rows = new Map(getPackageItems(provider).map(item => [item.packageName, item]));
    const matchesAny = (patterns: readonly RegExp[], contextValue: string | undefined): boolean => (
      patterns.some(pattern => pattern.test(contextValue ?? ''))
    );
    const outdatedRow = rows.get(outdatedPackageName);
    const currentRow = rows.get('current');
    const installingRow = rows.get('installing');
    const unsupportedRow = rows.get('unsupported');

    expect(outdatedRow?.vulnerabilitySeverity).toBe(severity);
    expect(matchesAny([updatePattern], outdatedRow?.contextValue)).toBe(true);
    expect(matchesAny(pinPatterns, outdatedRow?.contextValue)).toBe(true);
    expect(matchesAny(managePatterns, outdatedRow?.contextValue)).toBe(true);
    expect(matchesAny(dangerousPatterns, outdatedRow?.contextValue)).toBe(true);

    expect(currentRow?.vulnerabilitySeverity).toBe('high');
    expect(matchesAny([updatePattern], currentRow?.contextValue)).toBe(false);
    expect(matchesAny(pinPatterns, currentRow?.contextValue)).toBe(true);
    expect(matchesAny(managePatterns, currentRow?.contextValue)).toBe(true);
    expect(matchesAny(dangerousPatterns, currentRow?.contextValue)).toBe(true);

    expect(installingRow?.vulnerabilitySeverity).toBe('high');
    expect(matchesAny([updatePattern], installingRow?.contextValue)).toBe(false);
    expect(matchesAny(pinPatterns, installingRow?.contextValue)).toBe(false);
    expect(matchesAny(managePatterns, installingRow?.contextValue)).toBe(false);
    expect(matchesAny(dangerousPatterns, installingRow?.contextValue)).toBe(false);

    expect(unsupportedRow?.vulnerabilitySeverity).toBe('high');
    expect(matchesAny([updatePattern], unsupportedRow?.contextValue)).toBe(true);
    expect(matchesAny(pinPatterns, unsupportedRow?.contextValue)).toBe(false);
    expect(matchesAny(managePatterns, unsupportedRow?.contextValue)).toBe(true);
    expect(matchesAny(dangerousPatterns, unsupportedRow?.contextValue)).toBe(true);
  });

  it('keeps successful audit results and shows failed package paths', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/apps/web/package.json',
      },
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('audit unavailable')),
      });

    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    const folders = provider.getChildren().filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    const groups = folders.flatMap(folder => folder.children);
    const packages = groups.flatMap(group => group.children).filter((item): item is PackageItem => item instanceof PackageItem);

    expect(createClientMock).toHaveBeenCalledWith('npm', '/workspace/apps/web');
    expect(createClientMock).toHaveBeenCalledWith('npm', '/workspace/packages/ui');
    expect(showError).not.toHaveBeenCalled();
    expect(packages.map(item => [item.packageFilePath, item.vulnerabilitySeverity])).toEqual([
      ['/workspace/apps/web/package.json', 'high'],
      ['/workspace/packages/ui/package.json', undefined],
    ]);

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('1 vulnerable package from successful audit roots; 1 package root failed');
    expect(provider.getChildren().some(item => item.label === 'Audit complete')).toBe(false);
    expect(provider.getAuditProjects().map(summary => summary.status)).toEqual(['success', 'failure']);
    expect(provider.getAuditProjects()[1].failure?.reason).toBe('audit-failed');
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      reason: 'audit-failed',
      packageFilePaths: ['/workspace/packages/ui/package.json'],
      project: expect.objectContaining({ projectRoot: '/workspace/packages/ui' }),
    })]);
  });

  it('passes the current package snapshot to the audit service and keeps a discarded result silent', async () => {
    const auditService: AuditOrchestrationServiceContract = {
      run: vi.fn().mockResolvedValue({ kind: 'discarded', reason: 'cancelled' }),
    };
    const provider = new PackagesProvider(new FilterManager('all'), undefined, undefined, auditService);

    await provider.loadPackages();
    await provider.runAudit();

    expect(auditService.run).toHaveBeenCalledWith(expect.objectContaining({
      packageFilePaths: ['/workspace/package.json'],
      rows: expect.arrayContaining([
        expect.objectContaining({
          packageName: 'react',
          packageFilePath: '/workspace/package.json',
          dev: false,
          currentVersion: '18.0.0',
        }),
      ]),
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    expect(provider.getAuditProjects()).toEqual([]);
    expect(provider.getAuditFailures()).toEqual([]);
    expect(provider.getChildren().some(item => item instanceof StatusItem && (
      item.label === 'Audit complete' || item.label === 'Audit incomplete'
    ))).toBe(false);
  });

  it('applies a service failure without pretending the audit completed', async () => {
    const auditService: AuditOrchestrationServiceContract = {
      run: vi.fn().mockResolvedValue({
        kind: 'failed',
        reason: 'unresolvable-path',
        detail: 'Manifest disappeared.',
      }),
    };
    const provider = new PackagesProvider(new FilterManager('all'), undefined, undefined, auditService);

    await provider.loadPackages();
    await provider.runAudit();

    expect(provider.getAuditFailures()).toEqual([{
      packageFilePaths: [],
      reason: 'unresolvable-path',
      detail: 'Manifest disappeared.',
    }]);
    const auditStatus = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Audit failed'
    ));
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('No audit results available');
    expect(auditStatus?.command?.command).toBe('nestro.openStatusReport');
    expect(showError).toHaveBeenCalledWith('Package audit failed — the security audit report is incomplete.');
  });

  it('shows the running audit state and contains package detail paths defensively', async () => {
    let releaseAudit: (value: Map<string, AuditSeverity>) => void = () => {};
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockReturnValue(new Promise<Map<string, AuditSeverity>>((resolve) => {
        releaseAudit = resolve;
      })),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const audit = provider.runAudit();

    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Running audit…')).toBe(true);
    releaseAudit(new Map());
    await audit;

    const emptyPathItem = new PackageItem('empty', '1.0.0', undefined, 'none', undefined, undefined, '');
    const outsidePathItem = new PackageItem('outside', '1.0.0', undefined, 'none', undefined, undefined, '/outside/package.json');
    expect(provider.getChildren(emptyPathItem)).toHaveLength(2);
    expect(provider.getChildren(outsidePathItem)).toEqual([
      expect.objectContaining({ label: 'Dependency' }),
      expect.objectContaining({ label: 'Current: 1.0.0' }),
      expect.objectContaining({ label: 'File: /outside/package.json' }),
    ]);
  });

  it('keeps search clearing and invalid capability input side-effect free', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    provider.clearSearch();

    await expect(provider.resolvePackageItem(undefined)).resolves.toEqual({
      ok: false,
      reason: 'invalid-item',
    });
    expect(provider.getVisibleOutdatedPackages()).toEqual([]);
  });

  it('bounds independent audit roots and retains deterministic project ordering', async () => {
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/audit-root-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `audit-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    createClientMock.mockImplementation((_manager: string, projectRoot: string) => ({
      runAudit: async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(projectRoot);
        await gate;
        active -= 1;
        const index = roots.indexOf(projectRoot);
        return new Map([[`audit-package-${index}`, 'high' as const]]);
      },
    }));

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const audit = provider.runAudit();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));

    expect(peak).toBe(CHECK_CONCURRENCY_CAP);
    expect(started).toEqual(roots.slice(0, CHECK_CONCURRENCY_CAP));
    release();
    await audit;

    expect(provider.getAuditProjects().map(summary => summary.project.projectRoot)).toEqual(roots);
    expect(provider.getAuditProjects().every(summary => summary.status === 'success')).toBe(true);
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('aborts an audit on reload and never starts queued roots from the old snapshot', async () => {
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/reload-audit-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `reload-audit-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies)
      .mockResolvedValueOnce(packageEntries)
      .mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths)
      .mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath))
      .mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const auditGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    createClientMock.mockImplementation(() => ({
      runAudit: async (signal?: AbortSignal) => {
        if (signal !== undefined) {
          signals.push(signal);
        }
        await auditGate;
        return new Map<string, never>();
      },
    }));

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const audit = provider.runAudit();
    await vi.waitFor(() => expect(signals).toHaveLength(CHECK_CONCURRENCY_CAP));

    const reload = provider.loadPackages();
    await reload;

    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(createClientMock).toHaveBeenCalledTimes(CHECK_CONCURRENCY_CAP);

    release();
    await audit;
    expect(createClientMock).toHaveBeenCalledTimes(CHECK_CONCURRENCY_CAP);
    provider.dispose();
  });

  it('serializes audit projects that share one project root', async () => {
    const firstManifest = '/workspace/shared/first/package.json';
    const secondManifest = '/workspace/shared/second/package.json';
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      { name: 'first-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: firstManifest },
      { name: 'second-package', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: secondManifest },
    ]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest, secondManifest]);
    const sharedProject = {
      projectRoot: '/workspace/shared',
      workspaceFolder: '/workspace',
      packageManager: 'npm' as const,
      lockfilePath: '/workspace/shared/package-lock.json',
    };
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runAuditMock = vi.fn().mockImplementation(async () => {
      const index = runAuditMock.mock.calls.length;
      active += 1;
      peak = Math.max(peak, active);
      order.push(`enter-${index}`);
      if (index === 1) {
        await firstGate;
      }
      order.push(`exit-${index}`);
      active -= 1;
      return new Map<string, never>();
    });
    createClientMock.mockReturnValue({ runAudit: runAuditMock });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    resolveAuditProjectsMock.mockResolvedValueOnce({
      projects: [
        { ...sharedProject, originManifests: [firstManifest] },
        { ...sharedProject, originManifests: [secondManifest] },
      ],
      rejected: [],
    });
    const audit = provider.runAudit();
    await vi.waitFor(() => expect(runAuditMock).toHaveBeenCalledTimes(1));
    expect(active).toBe(1);
    releaseFirst();
    await audit;

    expect(peak).toBe(1);
    expect(order).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
    expect(provider.getAuditProjects()).toHaveLength(2);
    provider.dispose();
  });

  it('cancels queued audit roots without publishing a completion status', async () => {
    const roots = Array.from({ length: CHECK_CONCURRENCY_CAP + 2 }, (_, index) => (
      `/workspace/audit-cancel-${index}`
    ));
    const packageEntries = roots.map((root, index) => ({
      name: `audit-cancel-package-${index}`,
      current: '1.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: `${root}/package.json`,
    }));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(packageEntries.map(entry => entry.packageFilePath));
    let active = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    createClientMock.mockImplementation(() => ({
      runAudit: async () => {
        active += 1;
        await gate;
        active -= 1;
        return new Map<string, never>();
      },
    }));

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const audit = provider.runAudit();
    await vi.waitFor(() => expect(active).toBe(CHECK_CONCURRENCY_CAP));
    provider.cancelAudit();
    release();
    await audit;

    expect(createClientMock).toHaveBeenCalledTimes(CHECK_CONCURRENCY_CAP);
    expect(provider.getAuditProjects()).toEqual([]);
    expect(provider.getAuditFailures()).toEqual([]);
    expect(provider.getChildren().some(item => item instanceof StatusItem && (
      item.label === 'Audit complete' || item.label === 'Audit incomplete'
    ))).toBe(false);
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('keeps an unrecognized structured client result incomplete instead of clean', async () => {
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({ unexpected: true }),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(provider.getAuditProjects()[0]).toMatchObject({
      status: 'failure',
      failure: { reason: 'audit-failed' },
      advisories: [],
    });
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      reason: 'audit-failed',
      packageFilePaths: ['/workspace/package.json'],
    })]);
  });

  it('shows every failed package path when all audits fail', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/apps/web/package.json',
      },
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('web audit unavailable')),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('ui audit unavailable')),
      });

    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(showError).not.toHaveBeenCalled();
    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('No successful audit results; 2 package roots failed');
    expect(provider.getChildren().some(item => item.label === 'Audit complete')).toBe(false);
  });

  it('preserves complete audit wording when all roots succeed', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map()),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit complete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('No vulnerabilities');
  });

  it('ignores concurrent audits while allowing a later manual audit', async () => {
    let resolveAudit: (value: Map<string, 'high'>) => void = () => {};
    const runAuditMock = vi.fn()
      .mockReturnValueOnce(new Promise<Map<string, 'high'>>((resolve) => {
        resolveAudit = resolve;
      }))
      .mockResolvedValueOnce(new Map([['react', 'moderate']]));
    createClientMock.mockReturnValue({
      runAudit: runAuditMock,
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const firstAudit = provider.runAudit();
    const secondAudit = provider.runAudit();

    await vi.waitFor(() => expect(runAuditMock).toHaveBeenCalledTimes(1));

    expect(createClientMock).toHaveBeenCalledTimes(1);

    resolveAudit(new Map([['react', 'high']]));
    await Promise.all([firstAudit, secondAudit]);

    await provider.runAudit();

    const packages = provider.getChildren()
      .filter((item): item is GroupItem => item instanceof GroupItem)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    const react = packages.find(item => item.packageName === 'react');

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(runAuditMock).toHaveBeenCalledTimes(2);
    expect(react?.vulnerabilitySeverity).toBe('moderate');
  });

  it('discards an audit result after the package snapshot reloads', async () => {
    let resolveAudit: (value: Map<string, 'high'>) => void = () => {};
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>((resolve) => {
        resolveAudit = resolve;
      })),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    const audit = provider.runAudit();
    await vi.waitFor(() => expect(createClientMock).toHaveBeenCalledTimes(1));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'lodash',
        current: '4.17.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    await provider.loadPackages();

    resolveAudit(new Map([['react', 'high']]));
    await audit;

    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBeUndefined();
    expect(provider.getAuditProjects()).toEqual([]);
    expect(provider.getAuditFailures()).toEqual([]);
    expect(provider.getChildren().some(item => item instanceof StatusItem && (
      item.label === 'Audit complete' || item.label === 'Audit incomplete'
    ))).toBe(false);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/^Audit/));
    expect(showError).not.toHaveBeenCalled();
  });

  it('keeps the current audit failure when a cancelled predecessor succeeds late', async () => {
    let resolveOldAudit: (value: Map<string, 'high'>) => void = () => {};
    const oldRunAudit = vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>((resolve) => {
      resolveOldAudit = resolve;
    }));
    const newRunAudit = vi.fn().mockRejectedValue(new Error('current audit failed'));
    createClientMock
      .mockReturnValueOnce({ runAudit: oldRunAudit })
      .mockReturnValueOnce({ runAudit: newRunAudit });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    let treeChangeCount = 0;
    const treeChangeSubscription = provider.onDidChangeTreeData(() => {
      treeChangeCount += 1;
    });

    const oldAudit = provider.runAudit();
    await vi.waitFor(() => expect(oldRunAudit).toHaveBeenCalledTimes(1));
    provider.cancelAudit();

    const currentAudit = provider.runAudit();
    resolveOldAudit(new Map([['react', 'high']]));
    await Promise.all([oldAudit, currentAudit]);
    const treeChangesAfterCurrentRun = treeChangeCount;

    expect(provider.getAuditProjects().map(summary => summary.status)).toEqual(['failure']);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBeUndefined();
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Audit incomplete')).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Audit incomplete: 0 vulnerable package(s); failed 1 package root(s).');
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/^Audit: /));
    expect(showError).not.toHaveBeenCalled();
    expect(treeChangeCount).toBe(treeChangesAfterCurrentRun);
    treeChangeSubscription.dispose();
  });

  it('keeps the current audit success when a cancelled predecessor fails late', async () => {
    let rejectOldAudit: (reason: Error) => void = () => {};
    const oldRunAudit = vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>((_, reject) => {
      rejectOldAudit = reject;
    }));
    const newRunAudit = vi.fn().mockResolvedValue(new Map<string, never>());
    createClientMock
      .mockReturnValueOnce({ runAudit: oldRunAudit })
      .mockReturnValueOnce({ runAudit: newRunAudit });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    const oldAudit = provider.runAudit();
    await vi.waitFor(() => expect(oldRunAudit).toHaveBeenCalledTimes(1));
    provider.cancelAudit();

    const currentAudit = provider.runAudit();
    rejectOldAudit(new Error('stale audit failed'));
    await Promise.all([oldAudit, currentAudit]);

    expect(provider.getAuditProjects().map(summary => summary.status)).toEqual(['success']);
    expect(provider.getAuditFailures()).toEqual([]);
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Audit complete')).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('does nothing when cancelling with no audit running', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    provider.cancelAudit();

    expect(createClientMock).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('resets the busy state synchronously when the audit is cancelled, discarding the run', async () => {
    let resolveAudit: (value: Map<string, 'high'>) => void = () => {};
    const runAuditMock = vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>((resolve) => {
      resolveAudit = resolve;
    }));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    const audit = provider.runAudit();
    await vi.waitFor(() => expect(runAuditMock).toHaveBeenCalledWith(expect.any(AbortSignal)));
    const [signal] = runAuditMock.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    provider.cancelAudit();

    // Synchronous: gone the instant cancelAudit() returns, before the aborted
    // client.runAudit() call has actually settled in the background.
    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Running audit…')).toBe(false);
    expect(signal.aborted).toBe(true);

    resolveAudit(new Map([['react', 'high']]));
    await audit;

    // The cancelled run's result is discarded rather than surfaced as a finished audit.
    expect(provider.getChildren().some(item =>
      item instanceof StatusItem && (item.label === 'Audit complete' || item.label === 'Audit incomplete'))).toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });

  it('keeps a replacement audit controller alive after the cancelled run finally settles', async () => {
    let resolveOldAudit: (value: Map<string, 'high'>) => void = () => {};
    let resolveNewAudit: (value: Map<string, 'high'>) => void = () => {};
    let oldSignal!: AbortSignal;
    let newSignal!: AbortSignal;
    const oldRunAudit = vi.fn().mockImplementation((signal: AbortSignal) => {
      oldSignal = signal;
      return new Promise<Map<string, 'high'>>((resolve) => {
        resolveOldAudit = resolve;
      });
    });
    const newRunAudit = vi.fn().mockImplementation((signal: AbortSignal) => {
      newSignal = signal;
      return new Promise<Map<string, 'high'>>((resolve) => {
        resolveNewAudit = resolve;
      });
    });
    createClientMock
      .mockReturnValueOnce({ runAudit: oldRunAudit })
      .mockReturnValueOnce({ runAudit: newRunAudit });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    const oldAudit = provider.runAudit();
    await vi.waitFor(() => expect(oldRunAudit).toHaveBeenCalledTimes(1));
    provider.cancelAudit();
    expect(oldSignal.aborted).toBe(true);

    const newAudit = provider.runAudit();
    resolveOldAudit(new Map());
    await oldAudit;
    await vi.waitFor(() => expect(newRunAudit).toHaveBeenCalledTimes(1));
    expect(newSignal.aborted).toBe(false);

    // The old finally block must take the false side of the identity guard and leave
    // the replacement controller installed. A mutation that unconditionally clears it
    // makes the next cancel a no-op, leaving this second process alive.
    expect(newSignal.aborted).toBe(false);

    provider.cancelAudit();
    expect(newSignal.aborted).toBe(true);
    resolveNewAudit(new Map());
    await newAudit;
  });

  it('stops auditing further projects once cancelled mid-run', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/apps/web/package.json' },
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/packages/ui/package.json' },
    ]);
    let provider!: PackagesProvider;
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockImplementation(() => {
          // Cancellation lands mid-loop, after the first project's own audit already
          // succeeded — proves the loop stops *starting new* work rather than
          // discarding a project that had already finished.
          provider.cancelAudit();
          return Promise.resolve(new Map<string, never>());
        }),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map()),
      });
    provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight audit process on dispose', async () => {
    // The mock never settles on its own — it stands in for a real, still-running child
    // process. dispose() must not need it to settle: cancellation is proven directly by
    // the signal it was called with flipping to aborted, matching what a real
    // execFile(..., { signal }) call would then react to (see processRunner.unit.test.ts
    // for that real-process proof).
    const runAuditMock = vi.fn().mockReturnValue(new Promise<Map<string, 'high'>>(() => {}));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    void provider.runAudit();
    await vi.waitFor(() => expect(runAuditMock).toHaveBeenCalledTimes(1));
    const [signal] = runAuditMock.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    provider.dispose();

    expect(signal.aborted).toBe(true);
  });

  it('does not surface an error for an exception that races a cancellation', async () => {
    let provider!: PackagesProvider;
    resolveAuditProjectsMock.mockImplementationOnce(() => {
      provider.cancelAudit();
      throw new Error('resolver raced with cancellation');
    });
    provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.runAudit();

    expect(showError).not.toHaveBeenCalled();
  });

  it('allows a later manual audit when package file discovery fails', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths)
      .mockRejectedValueOnce(new Error('workspace scan failed'))
      .mockResolvedValueOnce(['/workspace/package.json']);
    const runAuditMock = vi.fn().mockResolvedValue(new Map([['react', 'high']]));
    createClientMock.mockReturnValue({
      runAudit: runAuditMock,
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    const status = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Workspace package loading failed'
    ));
    expect(status?.command?.command).toBe('nestro.openStatusReport');
    expect(provider.getChildren().some(item => (
      item instanceof StatusItem && item.label === 'Package read incomplete'
    ))).toBe(false);
    expect(provider.getStatusReport().packageReadFailures).toEqual([expect.objectContaining({
      packageFilePaths: [],
      reason: 'package-discovery-failed',
    })]);
    await provider.runAudit();
    await provider.runAudit();

    // Capability computation discovers the manifest during load, so both later manual
    // audits can use the now-known empty manifest rather than consuming the failed scan.
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(runAuditMock).toHaveBeenCalledTimes(2);
  });

  it('audits a shared lock file graph exactly once and suppresses row badges across its manifests', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/api/package.json',
      },
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    resolveAuditProjectsMock.mockResolvedValue({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'pnpm',
        lockfilePath: '/workspace/pnpm-lock.yaml',
        originManifests: [
          '/workspace/packages/api/package.json',
          '/workspace/packages/ui/package.json',
        ],
      }],
      rejected: [],
    });
    const runAuditMock = vi.fn().mockResolvedValue(new Map([['react', 'high']]));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith('pnpm', '/workspace');
    expect(runAuditMock).toHaveBeenCalledTimes(1);
    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);

    const [summary] = provider.getAuditProjects();
    expect(summary.project.originManifests).toEqual([
      '/workspace/packages/api/package.json',
      '/workspace/packages/ui/package.json',
    ]);
    expect(summary.vulnerabilities.get('react')).toBe('high');
  });

  it('projects one proven direct path and installed version onto exactly one manifest row', async () => {
    const advisory = {
      identity: 'npm\0npm-v2-vulnerabilities\0react\0GHSA-react',
      identityStability: 'stable' as const,
      packageName: 'react',
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      advisoryId: 'GHSA-react',
      sources: ['npm'],
      titles: ['React issue'],
      urls: ['https://example.test/react'],
      affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct' as const,
      via: [],
      fixAvailable: false,
    };
    const report: AuditResult = {
      vulnerabilities: new Map([['react', 'high']]),
      total: 1,
      advisories: [advisory],
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
    };
    createClientMock.mockReturnValue({ runAuditReport: vi.fn().mockResolvedValue(report) });
    const fixture = await createRealAuditProject(['react']);
    try {
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: fixture.manifest,
      }]);
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      expect(provider.getAuditProjects()[0]).toMatchObject({
        status: 'success',
        advisories: [advisory],
        failure: undefined,
      });
      expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBe('high');
    }
    finally {
      await fixture.cleanup();
    }
  });

  it('suppresses a badge when one manifest has the package in both dependency sections', async () => {
    const fixture = await createRealAuditProject(['react']);
    const advisory: AuditAdvisory = {
      identity: 'audit-section-version', identityStability: 'stable', packageName: 'react',
      severity: 'high', manager: 'npm', schema: 'npm-v2-vulnerabilities', advisoryId: 'audit-section-version',
      sources: [], titles: [], urls: [], affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'], resolvedVersions: ['18.0.0'], attribution: 'direct', via: [],
    };
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({
        vulnerabilities: new Map([['react', 'high']]), total: 1, advisories: [advisory],
        manager: 'npm', schema: 'npm-v2-vulnerabilities',
      } satisfies AuditResult),
    });
    try {
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        {
          name: 'react', current: '18.0.0', dev: false, versionPrefix: '',
          packageFilePath: fixture.manifest,
        },
        {
          name: 'react', current: '17.0.0', dev: true, versionPrefix: '',
          packageFilePath: fixture.manifest,
        },
      ]);
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      const rows = getPackageItems(provider).filter(item => item.packageName === 'react');
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.vulnerabilitySeverity === undefined)).toBe(true);
    }
    finally {
      await fixture.cleanup();
    }
  });

  it('suppresses a badge when a resolved dependency symlink escapes the project root', async () => {
    const fixture = await createRealAuditProject(['react']);
    const outsideRoot = await mkdtemp(join(tmpdir(), 'nestro-audit-outside-'));
    try {
      const outsidePackage = join(outsideRoot, 'react');
      await mkdir(outsidePackage, { recursive: true });
      await rm(join(fixture.root, 'node_modules', 'react'), { recursive: true, force: true });
      await symlink(outsidePackage, join(fixture.root, 'node_modules', 'react'), 'dir');
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([{
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: fixture.manifest,
      }]);
      const advisory: AuditAdvisory = {
        identity: 'audit-symlink-escape', identityStability: 'stable', packageName: 'react',
        severity: 'high', manager: 'npm', schema: 'npm-v2-vulnerabilities', advisoryId: 'audit-symlink-escape',
        sources: [], titles: [], urls: [], affectedRanges: ['<19.0.0'],
        resolvedPaths: ['node_modules/react'], resolvedVersions: ['18.0.0'], attribution: 'direct', via: [],
      };
      createClientMock.mockReturnValue({
        runAuditReport: vi.fn().mockResolvedValue({
          vulnerabilities: new Map([['react', 'high']]), total: 1, advisories: [advisory],
          manager: 'npm', schema: 'npm-v2-vulnerabilities',
        } satisfies AuditResult),
      });
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBeUndefined();
      expect(provider.getAuditProjects()[0].advisories).toHaveLength(1);
    }
    finally {
      await fixture.cleanup();
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing resolved version', { resolvedVersions: [] }],
    ['transitive attribution', { attribution: 'transitive' }],
    ['nested node_modules path', { resolvedPaths: ['node_modules/dependency/node_modules/react'] }],
    ['virtual Yarn locator', { resolvedPaths: [], resolvedVersions: ['18.0.0'], attribution: 'unknown', manager: 'yarn', schema: 'yarn-modern-npm-audit' }],
  ] as const)('keeps %s in the project report without a row badge', async (_label, overrides) => {
    const advisory = {
      identity: 'audit-structured',
      identityStability: 'stable' as const,
      packageName: 'react',
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      sources: [],
      titles: ['React issue'],
      urls: [],
      affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct' as const,
      via: [],
      ...overrides,
    } as const;
    const report: AuditResult = {
      vulnerabilities: new Map([['react', 'high']]),
      total: 1,
      advisories: [advisory],
      manager: advisory.manager,
      schema: advisory.schema,
    };
    createClientMock.mockReturnValue({ runAuditReport: vi.fn().mockResolvedValue(report) });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBeUndefined();
    expect(provider.getAuditProjects()[0].advisories).toHaveLength(1);
  });

  it('requires manifest and affected-range evidence across exact, caret and tilde specs', async () => {
    const namesAndSpecs = [
      ['exact', '1.2.3', '1.2.3'],
      ['caret', '^1.2.3', '1.3.0'],
      ['tilde', '~1.2.3', '1.2.4'],
      ['zero-major', '^0.2.3', '0.2.4'],
      ['zero-minor', '^0.0.3', '0.0.4'],
      ['workspace', 'workspace:*', '1.0.0'],
      ['empty-range', '1.0.0', '1.0.0'],
      ['bad-version', '1.0.0', 'not-a-version'],
      ['bad-range', '1.0.0', '1.0.0'],
    ] as const;
    const fixture = await createRealAuditProject(namesAndSpecs.map(([name]) => name));
    try {
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(namesAndSpecs.map(([name, current]) => ({
        name,
        current,
        dev: false,
        versionPrefix: '',
        packageFilePath: fixture.manifest,
      })));
      const ranges: Record<string, string> = {
        exact: '<=1.2.3',
        caret: '>=1.0.0 <2.0.0',
        tilde: '>1.2.0 <=1.2.4',
        'zero-major': '0.2.4',
        'zero-minor': '*',
        workspace: '||',
        'empty-range': '',
        'bad-version': '*',
        'bad-range': 'not-a-range',
      };
      const makeAdvisory = (name: string, resolvedVersion: string): AuditAdvisory => ({
        identity: `audit-${name}`,
        identityStability: 'stable',
        packageName: name,
        severity: 'high',
        manager: 'npm',
        schema: 'npm-v2-vulnerabilities',
        advisoryId: `audit-${name}`,
        sources: [],
        titles: [],
        urls: [],
        affectedRanges: [ranges[name]],
        resolvedPaths: [`node_modules/${name}`],
        resolvedVersions: [resolvedVersion],
        attribution: 'direct',
        via: [],
      });
      const report: AuditResult = {
        vulnerabilities: new Map(namesAndSpecs.map(([name]) => [name, 'high' as const])),
        total: namesAndSpecs.length,
        advisories: namesAndSpecs.map(([name, , resolvedVersion]) => makeAdvisory(name, resolvedVersion)),
        manager: 'npm',
        schema: 'npm-v2-vulnerabilities',
      };
      createClientMock.mockReturnValue({ runAuditReport: vi.fn().mockResolvedValue(report) });
      const provider = new PackagesProvider(new FilterManager('all'));

      await provider.loadPackages();
      await provider.runAudit();

      const items = getPackageItems(provider);
      expect(items.filter(item => item.vulnerabilitySeverity !== undefined).map(item => item.packageName)).toEqual(
        expect.arrayContaining(['caret', 'exact', 'tilde', 'zero-major']),
      );
      expect(items.filter(item => item.vulnerabilitySeverity !== undefined)).toHaveLength(4);
      expect(items.find(item => item.packageName === 'zero-minor')?.vulnerabilitySeverity).toBeUndefined();
    }
    finally {
      await fixture.cleanup();
    }
  });

  it('does not infer manifest ownership from an outside or ambiguous resolved path', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react', current: '18.0.0', dev: false, versionPrefix: '',
        packageFilePath: '/workspace/packages/api/package.json',
      },
      {
        name: 'react', current: '18.0.0', dev: false, versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    resolveAuditProjectsMock.mockResolvedValueOnce({
      projects: [{
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'npm',
        lockfilePath: '/workspace/package-lock.json',
        originManifests: ['/workspace/packages/api/package.json', '/workspace/packages/ui/package.json'],
      }],
      rejected: [],
    });
    const advisory: AuditAdvisory = {
      identity: 'audit-ambiguous',
      identityStability: 'stable',
      packageName: 'react',
      severity: 'high',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'audit-ambiguous',
      sources: [], titles: [], urls: [], affectedRanges: ['<19.0.0'],
      resolvedPaths: ['/workspace/packages/api/node_modules/react'],
      resolvedVersions: ['18.0.0'], attribution: 'direct', via: [],
    };
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({
        vulnerabilities: new Map([['react', 'high']]), total: 1, advisories: [advisory],
        manager: 'npm', schema: 'npm-v2-vulnerabilities',
      } satisfies AuditResult),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
    expect(provider.getAuditProjects()[0].advisories).toHaveLength(1);
  });

  it('returns mutation-safe nested project snapshots', async () => {
    const advisory = {
      identity: 'audit-snapshot',
      identityStability: 'stable' as const,
      packageName: 'react',
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      sources: ['source'],
      titles: ['title'],
      urls: [],
      affectedRanges: ['<19.0.0'],
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct' as const,
      via: [{ identity: 'via' }],
    };
    createClientMock.mockReturnValue({
      runAuditReport: vi.fn().mockResolvedValue({
        vulnerabilities: new Map([['react', 'high']]),
        total: 1,
        advisories: [advisory],
        manager: 'npm',
        schema: 'npm-v2-vulnerabilities',
      } satisfies AuditResult),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    const snapshot = provider.getAuditProjects();
    (snapshot[0].vulnerabilities as Map<string, 'critical'>).set('injected', 'critical');
    (snapshot[0].advisories[0].resolvedPaths as string[]).push('injected');
    (snapshot[0].project.originManifests as string[]).push('injected');

    const fresh = provider.getAuditProjects()[0];
    expect(fresh.vulnerabilities.has('injected')).toBe(false);
    expect(fresh.advisories[0].resolvedPaths).toEqual(['node_modules/react']);
    expect(fresh.project.originManifests).toEqual(['/workspace/package.json']);
    const report = provider.getAuditReport();
    expect(report.projects).toHaveLength(1);
    expect(report.failures).toEqual([]);
  });

  it('suppresses the badge for a package name duplicated across dependencies and devDependencies', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'react',
        current: '17.0.0',
        dev: true,
        versionPrefix: '',
        packageFilePath: '/workspace/package.json',
      },
    ]);
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
  });

  it('never attaches a badge for a transitive-only advisory that matches no direct dependency row', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['left-pad', 'critical']])),
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
  });

  it('returns a fresh array from getAuditProjects on each call rather than the live internal state', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map()),
    });
    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();
    const first = provider.getAuditProjects();
    const second = provider.getAuditProjects();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('clears audit projects for the duration of a new audit run', async () => {
    let resolveSecondAudit: (value: Map<string, string>) => void = () => {};
    const runAuditMock = vi.fn()
      .mockResolvedValueOnce(new Map([['react', 'high']]))
      .mockReturnValueOnce(new Promise<Map<string, string>>((resolve) => {
        resolveSecondAudit = resolve;
      }));
    createClientMock.mockReturnValue({ runAudit: runAuditMock });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    await provider.runAudit();
    expect(provider.getAuditProjects()).toHaveLength(1);

    const secondAudit = provider.runAudit();
    expect(provider.getAuditProjects()).toEqual([]);

    resolveSecondAudit(new Map());
    await secondAudit;
  });

  it('clears stale audit projects after an early exit with no package files', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();
    expect(provider.getAuditProjects()).toHaveLength(1);

    (provider as unknown as { allEntries: unknown[] }).allEntries = [];
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    await provider.runAudit();

    expect(provider.getAuditProjects()).toEqual([]);
  });

  it('keeps discovery exceptions actionable in the diagnostics report', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    (provider as unknown as { allEntries: unknown[] }).allEntries = [];
    vi.mocked(getWorkspacePackageFilePaths).mockRejectedValueOnce(new Error('discovery exploded'));

    await provider.runAudit();

    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      packageFilePaths: [],
      reason: 'audit-failed',
      detail: expect.stringContaining('discovery exploded'),
    })]);
    const auditStatus = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Audit failed'
    ));
    expect(auditStatus?.command?.command).toBe('nestro.openStatusReport');
    expect(showError).toHaveBeenCalledWith('Package audit failed — the security audit report is incomplete.');
  });

  it('clears stale audit projects after an exception during project resolution', async () => {
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();
    expect(provider.getAuditProjects()).toHaveLength(1);
    expect(getPackageItems(provider).find(item => item.packageName === 'react')?.vulnerabilitySeverity).toBe('high');

    resolveAuditProjectsMock.mockRejectedValueOnce(new Error('resolution exploded'));
    await provider.runAudit();

    expect(provider.getAuditProjects()).toEqual([]);
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      packageFilePaths: [],
      reason: 'audit-failed',
    })]);
    const auditStatus = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Audit failed'
    ));
    expect(auditStatus?.command?.command).toBe('nestro.openStatusReport');
    expect(getPackageItems(provider).every(item => item.vulnerabilitySeverity === undefined)).toBe(true);
    expect(showError).toHaveBeenCalled();
  });

  it('treats a rejected project resolution as a failed audit root without calling a client', async () => {
    resolveAuditProjectsMock.mockResolvedValue({
      projects: [],
      rejected: [{
        packageFilePath: '/workspace/package.json',
        reason: 'workspace-escape',
        detail: '/workspace/package.json resolves outside its owning workspace folder.',
      }],
    });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(createClientMock).not.toHaveBeenCalled();
    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('No successful audit results; 1 package root failed');
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      packageFilePaths: ['/workspace/package.json'],
      reason: 'workspace-escape',
    })]);
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

  it('gives a package row an accessible workspace owner that matches the disambiguated tree label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-owner-label-'));
    const firstRoot = join(root, 'team-a', 'app');
    const secondRoot = join(root, 'team-b', 'app');
    const firstManifest = join(firstRoot, 'package.json');
    const secondManifest = join(secondRoot, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await mkdir(firstRoot, { recursive: true });
      await mkdir(secondRoot, { recursive: true });
      await writeFile(firstManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      await writeFile(secondManifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      // Neither folder declares a `name`, so both derive the same "app" folder name and
      // can only be told apart by the same suffix disambiguation the tree/picker use.
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }],
      });
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: firstManifest },
        { name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: secondManifest },
      ]);
      vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest, secondManifest]);

      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();

      const folders = provider.getChildren()
        .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
      expect(folders.map(folder => folder.folderLabel)).toEqual(['team-a/app — (root)', 'team-b/app — (root)']);

      const rows = folders
        .flatMap(folder => folder.children)
        .flatMap(group => group.children)
        .filter((item): item is PackageItem => item instanceof PackageItem);

      expect(rows).toHaveLength(2);
      const ownerLabels = rows.map(item => item.accessibilityInformation?.label);
      expect(ownerLabels[0]).toContain('Workspace owner: team-a/app — (root)');
      expect(ownerLabels[1]).toContain('Workspace owner: team-b/app — (root)');
      // The two roots share a folder name; a naive `folder.name` fallback would collide here.
      expect(new Set(ownerLabels)).toHaveLength(2);

      provider.dispose();
    }
    finally {
      restoreWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('computes the owner-label projection once per load, not once per row', async () => {
    const manifestCount = 20;
    const packagesPerManifest = 15;
    const manifestPaths = Array.from(
      { length: manifestCount },
      (_, manifestIndex) => `/workspace/pkg-${manifestIndex}/package.json`,
    );
    const entries = manifestPaths.flatMap((packageFilePath, manifestIndex) => (
      Array.from({ length: packagesPerManifest }, (_, packageIndex) => ({
        name: `dep-${manifestIndex}-${packageIndex}`,
        current: '1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      }))
    ));
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(entries);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce(manifestPaths);

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();

    // A per-row lookup over manifestCount * packagesPerManifest rows would call the
    // projection hundreds of times; caching it per load calls it exactly once, checked
    // before the tree is ever rendered so buildTree()'s own (unrelated) call cannot hide it.
    expect(vi.mocked(resolvePackageFileLabels)).toHaveBeenCalledTimes(1);

    const rows = provider.getChildren()
      .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem)
      .flatMap(folder => folder.children)
      .flatMap(group => group.children)
      .filter((item): item is PackageItem => item instanceof PackageItem);
    expect(rows).toHaveLength(manifestCount * packagesPerManifest);

    provider.dispose();
  });

  it('does not reuse a stale owner label after the manifest set changes', async () => {
    const firstRoot = '/workspace/team-a/app';
    const secondRoot = '/workspace/team-b/app';
    const firstManifest = `${firstRoot}/package.json`;
    const secondManifest = `${secondRoot}/package.json`;
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      // First load: a single folder named "app" — no collision, no disambiguation needed.
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: firstRoot } }],
      });
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: firstManifest },
      ]);
      vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest]);

      const provider = new PackagesProvider(new FilterManager('all'));
      await provider.loadPackages();

      const soloLabel = getPackageItems(provider)[0]?.accessibilityInformation?.label;
      expect(soloLabel).toContain('Workspace owner: app — (root)');

      // Second load on the same provider: a same-named sibling folder now collides,
      // so the label cached for the single-folder load must not survive unchanged.
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }],
      });
      vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
        { name: 'react', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: firstManifest },
        { name: 'react', current: '1.0.0', dev: false, versionPrefix: '', packageFilePath: secondManifest },
      ]);
      vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([firstManifest, secondManifest]);

      await provider.loadPackages();

      const folders = provider.getChildren()
        .filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
      const rows = folders
        .flatMap(folder => folder.children)
        .flatMap(group => group.children)
        .filter((item): item is PackageItem => item instanceof PackageItem);
      const labels = rows.map(item => item.accessibilityInformation?.label);

      expect(labels[0]).toContain('Workspace owner: team-a/app — (root)');
      expect(labels[1]).toContain('Workspace owner: team-b/app — (root)');
      expect(labels[0]).not.toContain('Workspace owner: app — (root)');

      provider.dispose();
    }
    finally {
      restoreWorkspaceFolders(previousFolders);
    }
  });
});

function mockNestroConfiguration(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}

function getPackageItems(provider: PackagesProvider): PackageItem[] {
  return provider.getChildren()
    .filter((item): item is GroupItem => item instanceof GroupItem)
    .flatMap(group => group.children)
    .filter((item): item is PackageItem => item instanceof PackageItem);
}

function setProviderState(
  provider: PackagesProvider,
  state: {
    allEntries?: unknown[];
    auditState?: string;
    auditResults?: Map<string, unknown>;
    checkState?: string;
    lastAuditCount?: number;
    lastCheckTime?: Date;
    loading?: boolean;
  },
): void {
  Object.assign(provider as unknown as Record<string, unknown>, state);
}

describe('package identity boundary', () => {
  it('rejects a manifest replaced after materialization before the first mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-baseline-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders(root);
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
        'Package action is no longer available. Refresh the package list and try again.',
      );
      provider.dispose();
    }
    finally {
      restoreWorkspaceFolders(previousFolders);
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
      setWorkspaceFolders(root);
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
        'Package action is no longer available. Refresh the package list and try again.',
      );
      provider.dispose();
    }
    finally {
      restoreWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not issue a progress capability when tree refresh starts a reload synchronously', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-reload-race-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders(root);
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
      restoreWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale and forged rows while ignoring mutations of a provider-owned row object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-rows-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders(root);
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
      const forged = new PackageItem('react', '^1.0.0', '9.9.9', 'breaking', false, undefined, manifest, false, '^');
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
      restoreWorkspaceFolders(previousFolders);
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
      setWorkspaceFolders(root);
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
      restoreWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a row issued by a different provider instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-foreign-provider-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders(root);
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
      restoreWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps provider-issued capabilities current across progress, baseline refresh, and update marks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-identity-capability-lifecycle-'));
    const manifest = join(root, 'package.json');
    const previousFolders = vscode.workspace.workspaceFolders;
    try {
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.0.0' } }));
      setWorkspaceFolders(root);
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
      restoreWorkspaceFolders(previousFolders);
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
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }],
      });
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
      restoreWorkspaceFolders(previousFolders);
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
      setWorkspaceFolders(root);
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
        setWorkspaceFolders(symlinkWorkspaceRoot);
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
      restoreWorkspaceFolders(previousFolders);
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

      setWorkspaceFolders(workspaceRoot);
      const internal = await resolveCanonicalPackageLocation(internalManifest);
      expect(internal.ok).toBe(true);
      if (internal.ok) {
        expect(internal.value.packageFilePath).toBe(await realpath(join(targetRoot, 'package.json')));
      }

      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: [{ uri: { fsPath: workspaceRoot } }, { uri: { fsPath: otherRoot } }],
      });
      const foreignPath = join(workspaceRoot, 'foreign', 'package.json');
      await mkdir(join(workspaceRoot, 'foreign'));
      await symlink(otherManifest, foreignPath);
      const foreign = await resolveCanonicalPackageLocation(foreignPath);
      expect(foreign).toEqual({ ok: false, reason: 'cross-workspace' });
    }
    finally {
      restoreWorkspaceFolders(previousFolders);
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
      setWorkspaceFolders(root);
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
      restoreWorkspaceFolders(previousFolders);
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
      setWorkspaceFolders(root);
      const result = await resolveCanonicalPackageLocation(manifest);
      expect(result).toEqual({ ok: false, reason });
    }
    finally {
      restoreWorkspaceFolders(previousFolders);
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
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
    setWorkspaceFolders(root);
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
    restoreWorkspaceFolders(previousFolders);
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

function setWorkspaceFolders(root: string): void {
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    value: [{ uri: { fsPath: root } }],
  });
}

function restoreWorkspaceFolders(folders: typeof vscode.workspace.workspaceFolders): void {
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    value: folders,
  });
}

describe('PackageDetailItem', () => {
  it('leaves the icon unset when none is provided', () => {
    const detail = new PackageDetailItem('Current: 1.0.0');

    expect(detail.iconPath).toBeUndefined();
  });
});