import { vi } from 'vitest';
import type { AuditAdvisory } from '../../utils';
import { runWithYarnFamilyMemoPassthrough } from './yarnFamilyMemo';

export const packagesProviderMocks = {
  createClient: vi.fn(),
  resolveAuditProjects: vi.fn(),
  getUpdateType: vi.fn(),
};

export function createClientsModuleMock(): Record<string, unknown> {
  return {
    ClientManager: vi.fn(function (this: { createClient: typeof packagesProviderMocks.createClient }) {
      this.createClient = packagesProviderMocks.createClient;
    }),
    resolveAuditProjects: (packageFilePaths: readonly string[]) => packagesProviderMocks.resolveAuditProjects(packageFilePaths),
    // Test double for the coordinator key: each manifest's own directory,
    // matching resolveAuditProjects's default "no shared ancestor lockfile" shape.
    resolveMutationCoordinatorKey: vi.fn((packageFilePath: string) => Promise.resolve(
      packageFilePath.replace(/\/package\.json$/, ''),
    )),
  };
}

export async function createUtilsModuleMock(): Promise<Record<string, unknown>> {
  const { parseDependencySpec } = await vi.importActual<typeof import('../../utils/dependencySpec')>('../../utils/dependencySpec');
  const localization = await vi.importActual<typeof import('../../utils/localization')>('../../utils/localization');
  const releaseAge = await vi.importActual<typeof import('../../utils/releaseAge')>('../../utils/releaseAge');
  // Real scheduler primitives: the provider suites' cap/parallelism/partial-failure/cancellation
  // tests need genuine bounded concurrency, not a trivial always-run-immediately double.
  const operationCoordinator = await vi.importActual<
    typeof import('../../utils/operationCoordinator')
  >('../../utils/operationCoordinator');
  const rootOperation = await vi.importActual<typeof import('../../utils/rootOperation')>('../../utils/rootOperation');
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
    getUpdateType: packagesProviderMocks.getUpdateType,
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
    // without real cross-key exclusion — the provider suites' provider-level tests only need
    // installUpdateCommand's control flow, not coordinator concurrency semantics
    // (those are covered directly in operationCoordinator.unit.test.ts).
    mutationCoordinator: {
      runExclusive: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
      runManyExclusive: vi.fn((_keys: readonly string[], fn: () => Promise<unknown>) => fn()),
    },
    parseDependencySpec,
    readAllWorkspaceDependencies: vi.fn(),
    runWithYarnFamilyMemo: vi.fn(runWithYarnFamilyMemoPassthrough),
    resolveYarnFamily: vi.fn(),
    resolveMetadataRegistryKey: vi.fn((_packageName: string, packageFilePath?: string) => (
      Promise.resolve(packageFilePath ?? 'https://registry.npmjs.org/')
    )),
    runNpmAudit: vi.fn(),
    cloneAuditAdvisory,
    mergeAuditAdvisories: vi.fn((advisories: readonly AuditAdvisory[]) => [...advisories]),
    showError: vi.fn(),
  };
}