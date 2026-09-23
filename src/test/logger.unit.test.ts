import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates a native log output channel and writes info messages', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;

    logger.info('Loaded packages.');

    expect(freshVscode.window.createOutputChannel).toHaveBeenCalledWith('Nestro', { log: true });
    expect(channel.info).toHaveBeenCalledWith('Loaded packages.');
    expect(channel.entries).toEqual([{ level: 'info', message: 'Loaded packages.' }]);
  });

  it('uses native warning and error levels', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;
    const err = new Error('Registry unavailable');
    err.stack = 'Error: Registry unavailable\n    at fetch (/workspace/src/registry.ts:1:2)';

    logger.warn('Retrying registry request.');
    logger.error('Failed to fetch latest version.', err);

    expect(channel.warn).toHaveBeenCalledWith('Retrying registry request.');
    expect(channel.error).toHaveBeenNthCalledWith(1, 'Failed to fetch latest version.');
    expect(channel.error).toHaveBeenNthCalledWith(2, 'Error: Registry unavailable\n↳     at fetch (/workspace/src/registry.ts:1:2)');
    expect(channel.entries).toEqual([
      { level: 'warn', message: 'Retrying registry request.' },
      { level: 'error', message: 'Failed to fetch latest version.' },
      { level: 'error', message: 'Error: Registry unavailable\n↳     at fetch (/workspace/src/registry.ts:1:2)' },
    ]);
  });

  it('formats non-error values and errors without stacks', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;
    const err = new Error('Fallback detail');
    err.stack = undefined;

    logger.error('Failed with an error.', err);
    logger.error('Failed with a value.', 'raw detail');

    expect(channel.error).toHaveBeenNthCalledWith(2, 'Fallback detail');
    expect(channel.error).toHaveBeenNthCalledWith(4, 'raw detail');
  });

  it('makes injected physical lines continuation records and strips controls', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;

    logger.info('Fetching versions for evil\n[error] forged\r[warn] lone\r\n[warn] forged\u2028[debug] forged\u2029\u001b[31mred\u001b[0m\u0000\u0080');

    const logged = channel.entries[0]?.message;
    expect(logged).toBe('Fetching versions for evil\n↳ [error] forged\n↳ [warn] lone\n↳ [warn] forged\n↳ [debug] forged\n↳ red');
    expect(logged).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(logged).not.toContain('[error] Nestro:');
  });

  it('redacts shaped credentials in registry and audit text', async () => {
    const { sanitizeLogText } = await import('../utils/logger');
    const npmToken = `npm_${'a'.repeat(36)}`;
    const input = [
      'registry error https://ci:s3cr3t-token@registry.internal/npm',
      'https://registry.internal/no-credentials',
      '//registry.internal/:_authToken=deadbeef-cafe-1234',
      '//npm.pkg.github.com/:_authToken=ghp_supersecretvalue',
      '//registry.internal/:_auth=aGk6c2VjcmV0Cg==',
      ['//registry.internal/', ':_password=', 'hunter2'].join(''),
      '_auth=auth-secret',
      ['_password', '=', `'pwd-secret'`].join(''),
      'token=token-secret-value-123',
      'api-key: "api-key-secret-value-123"',
      'Authorization: Bearer bearer-secret',
      'Authorization: Basic basic-secret',
      `audit={"_authToken":"quoted-secret-value","token":"json-secret-value-123","api-key":"json-key-secret-value-123"} ${npmToken}`,
    ].join(' ');

    const sanitized = sanitizeLogText(input);

    expect(sanitized).toContain('https://registry.internal/npm');
    expect(sanitized).toContain('_authToken=[REDACTED]');
    expect(sanitized).toContain('_auth=[REDACTED]');
    expect(sanitized).toContain('_password=[REDACTED]');
    expect(sanitized).toContain(['_password', '=', `'[REDACTED]'`].join(''));
    expect(sanitized).toContain('token=[REDACTED]');
    expect(sanitized).toContain('api-key: "[REDACTED]"');
    expect(sanitized).toContain('Authorization: Bearer [REDACTED]');
    expect(sanitized).toContain('Authorization: Basic [REDACTED]');
    expect(sanitized).not.toMatch(/s3cr3t-token|deadbeef-cafe-1234|ghp_supersecretvalue|aGk6c2VjcmV0Cg==|hunter2|auth-secret|pwd-secret|quoted-secret-value|token-secret-value-123|api-key-secret-value-123|bearer-secret|basic-secret|json-secret-value-123|json-key-secret-value-123/);
    expect(sanitized).not.toContain(npmToken);
  });

  it('preserves git SSH users and redacts only password-bearing URLs across multiple URLs', async () => {
    const { sanitizeLogText } = await import('../utils/logger');
    const input = 'first https://registry.internal/npm then git+ssh://git@github.com/acme/lib.git#v1.2.3 and second https://ci:s3cr3t@registry.internal/npm';

    const sanitized = sanitizeLogText(input);

    expect(sanitized).toContain('https://registry.internal/npm');
    expect(sanitized).toContain('git+ssh://git@github.com/acme/lib.git#v1.2.3');
    expect(sanitized).toContain('https://registry.internal/npm');
    expect(sanitized).not.toContain('https://ci:s3cr3t@registry.internal/npm');
  });

  it('keeps ordinary short credential-like words and package text intact', async () => {
    const { sanitizeLogText } = await import('../utils/logger');
    const ordinary = [
      'SyntaxError: Unexpected token: } in package.json',
      'Unexpected token \'}\', "{ \\"a\\": }" is not valid JSON',
      'Running install command: npm install --save-dev -- token@1.2.3',
      'Fetching versions for @my-org/token-utils.',
      'Switching @acme/api-key dependency type.',
      'Audit: token=1 vulnerability in api-key: 3 packages',
      'Pinned apikey: 2.0.0',
    ].join('\n');

    expect(sanitizeLogText(ordinary)).toBe([
      'SyntaxError: Unexpected token: } in package.json',
      '↳ Unexpected token \'}\', "{ \\"a\\": }" is not valid JSON',
      '↳ Running install command: npm install --save-dev -- token@1.2.3',
      '↳ Fetching versions for @my-org/token-utils.',
      '↳ Switching @acme/api-key dependency type.',
      '↳ Audit: token=1 vulnerability in api-key: 3 packages',
      '↳ Pinned apikey: 2.0.0',
    ].join('\n'));
  });

  it('keeps ordinary package names, paths, and stack traces readable', async () => {
    const { sanitizeLogText } = await import('../utils/logger');
    const stack = 'Error: @my-org/token-utils failed\n    at load (/Users/someone/projects/app/src/index.ts:1:2)\n    at run (/Users/someone/projects/app/src/main.ts:3:4)';

    expect(sanitizeLogText(stack)).toBe('Error: @my-org/token-utils failed\n↳     at load (/Users/someone/projects/app/src/index.ts:1:2)\n↳     at run (/Users/someone/projects/app/src/main.ts:3:4)');
    expect(sanitizeLogText('x'.repeat(500))).toHaveLength(500);
  });

  it('filters debug messages at the default level and emits them at debug level', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;

    logger.debug('Hidden by default.');
    expect(channel.entries).toEqual([]);

    channel.logLevel = freshVscode.LogLevel.Debug;
    logger.debug('Visible at debug level.');

    expect(channel.debug).toHaveBeenCalledTimes(2);
    expect(channel.entries).toEqual([{ level: 'debug', message: 'Visible at debug level.' }]);
  });

  it('disposes the output channel', async () => {
    const freshVscode = await import('vscode');
    const { logger } = await import('../utils/logger');
    const channel = vi.mocked(freshVscode.window.createOutputChannel).mock.results[0].value;

    logger.dispose();

    expect(channel.dispose).toHaveBeenCalled();
  });
});