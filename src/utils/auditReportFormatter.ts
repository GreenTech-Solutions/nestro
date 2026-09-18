import * as path from 'node:path';
import { sanitizeAuditText } from './auditReport';
import type { AuditAdvisory, AuditFixAvailability } from './auditReport';
import type { AuditProjectFailure, AuditProjectSummary } from '../providers';

/** Formats all project reports as plain text; package-controlled values never create lines. */
export function formatAuditReport(
  projects: readonly AuditProjectSummary[],
  failures: readonly AuditProjectFailure[] = [],
): string {
  if (projects.length === 0 && failures.length === 0) {
    return 'Nestro Security Audit Report\n\nNo audit results are available. Run “Run Security Audit” first.';
  }

  const lines = ['Nestro Security Audit Report', ''];
  if (projects.some(summary => summary.status === 'failure') || failures.length > 0) {
    lines.push('Overall status: Incomplete', '');
  }
  projects.forEach((summary, index) => {
    const projectLabel = formatProjectLabel(summary);
    lines.push(`Project ${index + 1}: ${projectLabel}`);
    lines.push(`Manager: ${safe(summary.manager)}${summary.schema === undefined ? '' : ` / ${safe(summary.schema)}`}`);
    lines.push(`Status: ${summary.status === 'success' ? getSuccessStatus(summary) : 'Incomplete'}`);
    if (summary.status === 'failure') {
      // Process detail may contain a cwd, lockfile content, stderr or registry
      // configuration. Preserve it in the provider snapshot for diagnostics, but do
      // not put it in the user-facing report.
      lines.push(`Failure: ${safe(summary.failure?.reason ?? 'audit-failed')} (details redacted)`);
    }
    if (summary.advisories.length === 0 && summary.status === 'success' && summary.vulnerabilities.size === 0) {
      lines.push('Advisories: none');
    }
    else if (summary.advisories.length === 0 && summary.status === 'success') {
      lines.push(`Advisories: ${summary.vulnerabilities.size} package-level finding(s); structured details unavailable`);
    }
    for (const advisory of summary.advisories) {
      appendAdvisory(lines, advisory, summary.project.projectRoot);
    }
    lines.push('');
  });
  const rejectedFailures = failures.filter(failure => failure.project === undefined);
  if (rejectedFailures.length > 0) {
    lines.push(`Unassigned audit projects: ${rejectedFailures.length} (details redacted)`);
  }
  return lines.join('\n').trimEnd();
}

/** Allows only explicit HTTP(S) advisory URLs before any future URI/openExternal action. */
export function validateAdvisoryUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (sanitizeAuditText(value, Number.MAX_SAFE_INTEGER) !== value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      ? sanitizeInline(parsed.toString())
      : undefined;
  }
  catch {
    return undefined;
  }
}

function appendAdvisory(lines: string[], advisory: AuditAdvisory, projectRoot: string): void {
  lines.push(`- ${safe(advisory.packageName)} [${safe(advisory.severity)}]`);
  if (advisory.advisoryId !== undefined) {
    lines.push(`  Advisory ID: ${safe(advisory.advisoryId)}`);
  }
  if (advisory.titles.length > 0) {
    lines.push(`  Title: ${advisory.titles.map(safe).join(', ')}`);
  }
  lines.push(`  Attribution: ${safe(advisory.attribution)}`);
  lines.push(`  Affected range: ${advisory.affectedRanges.length === 0 ? 'not provided' : advisory.affectedRanges.map(safe).join(', ')}`);
  lines.push(`  Resolved path(s): ${advisory.resolvedPaths.length === 0 ? 'not provided' : advisory.resolvedPaths.map(value => formatResolvedPath(value, projectRoot)).join(', ')}`);
  lines.push(`  Resolved/installed version(s): ${advisory.resolvedVersions.length === 0 ? 'not provided' : advisory.resolvedVersions.map(safe).join(', ')}`);
  lines.push(`  Via: ${advisory.via.length === 0 ? 'not provided' : advisory.via.map(via => safe(via.identity)).join(', ')}`);
  lines.push(`  Fix available: ${formatFix(advisory.fixAvailable)}`);
  lines.push(`  URL: ${advisory.urls.map(validateAdvisoryUrl).filter((url): url is string => url !== undefined).join(', ') || 'not provided'}`);
  if (advisory.sources.length > 0) {
    lines.push(`  Source: ${advisory.sources.map(safe).join(', ')}`);
  }
}

function formatProjectLabel(summary: AuditProjectSummary): string {
  const root = summary.project.workspaceFolder;
  const relativeRoot = path.relative(root, summary.project.projectRoot).replace(/\\/g, '/');
  return safe(relativeRoot === '' ? '(root)' : relativeRoot.startsWith('..') ? '(external project)' : relativeRoot);
}

function getSuccessStatus(summary: AuditProjectSummary): string {
  if (summary.advisories.length > 0) {
    return `${summary.advisories.length} advisory row(s)`;
  }
  return summary.vulnerabilities.size === 0 ? 'Clean' : 'Findings present (structured details unavailable)';
}

function formatFix(value: AuditFixAvailability | undefined): string {
  if (value === undefined) {
    return 'not provided';
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  const target = [value.name, value.version].filter((part): part is string => part !== undefined).join('@');
  return target === ''
    ? 'available'
    : `available${value.isSemVerMajor === true ? ' (semver-major)' : ''}: ${safe(target)}`;
}

function safe(value: string): string {
  return sanitizeInline(sanitizeAuditText(value));
}

function sanitizeInline(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '');
}

function formatResolvedPath(value: string, projectRoot: string): string {
  if (path.isAbsolute(value)) {
    const relative = path.relative(projectRoot, value).replace(/\\/g, '/');
    return safe(relative === '' || relative.startsWith('..') ? '(outside project)' : relative);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('workspace:')) {
    return safe(`${normalized} (virtual locator)`);
  }
  const relative = path.posix.normalize(normalized);
  return safe(relative === '..'
    || relative.startsWith('../')
    || relative.startsWith('/')
    || relative.startsWith('~/')
    || /^[A-Za-z]:/.test(relative)
    ? '(outside project)'
    : relative);
}