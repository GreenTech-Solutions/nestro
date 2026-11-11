import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigFilePaths, getPackageRoot, readConfigFile } from '../utils/registry/configFiles';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

describe('registry config files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => (
      vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`))
    ));
  });

  it('lists the home file, then every directory from the workspace root down to the package', () => {
    expect(getConfigFilePaths('/workspace/apps/web/package.json', '.npmrc')).toEqual([
      '/home/user/.npmrc',
      '/workspace/.npmrc',
      '/workspace/apps/.npmrc',
      '/workspace/apps/web/.npmrc',
    ]);
  });

  it('uses the first workspace folder when no package file is given', () => {
    expect(getConfigFilePaths(undefined, 'bunfig.toml')).toEqual([
      '/home/user/bunfig.toml',
      '/workspace/bunfig.toml',
    ]);
  });

  it('lists a file once when the workspace root is the home directory', () => {
    setWorkspaceFolders([{ uri: { fsPath: '/home/user' } }]);

    expect(getConfigFilePaths(undefined, '.yarnrc')).toEqual(['/home/user/.yarnrc']);
  });

  it('keeps only the user file outside any workspace folder', () => {
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);

    expect(getConfigFilePaths('/elsewhere/package.json', '.npmrc')).toEqual(['/home/user/.npmrc']);
  });

  it('resolves the package root from the package file or the first workspace folder', () => {
    expect(getPackageRoot('/workspace/apps/web/package.json')).toBe('/workspace/apps/web');
    expect(getPackageRoot(undefined)).toBe('/workspace');
  });

  it('reads a file and maps every failure to undefined', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('registry=https://r/');
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));

    await expect(readConfigFile('/a')).resolves.toBe('registry=https://r/');
    await expect(readConfigFile('/b')).resolves.toBeUndefined();
  });
});