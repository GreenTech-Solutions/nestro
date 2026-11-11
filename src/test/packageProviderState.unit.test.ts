import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageProviderState } from '../providers/packageProviderState';

const previousWorkspaceFolders = vscode.workspace.workspaceFolders;

afterEach(() => {
  setWorkspaceFolders(previousWorkspaceFolders);
});

describe('PackageProviderState', () => {
  it('creates package items without owner labels when workspace folders are absent', () => {
    setWorkspaceFolders([]);
    const state = new PackageProviderState();

    const emptyPathItem = state.createPackageItem({
      packageName: 'react',
      currentVersion: '1.0.0',
      updateType: 'none',
      packageFilePath: '',
      dev: false,
      versionPrefix: '',
    });
    const manifestItem = state.createPackageItem({
      packageName: 'vue',
      currentVersion: '3.0.0',
      updateType: 'none',
      packageFilePath: '/workspace/package.json',
      dev: false,
      versionPrefix: '',
    });

    expect(emptyPathItem.workspaceOwner).toBeUndefined();
    expect(manifestItem.workspaceOwner).toBeUndefined();
  });
});