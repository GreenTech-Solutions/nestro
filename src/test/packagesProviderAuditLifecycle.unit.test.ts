import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as vscode from 'vscode';
import {
  FilterManager,
  GroupItem,
  PackageItem,
  PackagesProvider,
  StatusItem,
} from '../providers';
import {
  CHECK_CONCURRENCY_CAP,
  getWorkspacePackageFilePaths,
  logger,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import { packagesProviderMocks } from './fixtures/packagesProviderMocks';
import { getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';
const { createClient: createClientMock, resolveAuditProjects: resolveAuditProjectsMock } = packagesProviderMocks;

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
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

    // The first manual audit retries the failed load before using its package snapshot.
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(runAuditMock).toHaveBeenCalledTimes(2);
  });
});