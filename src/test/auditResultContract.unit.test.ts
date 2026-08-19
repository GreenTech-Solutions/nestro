import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterManager, PackagesProvider, StatusItem } from '../providers';
import {
  AUDIT_PROCESS_MAX_BUFFER_BYTES,
  getWorkspacePackageFilePaths,
  readAllWorkspaceDependencies,
} from '../utils';

// End-to-end guard for ARC-02: the audit runner, the package manager client and the tree
// status row are wired together with only the child process mocked, so an unrecognized
// audit result can never reach the user as "No vulnerabilities".

const runBoundedProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

vi.mock('../clients', async () => {
  const { NpmClient } = await vi.importActual<typeof import('../clients/NpmClient')>('../clients/NpmClient');
  return {
    ClientManager: vi.fn(function (this: {
      getClient: () => Promise<InstanceType<typeof NpmClient>>;
      createClient: () => InstanceType<typeof NpmClient>;
    }) {
      this.getClient = () => Promise.resolve(new NpmClient('/workspace'));
      this.createClient = () => new NpmClient('/workspace');
    }),
    // Every known package file resolves to one project rooted at its own directory —
    // this suite's fixtures are all single-manifest, so real project-graph dedupe
    // (`ARC-07`) is not what's under test here; only the audit-result contract is.
    resolveAuditProjects: (packageFilePaths: readonly string[]) => Promise.resolve({
      projects: packageFilePaths.map(packageFilePath => ({
        projectRoot: '/workspace',
        workspaceFolder: '/workspace',
        packageManager: 'npm' as const,
        lockfilePath: undefined,
        originManifests: [packageFilePath],
      })),
      rejected: [],
    }),
  };
});

vi.mock('../utils', async () => {
  const auditClient = await vi.importActual<typeof import('../utils/auditClient')>('../utils/auditClient');
  const auditReport = await vi.importActual<typeof import('../utils/auditReport')>('../utils/auditReport');
  const { logger } = await vi.importActual<typeof import('../utils/logger')>('../utils/logger');
  return {
    ...auditClient,
    ...auditReport,
    fetchAllLatestVersions: vi.fn().mockResolvedValue(new Map()),
    getPackageDirectory: vi.fn((packageFilePath: string) => packageFilePath.replace(/\/package\.json$/, '')),
    getUpdateType: vi.fn(() => 'none'),
    getWorkspacePackageFilePaths: vi.fn(),
    logger,
    readAllWorkspaceDependencies: vi.fn(),
    readWorkspaceDependencies: vi.fn(),
    showError: vi.fn(),
  };
});

function mockAuditProcess(err: unknown, stdout: string): void {
  runBoundedProcessMock.mockImplementationOnce(() => {
    if (err === null) {
      return Promise.resolve({ kind: 'exit', stdout, stderr: '', exitCode: 0 });
    }
    const properties = typeof err === 'object' && err !== null
      ? err as { code?: unknown; stdout?: unknown; stderr?: unknown }
      : {};
    const output = typeof properties.stdout === 'string' ? properties.stdout : stdout;
    const stderr = typeof properties.stderr === 'string' ? properties.stderr : '';
    if (properties.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return Promise.resolve({ kind: 'overflow', maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES });
    }
    if (typeof properties.code === 'number') {
      return Promise.resolve({ kind: 'exit', stdout: output, stderr, exitCode: properties.code });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Promise.resolve({
      kind: 'spawn-error',
      reason: properties.code === 'ENOENT' ? 'command-not-found' : 'process-failed',
      detail: `npm could not run: ${message}`,
      message,
      cause: err,
    });
  });
}

function npmReport(vulnerabilities: Record<string, unknown>, total: number): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: total, critical: 0, total } },
  });
}

const cleanReport = npmReport({}, 0);
const advisoryReport = npmReport({ react: { name: 'react', severity: 'high' } }, 1);

async function auditStatusRow(): Promise<StatusItem | undefined> {
  const provider = new PackagesProvider(new FilterManager('all'));
  await provider.loadPackages();
  await provider.runAudit();
  return provider.getChildren()
    .filter((item): item is StatusItem => item instanceof StatusItem)
    .find(item => String(item.label).startsWith('Audit'));
}

describe('audit status row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/package.json' },
    ]);
    vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(['/workspace/package.json']);
  });

  it('reports no vulnerabilities for a confirmed clean audit', async () => {
    mockAuditProcess(null, cleanReport);

    const status = await auditStatusRow();

    expect(status?.label).toBe('Audit complete');
    expect(status?.description).toBe('No vulnerabilities');
  });

  it('reports the vulnerable package count for a recognized advisory report', async () => {
    mockAuditProcess(Object.assign(new Error('audit found vulnerabilities'), { code: 1, stdout: advisoryReport }), '');

    const status = await auditStatusRow();

    expect(status?.label).toBe('Audit complete');
    expect(status?.description).toBe('1 vulnerable package(s)');
  });

  it.each([
    ['an unrecognized schema', null, JSON.stringify({ foo: 'bar' })],
    ['empty output', null, ''],
    ['truncated JSON', null, advisoryReport.slice(0, 40)],
    ['an unexpected exit code', Object.assign(new Error('failed'), { code: 2, stdout: cleanReport }), ''],
    ['a zero-finding report on a non-zero exit', Object.assign(new Error('failed'), { code: 1, stdout: cleanReport }), ''],
    ['an unknown command', Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }), ''],
  ])('never reports no vulnerabilities for %s', async (_label, err, stdout) => {
    mockAuditProcess(err, stdout);

    const status = await auditStatusRow();

    expect(status?.label).toBe('Audit incomplete');
    expect(status?.description).not.toContain('No vulnerabilities');
  });
});