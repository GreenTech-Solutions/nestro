import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileException, ExecFileOptions } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getExecExitCode,
  getExecStdout,
  mergeSeverity,
  parseAuditOutcome,
  parseSeverity,
  runAuditOutcome,
  runNpmAudit,
  runPackageAudit,
  toAuditResult,
  UnrecognizedAuditResultError,
} from '../utils';
import type {
  AuditAdvisoriesOutcome,
  AuditCleanOutcome,
  AuditIncompleteOutcome,
  AuditIncompleteReason,
  AuditOutcome,
  AuditResult,
  AuditSeverity,
} from '../utils';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

type ExecFileCallback = NonNullable<Parameters<typeof execFile>[3]>;

const cwd = '/workspace';
const auditArgs = ['audit', '--json'];

function mockAuditProcess(err: unknown, stdout: string): void {
  vi.mocked(execFile).mockImplementationOnce((
    _file: string,
    _args: readonly string[] | null | undefined,
    _options: ExecFileOptions | null | undefined,
    callback: ExecFileCallback | null | undefined,
  ) => {
    if (callback === undefined || callback === null) {
      throw new Error('Expected execFile callback.');
    }
    callback(err as ExecFileException, stdout, '');
    return {} as ChildProcess;
  });
}

/** Successful run: exit code 0. */
function mockAuditSuccess(stdout: string): void {
  mockAuditProcess(null, stdout);
}

/** Rejected run: the process exited with `exitCode` after writing `stdout`. */
function mockAuditExit(exitCode: number, stdout: string): void {
  mockAuditProcess(Object.assign(new Error(`Command failed with exit code ${exitCode}`), { code: exitCode, stdout }), '');
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

const npmSummary = (total: number, high: number, moderate: number) => ({
  vulnerabilities: { info: 0, low: 0, moderate, high, critical: 0, total },
  dependencies: { prod: 2, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 3 },
});

const pnpmSummary = (total: number, high: number, moderate: number) => ({
  vulnerabilities: { info: 0, low: 0, moderate, high, critical: 0, total },
  dependencies: 2,
  devDependencies: 1,
  optionalDependencies: 0,
  totalDependencies: 3,
});

interface ManagerFixture {
  manager: string;
  /** Two readable advisories: react (high) and eslint (moderate). */
  advisories: string;
  /** Documented report with zero findings. */
  clean: string;
  /** Report body without the version/summary marker of its schema. */
  markerless: string;
  /** Recognized schema whose entries cannot be read while the summary claims findings. */
  summaryMismatch: string;
  runAudit: (auditCwd: string) => Promise<AuditResult>;
}

const managerFixtures: ManagerFixture[] = [
  {
    manager: 'npm',
    advisories: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        react: { name: 'react', severity: 'high', isDirect: true, range: '<18.0.1', fixAvailable: true },
        eslint: { name: 'eslint', severity: 'moderate', isDirect: false, range: '<8.57.0', fixAvailable: false },
      },
      metadata: npmSummary(2, 1, 1),
    }),
    clean: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: npmSummary(0, 0, 0),
    }),
    markerless: JSON.stringify({
      vulnerabilities: { react: { name: 'react', severity: 'high' } },
    }),
    summaryMismatch: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: { react: { name: 'react', severity: 'catastrophic' } },
      metadata: npmSummary(1, 1, 0),
    }),
    runAudit: runNpmAudit,
  },
  {
    manager: 'pnpm',
    advisories: JSON.stringify({
      actions: [],
      advisories: {
        1092461: { module_name: 'react', severity: 'high', title: 'Prototype pollution', url: 'https://example.test/1' },
        1096520: { module_name: 'eslint', severity: 'moderate', title: 'ReDoS', url: 'https://example.test/2' },
      },
      muted: [],
      metadata: pnpmSummary(2, 1, 1),
    }),
    clean: JSON.stringify({
      actions: [],
      advisories: {},
      muted: [],
      metadata: pnpmSummary(0, 0, 0),
    }),
    markerless: JSON.stringify({
      advisories: { 1092461: { module_name: 'react', severity: 'high' } },
    }),
    summaryMismatch: JSON.stringify({
      actions: [],
      advisories: { 1092461: { module_name: 'react', severity: 'catastrophic' } },
      muted: [],
      metadata: pnpmSummary(1, 1, 0),
    }),
    runAudit: (auditCwd: string) => runPackageAudit('pnpm', auditCwd),
  },
];

describe.each(managerFixtures)('$manager audit result contract', (fixture) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recognizes advisories reported on a zero exit code', async () => {
    mockAuditSuccess(fixture.advisories);

    const outcome = expectAdvisories(await runAuditOutcome(fixture.manager, auditArgs, cwd));

    expect(outcome.total).toBe(2);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.vulnerabilities.get('react')).toBe('high');
    expect(outcome.vulnerabilities.get('eslint')).toBe('moderate');
    expect(vi.mocked(execFile).mock.calls[0][0]).toBe(fixture.manager);
  });

  it('recognizes advisories reported through the advisory exit code', async () => {
    mockAuditExit(1, fixture.advisories);

    const outcome = expectAdvisories(await runAuditOutcome(fixture.manager, auditArgs, cwd));

    expect(outcome.total).toBe(2);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.vulnerabilities.get('react')).toBe('high');
  });

  it('confirms a clean result only from a documented report on a zero exit code', async () => {
    mockAuditSuccess(fixture.clean);

    const outcome = expectClean(await runAuditOutcome(fixture.manager, auditArgs, cwd));

    expect(outcome.total).toBe(0);
    expect(outcome.vulnerabilities.size).toBe(0);
    expect(outcome.exitCode).toBe(0);
  });

  it('treats empty stdout as incomplete', async () => {
    mockAuditSuccess('');

    const outcome = await runAuditOutcome(fixture.manager, auditArgs, cwd);

    expect(expectIncomplete(outcome, 'empty-output').detail).toContain(fixture.manager);
  });

  it('treats whitespace-only stdout as incomplete', async () => {
    mockAuditSuccess('   \n\t\n');

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'empty-output');
  });

  it('treats malformed JSON as incomplete', async () => {
    mockAuditSuccess('audit output is not json');

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'malformed-json');
  });

  it('treats truncated JSON as incomplete', async () => {
    mockAuditSuccess(fixture.advisories.slice(0, 60));

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'malformed-json');
  });

  it('treats a report without its schema marker as incomplete', async () => {
    mockAuditSuccess(fixture.markerless);

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'unrecognized-schema');
  });

  it('treats unknown-command output as incomplete', async () => {
    mockAuditExit(1, `Unknown command: "audit"\nUsage: ${fixture.manager} <command>\n`);

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'malformed-json');
  });

  it('treats an unexpected exit code as incomplete even with a documented report', async () => {
    mockAuditExit(2, fixture.clean);

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'unexpected-exit');
  });

  // The case above uses a zero-finding report, so it is also rejected by the
  // separate `exitCode !== 0` guard — widening the compatible exit codes alone
  // would not turn it green. A report that does carry findings pins the exit
  // code contract on its own.
  it('rejects an unexpected exit code even when the report carries findings', async () => {
    mockAuditExit(2, fixture.advisories);

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'unexpected-exit');
  });

  it('refuses to confirm clean when a zero-finding report exits non-zero', async () => {
    mockAuditExit(1, fixture.clean);

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'unexpected-exit');
  });

  it('treats a summary that disagrees with the readable advisories as incomplete', async () => {
    mockAuditSuccess(fixture.summaryMismatch);

    expectIncomplete(await runAuditOutcome(fixture.manager, auditArgs, cwd), 'summary-mismatch');
  });

  it('returns an empty result for a confirmed clean report', async () => {
    mockAuditSuccess(fixture.clean);

    const result = await fixture.runAudit(cwd);

    expect(result.total).toBe(0);
    expect(result.vulnerabilities.size).toBe(0);
  });

  it('returns parsed vulnerabilities for a recognized advisory report', async () => {
    mockAuditSuccess(fixture.advisories);

    const result = await fixture.runAudit(cwd);

    expect(result.total).toBe(2);
    expect(result.vulnerabilities.get('react')).toBe('high');
  });

  it('throws instead of reporting no vulnerabilities for an unrecognized report', async () => {
    mockAuditSuccess(JSON.stringify({ foo: 'bar' }));

    await expect(fixture.runAudit(cwd)).rejects.toBeInstanceOf(UnrecognizedAuditResultError);
  });
});

describe('parseAuditOutcome()', () => {
  it('treats a missing exit code as incomplete', () => {
    const outcome = parseAuditOutcome({ command: 'npm', stdout: '{}', exitCode: undefined });

    expect(expectIncomplete(outcome, 'unexpected-exit').detail).toContain('none');
  });

  it.each([
    ['an array', '[]'],
    ['a null literal', 'null'],
    ['a number literal', '5'],
    ['an object without a known report section', '{"error":{"code":"ENOLOCK"}}'],
    ['an empty object', '{}'],
    ['an advisories section without its summary marker', '{"advisories":{}}'],
    // Bun returns the raw npm bulk advisory response; its adapter lands in AUD-05C. Until
    // then the npm/pnpm parser must reject it instead of reading it as zero findings.
    ['a bun bulk advisory response', '{"react":[{"id":1,"severity":"high","title":"XSS"}]}'],
  ])('treats %s as an unrecognized schema', (_label, stdout) => {
    expectIncomplete(parseAuditOutcome({ command: 'npm', stdout, exitCode: 0 }), 'unrecognized-schema');
  });

  it('recognizes an npm report that carries only the report-version marker', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: { react: { severity: 'critical' } },
      }),
      exitCode: 1,
    });

    expect(expectAdvisories(outcome).vulnerabilities.get('react')).toBe('critical');
  });

  it.each([
    ['a summary without a vulnerabilities section', { dependencies: 3 }],
    ['a summary total that is not a number', { vulnerabilities: { total: 'many' } }],
  ])('confirms clean for a documented report with %s', (_label, metadata) => {
    const outcome = parseAuditOutcome({
      command: 'pnpm',
      stdout: JSON.stringify({ advisories: {}, metadata }),
      exitCode: 0,
    });

    expect(expectClean(outcome).schema).toBe('npm-v1-advisories');
  });

  it('skips entries that are not advisory objects', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: { react: 'unexpected', eslint: { severity: 'low' } },
        metadata: npmSummary(2, 0, 0),
      }),
      exitCode: 1,
    });

    const advisories = expectAdvisories(outcome);
    expect(advisories.total).toBe(1);
    expect(advisories.vulnerabilities.has('react')).toBe(false);
  });

  it('skips advisories with an unknown severity or without a module name', () => {
    const outcome = parseAuditOutcome({
      command: 'pnpm',
      stdout: JSON.stringify({
        advisories: {
          1: { module_name: 'lodash', severity: 'high' },
          2: { severity: 'critical' },
          3: { module_name: '', severity: 'critical' },
          4: { module_name: 'express', severity: 'catastrophic' },
        },
        metadata: pnpmSummary(4, 1, 0),
      }),
      exitCode: 1,
    });

    const advisories = expectAdvisories(outcome);
    expect([...advisories.vulnerabilities.keys()]).toEqual(['lodash']);
  });

  it('keeps the highest severity for advisories that share a module name', () => {
    const outcome = parseAuditOutcome({
      command: 'pnpm',
      stdout: JSON.stringify({
        advisories: {
          1: { module_name: 'lodash', severity: 'moderate' },
          2: { module_name: 'lodash', severity: 'critical' },
          3: { module_name: 'lodash', severity: 'low' },
        },
        metadata: pnpmSummary(3, 0, 1),
      }),
      exitCode: 1,
    });

    const advisories = expectAdvisories(outcome);
    expect(advisories.total).toBe(1);
    expect(advisories.vulnerabilities.get('lodash')).toBe('critical');
  });

  it('keeps distinct npm dependency paths apart', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          react: { severity: 'low' },
          'react/node_modules/debug': { severity: 'high' },
        },
        metadata: npmSummary(2, 1, 0),
      }),
      exitCode: 1,
    });

    const advisories = expectAdvisories(outcome);
    expect(advisories.vulnerabilities.get('react')).toBe('low');
    expect(advisories.vulnerabilities.get('react/node_modules/debug')).toBe('high');
  });
});

describe('runAuditOutcome() process failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a missing executable as a command-not-found error', async () => {
    mockAuditProcess(Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' }), '');

    const outcome = await runAuditOutcome('bun', auditArgs, cwd);

    expect(outcome.kind).toBe('error');
    expect(outcome).toMatchObject({ reason: 'command-not-found' });
  });

  it('reports a failure without an exit code as a process error', async () => {
    mockAuditProcess(new Error('npm not found'), '');

    const outcome = await runAuditOutcome('npm', auditArgs, cwd);

    expect(outcome.kind).toBe('error');
    expect(outcome).toMatchObject({ reason: 'process-failed', detail: expect.stringContaining('npm not found') });
  });

  it('describes a non-Error rejection value', async () => {
    mockAuditProcess({ killed: true }, '');

    const outcome = await runAuditOutcome('npm', auditArgs, cwd);

    expect(outcome).toMatchObject({ kind: 'error', reason: 'process-failed' });
  });

  it('treats a non-zero exit without stdout as incomplete', async () => {
    mockAuditProcess(Object.assign(new Error('Command failed'), { code: 1 }), '');

    expectIncomplete(await runAuditOutcome('npm', auditArgs, cwd), 'empty-output');
  });

  it('throws an error carrying the outcome when the process could not run', async () => {
    mockAuditProcess(new Error('npm not found'), '');

    await expect(runNpmAudit(cwd)).rejects.toThrow('npm not found');
  });
});

describe('toAuditResult()', () => {
  it('passes a clean outcome through as an empty result', () => {
    const result = toAuditResult({
      kind: 'clean',
      schema: 'npm-v2-vulnerabilities',
      exitCode: 0,
      vulnerabilities: new Map(),
      total: 0,
    });

    expect(result).toEqual({ vulnerabilities: new Map(), total: 0 });
  });

  it('passes an advisories outcome through with its vulnerabilities', () => {
    const vulnerabilities = new Map<string, AuditSeverity>([['react', 'high']]);

    const result = toAuditResult({
      kind: 'advisories',
      schema: 'npm-v2-vulnerabilities',
      exitCode: 1,
      vulnerabilities,
      total: 1,
    });

    expect(result.total).toBe(1);
    expect(result.vulnerabilities).toBe(vulnerabilities);
  });

  it.each([
    ['incomplete', { kind: 'incomplete', reason: 'empty-output', detail: 'npm audit produced no output.' }],
    ['error', { kind: 'error', reason: 'process-failed', detail: 'npm audit could not run: boom' }],
  ] as [string, AuditOutcome][])('throws for an %s outcome instead of returning an empty result', (_label, outcome) => {
    expect(() => toAuditResult(outcome)).toThrow(UnrecognizedAuditResultError);
    try {
      toAuditResult(outcome);
    }
    catch (err) {
      expect((err as UnrecognizedAuditResultError).outcome).toBe(outcome);
    }
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

describe('getExecExitCode()', () => {
  it.each([
    ['a plain string error', 'not an object', undefined],
    ['null', null, undefined],
    ['an object without a code property', {}, undefined],
    ['a spawn error code', { code: 'ENOENT' }, undefined],
    ['a numeric exit code', { code: 2 }, 2],
  ] as [string, unknown, number | undefined][])('handles %s', (_label, err, expected) => {
    expect(getExecExitCode(err)).toBe(expected);
  });
});