import * as vscode from 'vscode';
import { BunClient } from './BunClient';
import { Client } from './Client';
import { NpmClient } from './NpmClient';
import { PnpmClient } from './PnpmClient';
import {
  detectPackageManagerFromLockfile,
  detectPackageManagerFromManifest,
  detectPackageManagerSignalFromAncestors,
} from './projectResolver';
import { YarnClient } from './YarnClient';
import { isWorkspaceRoot } from './workspaceRoot';
import { logger } from '../utils/logger';
import { DEFAULT_PACKAGE_MANAGER } from '../shared';
import type { PackageManager } from '../shared';

export type { PackageManager } from '../shared';

export class ClientManager {
  async getClient(cwd: string): Promise<Client> {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
      const signal = await detectPackageManagerSignalFromAncestors(cwd, workspaceFolder?.uri.fsPath);
      const packageManager = signal?.packageManager ?? DEFAULT_PACKAGE_MANAGER;
      const clientCwd = signal?.packageManager === 'yarn' ? signal.signalRoot : cwd;
      return this.createClient(packageManager, clientCwd, await isWorkspaceRoot(packageManager, cwd));
    }
    catch (err) {
      logger.error('Failed to detect package manager.', err);
      throw err;
    }
  }

  createClient(packageManager: PackageManager, cwd: string, atWorkspaceRoot = false): Client {
    switch (packageManager) {
      case 'pnpm':
        return new PnpmClient(cwd, atWorkspaceRoot);
      case 'yarn':
        return new YarnClient(cwd, atWorkspaceRoot);
      case 'bun':
        return new BunClient(cwd, atWorkspaceRoot);
      case 'npm':
        return new NpmClient(cwd, atWorkspaceRoot);
    }
  }

  async detectPackageManager(cwd?: string): Promise<PackageManager> {
    try {
      if (cwd !== undefined) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
        const fromAncestor = await detectPackageManagerSignalFromAncestors(cwd, workspaceFolder?.uri.fsPath);
        return fromAncestor?.packageManager ?? DEFAULT_PACKAGE_MANAGER;
      }

      const fromManifest = await detectPackageManagerFromManifest(cwd);
      if (fromManifest !== undefined) {
        return fromManifest;
      }
      const fromLockfile = await detectPackageManagerFromLockfile();
      return fromLockfile ?? DEFAULT_PACKAGE_MANAGER;
    }
    catch (err) {
      logger.error('Failed to detect package manager.', err);
      throw err;
    }
  }
}