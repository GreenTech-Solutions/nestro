import * as vscode from 'vscode';
import { logger } from './logger';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PackageJson {
  packageManager?: string;
}

const packageManagerNames = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export async function detectPackageManager(): Promise<PackageManager> {
  try {
    const fromManifest = await detectPackageManagerFromManifest();
    if (fromManifest !== undefined) {
      return fromManifest;
    }

    const fromLockfile = await detectPackageManagerFromLockfile();
    return fromLockfile ?? 'npm';
  }
  catch (err) {
    logger.error('Failed to detect package manager.', err);
    throw err;
  }
}

export function buildInstallCommand(
  packageManager: PackageManager,
  packageName: string,
  version: string,
): string {
  return buildPackageUpdateCommand(packageManager, [{ packageName, version }]);
}

export function buildPackageUpdateCommand(
  packageManager: PackageManager,
  updates: readonly { packageName: string; version: string }[],
): string {
  const targets = updates.map(update => `${update.packageName}@${update.version}`).join(' ');
  switch (packageManager) {
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return `${packageManager} add ${targets}`;
    case 'npm':
      return `npm install ${targets}`;
  }
}

export function buildRunInstallCommand(packageManager: PackageManager): string {
  return `${packageManager} install`;
}

async function detectPackageManagerFromManifest(): Promise<PackageManager | undefined> {
  const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1);
  if (files.length === 0) {
    return undefined;
  }

  const raw = await vscode.workspace.fs.readFile(files[0]);
  const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as PackageJson;
  const packageManager = manifest.packageManager?.split('@')[0];
  return parsePackageManager(packageManager);
}

async function detectPackageManagerFromLockfile(): Promise<PackageManager | undefined> {
  const lockfiles = [
    { pattern: '**/pnpm-lock.yaml', packageManager: 'pnpm' },
    { pattern: '**/yarn.lock', packageManager: 'yarn' },
    { pattern: '**/bun.lock', packageManager: 'bun' },
    { pattern: '**/bun.lockb', packageManager: 'bun' },
    { pattern: '**/package-lock.json', packageManager: 'npm' },
    { pattern: '**/npm-shrinkwrap.json', packageManager: 'npm' },
  ] as const;

  for (const lockfile of lockfiles) {
    const files = await vscode.workspace.findFiles(lockfile.pattern, '**/node_modules/**', 1);
    if (files.length > 0) {
      return lockfile.packageManager;
    }
  }
  return undefined;
}

function parsePackageManager(value: string | undefined): PackageManager | undefined {
  return packageManagerNames.find(name => name === value);
}