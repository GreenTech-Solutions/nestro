import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { logger } from './logger';

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

export const yarnVersionProbeTimeoutMs = 5_000;
export const yarnVersionProbeMaxBufferBytes = 8_192;

/**
 * Resolves the Yarn command family for one already-selected project root. Explicit
 * packageManager metadata wins, same-root markers are considered as a set, and PATH
 * probing is the bounded last resort. Nothing defaults to Yarn Classic.
 */
export async function resolveYarnFamily(projectRoot: string): Promise<YarnFamilyResolution> {
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
  const contents = await readOptionalFile(path.join(projectRoot, 'package.json'));
  if (contents === undefined) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(contents) as unknown;
    if (!isPlainObject(manifest)) {
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
  const match = /^yarn@(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(packageManager.trim());
  if (match === null) {
    return 'unknown';
  }
  return familyFromMajor(Number(match[1]));
}

async function resolveMarkerFamily(projectRoot: string): Promise<YarnFamilyResolution | undefined> {
  const [modernConfig, classicConfig, lockfile] = await Promise.all([
    readOptionalFile(path.join(projectRoot, '.yarnrc.yml')),
    readOptionalFile(path.join(projectRoot, '.yarnrc')),
    readOptionalFile(path.join(projectRoot, 'yarn.lock')),
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
  try {
    const result = await execFileAsync('yarn', ['--version'], {
      cwd: projectRoot,
      maxBuffer: yarnVersionProbeMaxBufferBytes,
      timeout: yarnVersionProbeTimeoutMs,
    }) as { stdout: string } | string;
    const stdout = typeof result === 'string' ? result : result.stdout;
    const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(stdout.trim());
    return {
      family: match === null ? 'unknown' : familyFromMajor(Number(match[1])),
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

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(raw).toString('utf8');
  }
  catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}