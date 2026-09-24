import { describe, expect, it, vi } from 'vitest';
import { AuditOrchestrationService } from '../providers';
import type {
  AuditableClient,
  AuditableRow,
  AuditOrchestrationDependencies,
  AuditOrchestrationRequest,
  AuditOrchestrationResult,
} from '../providers';
import type { AuditProject, PackageManager } from '../clients';
import { OperationCoordinator } from '../utils';
import type {
  AuditAdvisory,
  AuditResult,
} from '../utils';

const PACKAGE_FILE = '/workspace/package.json';
const PROJECT_ROOT = '/workspace';

function createProject(
  projectRoot: string,
  originManifests: readonly string[] = [`${projectRoot}/package.json`],
  packageManager: PackageManager = 'npm',
): AuditProject {
  return {
    projectRoot,
    workspaceFolder: '/workspace',
    packageManager,
    lockfilePath: `${projectRoot}/package-lock.json`,
    originManifests,
  };
}

function createRow(
  packageName = 'react',
  packageFilePath = PACKAGE_FILE,
  currentVersion = '^18.0.0',
  dev = false,
): AuditableRow {
  return { packageName, packageFilePath, currentVersion, dev };
}

function createAdvisory(overrides: Partial<AuditAdvisory> = {}): AuditAdvisory {
  return {
    identity: 'npm\0npm-v2-vulnerabilities\0react\0GHSA-react',
    identityStability: 'stable',
    packageName: 'react',
    severity: 'high',
    manager: 'npm',
    schema: 'npm-v2-vulnerabilities',
    advisoryId: 'GHSA-react',
    sources: ['npm'],
    titles: ['React issue'],
    urls: ['https://example.test/react'],
    affectedRanges: ['<19.0.0'],
    resolvedPaths: ['node_modules/react'],
    resolvedVersions: ['18.1.0'],
    attribution: 'direct',
    via: [],
    ...overrides,
  };
}

function createReport(
  advisories: readonly AuditAdvisory[],
  manager: AuditProject['packageManager'] = 'npm',
): AuditResult {
  return {
    vulnerabilities: new Map(advisories.map(advisory => [advisory.packageName, advisory.severity])),
    total: advisories.length,
    advisories,
    manager,
    schema: manager === 'yarn' ? 'yarn-modern-npm-audit' : 'npm-v2-vulnerabilities',
  };
}

function createDependencies(
  overrides: Partial<AuditOrchestrationDependencies> = {},
): AuditOrchestrationDependencies {
  const client: AuditableClient = {
    runAudit: vi.fn().mockResolvedValue(new Map()),
  };
  return {
    checkCoordinator: new OperationCoordinator(2),
    resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [], rejected: [] }),
    createClient: vi.fn((_packageManager: PackageManager, _projectRoot: string) => client),
    realpath: vi.fn((targetPath: string) => Promise.resolve(targetPath)),
    ...overrides,
  };
}

function createRequest(overrides: Partial<AuditOrchestrationRequest> = {}): AuditOrchestrationRequest {
  return {
    packageFilePaths: [PACKAGE_FILE],
    rows: [createRow()],
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...overrides,
  };
}

function expectCompleted(
  result: AuditOrchestrationResult,
): result is Extract<AuditOrchestrationResult, { kind: 'completed' }> {
  expect(result.kind).toBe('completed');
  return result.kind === 'completed';
}

describe('AuditOrchestrationService', () => {
  it('runs the structured report adapter and attributes a proven row', async () => {
    const project = createProject(PROJECT_ROOT);
    const advisory = createAdvisory();
    const runAuditReport = vi.fn().mockResolvedValue(createReport([advisory]));
    const createClient = vi.fn(() => ({ runAudit: vi.fn(), runAuditReport }));
    const resolveAuditProjects = vi.fn().mockResolvedValue({ projects: [project], rejected: [] });
    const dependencies = createDependencies({ createClient, resolveAuditProjects });

    const result = await new AuditOrchestrationService(dependencies).run(createRequest());

    expect(expectCompleted(result)).toBe(true);
    if (!expectCompleted(result)) {
      return;
    }
    expect(resolveAuditProjects).toHaveBeenCalledWith([PACKAGE_FILE]);
    expect(createClient).toHaveBeenCalledWith('npm', PROJECT_ROOT);
    expect(runAuditReport).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.auditResults.get(`${PACKAGE_FILE}\0react\0dependencies`)).toBe('high');
    expect(result.auditProjects).toEqual([expect.objectContaining({
      project,
      status: 'success',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      vulnerabilities: new Map([['react', 'high']]),
      advisories: [advisory],
    })]);
    expect(result.successfulAuditRootCount).toBe(1);
    expect(result.vulnerablePackageCount).toBe(1);
  });

  it('uses the legacy map adapter and keeps partial outcomes in input order', async () => {
    const projects = [
      createProject('/workspace/success'),
      createProject('/workspace/failure'),
      createProject('/workspace/unknown'),
    ];
    const rejected = {
      packageFilePath: '/workspace/rejected/package.json',
      reason: 'workspace-escape' as const,
      detail: 'Rejected manifest.',
    };
    const resolveAuditProjects = vi.fn().mockResolvedValue({ projects, rejected: [rejected] });
    const createClient = vi.fn((_manager: PackageManager, projectRoot: string): AuditableClient => {
      if (projectRoot === '/workspace/success') {
        return { runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])) };
      }
      if (projectRoot === '/workspace/failure') {
        return { runAudit: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
      }
      return { runAudit: vi.fn().mockResolvedValue({ future: 'schema' }) };
    });
    const dependencies = createDependencies({ resolveAuditProjects, createClient });

    const result = await new AuditOrchestrationService(dependencies).run(createRequest({
      packageFilePaths: projects.map(project => project.originManifests[0] as string),
      rows: [createRow('react', '/workspace/success/package.json')],
    }));

    expect(expectCompleted(result)).toBe(true);
    if (!expectCompleted(result)) {
      return;
    }
    expect(result.auditProjects.map(project => project.status)).toEqual([
      'success',
      'failure',
      'failure',
    ]);
    expect(result.auditFailures.map(failure => failure.packageFilePaths)).toEqual([
      ['/workspace/rejected/package.json'],
      ['/workspace/failure/package.json'],
      ['/workspace/unknown/package.json'],
    ]);
    expect(result.failedAuditPaths).toEqual([
      '/workspace/rejected/package.json',
      '/workspace/failure/package.json',
      '/workspace/unknown/package.json',
    ]);
    expect(result.auditResults.get('/workspace/success/package.json\0react\0dependencies')).toBe('high');
    expect(result.successfulAuditRootCount).toBe(1);
    expect(result.vulnerablePackageCount).toBe(1);
    expect(result.auditFailures[1]?.reason).toBe('audit-failed');
    expect(result.auditFailures[2]?.detail).toContain('unrecognized audit result');
  });

  it('preserves report-only advisories when row attribution is ambiguous or unsafe', async () => {
    const project = createProject(PROJECT_ROOT);
    const valid = createAdvisory();
    const transitive = createAdvisory({
      identity: 'transitive',
      advisoryId: 'transitive',
      attribution: 'transitive',
    });
    const missingVersion = createAdvisory({
      identity: 'missing-version',
      advisoryId: 'missing-version',
      resolvedVersions: [],
    });
    const outsidePath = createAdvisory({
      identity: 'outside-path',
      advisoryId: 'outside-path',
      resolvedPaths: ['/outside/node_modules/react'],
    });
    const duplicateRows = [createRow(), createRow('react', PACKAGE_FILE, '^17.0.0', true)];
    const runAuditReport = vi.fn().mockResolvedValue(createReport([
      valid,
      transitive,
      missingVersion,
      outsidePath,
    ]));
    const dependencies = createDependencies({
      resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
      createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport })),
    });

    const result = await new AuditOrchestrationService(dependencies).run(createRequest({ rows: duplicateRows }));

    expect(expectCompleted(result)).toBe(true);
    if (!expectCompleted(result)) {
      return;
    }
    expect(result.auditResults).toEqual(new Map());
    expect(result.auditProjects[0]?.advisories).toHaveLength(4);
  });

  it('serializes same-root projects while retaining their deterministic input order', async () => {
    const projects = [
      createProject('/workspace/shared', ['/workspace/shared/first/package.json']),
      createProject('/workspace/shared', ['/workspace/shared/second/package.json']),
    ];
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runAudit = vi.fn().mockImplementation(async () => {
      const index = runAudit.mock.calls.length;
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
    const dependencies = createDependencies({
      resolveAuditProjects: vi.fn().mockResolvedValue({ projects, rejected: [] }),
      createClient: vi.fn(() => ({ runAudit })),
    });
    const pending = new AuditOrchestrationService(dependencies).run(createRequest({
      packageFilePaths: projects.flatMap(project => project.originManifests),
      rows: [],
    }));

    await vi.waitFor(() => expect(runAudit).toHaveBeenCalledTimes(1));
    expect(active).toBe(1);
    releaseFirst();
    const result = await pending;

    expect(peak).toBe(1);
    expect(order).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
    expect(expectCompleted(result)).toBe(true);
    if (expectCompleted(result)) {
      expect(result.auditProjects.map(summary => summary.project.originManifests[0])).toEqual([
        '/workspace/shared/first/package.json',
        '/workspace/shared/second/package.json',
      ]);
    }
  });

  it('discards before resolving projects when the request is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const resolveAuditProjects = vi.fn();
    const dependencies = createDependencies({ resolveAuditProjects });

    const result = await new AuditOrchestrationService(dependencies).run(createRequest({
      signal: controller.signal,
    }));

    expect(result).toEqual({ kind: 'discarded', reason: 'cancelled' });
    expect(resolveAuditProjects).not.toHaveBeenCalled();
  });

  it('discards a result that becomes stale during project resolution or audit execution', async () => {
    let current = true;
    const project = createProject(PROJECT_ROOT);
    const resolveAuditProjects = vi.fn().mockImplementation(() => {
      current = false;
      return { projects: [project], rejected: [] };
    });
    const createClient = vi.fn();
    const service = new AuditOrchestrationService(createDependencies({ resolveAuditProjects, createClient }));

    await expect(service.run(createRequest({ isCurrent: () => current }))).resolves.toEqual({
      kind: 'discarded',
      reason: 'cancelled',
    });
    expect(createClient).not.toHaveBeenCalled();

    current = true;
    const runAudit = vi.fn().mockImplementation(() => {
      current = false;
      return new Map<string, never>();
    });
    const execution = await new AuditOrchestrationService(createDependencies({
      resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
      createClient: vi.fn(() => ({ runAudit })),
    })).run(createRequest({ isCurrent: () => current }));

    expect(execution).toEqual({ kind: 'discarded', reason: 'cancelled' });
  });

  it('returns a typed failure for a resolver error and preserves cancellation races', async () => {
    const error = Object.assign(new Error('resolver failed'), {
      outcome: { reason: 'unresolvable-path', detail: 'Manifest disappeared.' },
    });
    const failed = await new AuditOrchestrationService(createDependencies({
      resolveAuditProjects: vi.fn().mockRejectedValue(error),
    })).run(createRequest());

    expect(failed).toEqual({
      kind: 'failed',
      reason: 'unresolvable-path',
      detail: 'Manifest disappeared.',
    });

    let current = true;
    const raced = await new AuditOrchestrationService(createDependencies({
      resolveAuditProjects: vi.fn().mockImplementation(() => {
        current = false;
        return Promise.reject(new Error('cancelled resolver'));
      }),
    })).run(createRequest({ isCurrent: () => current }));
    expect(raced).toEqual({ kind: 'discarded', reason: 'cancelled' });
  });
});