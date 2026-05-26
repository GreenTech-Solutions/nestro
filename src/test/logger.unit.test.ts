import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('writes info messages to the output channel', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;

    logger.info('Loaded packages.');

    expect(channel.appendLine).toHaveBeenCalledWith('[info] Loaded packages.');
  });

  it('writes error messages and error details to the output channel', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;
    const err = new Error('Registry unavailable');

    logger.error('Failed to fetch latest version.', err);

    expect(channel.appendLine).toHaveBeenCalledWith('[error] Failed to fetch latest version.');
    expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Registry unavailable'));
  });

  it('disposes the output channel', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;

    logger.dispose();

    expect(channel.dispose).toHaveBeenCalled();
  });
});