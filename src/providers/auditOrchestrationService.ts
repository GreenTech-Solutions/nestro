import { realpath as fsRealpath } from 'node:fs/promises';
import { ClientManager, resolveAuditProjects } from '../clients';
import type { AuditProject, PackageManager } from '../clients';
import { cloneAuditAdvisory, runRootOperations } from '../utils';
import type {
  AuditAdvisory,
  AuditPackageManager,
  AuditSchemaId,
  AuditSeverity,
  OperationCoordinator,
  RootOperationResult,
} from '../utils';
import { enrichNpmV2AdvisoryVersions, readNodePackageJsonVersion } from './auditInstalledVersion';
import type { AuditFileProbe } from './auditInstalledVersion';
import { applyLegacyProjectAuditResults, applyStructuredProjectAuditResults } from './auditRowAttribution';
import { runProjectAudit } from './auditProjectRunner';
import type { AuditableClient, ProjectAuditOutcome } from './auditProjectRunner';
import type { AuditableRow } from './auditRowAttribution';

export type { AuditableClient, AuditableRow };

/** Project-level audit data remains available when row attribution is suppressed. */
export interface AuditProjectSummary {
  readonly project: AuditProject;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly manager: AuditPackageManager;
  readonly schema?: AuditSchemaId;
  readonly vulnerabilities: ReadonlyMap<string, AuditSeverity>;
  readonly advisories: readonly AuditAdvisory[];
  readonly failure?: {
    readonly reason: string;
    readonly detail: string;
  };
}

export interface AuditProjectFailure {
  readonly project?: AuditProject;
  readonly packageFilePaths: readonly string[];
  readonly manager?: AuditPackageManager;
  readonly reason: string;
  readonly detail: string;
}

export interface AuditReportSnapshot {
  readonly projects: readonly AuditProjectSummary[];
  readonly failures: readonly AuditProjectFailure[];
}

export interface AuditOrchestrationRequest {
  readonly packageFilePaths: readonly string[];
  readonly rows: readonly AuditableRow[];
  readonly signal: AbortSignal;
  /** Provider-owned operation and snapshot generation guard. */
  readonly isCurrent: () => boolean;
}

export type AuditOrchestrationResult
  = | {
    readonly kind: 'completed';
    readonly auditResults: ReadonlyMap<string, AuditSeverity>;
    readonly auditProjects: readonly AuditProjectSummary[];
    readonly auditFailures: readonly AuditProjectFailure[];
    readonly failedAuditPaths: readonly string[];
    readonly successfulAuditRootCount: number;
    readonly vulnerablePackageCount: number;
  }
  | { readonly kind: 'discarded'; readonly reason: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string; readonly detail: string };

export interface AuditOrchestrationDependencies extends AuditFileProbe {
  readonly checkCoordinator: OperationCoordinator;
  readonly resolveAuditProjects: (
    packageFilePaths: readonly string[],
  ) => Promise<Awaited<ReturnType<typeof resolveAuditProjects>>>;
  readonly createClient: (packageManager: PackageManager, projectRoot: string) => AuditableClient;
}

export interface AuditOrchestrationServiceContract {
  run(request: AuditOrchestrationRequest): Promise<AuditOrchestrationResult>;
}

/** Everything one run accumulates while folding per-project outcomes into the report. */
interface AuditFold {
  readonly auditResults: Map<string, AuditSeverity>;
  readonly auditProjects: AuditProjectSummary[];
  readonly auditFailures: AuditProjectFailure[];
  readonly failedAuditPaths: string[];
  successfulAuditRootCount: number;
}

const CANCELLED: AuditOrchestrationResult = { kind: 'discarded', reason: 'cancelled' };

function createDefaultDependencies(checkCoordinator: OperationCoordinator): AuditOrchestrationDependencies {
  const clientManager = new ClientManager();
  return {
    checkCoordinator,
    // Wrapped rather than passed by reference, so a caller mocking `../clients` without
    // this export only fails when the dependency is actually invoked.
    resolveAuditProjects: packageFilePaths => resolveAuditProjects(packageFilePaths),
    createClient: (packageManager, projectRoot) => clientManager.createClient(packageManager, projectRoot),
    realpath: targetPath => fsRealpath(targetPath),
    readPackageJsonVersion: packageJsonPath => readNodePackageJsonVersion(packageJsonPath),
  };
}

export function describeAuditFailure(error: unknown): { reason: string; detail: string } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      outcome?: { reason?: unknown; detail?: unknown };
      message?: unknown;
    };
    if (typeof candidate.outcome?.reason === 'string') {
      return {
        reason: candidate.outcome.reason,
        detail: typeof candidate.outcome.detail === 'string'
          ? candidate.outcome.detail
          : 'Audit did not produce a complete result.',
      };
    }
    if (typeof candidate.message === 'string') {
      return { reason: 'audit-failed', detail: candidate.message };
    }
  }
  return { reason: 'audit-failed', detail: String(error) };
}

export function cloneAuditProjectSummary(summary: AuditProjectSummary): AuditProjectSummary {
  return {
    ...summary,
    project: {
      ...summary.project,
      originManifests: [...summary.project.originManifests],
    },
    vulnerabilities: new Map(summary.vulnerabilities),
    advisories: summary.advisories.map(advisory => cloneAuditAdvisory(advisory)),
    failure: summary.failure === undefined ? undefined : { ...summary.failure },
  };
}

export function cloneAuditProjectFailure(failure: AuditProjectFailure): AuditProjectFailure {
  return {
    ...failure,
    project: failure.project === undefined
      ? undefined
      : {
          ...failure.project,
          originManifests: [...failure.project.originManifests],
        },
    packageFilePaths: [...failure.packageFilePaths],
  };
}

function countProjectVulnerablePackages(projects: readonly AuditProjectSummary[]): number {
  const packageNames = new Set<string>();
  for (const project of projects) {
    for (const packageName of project.vulnerabilities.keys()) {
      packageNames.add(packageName);
    }
  }
  return packageNames.size;
}

function recordProjectFailure(
  fold: AuditFold,
  project: AuditProject,
  failure: { reason: string; detail: string },
): void {
  fold.failedAuditPaths.push(...project.originManifests);
  fold.auditProjects.push({
    project,
    status: 'failure',
    manager: project.packageManager,
    vulnerabilities: new Map(),
    advisories: [],
    failure,
  });
  fold.auditFailures.push({
    project,
    packageFilePaths: [...project.originManifests],
    manager: project.packageManager,
    reason: failure.reason,
    detail: failure.detail,
  });
}

function isStale(request: AuditOrchestrationRequest): boolean {
  return !request.isCurrent() || request.signal.aborted;
}

/** Folds one project's outcome into `fold`; false when the run went stale while attributing rows. */
async function foldProjectOutcome(
  request: AuditOrchestrationRequest,
  dependencies: AuditOrchestrationDependencies,
  fold: AuditFold,
  project: AuditProject,
  outcome: RootOperationResult<ProjectAuditOutcome>,
): Promise<boolean> {
  if (outcome.status === 'cancelled') {
    return true;
  }
  if (outcome.status === 'failure') {
    recordProjectFailure(fold, project, describeAuditFailure(outcome.error));
    return true;
  }
  const { value } = outcome;
  if (value.kind === 'unrecognized') {
    recordProjectFailure(fold, project, describeAuditFailure(new Error('Audit client returned an unrecognized audit result.')));
    return true;
  }
  fold.successfulAuditRootCount += 1;
  if (value.kind === 'legacy') {
    fold.auditProjects.push({
      project,
      status: 'success',
      manager: project.packageManager,
      vulnerabilities: value.vulnerabilities,
      advisories: [],
    });
    applyLegacyProjectAuditResults(request.rows, project, value.vulnerabilities, fold.auditResults);
    return true;
  }
  const enrichedAdvisories = await enrichNpmV2AdvisoryVersions(project, value.advisories, dependencies);
  if (isStale(request)) {
    return false;
  }
  fold.auditProjects.push({
    project,
    status: 'success',
    manager: value.manager,
    schema: value.schema,
    vulnerabilities: new Map(value.vulnerabilities),
    advisories: enrichedAdvisories.map(advisory => cloneAuditAdvisory(advisory)),
  });
  await applyStructuredProjectAuditResults(request.rows, project, enrichedAdvisories, fold.auditResults, dependencies);
  return !isStale(request);
}

export class AuditOrchestrationService implements AuditOrchestrationServiceContract {
  constructor(private readonly dependencies: AuditOrchestrationDependencies) {}

  static withCoordinator(checkCoordinator: OperationCoordinator): AuditOrchestrationService {
    return new AuditOrchestrationService(createDefaultDependencies(checkCoordinator));
  }

  async run(request: AuditOrchestrationRequest): Promise<AuditOrchestrationResult> {
    try {
      if (isStale(request)) {
        return CANCELLED;
      }
      const { projects, rejected } = await this.dependencies.resolveAuditProjects(request.packageFilePaths);
      if (isStale(request)) {
        return CANCELLED;
      }

      const projectOutcomes = await runRootOperations(
        projects,
        project => project.projectRoot,
        this.dependencies.checkCoordinator,
        request.signal,
        (project, signal) => runProjectAudit(project, signal, this.dependencies.createClient),
      );
      if (isStale(request)) {
        return CANCELLED;
      }

      const fold: AuditFold = {
        auditResults: new Map(),
        auditProjects: [],
        auditFailures: rejected.map(rejection => ({
          packageFilePaths: [rejection.packageFilePath],
          reason: rejection.reason,
          detail: rejection.detail,
        })),
        failedAuditPaths: rejected.map(rejection => rejection.packageFilePath),
        successfulAuditRootCount: 0,
      };
      for (const [index, project] of projects.entries()) {
        if (!await foldProjectOutcome(request, this.dependencies, fold, project, projectOutcomes[index])) {
          return CANCELLED;
        }
      }
      if (isStale(request)) {
        return CANCELLED;
      }

      return {
        kind: 'completed',
        ...fold,
        vulnerablePackageCount: countProjectVulnerablePackages(fold.auditProjects),
      };
    }
    catch (err) {
      if (isStale(request)) {
        return CANCELLED;
      }
      const failure = describeAuditFailure(err);
      return { kind: 'failed', reason: failure.reason, detail: failure.detail };
    }
  }
}