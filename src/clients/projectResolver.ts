import * as path from 'path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PackageJsonManifest {
  packageManager?: string;
}

interface LockfileDescriptor {
  fileName: string;
  pattern: string;
  packageManager: PackageManager;
}

/**
 * Lock file precedence used everywhere a directory is checked for a package-manager
 * signal: pnpm, then Yarn, then Bun, then npm. The first match wins.
 */
const LOCKFILES: readonly LockfileDescriptor[] = [
  { fileName: 'pnpm-lock.yaml', pattern: '**/pnpm-lock.yaml', packageManager: 'pnpm' },
  { fileName: 'yarn.lock', pattern: '**/yarn.lock', packageManager: 'yarn' },
  { fileName: 'bun.lock', pattern: '**/bun.lock', packageManager: 'bun' },
  { fileName: 'bun.lockb', pattern: '**/bun.lockb', packageManager: 'bun' },
  { fileName: 'package-lock.json', pattern: '**/package-lock.json', packageManager: 'npm' },
  { fileName: 'npm-shrinkwrap.json', pattern: '**/npm-shrinkwrap.json', packageManager: 'npm' },
];

const packageManagerNames: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** One ancestor-directory package-manager signal: a `packageManager` field or a lock file. */
export interface PackageManagerSignal {
  packageManager: PackageManager;
  /** Directory the signal was found in. */
  signalRoot: string;
  /** Lock file name the signal matched, when the signal came from a lock file. */
  lockfileFileName: string | undefined;
}

export type AuditProjectRejectionReason
  = | 'no-owning-workspace'
    | 'workspace-escape'
    | 'unresolvable-path'
    | 'cross-workspace-collision';

export interface RejectedAuditManifest {
  readonly packageFilePath: string;
  readonly reason: AuditProjectRejectionReason;
  readonly detail: string;
}

export interface AuditProject {
  /** Canonical (symlink-resolved) directory the audit command runs from. */
  readonly projectRoot: string;
  /** Workspace folder that owns this project, as VS Code reports it (not canonicalized). */
  readonly workspaceFolder: string;
  readonly packageManager: PackageManager;
  /** Absolute path to the lock file backing this project graph, when one was found. */
  readonly lockfilePath: string | undefined;
  /** Every input package.json whose dependency graph resolves to this project, sorted. */
  readonly originManifests: readonly string[];
}

export interface AuditProjectResolution {
  readonly projects: readonly AuditProject[];
  readonly rejected: readonly RejectedAuditManifest[];
}

export function parsePackageManager(value: string | undefined): PackageManager | undefined {
  return packageManagerNames.find(name => name === value);
}

export async function detectPackageManagerFromManifest(cwd: string | undefined): Promise<PackageManager | undefined> {
  if (cwd !== undefined) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, 'package.json')));
      const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as PackageJsonManifest;
      const packageManager = manifest.packageManager?.split('@')[0];
      return parsePackageManager(packageManager);
    }
    catch {
      return undefined;
    }
  }

  const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1);
  if (files.length === 0) {
    return undefined;
  }

  const raw = await vscode.workspace.fs.readFile(files[0]);
  const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as PackageJsonManifest;
  const packageManager = manifest.packageManager?.split('@')[0];
  return parsePackageManager(packageManager);
}

async function detectLockfileSignalInDirectory(cwd: string): Promise<{ packageManager: PackageManager; fileName: string } | undefined> {
  for (const lockfile of LOCKFILES) {
    try {
      await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, lockfile.fileName)));
      return { packageManager: lockfile.packageManager, fileName: lockfile.fileName };
    }
    catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Workspace-wide lock file scan used only when no `cwd` is known at all (e.g. no
 * workspace folder is open yet). Every caller that has a `cwd` resolves an ancestor
 * signal through `detectPackageManagerSignalFromAncestors()` instead, which is why this
 * never takes a `cwd` parameter of its own.
 */
export async function detectPackageManagerFromLockfile(): Promise<PackageManager | undefined> {
  for (const lockfile of LOCKFILES) {
    const files = await vscode.workspace.findFiles(lockfile.pattern, '**/node_modules/**', 1);
    if (files.length > 0) {
      return lockfile.packageManager;
    }
  }
  return undefined;
}

async function detectPackageManagerSignalAt(cwd: string): Promise<{ packageManager: PackageManager; lockfileFileName: string | undefined } | undefined> {
  const fromManifest = await detectPackageManagerFromManifest(cwd);
  if (fromManifest !== undefined) {
    return { packageManager: fromManifest, lockfileFileName: undefined };
  }

  const fromLockfile = await detectLockfileSignalInDirectory(cwd);
  if (fromLockfile !== undefined) {
    return { packageManager: fromLockfile.packageManager, lockfileFileName: fromLockfile.fileName };
  }

  return undefined;
}

/**
 * Walks from `cwd` up to (and including) `workspaceFolderPath`, checking the
 * `packageManager` field before any lock file at each level, and returns the first
 * signal found. Used both to pick a client's cwd (`ClientManager`) and to resolve the
 * canonical audit project root below.
 */
export async function detectPackageManagerSignalFromAncestors(
  cwd: string,
  workspaceFolderPath: string | undefined,
): Promise<PackageManagerSignal | undefined> {
  for (const directory of getAncestorDirectories(cwd, workspaceFolderPath)) {
    const signal = await detectPackageManagerSignalAt(directory);
    if (signal !== undefined) {
      return { packageManager: signal.packageManager, signalRoot: directory, lockfileFileName: signal.lockfileFileName };
    }
  }
  return undefined;
}

function getAncestorDirectories(cwd: string, workspaceFolderPath: string | undefined): string[] {
  if (workspaceFolderPath === undefined) {
    return [cwd];
  }

  const normalizedCwd = path.resolve(cwd);
  const normalizedWorkspaceFolderPath = path.resolve(workspaceFolderPath);
  const relativePath = path.relative(normalizedWorkspaceFolderPath, normalizedCwd);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return [];
  }

  const directories: string[] = [];
  let current = normalizedCwd;
  while (true) {
    directories.push(current);
    if (current === normalizedWorkspaceFolderPath) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}

function isPathContained(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

type CanonicalRootResult
  = | { ok: true; root: string; workspaceFolder: string }
    // Two distinct failure causes, kept apart so callers never label an unreadable path
    // (a broken symlink, ELOOP, a permissions error) as a proven symlink escape (N4):
    // `unresolvable-path` means `realpath` itself failed; `workspace-escape` means it
    // succeeded but the resolved path is provably outside the workspace.
    | { ok: false; reason: 'unresolvable-path' | 'workspace-escape' };

/**
 * Resolves `candidateDir` to its real (symlink-free) path and confirms it stays inside
 * the real path of `workspaceFolderPath` (`SEC-05`). Returns a failure result — never a
 * partially-trusted path — when the directory cannot be read or escapes the workspace.
 */
async function canonicalizeRoot(candidateDir: string, workspaceFolderPath: string): Promise<CanonicalRootResult> {
  try {
    const [root, canonicalWorkspaceFolder] = await Promise.all([
      realpath(candidateDir),
      realpath(workspaceFolderPath),
    ]);
    if (!isPathContained(canonicalWorkspaceFolder, root)) {
      return { ok: false, reason: 'workspace-escape' };
    }
    return { ok: true, root, workspaceFolder: workspaceFolderPath };
  }
  catch (err) {
    logger.error(`Failed to resolve the canonical path for ${candidateDir}.`, err);
    return { ok: false, reason: 'unresolvable-path' };
  }
}

function rejectionDetail(packageFilePath: string, reason: 'unresolvable-path' | 'workspace-escape'): string {
  return reason === 'workspace-escape'
    ? `${packageFilePath} resolves to a project root outside its owning workspace folder.`
    : `${packageFilePath}'s project root could not be resolved.`;
}

async function resolveLockfilePath(
  canonicalRoot: string,
  packageManager: PackageManager,
  lockfileFileName: string | undefined,
): Promise<string | undefined> {
  if (lockfileFileName !== undefined) {
    return path.join(canonicalRoot, lockfileFileName);
  }

  for (const lockfile of LOCKFILES.filter(candidate => candidate.packageManager === packageManager)) {
    try {
      await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(canonicalRoot, lockfile.fileName)));
      return path.join(canonicalRoot, lockfile.fileName);
    }
    catch {
      continue;
    }
  }
  return undefined;
}

interface ResolvedManifestProject {
  readonly projectRoot: string;
  readonly workspaceFolder: string;
  readonly packageManager: PackageManager;
  readonly lockfilePath: string | undefined;
}

type ManifestProjectResolution
  = | { ok: true; project: ResolvedManifestProject }
    | { ok: false; reason: AuditProjectRejectionReason; detail: string };

/**
 * Resolves one manifest to its canonical audit project. An ancestor signal that escapes
 * the owning workspace is never trusted or merged into (`SEC-05`); resolution instead
 * retries using only the manifest's own directory before giving up entirely.
 */
async function resolveManifestProject(
  packageFilePath: string,
  workspaceFolderPath: string,
): Promise<ManifestProjectResolution> {
  const manifestDir = path.dirname(packageFilePath);
  const ancestorSignal = await detectPackageManagerSignalFromAncestors(manifestDir, workspaceFolderPath);
  const candidateRoot = ancestorSignal?.signalRoot ?? manifestDir;

  const canonical = await canonicalizeRoot(candidateRoot, workspaceFolderPath);
  if (canonical.ok) {
    const packageManager = ancestorSignal?.packageManager ?? 'npm';
    const lockfilePath = await resolveLockfilePath(canonical.root, packageManager, ancestorSignal?.lockfileFileName);
    return {
      ok: true,
      project: {
        projectRoot: canonical.root,
        workspaceFolder: canonical.workspaceFolder,
        packageManager,
        lockfilePath,
      },
    };
  }

  if (candidateRoot === manifestDir) {
    return { ok: false, reason: canonical.reason, detail: rejectionDetail(packageFilePath, canonical.reason) };
  }

  // The ancestor signal's canonical root did not resolve inside the workspace: discard
  // that untrusted evidence and retry using only the manifest's own directory, never
  // merging into it. Containment is checked here (SEC-05) before any file is read from
  // that directory — a directory that itself fails to resolve inside the workspace must
  // never have its package.json or lock files read, so signal detection only runs once
  // canonicalization has already proven the directory is safe.
  const ownCanonical = await canonicalizeRoot(manifestDir, workspaceFolderPath);
  if (!ownCanonical.ok) {
    return { ok: false, reason: ownCanonical.reason, detail: rejectionDetail(packageFilePath, ownCanonical.reason) };
  }

  const ownSignal = await detectPackageManagerSignalAt(manifestDir);
  const packageManager = ownSignal?.packageManager ?? 'npm';
  const lockfilePath = await resolveLockfilePath(ownCanonical.root, packageManager, ownSignal?.lockfileFileName);
  return {
    ok: true,
    project: {
      projectRoot: ownCanonical.root,
      workspaceFolder: ownCanonical.workspaceFolder,
      packageManager,
      lockfilePath,
    },
  };
}

/**
 * Resolves every discovered `package.json` to its canonical audit project: the real
 * directory an audit command should run from, the lock file it audits, the owning
 * workspace folder and every origin manifest that shares that project graph. Manifests
 * that resolve to the same canonical root are merged into one project so a single lock
 * file graph is audited exactly once (`ARC-07`).
 */
export async function resolveAuditProjects(packageFilePaths: readonly string[]): Promise<AuditProjectResolution> {
  const byRoot = new Map<string, { project: ResolvedManifestProject; originManifests: string[] }>();
  const rejected: RejectedAuditManifest[] = [];

  // Sorted before resolution so the winner of a cross-workspace collision (the first
  // manifest to claim a canonical root — see below) is deterministic regardless of input
  // order. The caller's list ultimately comes from `vscode.workspace.findFiles()`, whose
  // order is not contractually guaranteed (N7); the final `projects`/`rejected` sort
  // below only stabilizes the shape of the output, not which manifest wins the claim.
  const sortedPackageFilePaths = [...packageFilePaths].sort((a, b) => a.localeCompare(b));

  for (const packageFilePath of sortedPackageFilePaths) {
    const manifestDir = path.dirname(packageFilePath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(manifestDir));
    if (workspaceFolder === undefined) {
      rejected.push({
        packageFilePath,
        reason: 'no-owning-workspace',
        detail: `${packageFilePath} is not inside any open workspace folder.`,
      });
      continue;
    }

    const resolution = await resolveManifestProject(packageFilePath, workspaceFolder.uri.fsPath);
    if (!resolution.ok) {
      rejected.push({ packageFilePath, reason: resolution.reason, detail: resolution.detail });
      continue;
    }

    const { project } = resolution;
    const existing = byRoot.get(project.projectRoot);
    if (existing === undefined) {
      byRoot.set(project.projectRoot, { project, originManifests: [packageFilePath] });
      continue;
    }

    if (existing.project.workspaceFolder !== project.workspaceFolder) {
      rejected.push({
        packageFilePath,
        reason: 'cross-workspace-collision',
        detail: `${packageFilePath} resolves to project root ${project.projectRoot}, already claimed by `
          + `workspace folder ${existing.project.workspaceFolder}.`,
      });
      continue;
    }

    existing.originManifests.push(packageFilePath);
  }

  const projects = [...byRoot.values()]
    .map(({ project, originManifests }): AuditProject => ({
      ...project,
      originManifests: [...originManifests].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));

  return {
    projects,
    rejected: [...rejected].sort((a, b) => a.packageFilePath.localeCompare(b.packageFilePath)),
  };
}