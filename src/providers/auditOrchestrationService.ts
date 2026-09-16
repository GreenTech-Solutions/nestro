import * as path from 'node:path';
import { realpath as fsRealpath } from 'node:fs/promises';
import { ClientManager, resolveAuditProjects } from '../clients';
import type { AuditProject, PackageManager } from '../clients';
import { cloneAuditAdvisory, inferPathAttribution, mergeAuditAdvisories, runRootOperations } from '../utils';
import type {
  AuditAdvisory,
  AuditPackageManager,
  AuditResult,
  AuditSchemaId,
  AuditSeverity,
  OperationCoordinator,
} from '../utils';
import { packageIdentityFromValues, packageIdentityKey } from './packageIdentity';

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

/** One provider row eligible for audit attribution, stripped of tree-item identity. */
export interface AuditableRow {
  readonly packageName: string;
  readonly packageFilePath: string;
  readonly dev: boolean;
  readonly currentVersion: string;
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

/** A client capable of running one project's audit, structured or legacy Map-only. */
export interface AuditableClient {
  runAudit(signal?: AbortSignal): Promise<unknown>;
  runAuditReport?(signal?: AbortSignal): Promise<unknown>;
}

export interface AuditOrchestrationDependencies {
  readonly checkCoordinator: OperationCoordinator;
  readonly resolveAuditProjects: (
    packageFilePaths: readonly string[],
  ) => Promise<Awaited<ReturnType<typeof resolveAuditProjects>>>;
  readonly createClient: (packageManager: PackageManager, projectRoot: string) => AuditableClient;
  readonly realpath: (targetPath: string) => Promise<string>;
}

export interface AuditOrchestrationServiceContract {
  run(request: AuditOrchestrationRequest): Promise<AuditOrchestrationResult>;
}

/** One project's raw audit call result, before it is folded into the report snapshot. */
type ProjectAuditOutcome
  = | {
    readonly kind: 'structured';
    readonly manager: AuditPackageManager;
    readonly schema: AuditSchemaId;
    readonly vulnerabilities: ReadonlyMap<string, AuditSeverity>;
    readonly advisories: readonly AuditAdvisory[];
  }
  | { readonly kind: 'legacy'; readonly vulnerabilities: ReadonlyMap<string, AuditSeverity> }
  | { readonly kind: 'unrecognized' };

function createDefaultDependencies(checkCoordinator: OperationCoordinator): AuditOrchestrationDependencies {
  const clientManager = new ClientManager();
  return {
    checkCoordinator,
    // Wrapped rather than passed by reference, so a caller mocking `../clients` without
    // this export only fails when the dependency is actually invoked.
    resolveAuditProjects: packageFilePaths => resolveAuditProjects(packageFilePaths),
    createClient: (packageManager, projectRoot) => clientManager.createClient(packageManager, projectRoot),
    realpath: targetPath => fsRealpath(targetPath),
  };
}

function auditRowKey(row: Pick<AuditableRow, 'packageName' | 'packageFilePath' | 'dev'>): string {
  return packageIdentityKey(packageIdentityFromValues(row.packageName, row.packageFilePath, row.dev));
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

function isAuditPackageManager(value: unknown): value is AuditPackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun';
}

function isAuditSchemaId(value: unknown): value is AuditSchemaId {
  return value === 'npm-v2-vulnerabilities'
    || value === 'npm-v1-advisories'
    || value === 'bun-bulk-advisory'
    || value === 'yarn-classic-audit'
    || value === 'yarn-modern-npm-audit';
}

function isAuditResult(value: unknown): value is AuditResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    vulnerabilities?: unknown;
    advisories?: unknown;
    manager?: unknown;
    schema?: unknown;
  };
  return candidate.vulnerabilities instanceof Map
    && Array.isArray(candidate.advisories)
    && isAuditPackageManager(candidate.manager)
    && isAuditSchemaId(candidate.schema);
}

async function runProjectAudit(
  project: AuditProject,
  signal: AbortSignal,
  dependencies: AuditOrchestrationDependencies,
): Promise<ProjectAuditOutcome> {
  const client = dependencies.createClient(project.packageManager, project.projectRoot);
  const rawResult = typeof client.runAuditReport === 'function'
    ? await client.runAuditReport(signal)
    : await client.runAudit(signal);
  if (isAuditResult(rawResult)) {
    return {
      kind: 'structured',
      manager: rawResult.manager,
      schema: rawResult.schema,
      vulnerabilities: new Map(rawResult.vulnerabilities),
      advisories: mergeAuditAdvisories(rawResult.advisories),
    };
  }
  if (rawResult instanceof Map) {
    return { kind: 'legacy', vulnerabilities: new Map(rawResult as Map<string, AuditSeverity>) };
  }
  return { kind: 'unrecognized' };
}

/** Legacy Map-only adapters retain the conservative single-manifest behavior. */
function applyLegacyProjectAuditResults(
  rows: readonly AuditableRow[],
  project: AuditProject,
  vulnerabilities: ReadonlyMap<string, AuditSeverity>,
  auditResults: Map<string, AuditSeverity>,
): void {
  if (project.originManifests.length !== 1) {
    return;
  }

  const [packageFilePath] = project.originManifests;
  for (const [packageName, severity] of vulnerabilities) {
    const matchingRows = rows.filter(row => (
      row.packageFilePath === packageFilePath && row.packageName === packageName
    ));
    if (matchingRows.length === 1) {
      const [matchingRow] = matchingRows;
      auditResults.set(auditRowKey(matchingRow), severity);
    }
  }
}

/** Attribute a row only when direct ownership and one manifest/section/version match are proven. */
async function applyStructuredProjectAuditResults(
  rows: readonly AuditableRow[],
  project: AuditProject,
  advisories: readonly AuditAdvisory[],
  auditResults: Map<string, AuditSeverity>,
  dependencies: AuditOrchestrationDependencies,
): Promise<void> {
  for (const advisory of advisories) {
    if (advisory.attribution !== 'direct'
      || advisory.resolvedPaths.length !== 1
      || advisory.resolvedVersions.length !== 1
      || advisory.affectedRanges.length === 0) {
      continue;
    }

    const resolvedPath = advisory.resolvedPaths[0];
    const resolvedVersion = advisory.resolvedVersions[0];
    const owningRows: AuditableRow[] = [];
    for (const row of rows) {
      if (row.packageName === advisory.packageName
        && await resolvedPathBelongsToManifest(
          resolvedPath,
          advisory.packageName,
          row.packageFilePath,
          project,
          dependencies,
        )) {
        owningRows.push(row);
      }
    }
    // Resolve ownership before checking versions. If the same manifest declares a
    // package in both sections, the audit has no authoritative section evidence;
    // choosing the row whose spec happens to match would create a false badge.
    if (owningRows.length !== 1) {
      continue;
    }
    const [match] = owningRows;
    if (matchesManifestVersion(match.currentVersion, resolvedVersion)
      && isVersionInAffectedRange(resolvedVersion, advisory.affectedRanges)) {
      auditResults.set(auditRowKey(match), advisory.severity);
    }
  }
}

async function resolvedPathBelongsToManifest(
  resolvedPath: string,
  packageName: string,
  packageFilePath: string,
  project: AuditProject,
  dependencies: AuditOrchestrationDependencies,
): Promise<boolean> {
  if (project.originManifests.length !== 1
    || resolvedPath.trim() === ''
    || resolvedPath.startsWith('workspace:')) {
    return false;
  }
  if (packageFilePath !== project.originManifests[0]
    || inferPathAttribution(packageName, [resolvedPath]) !== 'direct') {
    return false;
  }
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  const dependencySuffix = `/node_modules/${packageName.replace(/\\/g, '/')}`;

  // Relative or absolute resolved paths identify direct dependencies only in a
  // single-origin project; merged projects remain report-only.
  if (normalizedPath !== packageName && normalizedPath !== `node_modules/${packageName}`
    && !normalizedPath.endsWith(dependencySuffix)) {
    return false;
  }
  const absoluteResolvedPath = path.isAbsolute(resolvedPath)
    ? path.normalize(resolvedPath)
    : path.resolve(project.projectRoot, resolvedPath);
  try {
    const [canonicalProjectRoot, canonicalManifest, canonicalResolvedPath] = await Promise.all([
      dependencies.realpath(project.projectRoot),
      dependencies.realpath(packageFilePath),
      dependencies.realpath(absoluteResolvedPath),
    ]);
    return isWithinPath(canonicalManifest, canonicalProjectRoot)
      && isWithinPath(canonicalResolvedPath, canonicalProjectRoot);
  }
  catch {
    // Missing paths, broken symlinks, and other realpath failures do not constitute
    // ownership evidence. Keep the advisory in the project report only.
    return false;
  }
}

function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function matchesManifestVersion(spec: string, resolvedVersion: string): boolean {
  const resolved = parseVersion(resolvedVersion);
  if (resolved === undefined) {
    return false;
  }
  const normalizedSpec = spec.trim();
  const exact = parseVersion(normalizedSpec.replace(/^=/, ''));
  if (exact !== undefined) {
    return compareVersions(resolved, exact) === 0;
  }
  const operator = normalizedSpec[0];
  if (operator !== '^' && operator !== '~') {
    return false;
  }
  const base = parseVersion(normalizedSpec.slice(1));
  if (base === undefined || compareVersions(resolved, base) < 0) {
    return false;
  }
  if (operator === '~') {
    return resolved.major === base.major && resolved.minor === base.minor;
  }
  if (base.major > 0) {
    return resolved.major === base.major;
  }
  if (base.minor > 0) {
    return resolved.major === 0 && resolved.minor === base.minor;
  }
  return resolved.major === 0 && resolved.minor === 0 && resolved.patch === base.patch;
}

function isVersionInAffectedRange(version: string, ranges: readonly string[]): boolean {
  const parsedVersion = parseVersion(version);
  if (parsedVersion === undefined) {
    return false;
  }
  return ranges.some((range) => {
    const normalizedRange = range.trim();
    if (normalizedRange === '*' || normalizedRange === '') {
      return normalizedRange === '*';
    }
    if (normalizedRange.includes('||')) {
      return false;
    }
    const tokens = normalizedRange.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(token => matchesComparator(parsedVersion, token));
  });
}

function matchesComparator(version: ParsedVersion, token: string): boolean {
  const match = /^(<=|>=|<|>|=)?(\d+\.\d+\.\d+)$/.exec(token);
  if (match === null) {
    return false;
  }
  const expected = parseVersion(match[2]);
  if (expected === undefined) {
    return false;
  }
  const comparison = compareVersions(version, expected);
  switch (match[1] ?? '=') {
    case '<':
      return comparison < 0;
    case '<=':
      return comparison <= 0;
    case '>':
      return comparison > 0;
    case '>=':
      return comparison >= 0;
    default:
      return comparison === 0;
  }
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
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

export class AuditOrchestrationService implements AuditOrchestrationServiceContract {
  constructor(private readonly dependencies: AuditOrchestrationDependencies) {}

  static withCoordinator(checkCoordinator: OperationCoordinator): AuditOrchestrationService {
    return new AuditOrchestrationService(createDefaultDependencies(checkCoordinator));
  }

  async run(request: AuditOrchestrationRequest): Promise<AuditOrchestrationResult> {
    try {
      if (!request.isCurrent() || request.signal.aborted) {
        return { kind: 'discarded', reason: 'cancelled' };
      }
      const { projects, rejected } = await this.dependencies.resolveAuditProjects(request.packageFilePaths);
      if (!request.isCurrent() || request.signal.aborted) {
        return { kind: 'discarded', reason: 'cancelled' };
      }

      const auditResults = new Map<string, AuditSeverity>();
      const auditProjects: AuditProjectSummary[] = [];
      const auditFailures: AuditProjectFailure[] = rejected.map(rejection => ({
        packageFilePaths: [rejection.packageFilePath],
        reason: rejection.reason,
        detail: rejection.detail,
      }));
      const failedAuditPaths: string[] = rejected.map(rejection => rejection.packageFilePath);
      let successfulAuditRootCount = 0;

      const projectOutcomes = await runRootOperations(
        projects,
        project => project.projectRoot,
        this.dependencies.checkCoordinator,
        request.signal,
        (project, signal) => runProjectAudit(project, signal, this.dependencies),
      );

      if (!request.isCurrent() || request.signal.aborted) {
        return { kind: 'discarded', reason: 'cancelled' };
      }

      for (let index = 0; index < projects.length; index += 1) {
        const project = projects[index];
        const outcome = projectOutcomes[index];
        if (outcome.status === 'cancelled') {
          continue;
        }
        if (outcome.status === 'failure') {
          failedAuditPaths.push(...project.originManifests);
          const failure = describeAuditFailure(outcome.error);
          auditProjects.push({
            project,
            status: 'failure',
            manager: project.packageManager,
            vulnerabilities: new Map(),
            advisories: [],
            failure,
          });
          auditFailures.push({
            project,
            packageFilePaths: [...project.originManifests],
            manager: project.packageManager,
            reason: failure.reason,
            detail: failure.detail,
          });
          continue;
        }

        const { value } = outcome;
        if (value.kind === 'unrecognized') {
          failedAuditPaths.push(...project.originManifests);
          const failure = describeAuditFailure(new Error('Audit client returned an unrecognized audit result.'));
          auditProjects.push({
            project,
            status: 'failure',
            manager: project.packageManager,
            vulnerabilities: new Map(),
            advisories: [],
            failure,
          });
          auditFailures.push({
            project,
            packageFilePaths: [...project.originManifests],
            manager: project.packageManager,
            reason: failure.reason,
            detail: failure.detail,
          });
          continue;
        }
        if (value.kind === 'structured') {
          successfulAuditRootCount += 1;
          auditProjects.push({
            project,
            status: 'success',
            manager: value.manager,
            schema: value.schema,
            vulnerabilities: new Map(value.vulnerabilities),
            advisories: value.advisories.map(advisory => cloneAuditAdvisory(advisory)),
          });
          await applyStructuredProjectAuditResults(
            request.rows,
            project,
            value.advisories,
            auditResults,
            this.dependencies,
          );
          if (!request.isCurrent() || request.signal.aborted) {
            return { kind: 'discarded', reason: 'cancelled' };
          }
          continue;
        }
        successfulAuditRootCount += 1;
        auditProjects.push({
          project,
          status: 'success',
          manager: project.packageManager,
          vulnerabilities: value.vulnerabilities,
          advisories: [],
        });
        applyLegacyProjectAuditResults(request.rows, project, value.vulnerabilities, auditResults);
      }

      if (!request.isCurrent() || request.signal.aborted) {
        return { kind: 'discarded', reason: 'cancelled' };
      }

      return {
        kind: 'completed',
        auditResults,
        auditProjects,
        auditFailures,
        failedAuditPaths,
        successfulAuditRootCount,
        vulnerablePackageCount: countProjectVulnerablePackages(auditProjects),
      };
    }
    catch (err) {
      if (!request.isCurrent() || request.signal.aborted) {
        return { kind: 'discarded', reason: 'cancelled' };
      }
      const failure = describeAuditFailure(err);
      return { kind: 'failed', reason: failure.reason, detail: failure.detail };
    }
  }
}