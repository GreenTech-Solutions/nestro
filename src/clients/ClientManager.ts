import * as path from 'path';
import * as vscode from 'vscode';
import { BunClient } from './BunClient';
import { Client } from './Client';
import { NpmClient } from './NpmClient';
import { PnpmClient } from './PnpmClient';
import { YarnClient } from './YarnClient';
import { logger } from '../utils/logger';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PackageJson {
  packageManager?: string;
}

const packageManagerNames = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export class ClientManager {
  async getClient(cwd: string): Promise<Client> {
    return this.createClient(await this.detectPackageManager(cwd), cwd);
  }

  createClient(packageManager: PackageManager, cwd: string): Client {
    switch (packageManager) {
      case 'pnpm':
        return new PnpmClient(cwd);
      case 'yarn':
        return new YarnClient(cwd);
      case 'bun':
        return new BunClient(cwd);
      case 'npm':
        return new NpmClient(cwd);
    }
  }

  async detectPackageManager(cwd?: string): Promise<PackageManager> {
    try {
      const fromManifest = await this.detectPackageManagerFromManifest(cwd);
      if (fromManifest !== undefined) {
        return fromManifest;
      }

      const fromLockfile = await this.detectPackageManagerFromLockfile(cwd);
      return fromLockfile ?? 'npm';
    }
    catch (err) {
      logger.error('Failed to detect package manager.', err);
      throw err;
    }
  }

  private async detectPackageManagerFromManifest(cwd: string | undefined): Promise<PackageManager | undefined> {
    if (cwd !== undefined) {
      try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, 'package.json')));
        const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as PackageJson;
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
    const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as PackageJson;
    const packageManager = manifest.packageManager?.split('@')[0];
    return parsePackageManager(packageManager);
  }

  private async detectPackageManagerFromLockfile(cwd: string | undefined): Promise<PackageManager | undefined> {
    const lockfiles = [
      { fileName: 'pnpm-lock.yaml', pattern: '**/pnpm-lock.yaml', packageManager: 'pnpm' },
      { fileName: 'yarn.lock', pattern: '**/yarn.lock', packageManager: 'yarn' },
      { fileName: 'bun.lock', pattern: '**/bun.lock', packageManager: 'bun' },
      { fileName: 'bun.lockb', pattern: '**/bun.lockb', packageManager: 'bun' },
      { fileName: 'package-lock.json', pattern: '**/package-lock.json', packageManager: 'npm' },
      { fileName: 'npm-shrinkwrap.json', pattern: '**/npm-shrinkwrap.json', packageManager: 'npm' },
    ] as const;

    for (const lockfile of lockfiles) {
      if (cwd !== undefined) {
        try {
          await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, lockfile.fileName)));
          return lockfile.packageManager;
        }
        catch {
          continue;
        }
      }
      const files = await vscode.workspace.findFiles(lockfile.pattern, '**/node_modules/**', 1);
      if (files.length > 0) {
        return lockfile.packageManager;
      }
    }
    return undefined;
  }
}

function parsePackageManager(value: string | undefined): PackageManager | undefined {
  return packageManagerNames.find(name => name === value);
}