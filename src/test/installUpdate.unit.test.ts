import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { installUpdateCommand } from '../commands';
import { PackageItem } from '../providers/PackageItem';

describe('installUpdateCommand()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
        vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
    });

    it('uses the detected package manager in the terminal command', async () => {
        const terminal = { sendText: vi.fn(), show: vi.fn() };
        vi.mocked(vscode.window.createTerminal).mockReturnValueOnce(terminal as unknown as vscode.Terminal);
        vi.mocked(vscode.workspace.findFiles)
            .mockResolvedValueOnce([{ path: '/workspace/package.json' }] as vscode.Uri[])
            .mockResolvedValueOnce([{ path: '/workspace/pnpm-lock.yaml' }] as vscode.Uri[]);

        await installUpdateCommand(new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor'));

        expect(terminal.sendText).toHaveBeenCalledWith('pnpm add typescript@5.9.3');
        expect(terminal.show).toHaveBeenCalled();
    });
});
