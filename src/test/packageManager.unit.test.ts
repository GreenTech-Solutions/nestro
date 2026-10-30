import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { detectPackageManager } from '../utils';

describe('package manager detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error('missing'));
    vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error('missing'));
  });

  it('uses packageManager from package.json first', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from('{"packageManager":"pnpm@11.0.8"}'));

    await expect(detectPackageManager('/workspace')).resolves.toBe('pnpm');
  });

  it('falls back to npm when no package manager markers exist', async () => {
    await expect(detectPackageManager('/workspace')).resolves.toBe('npm');
  });

  it('answers npm without reading anything when no directory is known', async () => {
    await expect(detectPackageManager(undefined)).resolves.toBe('npm');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  });
});