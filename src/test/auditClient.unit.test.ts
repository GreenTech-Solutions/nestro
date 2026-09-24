import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_PROCESS_MAX_BUFFER_BYTES,
  AUDIT_PROCESS_TIMEOUT_MS,
  describeBoundedProcessFailure,
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
  AuditErrorOutcome,
  AuditIncompleteOutcome,
  AuditIncompleteReason,
  AuditOutcome,
  AuditResult,
  AuditSeverity,
} from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

vi.mock('../utils/logger', () => ({ logger: loggerMock }));

const cwd = '/workspace';
const auditArgs = ['audit', '--json'];

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
      detail: `audit command could not run: ${message}`,
      message,
      cause: err,
    });
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
    expect(runBoundedProcessMock.mock.calls[0][0]).toBe(fixture.manager);
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

  // The case above uses a zero-finding report, so it's also rejected by the separate
  // `exitCode !== 0` guard — widening the compatible exit codes alone would not turn it
  // green. This case carries findings, so it pins the exit code contract on its own.
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
    // Bun returns the raw npm bulk advisory response through its own adapter. The shared
    // npm/pnpm parser must keep rejecting that shape instead of guessing a manager family.
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

  it('does not route an unknown command through the npm parser fallback', () => {
    const outcome = parseAuditOutcome({
      command: 'bun',
      stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }),
      exitCode: 0,
    });

    expect(expectIncomplete(outcome, 'unrecognized-schema').detail).toContain('not handled');
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

// Real `npm audit --json` output (auditReportVersion 2, npm 11.17), captured against a
// disposable fixture project and trimmed to five packages. Every key and value below is
// copied verbatim from that run — npm v2 never reports an installed version, only `nodes`.
const REAL_NPM_AUDIT_V2_DOCUMENT = {
  auditReportVersion: 2,
  vulnerabilities: {
    axios: {
      name: 'axios',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1111034,
          name: 'axios',
          dependency: 'axios',
          title: 'axios Requests Vulnerable To Possible SSRF and Credential Leakage via Absolute URL',
          url: 'https://github.com/advisories/GHSA-jr5f-v2jv-69x6',
          severity: 'high',
          cwe: [
            'CWE-918',
          ],
          cvss: {
            score: 0,
            vectorString: null,
          },
          range: '<0.30.0',
        },
      ],
      effects: [],
      range: '<=0.32.0',
      nodes: [
        'node_modules/axios',
      ],
      fixAvailable: {
        name: 'axios',
        version: '1.20.0',
        isSemVerMajor: true,
      },
    },
    esbuild: {
      name: 'esbuild',
      severity: 'moderate',
      isDirect: false,
      via: [
        {
          source: 1102341,
          name: 'esbuild',
          dependency: 'esbuild',
          title: 'esbuild enables any website to send any requests to the development server and read the response',
          url: 'https://github.com/advisories/GHSA-67mh-4wv8-2f99',
          severity: 'moderate',
          cwe: [
            'CWE-346',
          ],
          cvss: {
            score: 5.3,
            vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N',
          },
          range: '<=0.24.2',
        },
      ],
      effects: [
        'vite',
      ],
      range: '<=0.24.2',
      nodes: [
        'node_modules/esbuild',
      ],
      fixAvailable: {
        name: 'vitest',
        version: '5.0.1',
        isSemVerMajor: true,
      },
    },
    lodash: {
      name: 'lodash',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1106913,
          name: 'lodash',
          dependency: 'lodash',
          title: 'Command Injection in lodash',
          url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
          severity: 'high',
          cwe: [
            'CWE-77',
            'CWE-94',
          ],
          cvss: {
            score: 7.2,
            vectorString: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H',
          },
          range: '<4.17.21',
        },
      ],
      effects: [],
      range: '<=4.17.23',
      nodes: [
        'node_modules/lodash',
      ],
      fixAvailable: {
        name: 'lodash',
        version: '4.18.1',
        isSemVerMajor: false,
      },
    },
    vite: {
      name: 'vite',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1123525,
          name: 'vite',
          dependency: 'vite',
          title: 'vite: `server.fs.deny` bypass on Windows alternate paths',
          url: 'https://github.com/advisories/GHSA-fx2h-pf6j-xcff',
          severity: 'high',
          cwe: [
            'CWE-22',
            'CWE-200',
          ],
          cvss: {
            score: 7.5,
            vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
          },
          range: '<=6.4.2',
        },
        'esbuild',
      ],
      effects: [
        'vite-node',
        'vitest',
      ],
      range: '<=6.4.2',
      nodes: [
        'node_modules/vite',
      ],
      fixAvailable: {
        name: 'vitest',
        version: '5.0.1',
        isSemVerMajor: true,
      },
    },
    vitest: {
      name: 'vitest',
      severity: 'critical',
      isDirect: true,
      via: [
        {
          source: 1139528,
          name: 'vitest',
          dependency: 'vitest',
          title: 'When Vitest UI server is listening, arbitrary file can be read and executed',
          url: 'https://github.com/advisories/GHSA-5xrq-8626-4rwp',
          severity: 'critical',
          cwe: [
            'CWE-22',
            'CWE-862',
          ],
          cvss: {
            score: 9.8,
            vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
          },
          range: '<3.2.6',
        },
        'vite',
        'vite-node',
      ],
      effects: [],
      range: '<=3.2.5',
      nodes: [
        'node_modules/vitest',
      ],
      fixAvailable: {
        name: 'vitest',
        version: '5.0.1',
        isSemVerMajor: true,
      },
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 1,
      high: 3,
      critical: 1,
      total: 5,
    },
    dependencies: {
      prod: 86,
      dev: 203,
      optional: 50,
      peer: 0,
      peerOptional: 0,
      total: 288,
    },
  },
};

describe('parseAuditOutcome() real npm v2 document', () => {
  it('captures each package\'s node path and severity without inventing a resolved version', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      stdout: JSON.stringify(REAL_NPM_AUDIT_V2_DOCUMENT),
      exitCode: 1,
    });

    const result = toAuditResult(expectAdvisories(outcome));
    const byPackage = new Map(result.advisories.map(advisory => [advisory.packageName, advisory]));

    expect(result.vulnerabilities).toEqual(new Map([
      ['axios', 'high'],
      ['esbuild', 'moderate'],
      ['lodash', 'high'],
      ['vite', 'high'],
      ['vitest', 'critical'],
    ]));
    // Direct dependencies: the schema's only version-shaped hint is the `nodes` path.
    expect(byPackage.get('axios')).toMatchObject({
      attribution: 'direct',
      resolvedPaths: ['node_modules/axios'],
      resolvedVersions: [],
    });
    expect(byPackage.get('lodash')).toMatchObject({
      attribution: 'direct',
      resolvedPaths: ['node_modules/lodash'],
      resolvedVersions: [],
    });
    expect(byPackage.get('vitest')).toMatchObject({
      attribution: 'direct',
      resolvedPaths: ['node_modules/vitest'],
      resolvedVersions: [],
    });
    // Transitive dependencies (`isDirect: false`): never eligible for row attribution.
    expect(byPackage.get('esbuild')).toMatchObject({ attribution: 'transitive', resolvedVersions: [] });
    expect(byPackage.get('vite')).toMatchObject({ attribution: 'transitive', resolvedVersions: [] });
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

/** Minimal valid npm v2 clean report: no findings, with its version and summary markers. */
function npmCleanReport(): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  });
}

describe('runAuditOutcome() bounded-process termination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never reports clean for output truncated by the buffer limit', async () => {
    mockAuditProcess(
      Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        // A truncated prefix of a real clean report — proves the (possibly still
        // syntactically valid) partial stdout is never inspected once the runner
        // reports overflow, not just that a full clean report is rejected.
        stdout: npmCleanReport().slice(0, 20),
      }),
      '',
    );

    const outcome = expectIncomplete(await runAuditOutcome('npm', auditArgs, cwd), 'output-overflow');
    expect(outcome.detail).toContain(String(AUDIT_PROCESS_MAX_BUFFER_BYTES));
  });

  it('never reports clean for a run cancelled before it produced a result', async () => {
    const controller = new AbortController();
    controller.abort();
    runBoundedProcessMock.mockResolvedValueOnce({ kind: 'aborted' });

    const outcome = await runAuditOutcome('npm', auditArgs, cwd, controller.signal);

    expectIncomplete(outcome, 'aborted');
    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'npm',
      auditArgs,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('passes maxBuffer, timeout-backed signal and cwd through to the child process', async () => {
    mockAuditSuccess(npmCleanReport());

    await runAuditOutcome('npm', auditArgs, cwd);

    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'npm',
      auditArgs,
      {
        cwd,
        timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
        maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
        signal: undefined,
      },
    );
  });
});

describe('describeBoundedProcessFailure()', () => {
  it('maps a timeout to an incomplete outcome that names the bound', () => {
    const outcome = describeBoundedProcessFailure('npm', { kind: 'timeout', timeoutMs: 120_000 });

    expect(outcome).toMatchObject({ kind: 'incomplete', reason: 'timeout' });
    expect((outcome as AuditIncompleteOutcome).detail).toContain('120000');
  });

  it('maps an external cancellation to an incomplete outcome', () => {
    const outcome = describeBoundedProcessFailure('npm', { kind: 'aborted' });

    expect(outcome).toMatchObject({ kind: 'incomplete', reason: 'aborted' });
  });

  it('logs a bounded timeout exactly once at the audit domain boundary', () => {
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();

    describeBoundedProcessFailure('npm', { kind: 'timeout', timeoutMs: 120_000 });

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('maps a buffer overflow to an incomplete outcome that names the limit', () => {
    const outcome = describeBoundedProcessFailure('npm', { kind: 'overflow', maxBufferBytes: 1024 });

    expect(outcome).toMatchObject({ kind: 'incomplete', reason: 'output-overflow' });
    expect((outcome as AuditIncompleteOutcome).detail).toContain('1024');
  });

  it.each(['command-not-found', 'process-failed'] as const)(
    'maps a %s spawn error to an error outcome',
    (reason) => {
      const outcome = describeBoundedProcessFailure('npm', {
        kind: 'spawn-error',
        reason,
        detail: 'boom',
        message: 'boom',
        cause: undefined,
      });

      expect(outcome).toEqual<AuditErrorOutcome>({ kind: 'error', reason, detail: 'boom' });
    },
  );

  it('logs a bounded spawn error exactly once at the audit domain boundary', () => {
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();

    describeBoundedProcessFailure('npm', {
      kind: 'spawn-error',
      reason: 'process-failed',
      detail: 'npm could not run: boom',
      message: 'boom',
      cause: undefined,
    });

    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
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

    expect(result).toEqual({
      vulnerabilities: new Map(),
      total: 0,
      advisories: [],
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
    });
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