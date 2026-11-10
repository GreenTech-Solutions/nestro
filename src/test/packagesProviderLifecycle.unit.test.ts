import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FilterManager, PackagesProvider } from '../providers';
import type {
  AuditOrchestrationServiceContract,
  PackageLoadingServiceContract,
  PackageLoadingSnapshot,
} from '../providers';
import type { AuditOrchestrationResult } from '../providers/auditOrchestrationService';
import type {
  CachedUpdateData,
  UpdateOrchestrationResult,
  UpdateOrchestrationServiceContract,
} from '../providers/updateOrchestrationService';
import type { AuditSeverity, PackageFileEntry } from '../utils';

const updateResult: UpdateOrchestrationResult = {
  kind: 'completed',
  data: new Map<string, CachedUpdateData>(),
  failedPackageFilePaths: [],
  failures: [],
  allFailed: false,
};

const auditResult: AuditOrchestrationResult = {
  kind: 'completed',
  auditResults: new Map<string, AuditSeverity>(),
  auditProjects: [],
  auditFailures: [],
  failedAuditPaths: [],
  successfulAuditRootCount: 1,
  vulnerablePackageCount: 0,
};

function createSnapshot(): PackageLoadingSnapshot {
  const entries: PackageFileEntry[] = [{
    name: 'react',
    current: '18.0.0',
    dev: false,
    versionPrefix: '',
    packageFilePath: '/workspace/package.json',
  }];
  return {
    entries,
    packageFilePaths: ['/workspace/package.json'],
    readablePackageFilePaths: [],
    failedPackageReadPaths: [],
    packageLocationBaselines: new Map(),
    packageReadFailed: false,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface ProviderHarness {
  readonly provider: PackagesProvider;
  readonly load: PackageLoadingServiceContract['load'];
  readonly readPackageEntries: PackageLoadingServiceContract['readPackageEntries'];
  readonly discoverPackageFilePaths: PackageLoadingServiceContract['discoverPackageFilePaths'];
  readonly updateCheck: UpdateOrchestrationServiceContract['check'];
  readonly auditRun: AuditOrchestrationServiceContract['run'];
}

function createProvider(load: PackageLoadingServiceContract['load']): ProviderHarness {
  const readPackageEntries = vi.fn<PackageLoadingServiceContract['readPackageEntries']>(() => Promise.resolve([]));
  const discoverPackageFilePaths = vi.fn<PackageLoadingServiceContract['discoverPackageFilePaths']>(() => Promise.resolve([]));
  const packageLoadingService: PackageLoadingServiceContract = {
    load,
    readPackageEntries,
    discoverPackageFilePaths,
  };
  const updateCheck = vi.fn<UpdateOrchestrationServiceContract['check']>(() => Promise.resolve(updateResult));
  const updateService: UpdateOrchestrationServiceContract = {
    check: updateCheck,
    invalidateCache: vi.fn(),
    computeFingerprint: () => Promise.resolve('fingerprint'),
  };
  const auditRun = vi.fn<AuditOrchestrationServiceContract['run']>(() => Promise.resolve(auditResult));
  const provider = new PackagesProvider(
    new FilterManager('all'),
    packageLoadingService,
    updateService,
    { run: auditRun },
  );
  return {
    provider,
    load,
    readPackageEntries,
    discoverPackageFilePaths,
    updateCheck,
    auditRun,
  };
}

function mockCancelledProgress(): void {
  vi.mocked(vscode.window.withProgress).mockImplementationOnce((_options, task) => task(
    { report: vi.fn() },
    {
      isCancellationRequested: true,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    },
  ));
}

describe('PackagesProvider operation lifecycle', () => {
  it('waits for the current load before checking or auditing packages', async () => {
    const loadGate = deferred<PackageLoadingSnapshot>();
    const load = vi.fn<PackageLoadingServiceContract['load']>(() => loadGate.promise);
    const harness = createProvider(load);
    const loading = harness.provider.loadPackages();
    const checking = harness.provider.checkUpdates();
    const auditing = harness.provider.runAudit();

    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.readPackageEntries).not.toHaveBeenCalled();
    expect(harness.discoverPackageFilePaths).not.toHaveBeenCalled();
    expect(harness.updateCheck).not.toHaveBeenCalled();
    expect(harness.auditRun).not.toHaveBeenCalled();

    loadGate.resolve(createSnapshot());
    await Promise.all([loading, checking, auditing]);

    expect(harness.load).toHaveBeenCalledOnce();
    expect(harness.readPackageEntries).not.toHaveBeenCalled();
    expect(harness.discoverPackageFilePaths).not.toHaveBeenCalled();
    expect(harness.updateCheck).toHaveBeenCalledOnce();
    expect(harness.auditRun).toHaveBeenCalledOnce();
  });

  it('discards checks and audits cancelled while waiting for the load', async () => {
    const loadGate = deferred<PackageLoadingSnapshot>();
    const load = vi.fn<PackageLoadingServiceContract['load']>(() => loadGate.promise);
    const harness = createProvider(load);
    const checking = harness.provider.checkUpdates();
    const auditing = harness.provider.runAudit();

    expect(harness.load).toHaveBeenCalledOnce();
    harness.provider.cancelCheckUpdates();
    harness.provider.cancelAudit();
    loadGate.resolve(createSnapshot());
    await Promise.all([checking, auditing]);

    expect(harness.updateCheck).not.toHaveBeenCalled();
    expect(harness.auditRun).not.toHaveBeenCalled();
  });

  it('does not start an audit when its progress token was cancelled before start', async () => {
    const load = vi.fn<PackageLoadingServiceContract['load']>(() => Promise.resolve(createSnapshot()));
    const harness = createProvider(load);
    await harness.provider.loadPackages();
    mockCancelledProgress();

    await harness.provider.runAudit();

    expect(harness.auditRun).not.toHaveBeenCalled();
  });

  it('does not start an update check when its progress token was cancelled before start', async () => {
    const load = vi.fn<PackageLoadingServiceContract['load']>(() => Promise.resolve(createSnapshot()));
    const harness = createProvider(load);
    await harness.provider.loadPackages();
    mockCancelledProgress();

    await harness.provider.checkUpdates();

    expect(harness.updateCheck).not.toHaveBeenCalled();
  });

  it('resets audit state if VS Code cannot start progress', async () => {
    const load = vi.fn<PackageLoadingServiceContract['load']>(() => Promise.resolve(createSnapshot()));
    const harness = createProvider(load);
    await harness.provider.loadPackages();
    vi.mocked(vscode.window.withProgress).mockRejectedValueOnce(new Error('progress failed'));

    await expect(harness.provider.runAudit()).rejects.toThrow('progress failed');

    expect(harness.provider.getChildren().some(item => item.label === 'Running audit…')).toBe(false);
    expect(harness.auditRun).not.toHaveBeenCalled();
  });

  it('does nothing when cancelling with no audit running', async () => {
    const load = vi.fn<PackageLoadingServiceContract['load']>(() => Promise.resolve(createSnapshot()));
    const harness = createProvider(load);
    await harness.provider.loadPackages();

    harness.provider.cancelAudit();

    expect(harness.auditRun).not.toHaveBeenCalled();
  });
});