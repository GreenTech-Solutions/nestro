import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BunClient, ClientManager, NpmClient, PnpmClient, YarnClient } from '../clients';

describe('package manager clients', () => {
  it('builds npm update commands', () => {
    expectCommand(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'npm', ['install', quoted('react@18.0.0')]);
  });

  it('builds pnpm update commands', () => {
    expectCommand(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'pnpm', ['add', quoted('react@18.0.0')]);
  });

  it('builds yarn update commands', () => {
    expectCommand(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'yarn', ['add', quoted('react@18.0.0')]);
  });

  it('builds bun update commands', () => {
    expectCommand(new BunClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'bun', ['add', quoted('react@18.0.0')]);
  });

  it('includes multiple packages in one command', () => {
    expectCommand(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '19.0.0', section: 'dependencies' },
      { name: 'typescript', version: '5.9.3', section: 'dependencies' },
    ]), 'pnpm', ['add', quoted('react@19.0.0'), quoted('typescript@5.9.3')]);
  });

  it('adds a save-dev flag for dev dependency updates', () => {
    expectCommand(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'npm', ['install', quoted('vitest@4.0.0'), '--save-dev']);
    expectCommand(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'pnpm', ['add', quoted('vitest@4.0.0'), '--save-dev']);
    expectCommand(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'yarn', ['add', quoted('vitest@4.0.0'), '--dev']);
    expectCommand(new BunClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'bun', ['add', quoted('vitest@4.0.0'), '--dev']);
  });

  it('builds npm remove commands', () => {
    expectCommand(
      new NpmClient('/workspace').buildRemoveCommand(['lodash', 'moment']),
      'npm',
      ['uninstall', quoted('lodash'), quoted('moment')],
    );
  });

  it('strongly quotes package targets with shell metacharacters', () => {
    const command = new NpmClient('/workspace').buildUpdateCommand([
      { name: 'evil; touch /tmp/pwned', version: '1.0.0', section: 'dependencies' },
    ]);

    expectCommand(command, 'npm', ['install', quoted('evil; touch /tmp/pwned@1.0.0')]);
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

  it('prefers a child lockfile over parent packageManager metadata', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'pnpm@10.24.0' }),
      '/workspace/packages/app/package.json': '{}',
      '/workspace/packages/app/yarn.lock': '',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('yarn');
  });

  it('prefers packageManager metadata over lockfiles in the same directory', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'pnpm@10.24.0' }),
      '/workspace/yarn.lock': '',
    });

    await expect(new ClientManager().detectPackageManager('/workspace')).resolves.toBe('pnpm');
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
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
    const value = files[uri.fsPath];
    if (value === undefined) {
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    }

    return Promise.resolve(Buffer.from(value));
  });
}

function quoted(value: string): vscode.ShellQuotedString {
  return { value, quoting: vscode.ShellQuoting.Strong };
}

function expectCommand(
  command: { command: string | vscode.ShellQuotedString; args: (string | vscode.ShellQuotedString)[] },
  expectedCommand: string,
  expectedArgs: (string | vscode.ShellQuotedString)[],
): void {
  expect(command.command).toBe(expectedCommand);
  expect(command.args).toEqual(expectedArgs);
}