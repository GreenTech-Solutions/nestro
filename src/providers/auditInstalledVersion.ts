import * as path from 'node:path';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { AUDIT_NODE_PACKAGE_JSON_MAX_BYTES } from '../config';
import type { AuditProject } from '../clients';
import { isPathWithin } from '../shared';
import type { AuditAdvisory } from '../utils';

/** Loose enough to accept a prerelease/build suffix; the exact major.minor.patch parser downstream still fail-closes on it. */
const PLAIN_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The file-system probes audit attribution needs, injectable so tests stay hermetic. */
export interface AuditFileProbe {
  readonly realpath: (targetPath: string) => Promise<string>;
  /** Bounded read of one `package.json`'s `version` field; `undefined` on any failure. */
  readonly readPackageJsonVersion: (packageJsonPath: string) => Promise<string | undefined>;
}

/**
 * Reads the `version` field of one installed `package.json`, bounded by file type, size and
 * JSON validity. Any failure — missing file, oversized file, malformed JSON, non-semver
 * version — resolves `undefined` rather than throwing, so a caller can fail closed uniformly.
 */
export async function readNodePackageJsonVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const stats = await fsStat(packageJsonPath);
    if (!stats.isFile() || stats.size > AUDIT_NODE_PACKAGE_JSON_MAX_BYTES) {
      return undefined;
    }
    const raw = await fsReadFile(packageJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const { version } = parsed as { version?: unknown };
    return typeof version === 'string' && PLAIN_SEMVER_PATTERN.test(version) ? version : undefined;
  }
  catch {
    return undefined;
  }
}

/** An immediate `node_modules/<name>` (or `node_modules/@scope/name`) node; a nested one is transitive. */
export function parseDirectNodeModulesNode(nodePath: string, packageName: string): string | undefined {
  const normalized = nodePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments[0] !== 'node_modules') {
    return undefined;
  }
  const rest = segments.slice(1);
  const isScoped = rest[0]?.startsWith('@') ?? false;
  if (rest.length !== (isScoped ? 2 : 1) || rest.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  const name = isScoped ? `${rest[0]}/${rest[1]}` : rest[0];
  return name === packageName ? normalized : undefined;
}

/**
 * Resolves the version at one advisory's single `nodes[]` entry, proving — by realpath, the
 * same check as `resolvedPathBelongsToManifest()` — that the read stays inside the project
 * root; any failure leaves the advisory's version unresolved.
 */
async function resolveInstalledVersionFromNode(
  project: AuditProject,
  packageName: string,
  nodePath: string,
  probe: AuditFileProbe,
): Promise<string | undefined> {
  const directNode = parseDirectNodeModulesNode(nodePath, packageName);
  if (directNode === undefined) {
    return undefined;
  }
  const candidatePath = path.join(project.projectRoot, directNode, 'package.json');
  try {
    const [canonicalProjectRoot, canonicalTarget] = await Promise.all([
      probe.realpath(project.projectRoot),
      probe.realpath(candidatePath),
    ]);
    if (!isPathWithin(canonicalProjectRoot, canonicalTarget)) {
      return undefined;
    }
    return await probe.readPackageJsonVersion(canonicalTarget);
  }
  catch {
    // Missing paths, broken symlinks, and other realpath failures do not constitute
    // ownership evidence; the advisory's version stays unresolved.
    return undefined;
  }
}

/**
 * Fills in the installed version for npm audit v2 advisories, whose schema exposes no
 * version field of its own. Only a schema-v2 advisory with no version yet and exactly one
 * `nodes[]` entry is eligible; every other schema and shape passes through unchanged.
 */
export function enrichNpmV2AdvisoryVersions(
  project: AuditProject,
  advisories: readonly AuditAdvisory[],
  probe: AuditFileProbe,
): Promise<AuditAdvisory[]> {
  // Memoized per call, not across runs: npm v2 gives one package several via-split
  // advisories sharing the same node, so this collapses their fs work to one read.
  const resolutionsByKey = new Map<string, Promise<string | undefined>>();
  const resolveVersionOnce = (packageName: string, nodePath: string): Promise<string | undefined> => {
    const key = `${project.projectRoot}\0${packageName}\0${nodePath}`;
    const cached = resolutionsByKey.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const pending = resolveInstalledVersionFromNode(project, packageName, nodePath, probe);
    resolutionsByKey.set(key, pending);
    return pending;
  };
  return Promise.all(advisories.map(async (advisory) => {
    if (advisory.schema !== 'npm-v2-vulnerabilities'
      || advisory.resolvedVersions.length > 0
      || advisory.resolvedPaths.length !== 1) {
      return advisory;
    }
    const version = await resolveVersionOnce(advisory.packageName, advisory.resolvedPaths[0]);
    return version === undefined ? advisory : { ...advisory, resolvedVersions: [version] };
  }));
}