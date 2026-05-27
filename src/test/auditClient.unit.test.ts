import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileException, ExecFileOptions } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runNpmAudit } from '../utils/auditClient';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

type ExecFileCallback = NonNullable<Parameters<typeof execFile>[3]>;

function mockAuditSuccess(stdout: string): void {
  vi.mocked(execFile).mockImplementationOnce((
    _file: string,
    _args: readonly string[] | null | undefined,
    _options: ExecFileOptions | null | undefined,
    callback: ExecFileCallback | null | undefined,
  ) => {
    if (callback === undefined || callback === null) {
      throw new Error('Expected execFile callback.');
    }
    callback(null, stdout, '');
    return {} as ChildProcess;
  });
}

function mockAuditFailure(error: Error & { stdout?: string }): void {
  vi.mocked(execFile).mockImplementationOnce((
    _file: string,
    _args: readonly string[] | null | undefined,
    _options: ExecFileOptions | null | undefined,
    callback: ExecFileCallback | null | undefined,
  ) => {
    if (callback === undefined || callback === null) {
      throw new Error('Expected execFile callback.');
    }
    callback(error as ExecFileException, '', '');
    return {} as ChildProcess;
  });
}

describe('runNpmAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses successful npm audit JSON', async () => {
    mockAuditSuccess(JSON.stringify({
      vulnerabilities: {
        react: { severity: 'high' },
        eslint: { severity: 'moderate' },
      },
    }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(2);
    expect(result.vulnerabilities.get('react')).toBe('high');
    expect(result.vulnerabilities.get('eslint')).toBe('moderate');
  });

  it('parses audit JSON from stdout when npm exits with vulnerabilities', async () => {
    const error = Object.assign(new Error('audit found vulnerabilities'), {
      stdout: JSON.stringify({ vulnerabilities: { vite: { severity: 'critical' } } }),
    });
    mockAuditFailure(error);

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(1);
    expect(result.vulnerabilities.get('vite')).toBe('critical');
  });

  it('keeps the highest severity for duplicate packages', async () => {
    mockAuditSuccess(JSON.stringify({
      vulnerabilities: {
        react: { severity: 'low' },
        'react/node_modules/debug': { severity: 'high' },
      },
    }));

    const result = await runNpmAudit('/workspace');

    expect(result.vulnerabilities.get('react')).toBe('low');
    expect(result.vulnerabilities.get('react/node_modules/debug')).toBe('high');
  });

  it('handles empty vulnerability objects', async () => {
    mockAuditSuccess(JSON.stringify({ vulnerabilities: {} }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(0);
    expect(result.vulnerabilities.size).toBe(0);
  });

  it('throws when npm audit fails without JSON stdout', async () => {
    const error = new Error('npm not found');
    mockAuditFailure(error);

    await expect(runNpmAudit('/workspace')).rejects.toThrow('npm not found');
  });
});