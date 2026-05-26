import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { buildInstallCommand, detectPackageManager } from '../utils';

describe('package manager detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    });

    it('uses packageManager from package.json first', async () => {
        vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[]);
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from('{"packageManager":"pnpm@11.0.8"}'));

        await expect(detectPackageManager()).resolves.toBe('pnpm');
    });

    it('falls back to lockfiles when package.json has no packageManager', async () => {
        vi.mocked(vscode.workspace.findFiles)
            .mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[])
            .mockResolvedValueOnce([{ path: '/workspace/pnpm-lock.yaml' }] as vscode.Uri[]);

        await expect(detectPackageManager()).resolves.toBe('pnpm');
    });

    it('falls back to npm when no package manager markers exist', async () => {
        await expect(detectPackageManager()).resolves.toBe('npm');
    });
});

describe('install command builder', () => {
    it('builds npm install commands', () => {
        expect(buildInstallCommand('npm', 'typescript', '5.9.3')).toBe('npm install typescript@5.9.3');
    });

    it('builds pnpm add commands', () => {
        expect(buildInstallCommand('pnpm', 'typescript', '5.9.3')).toBe('pnpm add typescript@5.9.3');
    });
});
