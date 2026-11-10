import { uniqueStrings } from '../shared';
import type { StatusReportFailure, StatusReportFileLabel, StatusReportSnapshot } from '../utils';
import { getLocalizedPackageLabelFormatting, resolvePackageFileLabels } from './packageLabels';
import type { WorkspaceFolderDescriptor } from './packageLabels';
import type { AuditProjectFailure } from './auditOrchestrationService';

export interface StatusReportAssemblyInput {
  readonly packageReadFailures: readonly StatusReportFailure[];
  readonly updateFailures: readonly StatusReportFailure[];
  readonly auditFailures: readonly AuditProjectFailure[];
  readonly workspaceFolderDescriptors: readonly WorkspaceFolderDescriptor[];
}

/** Builds defensive report data without exposing mutable provider state. */
export function createStatusReportSnapshot(input: StatusReportAssemblyInput): StatusReportSnapshot {
  const packageReadFailures = input.packageReadFailures.map(cloneStatusReportFailure);
  const updateFailures = input.updateFailures.map(cloneStatusReportFailure);
  const auditFailures = input.auditFailures.map(failure => cloneStatusReportFailure({
    packageFilePaths: failure.packageFilePaths.length > 0
      ? failure.packageFilePaths
      : failure.project?.originManifests ?? [],
    reason: failure.reason,
    detail: failure.detail,
  }));
  const packageFilePaths = uniqueStrings([
    ...packageReadFailures.flatMap(failure => failure.packageFilePaths),
    ...updateFailures.flatMap(failure => failure.packageFilePaths),
    ...auditFailures.flatMap(failure => failure.packageFilePaths),
  ]);
  const fileLabels: StatusReportFileLabel[] = resolvePackageFileLabels(
    packageFilePaths,
    input.workspaceFolderDescriptors,
    getLocalizedPackageLabelFormatting(),
  ).map((entry, order) => ({
    packageFilePath: entry.packageFilePath,
    label: entry.owner.label,
    order,
  }));
  return { packageReadFailures, updateFailures, auditFailures, fileLabels };
}

export function createPackageReadFailureSnapshot(
  paths: readonly string[],
  details: readonly { readonly packageFilePath: string; readonly error: string }[] | undefined,
  discoveryFailed: boolean,
): StatusReportFailure[] {
  const detailByPath = new Map<string, string[]>();
  for (const failure of details ?? []) {
    const current = detailByPath.get(failure.packageFilePath) ?? [];
    current.push(failure.error);
    detailByPath.set(failure.packageFilePath, current);
  }
  for (const packageFilePath of paths) {
    if (!detailByPath.has(packageFilePath)) {
      detailByPath.set(packageFilePath, []);
    }
  }
  if (discoveryFailed && !detailByPath.has('')) {
    detailByPath.set('', ['Failed to discover workspace package files.']);
  }
  return [...detailByPath.entries()].map(([packageFilePath, errors]) => ({
    packageFilePaths: packageFilePath === '' ? [] : [packageFilePath],
    reason: packageFilePath === '' ? 'package-discovery-failed' : 'package-read-failed',
    detail: errors.length === 0 ? undefined : errors.join('; '),
  }));
}

export function createUpdateFailureSnapshot(
  paths: readonly string[],
  failures: readonly { readonly packageFilePath: string; readonly error: unknown }[],
): StatusReportFailure[] {
  const byPath = new Map<string, StatusReportFailure>();
  for (const failure of failures) {
    byPath.set(failure.packageFilePath, {
      packageFilePaths: [failure.packageFilePath],
      reason: 'update-check-failed',
      detail: formatFailureDetail(failure.error),
    });
  }
  for (const packageFilePath of uniqueStrings(paths)) {
    if (!byPath.has(packageFilePath)) {
      byPath.set(packageFilePath, {
        packageFilePaths: [packageFilePath],
        reason: 'update-check-failed',
      });
    }
  }
  return [...byPath.values()];
}

function cloneStatusReportFailure(failure: StatusReportFailure): StatusReportFailure {
  return {
    packageFilePaths: [...failure.packageFilePaths],
    reason: failure.reason,
    detail: failure.detail,
  };
}

function formatFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}