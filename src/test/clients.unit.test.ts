import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BunClient, ClientManager, NpmClient, PnpmClient, YarnClient } from '../clients';

describe('package manager clients', () => {
  it('builds npm update commands', () => {
    expect(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0' },
    ])).toBe('npm install react@18.0.0');
  });

  it('builds pnpm update commands', () => {
    expect(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0' },
    ])).toBe('pnpm add react@18.0.0');
  });

  it('builds yarn update commands', () => {
    expect(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0' },
    ])).toBe('yarn add react@18.0.0');
  });

  it('builds bun update commands', () => {
    expect(new BunClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0' },
    ])).toBe('bun add react@18.0.0');
  });

  it('includes multiple packages in one command', () => {
    expect(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '19.0.0' },
      { name: 'typescript', version: '5.9.3' },
    ])).toBe('pnpm add react@19.0.0 typescript@5.9.3');
  });

  it('builds npm remove commands', () => {
    expect(new NpmClient('/workspace').buildRemoveCommand(['lodash', 'moment'])).toBe('npm uninstall lodash moment');
  });
});

describe('ClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});