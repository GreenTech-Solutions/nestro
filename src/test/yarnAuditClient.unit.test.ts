import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  AUDIT_PROCESS_MAX_BUFFER_BYTES,
  AUDIT_PROCESS_TIMEOUT_MS,
  parseYarnAuditOutcome,
  runYarnAudit,
  runYarnAuditOutcome,
  UnrecognizedAuditResultError,
} from '../utils';
import type {
  AuditAdvisoriesOutcome,
  AuditCleanOutcome,
  AuditIncompleteOutcome,
  AuditIncompleteReason,
  AuditOutcome,
  YarnFamily,
} from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

const cwd = '/workspace/yarn-app';

function classicSummary(overrides: Record<string, number> = {}): string {
  return JSON.stringify({
    type: 'auditSummary',
    data: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        ...overrides,
      },
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
  });
}

function classicAdvisory(
  packageName: string,
  severity: string,
  id: number | string = 1,
): string {
  return JSON.stringify({
    type: 'auditAdvisory',
    data: {
      resolution: { id, path: packageName, dev: false, optional: false, bundled: false },
      advisory: {
        id,
        module_name: packageName,
        severity,
        title: 'Example advisory',
        url: 'https://example.test/advisory',
        vulnerable_versions: '<2.0.0',
      },
    },
  });
}

function modernAdvisory(
  packageName: string,
  severity: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    value: packageName,
    children: {
      ID: 1106913,
      Issue: 'Command Injection',
      URL: 'https://github.com/advisories/GHSA-example',
      Severity: severity,
      'Vulnerable Versions': '<4.17.21',
      'Tree Versions': ['4.17.20'],
      Dependents: ['workspace:.'],
      ...overrides,
    },
  });
}

function expectAdvisories(outcome: AuditOutcome): AuditAdvisoriesOutcome {
  if (outcome.kind !== 'advisories') {
    throw new Error(`Expected advisories, received ${outcome.kind}.`);
  }
  return outcome;
}

function expectClean(outcome: AuditOutcome): AuditCleanOutcome {
  if (outcome.kind !== 'clean') {
    throw new Error(`Expected clean, received ${outcome.kind}.`);
  }
  return outcome;
}

function expectIncomplete(outcome: AuditOutcome, reason: AuditIncompleteReason): AuditIncompleteOutcome {
  if (outcome.kind !== 'incomplete') {
    throw new Error(`Expected incomplete, received ${outcome.kind}.`);
  }
  expect(outcome.reason).toBe(reason);
  return outcome;
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
      detail: `yarn could not run: ${message}`,
      message,
      cause: err,
    });
  });
}

function mockAuditSuccess(stdout: string): void {
  mockAuditProcess(null, stdout);
}

function mockAuditExit(exitCode: number, stdout: string): void {
  mockAuditProcess(Object.assign(new Error(`Exit ${exitCode}`), { code: exitCode, stdout }), '');
}

describe('parseYarnAuditOutcome() — Classic', () => {
  it('recognizes the mandatory zero summary as clean on exit 0', () => {
    const outcome = expectClean(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout: `${classicSummary()}\n`,
      exitCode: 0,
    }));

    expect(outcome).toMatchObject({ schema: 'yarn-classic-audit', exitCode: 0, total: 0 });
  });

  it('recognizes a clean Classic summary despite Node deprecation warnings on stderr', () => {
    const outcome = expectClean(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stderr: '(node:123) [DEP0169] DeprecationWarning: url.parse() is deprecated\n'
        + '(node:123) [DEP0040] DeprecationWarning: punycode is deprecated',
      stdout: classicSummary(),
      exitCode: 0,
    }));

    expect(outcome).toMatchObject({ schema: 'yarn-classic-audit', exitCode: 0, total: 0 });
  });

  it('parses advisories, merges duplicate packages, and validates the severity mask', () => {
    const outcome = expectAdvisories(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout: [
        classicAdvisory('lodash', 'moderate', 1),
        classicAdvisory('lodash', 'high', 2),
        classicSummary({ moderate: 1, high: 1 }),
      ].join('\n'),
      exitCode: 12,
    }));

    expect(outcome).toMatchObject({ schema: 'yarn-classic-audit', exitCode: 12, total: 1 });
    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
  });

  it('accepts an info-only advisory with Classic bitmask exit 1', () => {
    const outcome = expectAdvisories(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout: `${classicAdvisory('legacy-package', 'info')}\n${classicSummary({ info: 1 })}`,
      exitCode: 1,
    }));

    expect(outcome.vulnerabilities.get('legacy-package')).toBe('info');
  });

  it('recognizes Classic advisories despite diagnostic stderr when summary and mask match', () => {
    const outcome = expectAdvisories(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stderr: '(node:456) [DEP0169] DeprecationWarning: url.parse() is deprecated',
      stdout: `${classicAdvisory('lodash', 'high')}\n${classicSummary({ high: 1 })}`,
      exitCode: 8,
    }));

    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
  });

  it.each([
    ['empty stdout with network stderr', '', 1, 'empty-output'],
    [
      'unknown informational stdout with network stderr',
      JSON.stringify({ type: 'info', data: 'Request failed: getaddrinfo ENOTFOUND registry.yarnpkg.com' }),
      1,
      'unrecognized-schema',
    ],
  ] as const)('keeps %s incomplete regardless of stderr diagnostics', (_label, stdout, exitCode, reason) => {
    expectIncomplete(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stderr: 'error An unexpected network error occurred.',
      stdout,
      exitCode,
    }), reason);
  });

  it.each([
    ['empty output', '', 0, 'empty-output'],
    ['malformed line', `${classicAdvisory('lodash', 'high')}\nnot-json\n${classicSummary({ high: 1 })}`, 8, 'malformed-json'],
    ['unknown record', `${JSON.stringify({ type: 'info', data: 'unknown command' })}\n${classicSummary()}`, 0, 'unrecognized-schema'],
    ['missing summary', classicAdvisory('lodash', 'high'), 8, 'unrecognized-schema'],
    ['non-final summary', `${classicSummary()}\n${classicAdvisory('lodash', 'high')}`, 8, 'unrecognized-schema'],
    ['duplicate summary', `${classicSummary()}\n${classicSummary()}`, 0, 'unrecognized-schema'],
    ['unknown severity', `${classicAdvisory('lodash', 'catastrophic')}\n${classicSummary({ high: 1 })}`, 8, 'unrecognized-schema'],
    ['findings without advisories', classicSummary({ high: 1 }), 8, 'summary-mismatch'],
    ['advisory not represented in summary', `${classicAdvisory('lodash', 'high')}\n${classicSummary({ moderate: 1 })}`, 4, 'summary-mismatch'],
    ['inflated advisory count', `${classicAdvisory('lodash', 'high')}\n${classicSummary({ high: 99 })}`, 8, 'summary-mismatch'],
    ['wrong severity bitmask', `${classicAdvisory('lodash', 'high')}\n${classicSummary({ high: 1 })}`, 1, 'unexpected-exit'],
    ['clean summary with advisory exit', classicSummary(), 8, 'unexpected-exit'],
  ] as const)('rejects %s', (_label, stdout, exitCode, reason) => {
    expectIncomplete(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout,
      exitCode,
    }), reason);
  });

  it('rejects an incomplete or malformed summary bucket set', () => {
    const summary = JSON.stringify({
      type: 'auditSummary',
      data: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: -1 } },
    });

    expectIncomplete(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout: summary,
      exitCode: 0,
    }), 'unrecognized-schema');
  });

  it('rejects a summary with a missing or invalid dependency counter', () => {
    const summary = JSON.parse(classicSummary()) as { data: Record<string, unknown> };
    summary.data.totalDependencies = -1;

    expectIncomplete(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout: JSON.stringify(summary),
      exitCode: 0,
    }), 'unrecognized-schema');
  });

  it.each([
    ['missing resolution path', { path: undefined }],
    ['empty resolution path', { path: '' }],
    ['non-boolean dev flag', { dev: 'false' }],
    ['non-boolean optional flag', { optional: 0 }],
    ['non-boolean bundled flag', { bundled: null }],
    ['resolution/advisory id mismatch', { id: 2 }],
  ])('rejects an advisory with %s', (_label, resolutionOverrides) => {
    const record = JSON.parse(classicAdvisory('lodash', 'high')) as {
      data: { resolution: Record<string, unknown> };
    };
    Object.assign(record.data.resolution, resolutionOverrides);

    expectIncomplete(parseYarnAuditOutcome('classic', {
      command: 'yarn',
      stdout: `${JSON.stringify(record)}\n${classicSummary({ high: 1 })}`,
      exitCode: 8,
    }), 'unrecognized-schema');
  });
});

describe('parseYarnAuditOutcome() — Modern', () => {
  it('recognizes only native empty stdout plus exit 0 as clean', () => {
    const outcome = expectClean(parseYarnAuditOutcome('modern', {
      command: 'yarn',
      stdout: '',
      exitCode: 0,
    }));

    expect(outcome).toMatchObject({ schema: 'yarn-modern-npm-audit', exitCode: 0, total: 0 });
  });

  it('refuses empty stdout as clean when the process produced stderr', () => {
    expectIncomplete(parseYarnAuditOutcome('modern', {
      command: 'yarn',
      stderr: 'Unknown command: npm audit',
      stdout: '',
      exitCode: 0,
    }), 'unrecognized-schema');
  });

  it('parses tree records, accepts string IDs, and merges duplicate package severities', () => {
    const outcome = expectAdvisories(parseYarnAuditOutcome('modern', {
      command: 'yarn',
      stdout: [
        modernAdvisory('lodash', 'low', { ID: 'YN-AUDIT-DEPRECATED' }),
        modernAdvisory('lodash', 'critical', { Future: 'additive child field' }),
      ].join('\n'),
      exitCode: 1,
    }));

    expect(outcome).toMatchObject({ schema: 'yarn-modern-npm-audit', exitCode: 1, total: 1 });
    expect(outcome.vulnerabilities.get('lodash')).toBe('critical');
  });

  it('accepts additive top-level fields on an otherwise recognized Modern tree record', () => {
    const record = JSON.parse(modernAdvisory('lodash', 'high')) as Record<string, unknown>;
    record.future = { schemaVersion: 2 };

    const outcome = expectAdvisories(parseYarnAuditOutcome('modern', {
      command: 'yarn', stdout: JSON.stringify(record), exitCode: 1,
    }));

    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
  });

  it('accepts an omitted URL but rejects an empty URL', () => {
    const withoutUrl = JSON.parse(modernAdvisory('lodash', 'high')) as { children: Record<string, unknown> };
    delete withoutUrl.children.URL;
    expectAdvisories(parseYarnAuditOutcome('modern', {
      command: 'yarn', stdout: JSON.stringify(withoutUrl), exitCode: 1,
    }));

    expectIncomplete(parseYarnAuditOutcome('modern', {
      command: 'yarn', stdout: modernAdvisory('lodash', 'high', { URL: '' }), exitCode: 1,
    }), 'unrecognized-schema');
  });

  it.each([
    ['whitespace-only clean output', ' \n', 0, 'unrecognized-schema'],
    ['empty advisory output', '', 1, 'empty-output'],
    ['malformed JSONL', '{"value":"lodash"', 1, 'malformed-json'],
    ['unknown top-level shape', '{"type":"auditSummary","data":{}}', 1, 'unrecognized-schema'],
    ['records with clean exit', modernAdvisory('lodash', 'high'), 0, 'unexpected-exit'],
    ['unexpected exit', modernAdvisory('lodash', 'high'), 2, 'unexpected-exit'],
    ['mixed valid and unknown records', `${modernAdvisory('lodash', 'high')}\n{}`, 1, 'unrecognized-schema'],
  ] as const)('rejects %s', (_label, stdout, exitCode, reason) => {
    expectIncomplete(parseYarnAuditOutcome('modern', {
      command: 'yarn', stdout, exitCode,
    }), reason);
  });

  it.each([
    ['empty package', { value: '' }],
    ['array children', { children: [] }],
    ['non-finite ID', { children: { ID: Number.POSITIVE_INFINITY } }],
    ['missing issue', { children: { Issue: undefined } }],
    ['unknown severity', { children: { Severity: 'catastrophic' } }],
    ['missing vulnerable versions', { children: { 'Vulnerable Versions': undefined } }],
    ['empty tree versions', { children: { 'Tree Versions': [] } }],
    ['invalid dependents', { children: { Dependents: [''] } }],
  ])('rejects a tree record with %s', (_label, overrides) => {
    const record = JSON.parse(modernAdvisory('lodash', 'high')) as Record<string, unknown>;
    const normalizedOverrides = overrides as Record<string, unknown>;
    const childOverrides = normalizedOverrides.children;
    if (typeof childOverrides === 'object' && childOverrides !== null && !Array.isArray(childOverrides)) {
      record.children = { ...(record.children as Record<string, unknown>), ...childOverrides };
    }
    else {
      Object.assign(record, normalizedOverrides);
    }

    expectIncomplete(parseYarnAuditOutcome('modern', {
      command: 'yarn', stdout: JSON.stringify(record), exitCode: 1,
    }), 'unrecognized-schema');
  });
});

describe('Yarn audit runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
      if (uri.fsPath === `${cwd}/package.json`) {
        return Promise.resolve(Buffer.from(JSON.stringify({ packageManager: 'yarn@4.6.0' })));
      }
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    });
  });

  it('runs the exact full-graph Modern command from the resolved project root', async () => {
    mockAuditSuccess('');

    expectClean(await runYarnAuditOutcome(cwd));
    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'yarn',
      ['npm', 'audit', '--all', '--recursive', '--json'],
      {
        cwd,
        timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
        maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
        signal: undefined,
      },
    );
  });

  it('runs the Classic command and accepts its advisory bitmask exit', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: 'yarn@1.22.19' })),
    );
    mockAuditExit(8, `${classicAdvisory('lodash', 'high')}\n${classicSummary({ high: 1 })}`);

    const outcome = expectAdvisories(await runYarnAuditOutcome(cwd));
    expect(outcome.vulnerabilities.get('lodash')).toBe('high');
    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'yarn',
      ['audit', '--json'],
      {
        cwd,
        timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
        maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
        signal: undefined,
      },
    );
  });

  it('does not spawn an audit command when conflicting markers leave the family unknown', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
      const files: Record<string, string> = {
        [`${cwd}/package.json`]: '{}',
        [`${cwd}/.yarnrc.yml`]: 'nodeLinker: node-modules',
        [`${cwd}/.yarnrc`]: '--install.offline true',
      };
      const value = files[uri.fsPath];
      return value === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(Buffer.from(value));
    });

    expectIncomplete(await runYarnAuditOutcome(cwd), 'unknown-yarn-family');
    expect(runBoundedProcessMock).not.toHaveBeenCalled();
  });

  it('classifies a missing executable after a recognized family as a command-not-found error', async () => {
    mockAuditProcess(Object.assign(new Error('spawn yarn ENOENT'), { code: 'ENOENT' }), '');

    await expect(runYarnAuditOutcome(cwd)).resolves.toMatchObject({
      kind: 'error', reason: 'command-not-found',
    });
  });

  it.each([
    ['classic', 'yarn@1.22.19', 'ENOENT', 'command-not-found', 'yarn classic audit could not run: spawn yarn ENOENT'],
    ['berry', 'yarn@4.6.0', 'EACCES', 'process-failed', 'yarn berry audit could not run: spawn yarn EACCES'],
  ] as const)('keeps the %s family and first error line in spawn-error text', async (_label, packageManager, code, reason, detail) => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager })),
    );
    const message = `spawn yarn ${code}\nstderr line 2`;
    mockAuditProcess(Object.assign(new Error(message), { code }), '');

    await expect(runYarnAuditOutcome(cwd)).resolves.toEqual({
      kind: 'error',
      reason,
      detail,
    });
  });

  it('preserves stderr from a rejected audit instead of inferring a clean result', async () => {
    mockAuditProcess(Object.assign(new Error('audit warning'), {
      code: 1,
      stderr: 'network response was incomplete',
      stdout: '',
    }), '');

    expectIncomplete(await runYarnAuditOutcome(cwd), 'unrecognized-schema');
  });

  it('throws the typed boundary error rather than returning false clean', async () => {
    mockAuditExit(1, '{"future":"schema"}');

    await expect(runYarnAudit(cwd)).rejects.toBeInstanceOf(UnrecognizedAuditResultError);
  });
});

describe('parseYarnAuditOutcome() — unknown family', () => {
  it.each(['classic', 'modern', 'future'] as const)('never guesses %s output', (label) => {
    const stdout = label === 'classic' ? classicSummary() : label === 'modern' ? '' : '{}';
    expectIncomplete(parseYarnAuditOutcome('unknown' as YarnFamily, {
      command: 'yarn', stdout, exitCode: 0,
    }), 'unknown-yarn-family');
  });
});