import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { logger } from './logger';
import { YARN_VERSION_PROBE_MAX_BUFFER_BYTES, YARN_VERSION_PROBE_TIMEOUT_MS } from '../config';
import { describeError, isRecord, PACKAGE_MANAGERS, parsePackageManagerField, parseYarnSemverMajor, resolveSpawnTarget, YARN_DIALECTS } from '../shared';

const execFileAsync = promisify(execFile);

export type YarnFamily = 'classic' | 'modern' | 'unknown';

export type YarnFamilySource
  = | 'package-manager'
    | 'project-markers'
    | 'conflicting-markers'
    | 'version-probe';

export interface YarnFamilyResolution {
  family: YarnFamily;
  source: YarnFamilySource;
}

const operationMemo = new AsyncLocalStorage<Map<string, Promise<YarnFamilyResolution>>>();

/** Runs one operation with a Yarn family memo per project root; a nested call joins the enclosing memo. */
export function runWithYarnFamilyMemo<T>(operation: () => Promise<T>): Promise<T> {
  return operationMemo.getStore() === undefined
    ? operationMemo.run(new Map(), operation)
    : operation();
}

/**
 * Resolves the Yarn command family for one already-selected project root. Explicit
 * packageManager metadata wins, same-root markers are considered as a set, and PATH
 * probing is the bounded last resort. Nothing defaults to Yarn Classic. Inside
 * runWithYarnFamilyMemo() each root resolves once; outside it every call resolves afresh.
 */
export function resolveYarnFamily(projectRoot: string): Promise<YarnFamilyResolution> {
  const memo = operationMemo.getStore();
  if (memo === undefined) {
    return resolveYarnFamilyUncached(projectRoot);
  }
  let resolution = memo.get(projectRoot);
  if (resolution === undefined) {
    resolution = resolveYarnFamilyUncached(projectRoot);
    memo.set(projectRoot, resolution);
  }
  return resolution;
}

async function resolveYarnFamilyUncached(projectRoot: string): Promise<YarnFamilyResolution> {
  const packageManager = await readPackageManager(projectRoot);
  const metadataFamily = parsePackageManagerFamily(packageManager);
  if (metadataFamily !== 'unknown') {
    return { family: metadataFamily, source: 'package-manager' };
  }

  const markerFamily = await resolveMarkerFamily(projectRoot);
  if (markerFamily !== undefined) {
    return markerFamily;
  }

  return probeYarnVersion(projectRoot);
}

async function readPackageManager(projectRoot: string): Promise<string | undefined> {
  const contents = await readFileOrUndefined(path.join(projectRoot, 'package.json'));
  if (contents === undefined) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(contents) as unknown;
    if (!isRecord(manifest)) {
      return undefined;
    }
    return typeof manifest.packageManager === 'string' ? manifest.packageManager : undefined;
  }
  catch {
    return undefined;
  }
}

function parsePackageManagerFamily(packageManager: string | undefined): YarnFamily {
  if (packageManager === undefined) {
    return 'unknown';
  }
  const field = parsePackageManagerField(packageManager.trim());
  const major = field?.packageManager === 'yarn' && field.version !== undefined
    ? parseYarnSemverMajor(field.version)
    : undefined;
  if (major === undefined) {
    return 'unknown';
  }
  return familyFromMajor(major);
}

async function resolveMarkerFamily(projectRoot: string): Promise<YarnFamilyResolution | undefined> {
  const [modernConfig, classicConfig, lockfile] = await Promise.all([
    readFileOrUndefined(path.join(projectRoot, YARN_DIALECTS.modern.configFile)),
    readFileOrUndefined(path.join(projectRoot, YARN_DIALECTS.classic.configFile)),
    readFileOrUndefined(path.join(projectRoot, PACKAGE_MANAGERS.yarn.lockfiles[0])),
  ]);

  const modern = modernConfig !== undefined || hasModernLockMarker(lockfile);
  const classic = classicConfig !== undefined || hasClassicLockMarker(lockfile);
  if (modern && classic) {
    return { family: 'unknown', source: 'conflicting-markers' };
  }
  if (modern || classic) {
    return { family: modern ? 'modern' : 'classic', source: 'project-markers' };
  }
  return undefined;
}

function hasModernLockMarker(lockfile: string | undefined): boolean {
  if (lockfile === undefined) {
    return false;
  }
  const lines = lockfile.split('\n');
  const metadataIndex = lines.findIndex(line => line.trim() === '__metadata:');
  const versionLine = lines[metadataIndex + 1]?.trim();
  if (metadataIndex < 0 || versionLine === undefined || !versionLine.startsWith('version:')) {
    return false;
  }
  return /^\d+$/.test(versionLine.slice('version:'.length).trim());
}

function hasClassicLockMarker(lockfile: string | undefined): boolean {
  return lockfile !== undefined
    && lockfile.split('\n').some(line => line.trim() === '# yarn lockfile v1');
}

async function probeYarnVersion(projectRoot: string): Promise<YarnFamilyResolution> {
  const target = resolveSpawnTarget(PACKAGE_MANAGERS.yarn.bin, ['--version']);
  if (target.kind === 'unresolved') {
    logger.warn(`Unable to identify Yarn family: ${target.message}`);
    return { family: 'unknown', source: 'version-probe' };
  }

  try {
    const result = await execFileAsync(target.command, target.args, {
      cwd: projectRoot,
      maxBuffer: YARN_VERSION_PROBE_MAX_BUFFER_BYTES,
      timeout: YARN_VERSION_PROBE_TIMEOUT_MS,
      ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    }) as { stdout: string } | string;
    const stdout = typeof result === 'string' ? result : result.stdout;
    const major = parseYarnSemverMajor(stdout.trim());
    return {
      family: major === undefined ? 'unknown' : familyFromMajor(major),
      source: 'version-probe',
    };
  }
  catch (err) {
    logger.warn(`Unable to identify Yarn family: ${describeError(err)}`);
    return { family: 'unknown', source: 'version-probe' };
  }
}

function familyFromMajor(major: number): YarnFamily {
  if (major === 1) {
    return 'classic';
  }
  return major >= 2 ? 'modern' : 'unknown';
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(raw).toString('utf8');
  }
  catch {
    return undefined;
  }
}