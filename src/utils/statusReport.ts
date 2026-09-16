import * as vscode from 'vscode';
import { sanitizeLogText } from './logger';

/** One failure captured by a package read, update check, or security audit. */
export interface StatusReportFailure {
  readonly packageFilePaths: readonly string[];
  readonly reason?: string;
  readonly detail?: string;
}

/** A stable, owner-qualified label for a package file used in diagnostics. */
export interface StatusReportFileLabel {
  readonly packageFilePath: string;
  readonly label: string;
  readonly order: number;
}

/** Immutable diagnostics snapshot rendered by the status-report command. */
export interface StatusReportSnapshot {
  readonly packageReadFailures: readonly StatusReportFailure[];
  readonly updateFailures: readonly StatusReportFailure[];
  readonly auditFailures: readonly StatusReportFailure[];
  readonly fileLabels: readonly StatusReportFileLabel[];
}

const MAX_DETAIL_LENGTH = 2000;
const FILE_URI_PATTERN = /\bfile:\/\/[^\s"'`<>(){}[\],;!?]+/giu;
const ABSOLUTE_PATH_PATTERN = /(^|[\s("'`=])((?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>(){}[\],;:!?]*)/g;
const REPORT_CREDENTIAL_PATTERN = /(\b(?:password|passwd|_password|_authToken|_auth|token|api-key|api_key|apikey)\b\s*[:=]\s*)\S+/giu;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:\\\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\\\\\)|\\\\[[0-?]*[ -/]*[@-~]|${String.fromCharCode(155)}[0-?]*[ -/]*[@-~])`,
  'g',
);

/** Formats read, update, and audit failures as bounded, plain-text diagnostics. */
export function formatStatusReport(snapshot: StatusReportSnapshot): string {
  const labels = [...snapshot.fileLabels]
    .sort((left, right) => left.order - right.order || compareText(left.label, right.label));
  const labelByPath = new Map(labels.map(label => [label.packageFilePath, sanitizeLabel(label.label)]));
  const orderByPath = new Map(labels.map(label => [label.packageFilePath, label.order]));
  const knownPaths = [...labelByPath.keys()].sort((left, right) => right.length - left.length);
  const lines = [vscode.l10n.t('Nestro Diagnostics Report'), ''];
  let hasFailures = false;

  hasFailures = appendFailureSection(
    lines,
    vscode.l10n.t('Package read failures'),
    snapshot.packageReadFailures,
    labelByPath,
    orderByPath,
    knownPaths,
  ) || hasFailures;
  hasFailures = appendFailureSection(
    lines,
    vscode.l10n.t('Update check failures'),
    snapshot.updateFailures,
    labelByPath,
    orderByPath,
    knownPaths,
  ) || hasFailures;
  hasFailures = appendFailureSection(
    lines,
    vscode.l10n.t('Security audit failures'),
    snapshot.auditFailures,
    labelByPath,
    orderByPath,
    knownPaths,
  ) || hasFailures;

  if (!hasFailures) {
    lines.push(vscode.l10n.t('No package operation failures are available.'));
  }
  return lines.join('\n').trimEnd();
}

function appendFailureSection(
  lines: string[],
  heading: string,
  failures: readonly StatusReportFailure[],
  labelByPath: ReadonlyMap<string, string>,
  orderByPath: ReadonlyMap<string, number>,
  knownPaths: readonly string[],
): boolean {
  if (failures.length === 0) {
    return false;
  }

  lines.push(heading, '');
  for (const failure of sortFailures(failures, labelByPath, orderByPath)) {
    const paths = failure.packageFilePaths.length === 0
      ? vscode.l10n.t('(workspace operation)')
      : failure.packageFilePaths
          .map(path => labelByPath.get(path) ?? vscode.l10n.t('(package file)'))
          .sort(compareText)
          .join(', ');
    const reason = failure.reason === undefined
      ? undefined
      : sanitizeReportText(failure.reason, labelByPath, knownPaths);
    const detail = failure.detail === undefined
      ? undefined
      : sanitizeReportText(failure.detail, labelByPath, knownPaths);
    lines.push(`- ${paths}`);
    if (reason !== undefined && reason !== '') {
      lines.push(vscode.l10n.t('  Reason: {0}', reason));
    }
    if (detail !== undefined && detail !== '') {
      lines.push(vscode.l10n.t('  Details: {0}', detail));
    }
  }
  lines.push('');
  return true;
}

function sortFailures(
  failures: readonly StatusReportFailure[],
  labelByPath: ReadonlyMap<string, string>,
  orderByPath: ReadonlyMap<string, number>,
): StatusReportFailure[] {
  return [...failures].sort((left, right) => (
    compareNumber(failureOrderKey(left, orderByPath), failureOrderKey(right, orderByPath))
    || compareText(failureSortKey(left, labelByPath), failureSortKey(right, labelByPath))
    || compareText(left.reason ?? '', right.reason ?? '')
    || compareText(left.detail ?? '', right.detail ?? '')
  ));
}

function failureOrderKey(
  failure: StatusReportFailure,
  orderByPath: ReadonlyMap<string, number>,
): number {
  return Math.min(...failure.packageFilePaths.map(path => orderByPath.get(path) ?? Number.MAX_SAFE_INTEGER));
}

function failureSortKey(
  failure: StatusReportFailure,
  labelByPath: ReadonlyMap<string, string>,
): string {
  return failure.packageFilePaths
    .map(path => labelByPath.get(path) ?? vscode.l10n.t('(package file)'))
    .sort(compareText)
    .join('\u0000');
}

function sanitizeReportText(
  value: string,
  labelByPath: ReadonlyMap<string, string>,
  knownPaths: readonly string[],
): string {
  let sanitized = sanitizeLogText(value)
    .replace(REPORT_CREDENTIAL_PATTERN, '$1[REDACTED]')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(FILE_URI_PATTERN, '[path]');
  // Replace paths captured by this report with their owner-qualified labels first;
  // unknown absolute paths are hidden rather than leaking local filesystem details.
  for (const packageFilePath of knownPaths) {
    const label = labelByPath.get(packageFilePath);
    if (label !== undefined && packageFilePath !== '') {
      sanitized = sanitized.split(packageFilePath).join(label);
    }
  }
  sanitized = sanitized.replace(ABSOLUTE_PATH_PATTERN, (_match, prefix: string, absolutePath: string) => {
    return `${prefix}${labelByPath.get(absolutePath) ?? '[path]'}`;
  });
  return sanitized.length <= MAX_DETAIL_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function sanitizeLabel(value: string): string {
  return sanitizeReportText(value, new Map(), []).replace(/[\\/]+/g, '/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}