import { PackageItem, type PackageOperation } from '../../providers';
import type { AuditSeverity, ReleaseAgeState, UpdateType } from '../../utils';

export interface BuildPackageItemOptions {
  readonly name: string;
  readonly currentVersion: string;
  readonly latest?: string;
  readonly updateType?: UpdateType;
  readonly operation?: PackageOperation | boolean;
  readonly vulnerabilitySeverity?: AuditSeverity;
  readonly packageFilePath?: string;
  readonly dev?: boolean;
  readonly versionPrefix?: string;
  readonly releaseAge?: ReleaseAgeState;
  readonly workspaceOwner?: string;
}

export function buildPackageItem({
  name,
  currentVersion,
  latest,
  updateType = 'none',
  operation,
  vulnerabilitySeverity,
  packageFilePath = '/workspace/package.json',
  dev = false,
  versionPrefix = '',
  releaseAge = { kind: 'accepted' },
  workspaceOwner,
}: BuildPackageItemOptions): PackageItem {
  return new PackageItem(
    name,
    currentVersion,
    latest,
    updateType,
    operation,
    vulnerabilitySeverity,
    packageFilePath,
    dev,
    versionPrefix,
    releaseAge,
    workspaceOwner,
  );
}