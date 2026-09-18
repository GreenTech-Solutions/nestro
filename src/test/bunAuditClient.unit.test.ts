import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_PROCESS_MAX_BUFFER_BYTES,
  AUDIT_PROCESS_TIMEOUT_MS,
  parseBunAuditOutcome,
  runBunAudit,
  runBunAuditOutcome,
  UnrecognizedAuditResultError,
} from '../utils';
import type {
  AuditAdvisoriesOutcome,
  AuditCleanOutcome,
  AuditIncompleteOutcome,
  AuditIncompleteReason,
  AuditOutcome,
} from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

const cwd = '/workspace/bun-app';

class NonErrorParseFailure {
  toString(): string {
    return 'synthetic parse failure';
  }
}

function mockAuditProcess(err: unknown, stdout: string): void {
  runBoundedProcessMock.mockImplementationOnce(() => {
    if (err === null) {
      return Promise.resolve({ kind: 'exit', stdout, stderr: '', exitCode: 0 });
    }
    const properties = typeof err === 'object' && err !== null
      ? err as { code?: unknown; stdout?: unknown; stderr?: unknown }
      : {};
    const output = typeof properties.stdout === 'string' ? properties.stdout : stdout;
    const stderr = typeof properties.stderr === 'string' ? properties.stderr : '';
    if (properties.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return Promise.resolve({ kind: 'overflow', maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES });
    }
    if (typeof properties.code === 'number') {
      return Promise.resolve({ kind: 'exit', stdout: output, stderr, exitCode: properties.code });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Promise.resolve({
      kind: 'spawn-error',
      reason: properties.code === 'ENOENT' ? 'command-not-found' : 'process-failed',
      detail: `bun could not run: ${message}`,
      message,
      cause: err,
    });
  });
}

function mockAuditSuccess(stdout: string): void {
  mockAuditProcess(null, stdout);
}

function mockAuditExit(exitCode: number, stdout: string): void {
  mockAuditProcess(Object.assign(new Error(`Command failed with exit code ${exitCode}`), {
    code: exitCode,
    stdout,
  }), '');
}

function bunAdvisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1106913,
    url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
    title: 'Command Injection in lodash',
    severity: 'high',
    vulnerable_versions: '<4.17.21',
    cwe: ['CWE-77'],
    cvss: {
      score: 7.2,
      vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N',
    },
    ...overrides,
  };
}

function bunReport(entries: Record<string, unknown[]>): string {
  return JSON.stringify(entries);
}

function expectAdvisories(outcome: AuditOutcome): AuditAdvisoriesOutcome {
  if (outcome.kind !== 'advisories') {
    throw new Error(`Expected an advisories outcome, received "${outcome.kind}".`);
  }
  return outcome;
}

function expectClean(outcome: AuditOutcome): AuditCleanOutcome {
  if (outcome.kind !== 'clean') {
    throw new Error(`Expected a clean outcome, received "${outcome.kind}".`);
  }
  return outcome;
}

function expectIncomplete(outcome: AuditOutcome, reason: AuditIncompleteReason): AuditIncompleteOutcome {
  if (outcome.kind !== 'incomplete') {
    throw new Error(`Expected an incomplete outcome, received "${outcome.kind}".`);
  }
  expect(outcome.reason).toBe(reason);
  return outcome;
}

describe('parseBunAuditOutcome()', () => {
  it('recognizes the native empty-object response as clean only on exit 0', () => {
    const outcome = expectClean(parseBunAuditOutcome({
      command: 'bun',
      stdout: '{}',
      exitCode: 0,
    }));

    expect(outcome).toMatchObject({
      schema: 'bun-bulk-advisory',
      exitCode: 0,
      total: 0,
    });
    expect(outcome.vulnerabilities.size).toBe(0);
  });

  it('turns native bulk advisory objects into one finding per package', () => {
    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({
        lodash: [bunAdvisory()],
        react: [bunAdvisory({
          id: 1099999,
          title: 'Example advisory',
          severity: 'moderate',
          vulnerable_versions: '<18.3.1',
        })],
      }),
      exitCode: 1,
    }));

    expect(outcome).toMatchObject({
      schema: 'bun-bulk-advisory',
      exitCode: 1,
      total: 2,
    });
    expect([...outcome.vulnerabilities]).toEqual([
      ['lodash', 'high'],
      ['react', 'moderate'],
    ]);
  });

  it('keeps the highest severity when one package has duplicate advisories', () => {
    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({
        lodash: [
          bunAdvisory({ id: 1, severity: 'low' }),
          bunAdvisory({ id: 2, severity: 'critical' }),
          bunAdvisory({ id: 3, severity: 'moderate' }),
        ],
      }),
      exitCode: 1,
    }));

    expect(outcome.total).toBe(1);
    expect(outcome.vulnerabilities.get('lodash')).toBe('critical');
  });

  it('accepts unknown advisory fields without weakening the required schema', () => {
    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({
        lodash: [bunAdvisory({
          future_registry_field: { introducedIn: 2 },
          ghsa_id: 'GHSA-35jh-r3h4-6jhm',
        })],
      }),
      exitCode: 1,
    }));

    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
  });

  it('accepts a non-empty string advisory id and a scoped package name', () => {
    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({
        '@scope/package': [bunAdvisory({ id: 'GHSA-35jh-r3h4-6jhm' })],
      }),
      exitCode: 1,
    }));

    expect(outcome.vulnerabilities.get('@scope/package')).toBe('high');
  });

  it('accepts omitted optional details and a null CVSS vector string', () => {
    const withoutOptionalDetails = bunAdvisory({ cwe: undefined, cvss: undefined });
    const withNullVector = bunAdvisory({
      id: 1106914,
      cvss: { score: 0, vectorString: null },
    });

    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({ lodash: [withoutOptionalDetails, withNullVector] }),
      exitCode: 1,
    }));

    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
  });

  it('tolerates an empty optional fix object without inventing a fix', () => {
    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({ lodash: [bunAdvisory({ fixAvailable: {}, source: 123 })] }),
      exitCode: 1,
    }));

    expect(outcome.advisories?.[0]?.fixAvailable).toBeUndefined();
  });

  it('preserves boolean and object fix availability when Bun provides it', () => {
    const outcome = expectAdvisories(parseBunAuditOutcome({
      command: 'bun',
      stdout: bunReport({
        lodash: [bunAdvisory({ id: 1106915, fixAvailable: true })],
        react: [bunAdvisory({
          id: 1106916,
          fixAvailable: { name: 'react', version: '19.0.0', isSemVerMajor: true },
        })],
      }),
      exitCode: 1,
    }));

    expect(outcome.advisories?.find(advisory => advisory.packageName === 'lodash')?.fixAvailable).toBe(true);
    expect(outcome.advisories?.find(advisory => advisory.packageName === 'react')?.fixAvailable).toEqual({
      name: 'react', version: '19.0.0', isSemVerMajor: true,
    });
  });

  it.each([
    ['empty stdout', '', 'empty-output'],
    ['whitespace-only stdout', '  \n\t', 'empty-output'],
    ['malformed JSON', 'Unknown command: audit', 'malformed-json'],
    ['truncated JSON', '{"lodash":[{"id":1106913', 'malformed-json'],
  ] as const)('treats %s as incomplete', (_label, stdout, reason) => {
    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      reason,
    );
  });

  it.each([
    ['an array', '[]'],
    ['a null literal', 'null'],
    ['a number literal', '5'],
    ['an unknown command object', '{"error":{"code":"UNKNOWN_COMMAND"}}'],
    ['an npm v2 report', '{"auditReportVersion":2,"vulnerabilities":{}}'],
    ['an unknown non-empty object', '{"futureSchema":{"version":2}}'],
  ])('rejects %s as an unknown schema', (_label, stdout) => {
    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      'unrecognized-schema',
    );
  });

  it.each([
    ['a package mapped to a non-array', JSON.stringify({ lodash: bunAdvisory() })],
    ['a package mapped to an empty advisory array', JSON.stringify({ lodash: [] })],
    ['an empty package name', bunReport({ '': [bunAdvisory()] })],
    ['a whitespace-only package name', bunReport({ '  ': [bunAdvisory()] })],
    ['a non-object advisory', bunReport({ lodash: ['unexpected'] })],
    ['a mixed valid and malformed advisory array', bunReport({ lodash: [bunAdvisory(), null] })],
  ])('rejects %s instead of partially accepting it', (_label, stdout) => {
    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      'unrecognized-schema',
    );
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['an empty string id', { id: '   ' }],
    ['an invalid object id', { id: { value: 1106913 } }],
    ['a non-finite id', { id: Number.POSITIVE_INFINITY }],
    ['a missing URL', { url: undefined }],
    ['an empty URL', { url: '' }],
    ['a missing title', { title: undefined }],
    ['an empty title', { title: '   ' }],
  ])('rejects an advisory with %s', (_label, overrides) => {
    const stdout = bunReport({ lodash: [bunAdvisory(overrides)] });

    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      'unrecognized-schema',
    );
  });

  it.each([
    ['a non-array CWE', { cwe: 'CWE-77' }],
    ['an invalid CWE entry', { cwe: ['CWE-77', ''] }],
    ['a non-object CVSS value', { cvss: 'CVSS:3.1' }],
    ['a non-finite CVSS score', { cvss: { score: Number.NaN, vectorString: null } }],
    ['a missing CVSS score', { cvss: { vectorString: null } }],
    ['an invalid CVSS vector', { cvss: { score: 7.2, vectorString: 3 } }],
  ])('rejects malformed optional details with %s', (_label, overrides) => {
    const stdout = bunReport({ lodash: [bunAdvisory(overrides)] });

    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      'unrecognized-schema',
    );
  });

  it.each([
    ['a missing severity', { severity: undefined }],
    ['a non-string severity', { severity: 4 }],
    ['an unknown severity', { severity: 'catastrophic' }],
    ['a missing vulnerable range', { vulnerable_versions: undefined }],
    ['a non-string vulnerable range', { vulnerable_versions: ['<4.17.21'] }],
    ['an empty vulnerable range', { vulnerable_versions: '   ' }],
  ])('rejects an advisory with %s', (_label, overrides) => {
    const stdout = bunReport({ lodash: [bunAdvisory(overrides)] });

    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      'unrecognized-schema',
    );
  });

  it('rejects the whole payload when a later advisory has an unknown severity', () => {
    const stdout = bunReport({
      lodash: [
        bunAdvisory({ id: 1, severity: 'low' }),
        bunAdvisory({ id: 2, severity: 'future-severity' }),
      ],
    });

    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 1 }),
      'unrecognized-schema',
    );
  });

  it.each([
    ['clean output with advisory exit 1', '{}', 1],
    ['clean output with unexpected exit 2', '{}', 2],
    ['advisories with clean exit 0', bunReport({ lodash: [bunAdvisory()] }), 0],
    ['advisories with unexpected exit 2', bunReport({ lodash: [bunAdvisory()] }), 2],
  ])('rejects %s as an incompatible schema/exit pair', (_label, stdout, exitCode) => {
    expectIncomplete(
      parseBunAuditOutcome({ command: 'bun', stdout, exitCode }),
      'unexpected-exit',
    );
  });

  it('rejects a missing process exit code before inferring a result', () => {
    const outcome = expectIncomplete(parseBunAuditOutcome({
      command: 'bun',
      stdout: '{}',
      exitCode: undefined,
    }), 'unexpected-exit');

    expect(outcome.detail).toContain('none');
  });

  it('keeps non-Error JSON parser failures bounded and incomplete', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new NonErrorParseFailure();
    });
    try {
      const outcome = expectIncomplete(parseBunAuditOutcome({
        command: 'bun', stdout: '{}', exitCode: 0,
      }), 'malformed-json');
      expect(outcome.detail).toContain('synthetic parse failure');
    }
    finally {
      parse.mockRestore();
    }
  });
});

describe('runBunAuditOutcome()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs bun audit --json in the requested project root', async () => {
    mockAuditSuccess('{}');

    expectClean(await runBunAuditOutcome(cwd));

    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'bun',
      ['audit', '--json'],
      {
        cwd,
        timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
        maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
        signal: undefined,
      },
    );
  });

  it('parses advisories written before native exit 1', async () => {
    mockAuditExit(1, bunReport({ lodash: [bunAdvisory()] }));

    const outcome = expectAdvisories(await runBunAuditOutcome(cwd));

    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
  });

  it('keeps unknown-command stdout incomplete instead of reporting clean', async () => {
    mockAuditExit(1, 'error: Unknown command "audit"');

    expectIncomplete(await runBunAuditOutcome(cwd), 'malformed-json');
  });

  it('keeps a non-zero exit without stdout incomplete', async () => {
    mockAuditProcess(Object.assign(new Error('Command failed'), { code: 1 }), '');

    expectIncomplete(await runBunAuditOutcome(cwd), 'empty-output');
  });

  it('reports a missing bun executable as a command-not-found error', async () => {
    mockAuditProcess(Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' }), '');

    expect(await runBunAuditOutcome(cwd)).toMatchObject({
      kind: 'error',
      reason: 'command-not-found',
    });
  });

  it('reports a process failure without an exit code as an error', async () => {
    mockAuditProcess(new Error('bun audit was terminated'), '');

    expect(await runBunAuditOutcome(cwd)).toMatchObject({
      kind: 'error',
      reason: 'process-failed',
      detail: expect.stringContaining('terminated'),
    });
  });

  it('describes a non-Error process rejection without inferring clean', async () => {
    mockAuditProcess('terminated by signal', '');

    expect(await runBunAuditOutcome(cwd)).toMatchObject({
      kind: 'error',
      reason: 'process-failed',
      detail: expect.stringContaining('terminated by signal'),
    });
  });
});

describe('runBunAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty result only for a recognized clean run', async () => {
    mockAuditSuccess('{}');

    await expect(runBunAudit(cwd)).resolves.toEqual({
      vulnerabilities: new Map(),
      total: 0,
      advisories: [],
      manager: 'bun',
      schema: 'bun-bulk-advisory',
    });
  });

  it('returns structured package severities for a recognized advisory run', async () => {
    mockAuditExit(1, bunReport({ lodash: [bunAdvisory()] }));

    const result = await runBunAudit(cwd);

    expect(result.total).toBe(1);
    expect(result.vulnerabilities.get('lodash')).toBe('high');
  });

  it('throws the typed boundary error for an unknown schema', async () => {
    mockAuditExit(1, '{"futureSchema":{"version":2}}');

    await expect(runBunAudit(cwd)).rejects.toBeInstanceOf(UnrecognizedAuditResultError);
  });
});