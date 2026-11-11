import * as path from 'node:path';
import type { AuditProject } from '../clients';
import { isPathWithin, WORKSPACE_PROTOCOL } from '../shared';
import { inferPathAttribution, mergeSeverity } from '../utils';
import type { AuditAdvisory, AuditSeverity } from '../utils';
import type { AuditFileProbe } from './auditInstalledVersion';
import { isVersionInAffectedRange, matchesManifestVersion } from './auditVersionMatching';
import { packageIdentityFromValues, packageIdentityKey } from './packageIdentity';

/** One provider row eligible for audit attribution, stripped of tree-item identity. */
export interface AuditableRow {
  readonly packageName: string;
  readonly packageFilePath: string;
  readonly dev: boolean;
  readonly currentVersion: string;
}

/** Attribute a row only when direct ownership and one manifest/section/version match are proven. */
export async function applyStructuredProjectAuditResults(
  rows: readonly AuditableRow[],
  project: AuditProject,
  advisories: readonly AuditAdvisory[],
  auditResults: Map<string, AuditSeverity>,
  probe: AuditFileProbe,
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
          probe,
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
      // A package can own several proven advisories (npm v2 splits one package's report
      // into one advisory per `via` entry); the row badge must show the worst of them,
      // not whichever advisory happened to be attributed last.
      const key = packageIdentityKey(packageIdentityFromValues(
        match.packageName,
        match.packageFilePath,
        match.dev,
      ));
      const existing = auditResults.get(key);
      auditResults.set(key, existing === undefined ? advisory.severity : mergeSeverity(existing, advisory.severity));
    }
  }
}

async function resolvedPathBelongsToManifest(
  resolvedPath: string,
  packageName: string,
  packageFilePath: string,
  project: AuditProject,
  probe: AuditFileProbe,
): Promise<boolean> {
  if (project.originManifests.length !== 1
    || resolvedPath.trim() === ''
    || resolvedPath.startsWith(WORKSPACE_PROTOCOL)) {
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
      probe.realpath(project.projectRoot),
      probe.realpath(packageFilePath),
      probe.realpath(absoluteResolvedPath),
    ]);
    return isPathWithin(canonicalProjectRoot, canonicalManifest)
      && isPathWithin(canonicalProjectRoot, canonicalResolvedPath);
  }
  catch {
    // Missing paths, broken symlinks, and other realpath failures do not constitute
    // ownership evidence. Keep the advisory in the project report only.
    return false;
  }
}