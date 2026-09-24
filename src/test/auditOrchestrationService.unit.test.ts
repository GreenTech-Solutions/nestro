import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditOrchestrationService } from '../providers';
import type {
  AuditableClient,
  AuditableRow,
  AuditOrchestrationDependencies,
  AuditOrchestrationRequest,
  AuditOrchestrationResult,
} from '../providers';
// Not part of the providers barrel's public surface (internal helpers used only as the
// default `readPackageJsonVersion`/node-path parser), so imported from their implementation file.
import { parseDirectNodeModulesNode, readNodePackageJsonVersion } from '../providers/auditOrchestrationService';
import type { AuditProject, PackageManager } from '../clients';
import { OperationCoordinator } from '../utils';
import type {
  AuditAdvisory,
  AuditResult,
  AuditSeverity,
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
    // Synthetic — a real npm v2 document never carries a version; see the real fixture in auditClient.unit.test.ts.
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
    readPackageJsonVersion: vi.fn().mockResolvedValue(undefined),
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

  describe('npm v2 installed-version resolution', () => {
    it('resolves installed versions from node_modules and attributes only direct rows, using the worst matched severity', async () => {
      const project = createProject(PROJECT_ROOT);
      // Real values captured from `npm audit --json` (auditReportVersion 2) against the
      // demo-app fixture: axios/lodash/vitest are direct, esbuild/vite are transitive.
      const installedVersions: Record<string, string> = {
        axios: '0.21.4',
        lodash: '4.17.15',
        vitest: '0.34.6',
        esbuild: '0.21.5',
        vite: '5.4.21',
      };
      const advisories = [
        createAdvisory({
          identity: 'axios', packageName: 'axios', severity: 'high', advisoryId: 'GHSA-jr5f',
          resolvedPaths: ['node_modules/axios'], resolvedVersions: [], affectedRanges: ['<0.30.0'], attribution: 'direct',
        }),
        createAdvisory({
          identity: 'lodash', packageName: 'lodash', severity: 'high', advisoryId: 'GHSA-35jh',
          resolvedPaths: ['node_modules/lodash'], resolvedVersions: [], affectedRanges: ['<4.17.21'], attribution: 'direct',
        }),
        createAdvisory({
          identity: 'vitest', packageName: 'vitest', severity: 'critical', advisoryId: 'GHSA-5xrq',
          resolvedPaths: ['node_modules/vitest'], resolvedVersions: [], affectedRanges: ['<3.2.6'], attribution: 'direct',
        }),
        createAdvisory({
          identity: 'esbuild', packageName: 'esbuild', severity: 'moderate', advisoryId: 'GHSA-67mh',
          resolvedPaths: ['node_modules/esbuild'], resolvedVersions: [], affectedRanges: ['<=0.24.2'], attribution: 'transitive',
        }),
        createAdvisory({
          identity: 'vite', packageName: 'vite', severity: 'high', advisoryId: 'GHSA-fx2h',
          resolvedPaths: ['node_modules/vite'], resolvedVersions: [], affectedRanges: ['<=6.4.2'], attribution: 'transitive',
        }),
      ];
      const readPackageJsonVersion = vi.fn((packageJsonPath: string) => {
        const match = /node_modules\/([^/]+)\/package\.json$/.exec(packageJsonPath);
        const name = match?.[1];
        return Promise.resolve(name === undefined ? undefined : installedVersions[name]);
      });
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport(advisories)) })),
        readPackageJsonVersion,
      });
      const rows = [
        createRow('axios', PACKAGE_FILE, '^0.21.1', false),
        createRow('lodash', PACKAGE_FILE, '4.17.15', false),
        createRow('vitest', PACKAGE_FILE, '^0.34.0', true),
        createRow('esbuild', PACKAGE_FILE, '^0.21.0', true),
        createRow('vite', PACKAGE_FILE, '^5.0.0', true),
      ];

      const result = await new AuditOrchestrationService(dependencies).run(createRequest({ rows }));

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(result.auditResults.get(`${PACKAGE_FILE}\0axios\0dependencies`)).toBe('high');
      expect(result.auditResults.get(`${PACKAGE_FILE}\0lodash\0dependencies`)).toBe('high');
      expect(result.auditResults.get(`${PACKAGE_FILE}\0vitest\0devDependencies`)).toBe('critical');
      expect(result.auditResults.has(`${PACKAGE_FILE}\0esbuild\0devDependencies`)).toBe(false);
      expect(result.auditResults.has(`${PACKAGE_FILE}\0vite\0devDependencies`)).toBe(false);
      expect(result.auditResults.size).toBe(3);
      // The report still records the resolved version for the transitive packages; only
      // row attribution is gated on direct ownership.
      const bySchemaProject = result.auditProjects[0]?.advisories ?? [];
      expect(bySchemaProject.find(a => a.packageName === 'esbuild')?.resolvedVersions).toEqual(['0.21.5']);
    });

    it('leaves an advisory unresolved when it reports more than one node', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisory = createAdvisory({
        resolvedPaths: ['node_modules/react', 'node_modules/other/node_modules/react'],
        resolvedVersions: [],
      });
      const readPackageJsonVersion = vi.fn();
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport([advisory])) })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(readPackageJsonVersion).not.toHaveBeenCalled();
      expect(result.auditResults.size).toBe(0);
      expect(result.auditProjects[0]?.advisories[0]?.resolvedVersions).toEqual([]);
    });

    it('leaves an advisory unresolved when its single node is a nested (transitive) install', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisory = createAdvisory({
        resolvedPaths: ['node_modules/dependency/node_modules/react'],
        resolvedVersions: [],
      });
      const readPackageJsonVersion = vi.fn();
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport([advisory])) })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(readPackageJsonVersion).not.toHaveBeenCalled();
      expect(result.auditResults.size).toBe(0);
    });

    it('stays report-only when the installed package.json cannot be read', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisory = createAdvisory({ resolvedVersions: [] });
      const readPackageJsonVersion = vi.fn().mockResolvedValue(undefined);
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport([advisory])) })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(readPackageJsonVersion).toHaveBeenCalledWith(`${PROJECT_ROOT}/node_modules/react/package.json`);
      expect(result.auditResults.size).toBe(0);
      expect(result.auditProjects[0]?.advisories[0]?.resolvedVersions).toEqual([]);
    });

    it('does not read past a node_modules path that realpaths outside the project root', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisory = createAdvisory({ resolvedVersions: [] });
      const readPackageJsonVersion = vi.fn();
      const realpath = vi.fn((targetPath: string) => Promise.resolve(
        targetPath === `${PROJECT_ROOT}/node_modules/react/package.json` ? '/outside/package.json' : targetPath,
      ));
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport([advisory])) })),
        realpath,
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(readPackageJsonVersion).not.toHaveBeenCalled();
      expect(result.auditResults.size).toBe(0);
    });

    it('resolves the installed version but leaves the row unbadged when it falls outside the affected range', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisory = createAdvisory({ resolvedVersions: [], affectedRanges: ['<18.0.0'] });
      const readPackageJsonVersion = vi.fn().mockResolvedValue('18.1.0');
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport([advisory])) })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(result.auditResults.size).toBe(0);
      expect(result.auditProjects[0]?.advisories[0]?.resolvedVersions).toEqual(['18.1.0']);
    });

    it.each([
      ['the worse advisory sorts first by identity', 'a', 'moderate', 'b', 'high'],
      ['the worse advisory sorts last by identity', 'a', 'high', 'b', 'moderate'],
    ] as [string, string, AuditSeverity, string, AuditSeverity][])('keeps the worst severity when several proven advisories attribute the same row (%s)', async (_label, idA, severityA, idB, severityB) => {
      const project = createProject(PROJECT_ROOT);
      const advisoryA = createAdvisory({ identity: idA, advisoryId: idA, severity: severityA, resolvedVersions: [] });
      const advisoryB = createAdvisory({ identity: idB, advisoryId: idB, severity: severityB, resolvedVersions: [] });
      const readPackageJsonVersion = vi.fn().mockResolvedValue('18.1.0');
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({
          runAudit: vi.fn(),
          runAuditReport: vi.fn().mockResolvedValue(createReport([advisoryA, advisoryB])),
        })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(result.auditResults.get(`${PACKAGE_FILE}\0react\0dependencies`)).toBe('high');
    });

    it('leaves a v1/yarn/bun advisory unaffected: only npm-v2-vulnerabilities is enriched', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisory = createAdvisory({
        schema: 'npm-v1-advisories',
        resolvedVersions: [],
        resolvedPaths: ['node_modules/react'],
      });
      const readPackageJsonVersion = vi.fn();
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({ runAudit: vi.fn(), runAuditReport: vi.fn().mockResolvedValue(createReport([advisory])) })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      expect(readPackageJsonVersion).not.toHaveBeenCalled();
      expect(result.auditResults.size).toBe(0);
    });

    it('memoizes the package.json read across several via-split advisories for one package', async () => {
      const project = createProject(PROJECT_ROOT);
      const advisories = [
        createAdvisory({ identity: 'a', advisoryId: 'a', resolvedVersions: [] }),
        createAdvisory({ identity: 'b', advisoryId: 'b', resolvedVersions: [] }),
        createAdvisory({ identity: 'c', advisoryId: 'c', resolvedVersions: [] }),
      ];
      const readPackageJsonVersion = vi.fn().mockResolvedValue('18.1.0');
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({
          runAudit: vi.fn(),
          runAuditReport: vi.fn().mockResolvedValue(createReport(advisories)),
        })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      // Three advisories for the same package and node: one read, not three.
      expect(readPackageJsonVersion).toHaveBeenCalledTimes(1);
      expect(result.auditResults.get(`${PACKAGE_FILE}\0react\0dependencies`)).toBe('high');
    });

    it('does not lose a valid advisory\'s version when an invalid-node advisory for the same package sorts first', async () => {
      const project = createProject(PROJECT_ROOT);
      // Identity 'a' sorts before 'b', so the rejected node is resolved (and memoized) first.
      const invalidNode = createAdvisory({
        identity: 'a', advisoryId: 'a', resolvedVersions: [], resolvedPaths: ['react'],
      });
      const validNode = createAdvisory({
        identity: 'b', advisoryId: 'b', resolvedVersions: [], resolvedPaths: ['node_modules/react'],
      });
      const readPackageJsonVersion = vi.fn().mockResolvedValue('18.1.0');
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({
          runAudit: vi.fn(),
          runAuditReport: vi.fn().mockResolvedValue(createReport([invalidNode, validNode])),
        })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      // The memo key must include the node path: a rejected node sharing only
      // (projectRoot, packageName) with a valid one must not poison its cache entry.
      expect(readPackageJsonVersion).toHaveBeenCalledTimes(1);
      expect(result.auditResults.get(`${PACKAGE_FILE}\0react\0dependencies`)).toBe('high');
    });

    it.each([
      ['a nested (transitive) node', 'node_modules/host/node_modules/react'],
      ['a name mismatch', 'node_modules/other'],
    ] as [string, string][])('does not leak the sibling package.json version onto an advisory whose node is rejected (%s)', async (_label, rejectedNodePath) => {
      const project = createProject(PROJECT_ROOT);
      // Identity 'a' (valid) sorts before 'b' (rejected), so 'a' resolves and caches first.
      const validNode = createAdvisory({
        identity: 'a', advisoryId: 'a', resolvedVersions: [], resolvedPaths: ['node_modules/react'],
      });
      const rejectedNode = createAdvisory({
        identity: 'b', advisoryId: 'b', resolvedVersions: [], resolvedPaths: [rejectedNodePath],
      });
      const readPackageJsonVersion = vi.fn().mockResolvedValue('18.1.0');
      const dependencies = createDependencies({
        resolveAuditProjects: vi.fn().mockResolvedValue({ projects: [project], rejected: [] }),
        createClient: vi.fn(() => ({
          runAudit: vi.fn(),
          runAuditReport: vi.fn().mockResolvedValue(createReport([validNode, rejectedNode])),
        })),
        readPackageJsonVersion,
      });

      const result = await new AuditOrchestrationService(dependencies).run(createRequest());

      expect(expectCompleted(result)).toBe(true);
      if (!expectCompleted(result)) {
        return;
      }
      const advisories = result.auditProjects[0]?.advisories ?? [];
      expect(advisories.find(advisory => advisory.identity === 'a')?.resolvedVersions).toEqual(['18.1.0']);
      expect(advisories.find(advisory => advisory.identity === 'b')?.resolvedVersions).toEqual([]);
      expect(readPackageJsonVersion).toHaveBeenCalledTimes(1);
    });
  });
});

describe('parseDirectNodeModulesNode()', () => {
  it.each([
    ['a relative traversal outside node_modules', '../../etc/passwd', 'passwd'],
    ['an absolute path outside node_modules', '/etc/passwd', 'passwd'],
    ['a name that does not match the package', 'node_modules/other', 'plain'],
    ['a dot segment', 'node_modules/.', '.'],
    ['a dot-dot segment', 'node_modules/..', '..'],
    ['an empty segment from a trailing slash', 'node_modules/plain/', 'plain'],
    ['a nested (transitive) install', 'node_modules/host/node_modules/nested', 'nested'],
  ] as [string, string, string][])('rejects %s', (_label, nodePath, packageName) => {
    expect(parseDirectNodeModulesNode(nodePath, packageName)).toBeUndefined();
  });

  it.each([
    ['an unscoped direct install', 'node_modules/plain', 'plain', 'node_modules/plain'],
    ['a scoped direct install', 'node_modules/@scope/pkg', '@scope/pkg', 'node_modules/@scope/pkg'],
    ['a backslash-separated path', 'node_modules\\plain', 'plain', 'node_modules/plain'],
  ] as [string, string, string, string][])('resolves %s', (_label, nodePath, packageName, expected) => {
    expect(parseDirectNodeModulesNode(nodePath, packageName)).toBe(expected);
  });
});

describe('readNodePackageJsonVersion() on a real filesystem', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nestro-audit-orch-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves the version from a well-formed package.json', async () => {
    const packageJsonPath = join(tempDir, 'package.json');
    await writeFile(packageJsonPath, JSON.stringify({ name: 'fixture', version: '2.4.6' }));

    await expect(readNodePackageJsonVersion(packageJsonPath)).resolves.toBe('2.4.6');
  });

  it('returns undefined for a missing file (ENOENT)', async () => {
    await expect(readNodePackageJsonVersion(join(tempDir, 'missing', 'package.json'))).resolves.toBeUndefined();
  });

  it('returns undefined when the path is a directory', async () => {
    const directoryPath = join(tempDir, 'package.json');
    await mkdir(directoryPath);

    await expect(readNodePackageJsonVersion(directoryPath)).resolves.toBeUndefined();
  });

  it('returns undefined for a file over the 1 MiB bound', async () => {
    const packageJsonPath = join(tempDir, 'package.json');
    const oversized = `{"version":"1.0.0","padding":"${'x'.repeat(1024 * 1024 + 1)}"}`;
    await writeFile(packageJsonPath, oversized);

    await expect(readNodePackageJsonVersion(packageJsonPath)).resolves.toBeUndefined();
  });

  it('returns undefined for invalid JSON', async () => {
    const packageJsonPath = join(tempDir, 'package.json');
    await writeFile(packageJsonPath, '{not valid json');

    await expect(readNodePackageJsonVersion(packageJsonPath)).resolves.toBeUndefined();
  });

  it.each([
    ['a non-string version', JSON.stringify({ version: 42 })],
    ['a missing version field', JSON.stringify({ name: 'fixture' })],
    ['a version that is not plain semver', JSON.stringify({ version: '../../etc/passwd' })],
  ])('returns undefined for %s', async (_label, content) => {
    const packageJsonPath = join(tempDir, 'package.json');
    await writeFile(packageJsonPath, content);

    await expect(readNodePackageJsonVersion(packageJsonPath)).resolves.toBeUndefined();
  });
});