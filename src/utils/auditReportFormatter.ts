import * as path from 'node:path';
import * as vscode from 'vscode';
import { sanitizeAuditText } from './auditReport';
import type { AuditAdvisory, AuditFixAvailability } from './auditReport';
import { formatAdvisoryRows, formatPackageLevelFindings } from './localization';
import type { AuditProjectFailure, AuditProjectSummary } from '../providers';

/** Formats all project reports as plain text; package-controlled values never create lines. */
export function formatAuditReport(
  projects: readonly AuditProjectSummary[],
  failures: readonly AuditProjectFailure[] = [],
): string {
  if (projects.length === 0 && failures.length === 0) {
    return vscode.l10n.t('Nestro Security Audit Report\n\nNo audit results are available. Run “Run Security Audit” first.');
  }

  const lines = [vscode.l10n.t('Nestro Security Audit Report'), ''];
  if (projects.some(summary => summary.status === 'failure') || failures.length > 0) {
    lines.push(vscode.l10n.t('Overall status: Incomplete'), '');
  }
  projects.forEach((summary, index) => {
    const projectLabel = formatProjectLabel(summary);
    lines.push(vscode.l10n.t('Project {0}: {1}', index + 1, projectLabel));
    const manager = summary.schema === undefined
      ? safe(summary.manager)
      : vscode.l10n.t('{0} / {1}', safe(summary.manager), safe(summary.schema));
    lines.push(vscode.l10n.t('Manager: {0}', manager));
    lines.push(vscode.l10n.t(
      'Status: {0}',
      summary.status === 'success' ? getSuccessStatus(summary) : vscode.l10n.t('Incomplete'),
    ));
    if (summary.status === 'failure') {
      // Process detail may contain a cwd, lockfile content, stderr or registry
      // configuration. Preserve it in the provider snapshot for diagnostics, but do
      // not put it in the user-facing report.
      lines.push(vscode.l10n.t(
        'Failure: {0} (details redacted)',
        safe(summary.failure?.reason ?? 'audit-failed'),
      ));
    }
    if (summary.advisories.length === 0 && summary.status === 'success' && summary.vulnerabilities.size === 0) {
      lines.push(vscode.l10n.t('Advisories: none'));
    }
    else if (summary.advisories.length === 0 && summary.status === 'success') {
      lines.push(vscode.l10n.t(
        'Advisories: {0}; structured details unavailable',
        formatPackageLevelFindings(summary.vulnerabilities.size),
      ));
    }
    for (const advisory of summary.advisories) {
      appendAdvisory(lines, advisory, summary.project.projectRoot);
    }
    lines.push('');
  });
  const rejectedFailures = failures.filter(failure => failure.project === undefined);
  if (rejectedFailures.length > 0) {
    lines.push(vscode.l10n.t('Unassigned audit projects: {0} (details redacted)', rejectedFailures.length));
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
  lines.push(vscode.l10n.t('- {0} [{1}]', safe(advisory.packageName), safe(advisory.severity)));
  if (advisory.advisoryId !== undefined) {
    lines.push(vscode.l10n.t('  Advisory ID: {0}', safe(advisory.advisoryId)));
  }
  if (advisory.titles.length > 0) {
    lines.push(vscode.l10n.t('  Title: {0}', advisory.titles.map(safe).join(', ')));
  }
  const notProvided = vscode.l10n.t('not provided');
  lines.push(vscode.l10n.t('  Attribution: {0}', safe(advisory.attribution)));
  lines.push(vscode.l10n.t('  Affected range: {0}', advisory.affectedRanges.length === 0 ? notProvided : advisory.affectedRanges.map(safe).join(', ')));
  lines.push(vscode.l10n.t('  Resolved paths: {0}', advisory.resolvedPaths.length === 0 ? notProvided : advisory.resolvedPaths.map(value => formatResolvedPath(value, projectRoot)).join(', ')));
  lines.push(vscode.l10n.t('  Resolved/installed versions: {0}', advisory.resolvedVersions.length === 0 ? notProvided : advisory.resolvedVersions.map(safe).join(', ')));
  lines.push(vscode.l10n.t('  Via: {0}', advisory.via.length === 0 ? notProvided : advisory.via.map(via => safe(via.identity)).join(', ')));
  lines.push(vscode.l10n.t('  Fix available: {0}', formatFix(advisory.fixAvailable)));
  lines.push(vscode.l10n.t('  URL: {0}', advisory.urls.map(validateAdvisoryUrl).filter((url): url is string => url !== undefined).join(', ') || notProvided));
  if (advisory.sources.length > 0) {
    lines.push(vscode.l10n.t('  Source: {0}', advisory.sources.map(safe).join(', ')));
  }
}

function formatProjectLabel(summary: AuditProjectSummary): string {
  const root = summary.project.workspaceFolder;
  const relativeRoot = path.relative(root, summary.project.projectRoot).replace(/\\/g, '/');
  return safe(relativeRoot === ''
    ? vscode.l10n.t('(root)')
    : relativeRoot.startsWith('..') ? vscode.l10n.t('(external project)') : relativeRoot);
}

function getSuccessStatus(summary: AuditProjectSummary): string {
  if (summary.advisories.length > 0) {
    return formatAdvisoryRows(summary.advisories.length);
  }
  return summary.vulnerabilities.size === 0
    ? vscode.l10n.t('Clean')
    : vscode.l10n.t('Findings present (structured details unavailable)');
}

function formatFix(value: AuditFixAvailability | undefined): string {
  if (value === undefined) {
    return vscode.l10n.t('not provided');
  }
  if (typeof value === 'boolean') {
    return value ? vscode.l10n.t('yes') : vscode.l10n.t('no');
  }
  const target = [value.name, value.version].filter((part): part is string => part !== undefined).join('@');
  return target === ''
    ? vscode.l10n.t('available')
    : value.isSemVerMajor === true
      ? vscode.l10n.t('available (semver-major): {0}', safe(target))
      : vscode.l10n.t('available: {0}', safe(target));
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
    return safe(relative === '' || relative.startsWith('..') ? vscode.l10n.t('(outside project)') : relative);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('workspace:')) {
    return safe(vscode.l10n.t('{0} (virtual locator)', normalized));
  }
  const relative = path.posix.normalize(normalized);
  return safe(relative === '..'
    || relative.startsWith('../')
    || relative.startsWith('/')
    || relative.startsWith('~/')
    || /^[A-Za-z]:/.test(relative)
    ? vscode.l10n.t('(outside project)')
    : relative);
}