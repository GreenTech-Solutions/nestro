import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { installUpdateCommand } from '../commands/installUpdate';
import { FilterManager, PackagesProvider } from '../providers';
import { GroupItem } from '../providers/GroupItem';
import { PackageItem } from '../providers/PackageItem';
import type {
  AuditOrchestrationResult,
  AuditOrchestrationServiceContract,
} from '../providers/auditOrchestrationService';
import type { CanonicalPackageLocation } from '../providers/packageIdentity';
import type { PackageLoadingServiceContract } from '../providers/packageLoadingService';
import type { ResolvedPackageItem } from '../providers';
import { resolveCanonicalPackageLocation } from '../providers/packageLocationResolution';
import type { UpdateOrchestrationServiceContract } from '../providers/updateOrchestrationService';
import { runShellTaskAndWait, updateDependencyVersionsInFile } from '../utils';

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    runShellTaskAndWait: vi.fn(),
    updateDependencyVersionsInFile: vi.fn(),
  };
});

const MANIFEST = { dependencies: { react: '^1.0.0' } };

interface Fixture {
  readonly root: string;
  readonly manifest: string;
  readonly provider: PackagesProvider;
  readonly audit: ReturnType<typeof createAuditService>;
}

let fixture: Fixture | undefined;
let previousFolders: typeof vscode.workspace.workspaceFolders;

function createAuditService(): AuditOrchestrationServiceContract & {
  release: (result?: AuditOrchestrationResult) => void;
  started: Promise<void>;
} {
  let resolveRun: ((result: AuditOrchestrationResult) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    started,
    release: (result = completedAudit()) => resolveRun?.(result),
    run: () => new Promise<AuditOrchestrationResult>((resolve) => {
      resolveRun = resolve;
      markStarted?.();
    }),
  };
}

function completedAudit(): AuditOrchestrationResult {
  return {
    kind: 'completed',
    auditResults: new Map(),
    auditProjects: [],
    auditFailures: [],
    failedAuditPaths: [],
    successfulAuditRootCount: 1,
    vulnerablePackageCount: 0,
  };
}

function createUpdateService(manifest: string): UpdateOrchestrationServiceContract {
  const key = `${manifest}\0react\0dependencies`;
  return {
    check: vi.fn(() => Promise.resolve({
      kind: 'completed' as const,
      data: new Map([[key, { acceptedVersion: '2.0.0', releaseAge: { kind: 'accepted' as const } }]]),
      failedPackageFilePaths: [],
      failures: [],
      allFailed: false,
    })),
    invalidateCache: vi.fn(),
    computeFingerprint: vi.fn(() => Promise.resolve('fingerprint')),
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-capability-freshness-'));
  const manifest = join(root, 'package.json');
  await writeFile(manifest, JSON.stringify(MANIFEST));
  setWorkspaceFolders([{ uri: { fsPath: root } }]);
  const location = await resolveCanonicalPackageLocation(manifest);
  if (!location.ok) {
    throw new Error('expected a canonical manifest location');
  }
  const baselines = new Map<string, CanonicalPackageLocation>([[manifest, location.value]]);
  const loading: PackageLoadingServiceContract = {
    load: () => Promise.resolve({
      entries: [{ name: 'react', current: '^1.0.0', dev: false, versionPrefix: '^', packageFilePath: manifest }],
      packageFilePaths: [manifest],
      readablePackageFilePaths: [manifest],
      failedPackageReadPaths: [],
      packageLocationBaselines: baselines,
      packageReadFailed: false,
    }),
    readPackageEntries: () => Promise.resolve({ entries: [], skippedFiles: [] } as never),
    discoverPackageFilePaths: () => Promise.resolve([manifest]),
  };
  const audit = createAuditService();
  const provider = new PackagesProvider(new FilterManager('all'), loading, createUpdateService(manifest), audit);
  await provider.loadPackages();
  return { root, manifest, provider, audit };
}

function currentRow(provider: PackagesProvider): PackageItem {
  const row = provider.getChildren()
    .filter((item): item is GroupItem => item instanceof GroupItem)
    .flatMap(group => group.children)
    .find((item): item is PackageItem => item instanceof PackageItem);
  if (row === undefined) {
    throw new Error('expected a rendered package row');
  }
  return row;
}

async function resolveRow(provider: PackagesProvider): Promise<ResolvedPackageItem> {
  const resolution = await provider.resolvePackageItem(currentRow(provider));
  if (!resolution.ok) {
    throw new Error(`expected a capability, got ${resolution.reason}`);
  }
  return resolution.value;
}

describe('capability freshness across row rebuilds', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    previousFolders = vscode.workspace.workspaceFolders;
    fixture = await createFixture();
  });

  afterEach(async () => {
    fixture?.provider.dispose();
    setWorkspaceFolders(previousFolders);
    if (fixture !== undefined) {
      await rm(fixture.root, { recursive: true, force: true });
    }
    fixture = undefined;
  });

  it('keeps the capability of an in-flight command valid when an audit completes', async () => {
    const { provider, audit } = fixture!;
    const capability = await resolveRow(provider);
    const active = provider.markPackageUpdatingForCapability(capability, { kind: 'update', target: '2.0.0' });
    expect(active).toBeDefined();

    const auditRun = provider.runAudit();
    await audit.started;
    audit.release();
    await auditRun;

    await expect(provider.revalidatePackageItem(active!)).resolves.toMatchObject({ ok: true });
    await expect(provider.refreshPackageBaselineForCapability(active!, '^1.0.0')).resolves.toBeDefined();
    provider.markPackageUpdatedForCapability(active!, '2.0.0');
    expect(currentRow(provider).currentVersion).toBe('^2.0.0');
  });

  it('keeps the capability valid across an update check and a settings reset', async () => {
    const { provider } = fixture!;
    const capability = await resolveRow(provider);
    const active = provider.markPackageUpdatingForCapability(capability, { kind: 'update', target: '2.0.0' });

    await provider.checkUpdates();
    provider.resetUpdateData();

    await expect(provider.revalidatePackageItem(active!)).resolves.toMatchObject({ ok: true });
    await expect(provider.reissuePackageCapability(active!)).resolves.toBeDefined();
    expect(provider.markPackageUpdatingForCapability(active!, undefined)).toBeDefined();
  });

  it('keeps an idle capability valid after a rebuild that changes no row data', async () => {
    const { provider } = fixture!;
    const capability = await resolveRow(provider);

    provider.resetUpdateData();

    await expect(provider.revalidatePackageItem(capability)).resolves.toMatchObject({ ok: true });
  });

  it('rejects a capability issued before the row operation started', async () => {
    const { provider } = fixture!;
    const stale = await resolveRow(provider);
    const active = provider.markPackageUpdatingForCapability(stale, { kind: 'update', target: '2.0.0' });
    const idle = provider.markPackageUpdatingForCapability(active!, undefined);
    provider.resetUpdateData();

    await expect(provider.revalidatePackageItem(stale)).resolves.toEqual({ ok: false, reason: 'not-current' });
    await expect(provider.revalidatePackageItem(idle!)).resolves.toMatchObject({ ok: true });
  });

  it('rejects the capability after a reload of the package list', async () => {
    const { provider } = fixture!;
    const capability = await resolveRow(provider);

    await provider.loadPackages();

    await expect(provider.revalidatePackageItem(capability)).resolves.toEqual({ ok: false, reason: 'not-current' });
  });

  it('rejects the capability after the manifest is edited, even when no reload ran', async () => {
    const { provider, manifest } = fixture!;
    const capability = await resolveRow(provider);
    provider.resetUpdateData();

    await writeFile(manifest, JSON.stringify({ dependencies: { react: '^1.5.0' } }));

    await expect(provider.revalidatePackageItem(capability)).resolves.toEqual({ ok: false, reason: 'path-replaced' });
  });

  it('rejects the capability once the row is marked updated to another version', async () => {
    const { provider } = fixture!;
    const capability = await resolveRow(provider);
    const active = provider.markPackageUpdatingForCapability(capability, { kind: 'update', target: '2.0.0' });
    provider.markPackageUpdatedForCapability(active!, '2.0.0');
    provider.resetUpdateData();

    await expect(provider.revalidatePackageItem(active!)).resolves.toEqual({ ok: false, reason: 'not-current' });
  });
});

describe('install command with a row rebuild in flight', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    previousFolders = vscode.workspace.workspaceFolders;
    fixture = await createFixture();
    await fixture.provider.checkUpdates();
  });

  afterEach(async () => {
    fixture?.provider.dispose();
    setWorkspaceFolders(previousFolders);
    if (fixture !== undefined) {
      await rm(fixture.root, { recursive: true, force: true });
    }
    fixture = undefined;
    mockDeferredInstall(false);
  });

  async function completeAuditDuringCommand(): Promise<void> {
    const { provider, audit } = fixture!;
    const run = provider.runAudit();
    await audit.started;
    audit.release();
    await run;
  }

  it('applies a deferred update when an audit completes after the manifest write', async () => {
    const { provider, manifest } = fixture!;
    mockDeferredInstall(true);
    vi.mocked(updateDependencyVersionsInFile).mockImplementation(async () => {
      await completeAuditDuringCommand();
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^2.0.0' } }));
    });

    await installUpdateCommand(currentRow(provider), provider);

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(currentRow(provider).currentVersion).toBe('^2.0.0');
    expect(currentRow(provider).installing).toBe(false);
  });

  it('applies a package-manager update when an audit completes while the task runs', async () => {
    const { provider, manifest } = fixture!;
    vi.mocked(runShellTaskAndWait).mockImplementation(async () => {
      await completeAuditDuringCommand();
      await writeFile(manifest, JSON.stringify({ dependencies: { react: '^2.0.0' } }));
      return { kind: 'ended', exitCode: 0 };
    });

    await installUpdateCommand(currentRow(provider), provider);

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(currentRow(provider).currentVersion).toBe('^2.0.0');
    expect(currentRow(provider).installing).toBe(false);
  });

  it('clears the installing state when the task fails after an audit completed', async () => {
    const { provider } = fixture!;
    vi.mocked(runShellTaskAndWait).mockImplementation(async () => {
      await completeAuditDuringCommand();
      return { kind: 'ended', exitCode: 1 };
    });

    await installUpdateCommand(currentRow(provider), provider);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(currentRow(provider).currentVersion).toBe('^1.0.0');
    expect(currentRow(provider).installing).toBe(false);
  });
});

function mockDeferredInstall(enabled: boolean): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      key === 'deferInstallAfterUpdate' ? enabled : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}