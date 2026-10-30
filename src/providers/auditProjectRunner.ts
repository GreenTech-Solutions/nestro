import type { AuditProject, PackageManager } from '../clients';
import { isPackageManager } from '../shared';
import { mergeAuditAdvisories } from '../utils';
import type { AuditAdvisory, AuditPackageManager, AuditResult, AuditSchemaId, AuditSeverity } from '../utils';

/** A client capable of running one project's audit, structured or legacy Map-only. */
export interface AuditableClient {
  runAudit(signal?: AbortSignal): Promise<unknown>;
  runAuditReport?(signal?: AbortSignal): Promise<unknown>;
}

/** One project's raw audit call result, before it is folded into the report snapshot. */
export type ProjectAuditOutcome
  = | {
    readonly kind: 'structured';
    readonly manager: AuditPackageManager;
    readonly schema: AuditSchemaId;
    readonly vulnerabilities: ReadonlyMap<string, AuditSeverity>;
    readonly advisories: readonly AuditAdvisory[];
  }
  | { readonly kind: 'legacy'; readonly vulnerabilities: ReadonlyMap<string, AuditSeverity> }
  | { readonly kind: 'unrecognized' };

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
    && isPackageManager(candidate.manager)
    && isAuditSchemaId(candidate.schema);
}

export async function runProjectAudit(
  project: AuditProject,
  signal: AbortSignal,
  createClient: (packageManager: PackageManager, projectRoot: string) => AuditableClient,
): Promise<ProjectAuditOutcome> {
  const client = createClient(project.packageManager, project.projectRoot);
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