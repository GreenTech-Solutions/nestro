import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_PROCESS_MAX_BUFFER_BYTES, AUDIT_PROCESS_TIMEOUT_MS } from '../config';
import { createAuditAdvisory } from '../utils';
import { isAdvisoryId, parseFixAvailable } from '../utils/audit/fields';
import {
  buildRecognizedOutcome,
  readAuditJsonDocument,
  runAuditCommand,
} from '../utils/audit/outcome';
import type { AuditExecution, AuditOutcome } from '../utils/audit/outcome';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

function execution(overrides: Partial<AuditExecution> = {}): AuditExecution {
  return { command: 'npm', stdout: '{}', exitCode: 0, ...overrides };
}

function advisory(packageName: string, severity: 'high' | 'low', advisoryId: string): ReturnType<typeof createAuditAdvisory> {
  return createAuditAdvisory({ packageName, severity, manager: 'npm', schema: 'npm-v2-vulnerabilities', advisoryId });
}

describe('readAuditJsonDocument()', () => {
  it('returns the parsed document together with its advisory exit code', () => {
    expect(readAuditJsonDocument(execution({ stdout: ' {"a":1}\n', exitCode: 1 })))
      .toEqual({ kind: 'json', json: { a: 1 }, exitCode: 1 });
  });

  it.each([
    [undefined, 'unexpected-exit'],
    [2, 'unexpected-exit'],
  ])('rejects exit code %s', (exitCode, reason) => {
    expect(readAuditJsonDocument(execution({ exitCode }))).toMatchObject({ kind: 'incomplete', reason });
  });

  it('reports empty and malformed output as incomplete', () => {
    expect(readAuditJsonDocument(execution({ stdout: '  \n' }))).toMatchObject({ reason: 'empty-output' });
    expect(readAuditJsonDocument(execution({ stdout: '{' }))).toMatchObject({ reason: 'malformed-json' });
  });
});

describe('buildRecognizedOutcome()', () => {
  it('builds a clean outcome when there are no advisories', () => {
    expect(buildRecognizedOutcome('bun-bulk-advisory', 'bun', 0, [])).toEqual({
      kind: 'clean',
      schema: 'bun-bulk-advisory',
      manager: 'bun',
      exitCode: 0,
      vulnerabilities: new Map(),
      advisories: [],
      total: 0,
    });
  });

  it('sorts advisories by identity and keeps the worst severity per package', () => {
    const outcome = buildRecognizedOutcome('npm-v2-vulnerabilities', 'npm', 1, [
      advisory('b-pkg', 'low', '2'),
      advisory('a-pkg', 'low', '9'),
      advisory('a-pkg', 'high', '1'),
    ]);

    expect(outcome.kind).toBe('advisories');
    expect(outcome.total).toBe(2);
    expect([...outcome.vulnerabilities]).toEqual([['a-pkg', 'high'], ['b-pkg', 'low']]);
    const identities = (outcome.advisories ?? []).map(entry => entry.identity);
    expect(identities).toEqual([...identities].sort((left, right) => left.localeCompare(right)));
  });
});

describe('runAuditCommand()', () => {
  beforeEach(() => {
    runBoundedProcessMock.mockReset();
  });

  const audit = { command: 'yarn', args: ['audit', '--json'], cwd: '/workspace' };

  it('runs the bounded process with the audit limits and hands an exit to the parser', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({ kind: 'exit', stdout: 'out', stderr: 'err', exitCode: 1 });
    const parsed: AuditOutcome = { kind: 'incomplete', reason: 'empty-output', detail: 'parsed' };
    const parse = vi.fn(() => parsed);

    await expect(runAuditCommand(audit, parse)).resolves.toBe(parsed);

    expect(runBoundedProcessMock).toHaveBeenCalledWith('yarn', ['audit', '--json'], {
      cwd: '/workspace',
      timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
      maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
      signal: undefined,
    });
    expect(parse).toHaveBeenCalledWith({ command: 'yarn', stdout: 'out', stderr: 'err', exitCode: 1 });
  });

  it('maps a terminated process without calling the parser', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({ kind: 'timeout', timeoutMs: 5 });
    const parse = vi.fn();

    await expect(runAuditCommand(audit, parse)).resolves.toMatchObject({ kind: 'incomplete', reason: 'timeout' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('lets the caller describe a spawn failure and defaults to the generic message', async () => {
    const spawnError = { kind: 'spawn-error', reason: 'command-not-found', detail: 'generic', message: 'm', cause: undefined };
    runBoundedProcessMock.mockResolvedValue(spawnError);
    const parse = vi.fn();

    await expect(runAuditCommand(audit, parse)).resolves.toEqual({
      kind: 'error',
      reason: 'command-not-found',
      detail: 'generic',
    });
    await expect(runAuditCommand(audit, parse, outcome => ({
      kind: 'error',
      reason: outcome.reason,
      detail: 'custom',
    }))).resolves.toMatchObject({ detail: 'custom' });
  });
});

describe('audit field readers', () => {
  it('accepts finite numbers and non-blank strings as advisory ids', () => {
    expect([1, 'GHSA-1', Number.NaN, ' ', undefined].map(isAdvisoryId)).toEqual([true, true, false, false, false]);
  });

  it('parses booleans and fix objects and drops empty fix objects', () => {
    expect(parseFixAvailable(true)).toBe(true);
    expect(parseFixAvailable({ name: 'x', version: '1.0.0', isSemVerMajor: false }))
      .toEqual({ name: 'x', version: '1.0.0', isSemVerMajor: false });
    expect(parseFixAvailable({ name: ' ' })).toBeUndefined();
    expect(parseFixAvailable('yes')).toBeUndefined();
  });
});