import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilterManager,
  PackagesProvider,
  StatusItem,
} from '../providers';
import {
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import type { AuditAdvisory, AuditResult } from '../utils';
import { packagesProviderMocks } from './fixtures/packagesProviderMocks';
import { getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';
const { createClient: createClientMock, resolveAuditProjects: resolveAuditProjectsMock } = packagesProviderMocks;

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

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
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

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValueOnce([]);
    await provider.loadPackages();
    await provider.runAudit();

    expect(provider.getAuditProjects()).toEqual([]);
  });

  it('keeps discovery exceptions actionable in the diagnostics report', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([]);
    vi.mocked(getWorkspacePackageFilePaths).mockRejectedValue(new Error('discovery exploded'));
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    expect(provider.getStatusReport().packageReadFailures).toEqual([expect.objectContaining({
      packageFilePaths: [],
      reason: 'package-discovery-failed',
      detail: 'Failed to discover workspace package files.',
    })]);
    const loadingStatus = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Workspace package loading failed'
    ));
    expect(loadingStatus?.command?.command).toBe('nestro.openStatusReport');
    expect(provider.getAuditFailures()).toEqual([]);
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
});