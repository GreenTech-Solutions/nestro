import type { PackageManager } from '../../shared';

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';
export type AuditPackageManager = PackageManager;

/**
 * Audit JSON schemas recognized by the manager-specific adapters. The shared parser in
 * `auditClient.ts` still recognizes only npm/pnpm shapes; Bun owns its bulk-advisory adapter.
 */
export type AuditSchemaId
  = | 'npm-v2-vulnerabilities'
    | 'npm-v1-advisories'
    | 'bun-bulk-advisory'
    | 'yarn-classic-audit'
    | 'yarn-modern-npm-audit';

/** Severities from worst to least severe. */
export const SEVERITY_ORDER: readonly AuditSeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];

/** Yarn Classic `audit` exit-code bit per severity. */
export const YARN_CLASSIC_SEVERITY_BITS: Readonly<Record<AuditSeverity, number>> = {
  info: 1,
  low: 2,
  moderate: 4,
  high: 8,
  critical: 16,
};

/** Negative when `left` is worse than `right`. */
export function compareSeverity(left: AuditSeverity, right: AuditSeverity): number {
  return SEVERITY_ORDER.indexOf(left) - SEVERITY_ORDER.indexOf(right);
}

export function mergeSeverity(left: AuditSeverity, right: AuditSeverity): AuditSeverity {
  return compareSeverity(left, right) <= 0 ? left : right;
}

export function parseSeverity(value: string | undefined): AuditSeverity | undefined {
  return SEVERITY_ORDER.find(severity => severity === value);
}

export function emptySeverityCounts(): Record<AuditSeverity, number> {
  const counts = {} as Record<AuditSeverity, number>;
  for (const severity of SEVERITY_ORDER) {
    counts[severity] = 0;
  }
  return counts;
}