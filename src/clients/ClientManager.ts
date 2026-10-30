import * as vscode from 'vscode';
import { PackageManagerClient } from './PackageManagerClient';
import { detectPackageManagerSignalFromAncestors } from './projectResolver';
import { isWorkspaceRoot } from './workspaceRoot';
import { logger } from '../utils/logger';
import { DEFAULT_PACKAGE_MANAGER } from '../shared';
import type { PackageManager } from '../shared';

export type { PackageManager } from '../shared';

export class ClientManager {
  async getClient(cwd: string): Promise<PackageManagerClient> {
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

  createClient(packageManager: PackageManager, cwd: string, atWorkspaceRoot = false): PackageManagerClient {
    return new PackageManagerClient(packageManager, cwd, atWorkspaceRoot);
  }

  async detectPackageManager(cwd: string): Promise<PackageManager> {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
      const signal = await detectPackageManagerSignalFromAncestors(cwd, workspaceFolder?.uri.fsPath);
      return signal?.packageManager ?? DEFAULT_PACKAGE_MANAGER;
    }
    catch (err) {
      logger.error('Failed to detect package manager.', err);
      throw err;
    }
  }
}