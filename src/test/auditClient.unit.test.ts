import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileException, ExecFileOptions } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getExecStdout, mergeSeverity, parseSeverity, runNpmAudit, runPackageAudit } from '../utils/auditClient';
import type { AuditSeverity } from '../utils/auditClient';

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

  it('parses v1 API advisories format', async () => {
    mockAuditSuccess(JSON.stringify({
      advisories: {
        123: { module_name: 'lodash', severity: 'high' },
        124: { module_name: 'express', severity: 'low' },
      },
    }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(2);
    expect(result.vulnerabilities.get('lodash')).toBe('high');
    expect(result.vulnerabilities.get('express')).toBe('low');
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

  it('logs and returns an empty result for an unrecognised audit JSON schema', async () => {
    mockAuditSuccess(JSON.stringify({ foo: 'bar' }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(0);
    expect(result.vulnerabilities.size).toBe(0);
  });

  it('skips vulnerabilities entries with an unrecognised severity value', async () => {
    mockAuditSuccess(JSON.stringify({
      vulnerabilities: {
        react: { severity: 'high' },
        eslint: { severity: 'unknown-severity' },
      },
    }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(1);
    expect(result.vulnerabilities.has('eslint')).toBe(false);
  });

  it('skips advisories entries with a missing module name or an unrecognised severity value', async () => {
    mockAuditSuccess(JSON.stringify({
      advisories: {
        123: { module_name: 'lodash', severity: 'high' },
        124: { severity: 'critical' },
        125: { module_name: 'express', severity: 'unknown-severity' },
      },
    }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(1);
    expect(result.vulnerabilities.has('lodash')).toBe(true);
    expect(result.vulnerabilities.has('express')).toBe(false);
  });

  it('merges severities for advisories that share the same module name', async () => {
    mockAuditSuccess(JSON.stringify({
      advisories: {
        123: { module_name: 'lodash', severity: 'high' },
        124: { module_name: 'lodash', severity: 'critical' },
      },
    }));

    const result = await runNpmAudit('/workspace');

    expect(result.total).toBe(1);
    expect(result.vulnerabilities.get('lodash')).toBe('critical');
  });
});

describe('runPackageAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses successful audit JSON for a non-npm package manager', async () => {
    mockAuditSuccess(JSON.stringify({
      vulnerabilities: { react: { severity: 'moderate' } },
    }));

    const result = await runPackageAudit('pnpm', '/workspace');

    expect(result.total).toBe(1);
    expect(result.vulnerabilities.get('react')).toBe('moderate');
    expect(vi.mocked(execFile).mock.calls[0][0]).toBe('pnpm');
  });
});

describe('mergeSeverity()', () => {
  it.each([
    ['critical', 'high', 'critical'],
    ['low', 'critical', 'critical'],
    ['high', 'high', 'high'],
    ['info', 'low', 'low'],
  ] as [AuditSeverity, AuditSeverity, AuditSeverity][])('keeps the more severe of %s and %s (%s)', (left, right, expected) => {
    expect(mergeSeverity(left, right)).toBe(expected);
  });
});

describe('parseSeverity()', () => {
  it.each([
    ['critical', 'critical'],
    ['info', 'info'],
    ['unknown-severity', undefined],
    [undefined, undefined],
  ] as [string | undefined, AuditSeverity | undefined][])('parses %s as %s', (value, expected) => {
    expect(parseSeverity(value)).toBe(expected);
  });
});

describe('getExecStdout()', () => {
  it.each([
    ['a plain string error', 'not an object', undefined],
    ['null', null, undefined],
    ['an object without a stdout property', {}, undefined],
    ['an object with a non-string stdout property', { stdout: Buffer.from('audit output') }, undefined],
    ['an object with a string stdout property', { stdout: 'audit output' }, 'audit output'],
  ] as [string, unknown, string | undefined][])('handles %s', (_label, err, expected) => {
    expect(getExecStdout(err)).toBe(expected);
  });
});