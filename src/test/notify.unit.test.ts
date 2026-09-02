import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { showError } from '../utils';

interface TestLogChannel {
  entries: readonly { message: string }[];
  logLevel: vscode.LogLevel;
}

const channel = vi.mocked(vscode.window.createOutputChannel).mock.results[0].value as unknown as TestLogChannel;

describe('showError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
    (channel.entries as { message: string }[]).length = 0;
    channel.logLevel = vscode.LogLevel.Info;
  });

  it('shows a relative bounded toast while keeping full sanitized detail in Output', () => {
    const message = `Failed to read '/workspace/apps/web/package.json' _authToken=toast-secret ${'x'.repeat(300)}`;
    const error = new Error(`ENOENT: open '/workspace/apps/web/package.json' _authToken=detail-secret`);
    error.stack = `Error: ENOENT: open '/workspace/apps/web/package.json' _authToken=detail-secret`;

    showError(message, error);

    const toast = String(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0]);
    const output = channel.entries.map(entry => entry.message).join('\n');

    expect(vscode.workspace.asRelativePath).toHaveBeenCalledWith('/workspace/apps/web/package.json');
    expect(toast.startsWith('Nestro: Failed to read \'apps/web/package.json\'')).toBe(true);
    expect(toast).not.toContain('/workspace/apps/web/package.json');
    expect(toast).not.toContain('toast-secret');
    expect(toast.length).toBeLessThanOrEqual(240);
    expect(output).toContain('/workspace/apps/web/package.json');
    expect(output).not.toContain('toast-secret');
    expect(output).not.toContain('detail-secret');
  });

  it('leaves absolute paths outside the workspace unchanged', () => {
    showError('Failed to read /external/project/package.json.');

    const toast = String(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0]);

    expect(toast).toContain('/external/project/package.json');
  });
});