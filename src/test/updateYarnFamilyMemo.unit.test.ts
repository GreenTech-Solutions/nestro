import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileOptions } from 'node:child_process';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockWorkspaceFiles } from './fixtures/workspaceFs';
import { AuditOrchestrationService, UpdateOrchestrationService } from '../providers';
import type {
  AuditOrchestrationDependencies,
  AuditOrchestrationRequest,
  CanonicalPackageLocation,
  PackageIdentityTuple,
  UpdateOrchestrationDependencies,
  UpdateOrchestrationRequest,
} from '../providers';
import type { AuditProject, PackageManager } from '../clients';
import { resolveSpawnTarget } from '../shared';
import { OperationCoordinator, resolveYarnFamily, runWithYarnFamilyMemo } from '../utils';
import type { AuditSeverity } from '../utils';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return { ...actual, resolveSpawnTarget: vi.fn(actual.resolveSpawnTarget) };
});

type ExecFileCallback = NonNullable<Parameters<typeof execFile>[3]>;

const projectRoot = '/workspace/project';
const packageFilePath = `${projectRoot}/package.json`;
const otherProjectRoot = '/workspace/other-project';
const otherPackageFilePath = `${otherProjectRoot}/package.json`;
let probeCounts = new Map<string, number>();

function mockVersionProbe(stdout: string): void {
  vi.mocked(execFile).mockImplementation((
    _file: string,
    _args: readonly string[] | null | undefined,
    options: ExecFileOptions | null | undefined,
    callback: ExecFileCallback | null | undefined,
  ) => {
    if (callback === undefined || callback === null) {
      throw new Error('Expected execFile callback.');
    }
    if (typeof options?.cwd === 'string') {
      probeCounts.set(options.cwd, (probeCounts.get(options.cwd) ?? 0) + 1);
    }
    callback(null, stdout, '');
    return {} as ChildProcess;
  });
}

function createLocation(path: string): CanonicalPackageLocation {
  return {
    packageFilePath: path,
    packageDirectory: dirname(path),
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'manifest-digest',
  };
}

function createUpdateDependencies(): UpdateOrchestrationDependencies {
  return {
    checkCoordinator: new OperationCoordinator(2),
    metadataCoordinator: new OperationCoordinator(2),
    fetchAllLatestVersions: () => Promise.resolve(new Map([
      ['react', '2.0.0'],
      ['vite', '2.0.0'],
    ])),
    resolveMetadataRegistryKey: async (_packageName, path) => {
      await resolveYarnFamily(dirname(path));
      return 'https://registry.example.test';
    },
    fetchPackageMetadata: (_packageName, path) => runWithYarnFamilyMemo(async () => {
      await resolveYarnFamily(dirname(path));
      return { kind: 'unavailable', reason: 'configuration-unavailable' };
    }),
    resolveMutationCoordinatorKey: path => Promise.resolve(dirname(path)),
    resolveCanonicalPackageLocation: path => Promise.resolve({ ok: true, value: createLocation(path) }),
    readCanonicalDependencySpecs: (_location, identities) => Promise.resolve(identities.map(() => '^1.0.0')),
    now: () => 1_000,
  };
}

function createUpdateRequest(): UpdateOrchestrationRequest {
  const identities: PackageIdentityTuple[] = [
    { packageName: 'react', packageFilePath, section: 'dependencies' },
    { packageName: 'vite', packageFilePath: otherPackageFilePath, section: 'dependencies' },
  ];
  return {
    identities,
    currentVersions: new Map(identities.map(identity => [
      `${identity.packageFilePath}\0${identity.packageName}\0${identity.section}`,
      '1.0.0',
    ])),
    packageFiles: [packageFilePath, otherPackageFilePath],
    target: 'latest',
    includePreReleases: false,
    minimumReleaseAgeDays: 7,
    forceAlways: true,
    debounceSeconds: 0,
    lastCheckTime: undefined,
    signal: new AbortController().signal,
    isCurrent: () => true,
    resolveCurrentPolicy: () => ({ target: 'latest', includePreReleases: false, minimumReleaseAgeDays: 7 }),
  };
}

function createAuditProject(root: string, packageManager: PackageManager): AuditProject {
  const manifestPath = `${root}/package.json`;
  return {
    projectRoot: root,
    workspaceFolder: '/workspace',
    packageManager,
    lockfilePath: `${root}/yarn.lock`,
    originManifests: [manifestPath],
  };
}

function createAuditDependencies(project: AuditProject): AuditOrchestrationDependencies {
  return {
    checkCoordinator: new OperationCoordinator(2),
    resolveAuditProjects: async () => {
      await Promise.all([project, createAuditProject(otherProjectRoot, 'yarn')].map(
        candidate => resolveYarnFamily(candidate.projectRoot),
      ));
      return { projects: [project, createAuditProject(otherProjectRoot, 'yarn')], rejected: [] };
    },
    createClient: (_packageManager, root) => ({
      runAudit: async () => {
        await resolveYarnFamily(root);
        return new Map<string, AuditSeverity>();
      },
    }),
    realpath: path => Promise.resolve(path),
    readPackageJsonVersion: () => Promise.resolve(undefined),
  };
}

function createAuditRequest(): AuditOrchestrationRequest {
  return {
    packageFilePaths: [packageFilePath, otherPackageFilePath],
    rows: [],
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

describe('operation-wide Yarn family memo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFile).mockReset();
    probeCounts = new Map();
    mockWorkspaceFiles({ [packageFilePath]: '{}', [otherPackageFilePath]: '{}' });
    vi.mocked(resolveSpawnTarget).mockReturnValue({ kind: 'resolved', command: 'yarn', args: ['--version'] });
    mockVersionProbe('4.6.0\n');
  });

  it('probes once per root across metadata registry resolution and fetching', async () => {
    const service = new UpdateOrchestrationService(createUpdateDependencies());

    await service.check(createUpdateRequest());

    expect(probeCounts.size).toBe(2);
    expect(probeCounts.get(projectRoot)).toBe(1);
    expect(probeCounts.get(otherProjectRoot)).toBe(1);
  });

  it('probes once per root across project resolution and audit execution', async () => {
    const project = createAuditProject(projectRoot, 'yarn');
    const service = new AuditOrchestrationService(createAuditDependencies(project));

    await service.run(createAuditRequest());

    expect(probeCounts.size).toBe(2);
    expect(probeCounts.get(projectRoot)).toBe(1);
    expect(probeCounts.get(otherProjectRoot)).toBe(1);
  });
});