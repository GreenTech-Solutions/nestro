import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRegistryConfiguration } from '../utils/registry/configResolution';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/yarnFamily', () => ({
  resolveYarnFamily: resolveYarnFamilyMock,
}));

const PEM = 'PEM-CONTENTS';

function mockFiles(files: Record<string, string>): void {
  vi.mocked(readFile).mockImplementation((filePath) => {
    const value = files[String(filePath)];
    return value === undefined
      ? Promise.reject(new Error(`File not found: ${String(filePath)}`))
      : Promise.resolve(value);
  });
}

describe('cafile resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('npm_config_cafile', undefined);
    resolveYarnFamilyMock.mockResolvedValue({ family: 'classic', source: 'version-probe' });
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => (
      vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`))
    ));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('finds a relative cafile next to the project .npmrc', async () => {
    mockFiles({ '/workspace/.npmrc': 'cafile=./certs/ca.pem', '/workspace/certs/ca.pem': PEM });

    const configuration = await resolveRegistryConfiguration('react', '/workspace/package.json', 'npm');

    expect(configuration.ca).toBe(PEM);
    expect(readFile).toHaveBeenCalledWith('/workspace/certs/ca.pem', 'utf8');
  });

  it('resolves a relative cafile against the .npmrc that declares it, not the package directory', async () => {
    mockFiles({ '/workspace/.npmrc': 'cafile=ca.pem', '/workspace/ca.pem': PEM });

    const configuration = await resolveRegistryConfiguration('react', '/workspace/apps/web/package.json', 'npm');

    expect(configuration.ca).toBe(PEM);
  });

  it('expands ~/ against the home directory', async () => {
    mockFiles({ '/workspace/.npmrc': 'cafile=~/certs/ca.pem', '/home/user/certs/ca.pem': PEM });

    const configuration = await resolveRegistryConfiguration('react', '/workspace/package.json', 'npm');

    expect(configuration.ca).toBe(PEM);
  });

  it('keeps an absolute cafile as written', async () => {
    mockFiles({ '/workspace/.npmrc': 'cafile=/etc/ssl/ca.pem', '/etc/ssl/ca.pem': PEM });

    const configuration = await resolveRegistryConfiguration('react', '/workspace/package.json', 'npm');

    expect(configuration.ca).toBe(PEM);
  });

  it('resolves a relative cafile from the environment against the package directory', async () => {
    vi.stubEnv('npm_config_cafile', 'env-ca.pem');
    mockFiles({ '/workspace/apps/web/env-ca.pem': PEM });

    const configuration = await resolveRegistryConfiguration('react', '/workspace/apps/web/package.json', 'npm');

    expect(configuration.ca).toBe(PEM);
  });

  it('resolves a relative Yarn Classic cafile against the .yarnrc that declares it', async () => {
    mockFiles({ '/workspace/.yarnrc': 'cafile "./ca.pem"', '/workspace/ca.pem': PEM });

    const configuration = await resolveRegistryConfiguration('react', '/workspace/package.json', 'yarn');

    expect(configuration.ca).toBe(PEM);
  });
});