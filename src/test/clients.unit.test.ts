import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BunClient, ClientManager, NpmClient, PnpmClient, YarnClient } from '../clients';

describe('package manager clients', () => {
  it('builds npm update commands', () => {
    expect(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ])).toBe('npm install react@18.0.0');
  });

  it('builds pnpm update commands', () => {
    expect(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ])).toBe('pnpm add react@18.0.0');
  });

  it('builds yarn update commands', () => {
    expect(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ])).toBe('yarn add react@18.0.0');
  });

  it('builds bun update commands', () => {
    expect(new BunClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ])).toBe('bun add react@18.0.0');
  });

  it('includes multiple packages in one command', () => {
    expect(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '19.0.0', section: 'dependencies' },
      { name: 'typescript', version: '5.9.3', section: 'dependencies' },
    ])).toBe('pnpm add react@19.0.0 typescript@5.9.3');
  });

  it('adds a save-dev flag for dev dependency updates', () => {
    expect(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ])).toBe('npm install vitest@4.0.0 --save-dev');
    expect(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ])).toBe('pnpm add vitest@4.0.0 --save-dev');
    expect(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ])).toBe('yarn add vitest@4.0.0 --dev');
    expect(new BunClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ])).toBe('bun add vitest@4.0.0 --dev');
  });

  it('builds npm remove commands', () => {
    expect(new NpmClient('/workspace').buildRemoveCommand(['lodash', 'moment'])).toBe('npm uninstall lodash moment');
  });
});

describe('ClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(candidate => uri.fsPath.startsWith(candidate.uri.fsPath));
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
  });

  it.each([
    ['npm', NpmClient],
    ['pnpm', PnpmClient],
    ['yarn', YarnClient],
    ['bun', BunClient],
  ] as const)('returns a %s client from packageManager metadata', async (packageManager, expectedClient) => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: `${packageManager}@1.0.0` })),
    );

    await expect(new ClientManager().getClient('/workspace')).resolves.toBeInstanceOf(expectedClient);
  });

  it('detects a root pnpm lockfile from a nested workspace package', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/app/package.json': '{}',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('pnpm');
  });

  it('detects ancestor packageManager metadata from a nested workspace package', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'yarn@4.12.0' }),
      '/workspace/packages/app/package.json': '{}',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('yarn');
  });

  it('prefers ancestor packageManager metadata over nested stray lockfiles', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'pnpm@10.24.0' }),
      '/workspace/packages/app/package.json': '{}',
      '/workspace/packages/app/package-lock.json': '',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('pnpm');
  });

  it('does not read above the owning workspace folder when walking ancestors', async () => {
    mockWorkspaceFiles({
      '/pnpm-lock.yaml': '',
      '/workspace/package.json': '{}',
      '/workspace/packages/app/package.json': '{}',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('npm');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/pnpm-lock.yaml' }),
    );
  });
});

function mockWorkspaceFiles(files: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: vscode.Uri) => {
    const value = files[uri.fsPath];
    if (value === undefined) {
      throw new Error(`File not found: ${uri.fsPath}`);
    }

    return Buffer.from(value);
  });
}
