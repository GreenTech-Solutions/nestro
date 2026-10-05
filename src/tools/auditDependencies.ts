/**
 * `audit:dependencies` gate: advisories in the shipped (production) graph block at moderate,
 * advisories anywhere block at critical, and every other advisory is reported as a warning.
 */
import type { SignatureAuditExecution } from './auditSignatures';

/** Production-only audit: the dependencies bundled into the shipped extension. */
export const PRODUCTION_AUDIT_ARGS = ['audit', '--prod', '--json'] as const;

/** Full-graph audit: production plus development tooling. */
export const FULL_AUDIT_ARGS = ['audit', '--json'] as const;

export type AuditSeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

const SEVERITY_RANK: Readonly<Record<AuditSeverity, number>> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

/** Lowest severity that blocks when the advisory reaches a production dependency. */
export const PRODUCTION_BLOCKING_SEVERITY: AuditSeverity = 'moderate';

/** Lowest severity that blocks anywhere in the graph, development tooling included. */
export const GRAPH_BLOCKING_SEVERITY: AuditSeverity = 'critical';

/** Same normalized process result the signature audit uses. */
export type DependencyAuditExecution = SignatureAuditExecution;

export type DependencyScope = 'production' | 'development';

export interface DependencyAdvisory {
  /** pnpm's report key; one GHSA can span several entries, one per package or version range. */
  readonly key: string;
  readonly id: string;
  readonly moduleName: string;
  readonly severity: AuditSeverity;
  readonly title: string;
  readonly url: string;
  readonly vulnerableVersions: string;
  readonly installedVersions: readonly string[];
}

export interface ScopedDependencyAdvisory extends DependencyAdvisory {
  readonly scope: DependencyScope;
}

/** Why a run must not be read as an audit result. */
export type DependencyAuditRejectionReason
  = | 'process-failed'
    | 'empty-output'
    | 'malformed-json'
    | 'audit-error'
    | 'unrecognized-schema'
    | 'unexpected-exit';

export interface DependencyAuditRejectedOutcome {
  readonly kind: 'rejected';
  readonly reason: DependencyAuditRejectionReason;
  readonly detail: string;
}

export interface DependencyAuditVerdictOutcome {
  readonly kind: 'passed' | 'failed';
  readonly blocking: readonly ScopedDependencyAdvisory[];
  readonly warnings: readonly ScopedDependencyAdvisory[];
}

export type DependencyAuditOutcome = DependencyAuditVerdictOutcome | DependencyAuditRejectedOutcome;

export interface DependencyAuditReport {
  readonly kind: 'report';
  readonly advisories: readonly DependencyAdvisory[];
}

export interface DependencyAuditCliDependencies {
  /** Runs `pnpm` with the given arguments without throwing on a failed audit. */
  readonly runAudit: (args: readonly string[]) => Promise<DependencyAuditExecution>;
  readonly writeOut: (line: string) => void;
  readonly writeError: (line: string) => void;
  /** Emits warnings as GitHub Actions `::warning` workflow commands. */
  readonly githubActions: boolean;
}

/** Rejects any argument: the gate takes none, and a typo must not silently change the run. */
export function parseDependencyAuditArgs(argv: readonly string[]): void {
  if (argv.length > 0) {
    throw new Error(`Unknown argument: ${argv[0]}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is AuditSeverity {
  return typeof value === 'string' && Object.hasOwn(SEVERITY_RANK, value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : `; stderr: ${trimmed}`;
}

/** Registry text is untrusted: control characters must not forge log lines or workflow commands. */
function sanitize(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll(/[\u0000-\u001F\u007F]+/g, ' ').trim() : '';
}

function reject(reason: DependencyAuditRejectionReason, detail: string): DependencyAuditRejectedOutcome {
  return { kind: 'rejected', reason, detail };
}

function parseAdvisory(key: string, value: unknown): DependencyAdvisory | undefined {
  if (!isPlainObject(value) || !isSeverity(value.severity) || typeof value.module_name !== 'string') {
    return undefined;
  }
  const findings = Array.isArray(value.findings) ? value.findings : [];
  const installedVersions = [...new Set(findings.flatMap(finding =>
    isPlainObject(finding) && typeof finding.version === 'string' ? [sanitize(finding.version)] : []))];
  return {
    key: sanitize(key),
    id: sanitize(value.github_advisory_id) || sanitize(key),
    moduleName: sanitize(value.module_name),
    severity: value.severity,
    title: sanitize(value.title),
    url: sanitize(value.url),
    vulnerableVersions: sanitize(value.vulnerable_versions),
    installedVersions,
  };
}

/** Parses one `pnpm audit --json` run; any shape other than a complete advisory report is a rejection. */
export function parseDependencyAuditReport(
  execution: DependencyAuditExecution,
): DependencyAuditReport | DependencyAuditRejectedOutcome {
  const { command, exitCode, stderr, stdout } = execution;
  if (exitCode === undefined) {
    return reject('process-failed', `${command} never reported an exit code${describeStderr(stderr)}`);
  }

  const output = stdout.trim();
  if (output === '') {
    return reject('empty-output', `${command} wrote no report to stdout (exit code ${exitCode})${describeStderr(stderr)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(output);
  }
  catch (error) {
    return reject('malformed-json', `${command} wrote stdout that is not JSON (exit code ${exitCode}): ${describeError(error)}`);
  }

  if (isPlainObject(json) && isPlainObject(json.error)) {
    return reject('audit-error', `${command} failed (exit code ${exitCode}): ${sanitize(json.error.message) || '<no message>'}`);
  }

  if (!isPlainObject(json) || !isPlainObject(json.advisories) || !isPlainObject(json.metadata)
    || !isPlainObject(json.metadata.vulnerabilities)) {
    return reject('unrecognized-schema', `${command} returned JSON that is not a pnpm advisory report (exit code ${exitCode})`);
  }

  const advisories: DependencyAdvisory[] = [];
  for (const [key, value] of Object.entries(json.advisories)) {
    const advisory = parseAdvisory(key, value);
    if (advisory === undefined) {
      return reject('unrecognized-schema', `${command} returned advisory ${sanitize(key)} without a known severity and module name`);
    }
    advisories.push(advisory);
  }

  const counted = Object.values(json.metadata.vulnerabilities).some(count => typeof count === 'number' && count > 0);
  if (advisories.length === 0 && counted) {
    return reject('unrecognized-schema', `${command} counted vulnerabilities in its summary but listed no advisory (exit code ${exitCode})`);
  }

  // pnpm exits 0 with no advisory and 0 or 1 with some, depending on their severity.
  if ((advisories.length === 0 && exitCode !== 0) || exitCode > 1 || exitCode < 0) {
    return reject('unexpected-exit', `${command} reported ${advisories.length} advisory(ies) but exited with code ${exitCode}${describeStderr(stderr)}`);
  }
  return { kind: 'report', advisories };
}

function isAtLeast(severity: AuditSeverity, floor: AuditSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

function bySeverityThenName(left: ScopedDependencyAdvisory, right: ScopedDependencyAdvisory): number {
  return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    || left.moduleName.localeCompare(right.moduleName)
    || left.id.localeCompare(right.id)
    || left.key.localeCompare(right.key);
}

/** Splits both audits into blocking advisories and warnings; an entry seen in production is scoped there. */
export function evaluateDependencyAudit(
  production: DependencyAuditExecution,
  full: DependencyAuditExecution,
): DependencyAuditOutcome {
  const productionReport = parseDependencyAuditReport(production);
  if (productionReport.kind === 'rejected') {
    return productionReport;
  }
  const fullReport = parseDependencyAuditReport(full);
  if (fullReport.kind === 'rejected') {
    return fullReport;
  }

  const scoped = new Map<string, ScopedDependencyAdvisory>();
  for (const advisory of productionReport.advisories) {
    scoped.set(advisory.key, { ...advisory, scope: 'production' });
  }
  for (const advisory of fullReport.advisories) {
    if (!scoped.has(advisory.key)) {
      scoped.set(advisory.key, { ...advisory, scope: 'development' });
    }
  }

  const blocking: ScopedDependencyAdvisory[] = [];
  const warnings: ScopedDependencyAdvisory[] = [];
  for (const advisory of scoped.values()) {
    const blocks = isAtLeast(advisory.severity, GRAPH_BLOCKING_SEVERITY)
      || (advisory.scope === 'production' && isAtLeast(advisory.severity, PRODUCTION_BLOCKING_SEVERITY));
    (blocks ? blocking : warnings).push(advisory);
  }
  blocking.sort(bySeverityThenName);
  warnings.sort(bySeverityThenName);
  return { kind: blocking.length > 0 ? 'failed' : 'passed', blocking, warnings };
}

/** One-line description shared by blocking and warning output. */
export function describeDependencyAdvisory(advisory: ScopedDependencyAdvisory): string {
  const installed = advisory.installedVersions.length > 0 ? ` (installed ${advisory.installedVersions.join(', ')})` : '';
  const title = advisory.title === '' ? '' : ` — ${advisory.title}`;
  const url = advisory.url === '' ? '' : ` ${advisory.url}`;
  return `${advisory.severity} ${advisory.scope} advisory ${advisory.id}: `
    + `${advisory.moduleName} ${advisory.vulnerableVersions}${installed}${title}${url}`;
}

/** Escapes a workflow-command message the way the GitHub Actions runner decodes it. */
function escapeWorkflowCommandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Warnings go to stdout ahead of the verdict; blocking advisories and rejections go to stderr. */
export async function runDependencyAuditCli(
  argv: readonly string[],
  deps: DependencyAuditCliDependencies,
): Promise<number> {
  let outcome: DependencyAuditOutcome;
  try {
    parseDependencyAuditArgs(argv);
    const production = await deps.runAudit(PRODUCTION_AUDIT_ARGS);
    const full = await deps.runAudit(FULL_AUDIT_ARGS);
    outcome = evaluateDependencyAudit(production, full);
  }
  catch (error) {
    deps.writeError(`Dependency audit failed: ${describeError(error)}`);
    return 1;
  }

  if (outcome.kind === 'rejected') {
    deps.writeError(`Dependency audit failed [${outcome.reason}]: ${outcome.detail}`);
    return 1;
  }

  for (const advisory of outcome.warnings) {
    const line = describeDependencyAdvisory(advisory);
    deps.writeOut(deps.githubActions
      ? `::warning title=Dependency audit::${escapeWorkflowCommandData(line)}`
      : `warning: ${line}`);
  }

  if (outcome.kind === 'failed') {
    for (const advisory of outcome.blocking) {
      deps.writeError(`Dependency audit failed: ${describeDependencyAdvisory(advisory)}`);
    }
    deps.writeError(
      `${outcome.blocking.length} blocking advisory(ies): production dependencies block at `
      + `${PRODUCTION_BLOCKING_SEVERITY}, every dependency blocks at ${GRAPH_BLOCKING_SEVERITY}`,
    );
    return 1;
  }

  deps.writeOut(`No blocking advisory; ${outcome.warnings.length} advisory(ies) reported as warnings`);
  return 0;
}