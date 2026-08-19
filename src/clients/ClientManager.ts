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
import type { PackageManager } from './projectResolver';
import { YarnClient } from './YarnClient';
import { logger } from '../utils/logger';

export type { PackageManager } from './projectResolver';

export class ClientManager {
  async getClient(cwd: string): Promise<Client> {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
      const signal = await detectPackageManagerSignalFromAncestors(cwd, workspaceFolder?.uri.fsPath);
      const packageManager = signal?.packageManager ?? 'npm';
      const clientCwd = signal?.packageManager === 'yarn' ? signal.signalRoot : cwd;
      return this.createClient(packageManager, clientCwd);
    }
    catch (err) {
      logger.error('Failed to detect package manager.', err);
      throw err;
    }
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
      if (cwd !== undefined) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
        const fromAncestor = await detectPackageManagerSignalFromAncestors(cwd, workspaceFolder?.uri.fsPath);
        return fromAncestor?.packageManager ?? 'npm';
      }

      const fromManifest = await detectPackageManagerFromManifest(cwd);
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
}