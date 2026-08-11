import { describe, expect, it, vi } from 'vitest';
import {
  evaluateSignatureAudit,
  MINIMUM_SIGNATURE_AUDIT_PNPM_VERSION,
  parseSignatureAuditArgs,
  resolvePnpmExecutable,
  runSignatureAuditCli,
  SIGNATURE_AUDIT_ARGS,
} from '../tools';
import type { SignatureAuditCliDependencies, SignatureAuditExecution } from '../tools';

const COMMAND = 'pnpm audit signatures --json';

/**
 * Verbatim stdout of `pnpm audit signatures --json` on pnpm 11.20.0 against this
 * repository's own lockfile (846 packages, exit 0). Measured for AUD-11.
 */
const VERIFIED_SIGNATURE_REPORT = `{
  "audited": 846,
  "invalid": [],
  "missing": [],
  "verified": 846
}
`;

/**
 * Verbatim stdout of the same command on the previously pinned pnpm 11.0.8,
 * which has no `signatures` subcommand and discards the positional argument.
 * It is an ordinary advisory report and it exits 0 — the defect AUD-11 closes.
 */
const ADVISORY_REPORT_FROM_PNPM_11_0_8 = `{
  "advisories": {},
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0
    },
    "dependencies": 1,
    "devDependencies": 845,
    "optionalDependencies": 129,
    "totalDependencies": 846
  }
}
`;

function execution(overrides: Partial<SignatureAuditExecution> = {}): SignatureAuditExecution {
  return {
    command: COMMAND,
    stdout: VERIFIED_SIGNATURE_REPORT,
    stderr: '',
    exitCode: 0,
    ...overrides,
  };
}

function signatureReport(report: Record<string, unknown>): string {
  return JSON.stringify(report);
}

describe('resolvePnpmExecutable()', () => {
  it.each([
    ['win32', 'pnpm.cmd'],
    ['darwin', 'pnpm'],
    ['linux', 'pnpm'],
  ])('resolves the launcher for %s', (platform, expected) => {
    expect(resolvePnpmExecutable(platform)).toBe(expected);
  });
});

describe('parseSignatureAuditArgs()', () => {
  it('accepts the only supported invocation, which takes no arguments', () => {
    expect(() => parseSignatureAuditArgs([])).not.toThrow();
  });

  it('rejects any argument so a typo cannot silently change the run', () => {
    expect(() => parseSignatureAuditArgs(['--audit-level', 'high'])).toThrow('Unknown argument: --audit-level');
  });
});

describe('evaluateSignatureAudit() accepts a real signature report', () => {
  it('verifies the measured pnpm 11.20.0 report', () => {
    const outcome = evaluateSignatureAudit(execution());

    expect(outcome).toStrictEqual({
      kind: 'verified',
      exitCode: 0,
      report: { audited: 846, verified: 846, missing: [], invalid: [] },
    });
  });

  it('accepts a warning on stderr, which pnpm writes independently of the report', () => {
    const outcome = evaluateSignatureAudit(execution({ stderr: '[WARN] The "pnpm" field is no longer read' }));

    expect(outcome.kind).toBe('verified');
  });
});

describe('evaluateSignatureAudit() rejects everything else', () => {
  it.each([
    [
      'a spawn failure that never produced an exit code',
      execution({ exitCode: undefined, stdout: '', stderr: 'spawn pnpm ENOENT' }),
      'process-failed',
      'spawn pnpm ENOENT',
    ],
    [
      'empty stdout',
      execution({ stdout: '   \n' }),
      'empty-output',
      'wrote no report to stdout (exit code 0)',
    ],
    [
      'stdout that is not JSON',
      execution({ stdout: 'audited 846 packages\n\n846 packages have verified registry signatures\n' }),
      'malformed-json',
      'are not JSON',
    ],
    [
      'the advisory report pnpm 11.0.8 returns for the same command line',
      execution({ stdout: ADVISORY_REPORT_FROM_PNPM_11_0_8 }),
      'advisory-report',
      MINIMUM_SIGNATURE_AUDIT_PNPM_VERSION,
    ],
    [
      'an npm v2 advisory report carrying auditReportVersion',
      execution({ stdout: signatureReport({ auditReportVersion: 2, vulnerabilities: {} }) }),
      'advisory-report',
      'instead of a signature report',
    ],
    [
      'an npm v2 advisory report carrying only a metadata summary',
      execution({ stdout: signatureReport({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }) }),
      'advisory-report',
      'instead of a signature report',
    ],
    [
      // Measured: pnpm writes this envelope to stdout and exits 1 when the registry
      // is unreachable. --ignore-registry-errors does not apply to the signature
      // path, so a registry outage stays a hard failure rather than a silent pass.
      'the JSON error envelope pnpm emits when the registry cannot be reached',
      execution({ exitCode: 1, stdout: '{\n  "error": {\n    "code": "pnpm",\n    "message": "fetch failed"\n  }\n}' }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'a JSON array',
      execution({ stdout: '[]' }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'a JSON string',
      execution({ stdout: '"verified"' }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'a report with no counters at all',
      execution({ stdout: signatureReport({ ok: true }) }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'counters sent as strings',
      execution({ stdout: signatureReport({ audited: '846', verified: '846', missing: [], invalid: [] }) }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'a fractional audited counter',
      execution({ stdout: signatureReport({ audited: 1.5, verified: 1.5, missing: [], invalid: [] }) }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'a negative verified counter',
      execution({ stdout: signatureReport({ audited: 0, verified: -1, missing: [], invalid: [] }) }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'findings sent as objects instead of arrays',
      execution({ stdout: signatureReport({ audited: 1, verified: 1, missing: {}, invalid: {} }) }),
      'unrecognized-schema',
      'not a recognized signature report',
    ],
    [
      'a verified counter that does not add up to the audited counter',
      execution({ stdout: signatureReport({ audited: 846, verified: 12, missing: [], invalid: [] }) }),
      'count-mismatch',
      'reported 846 audited package(s) but classified 12',
    ],
    [
      'an invalid signature',
      execution({
        exitCode: 1,
        stdout: signatureReport({
          audited: 2,
          verified: 1,
          missing: [],
          invalid: [{ name: 'left-pad', version: '1.3.0', reason: 'Invalid registry signature' }],
        }),
      }),
      'invalid-signatures',
      'left-pad@1.3.0 — Invalid registry signature',
    ],
    [
      'an invalid entry that carries no readable identity',
      execution({
        exitCode: 1,
        stdout: signatureReport({ audited: 1, verified: 0, missing: [], invalid: [{ registry: 'https://r/' }] }),
      }),
      'invalid-signatures',
      '<unknown>@<unknown>',
    ],
    [
      'an invalid entry that is not an object at all',
      execution({
        exitCode: 1,
        stdout: signatureReport({ audited: 1, verified: 0, missing: [], invalid: ['tampered'] }),
      }),
      'invalid-signatures',
      '"tampered"',
    ],
    [
      'a package published without a signature',
      execution({
        exitCode: 1,
        stdout: signatureReport({
          audited: 2,
          verified: 1,
          missing: [{ name: 'internal-pkg', version: '0.1.0' }],
          invalid: [],
        }),
      }),
      'missing-signatures',
      'internal-pkg@0.1.0',
    ],
    [
      'a clean report that still exited non-zero',
      execution({ exitCode: 1 }),
      'unexpected-exit',
      'exited with code 1',
    ],
    [
      'a report that audited nothing because no registry published signing keys',
      execution({ stdout: signatureReport({ audited: 0, verified: 0, missing: [], invalid: [] }) }),
      'nothing-audited',
      'audited no packages',
    ],
  ])('rejects %s', (_label, input, reason, detailFragment) => {
    const outcome = evaluateSignatureAudit(input);

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') {
      return;
    }
    expect(outcome.reason).toBe(reason);
    expect(outcome.detail).toContain(detailFragment);
  });

  /**
   * Shape measured on pnpm 11.20.0 against a proxy that answers 500 for one
   * packument: the failing entry is pushed onto `invalid` from a catch block
   * that never runs the `audited++` of the success path, so the classified sum
   * exceeds `audited`. Both rejection reasons apply; the named one has to win,
   * because `count-mismatch` would report arithmetic and drop the package names
   * in precisely the run where they matter.
   */
  it('names the invalid packages when a failed packument also breaks the counts', () => {
    const outcome = evaluateSignatureAudit(execution({
      exitCode: 1,
      stdout: signatureReport({
        audited: 843,
        verified: 843,
        missing: [],
        invalid: [{ name: 'semver', version: '7.8.5', reason: 'The packument endpoint responded with 500' }],
      }),
    }));

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') {
      return;
    }
    expect(outcome.reason).toBe('invalid-signatures');
    expect(outcome.detail).toContain('semver@7.8.5 — The packument endpoint responded with 500');
  });

  /**
   * Characterization of the documented boundary, not an endorsement of it: pnpm
   * silently drops a package whose packument answers 404, and a registry with no
   * signing keys, out of the denominator. The report stays self-consistent and
   * exits 0, so the guard accepts it — `audited` is a floor, never a total.
   * Measured: a proxy answering 404 for one package took this repository from
   * 846 audited to 843, with the verdict still green. Closing this needs an
   * independent count of what should have been audited, which pnpm does not
   * report; it belongs to the CI step that owns the release boundary.
   */
  it('accepts a partial audit, because the report carries no total to compare against', () => {
    const outcome = evaluateSignatureAudit(execution({
      stdout: signatureReport({ audited: 843, verified: 843, missing: [], invalid: [] }),
    }));

    expect(outcome.kind).toBe('verified');
    if (outcome.kind !== 'verified') {
      return;
    }
    expect(outcome.report.audited).toBe(843);
  });

  it('omits the stderr suffix when the process wrote nothing to stderr', () => {
    const outcome = evaluateSignatureAudit(execution({ stdout: '', stderr: '' }));

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') {
      return;
    }
    expect(outcome.detail).not.toContain('stderr');
  });
});

describe('runSignatureAuditCli()', () => {
  function createDeps(runAudit: SignatureAuditCliDependencies['runAudit']): {
    deps: SignatureAuditCliDependencies;
    out: string[];
    err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      deps: { runAudit, writeOut: line => out.push(line), writeError: line => err.push(line) },
      out,
      err,
    };
  }

  it('reports the verified package count on stdout and exits 0', async () => {
    const { deps, err, out } = createDeps(() => Promise.resolve(execution()));

    await expect(runSignatureAuditCli([], deps)).resolves.toBe(0);
    expect(out).toStrictEqual(['846 of 846 audited package(s) have a verified registry signature']);
    expect(err).toStrictEqual([]);
  });

  it('leaves stdout empty on a rejection so a piped consumer cannot answer for the guard', async () => {
    const runAudit = vi.fn(() => Promise.resolve(execution({ stdout: ADVISORY_REPORT_FROM_PNPM_11_0_8 })));
    const { deps, err, out } = createDeps(runAudit);

    await expect(runSignatureAuditCli([], deps)).resolves.toBe(1);
    expect(out).toStrictEqual([]);
    expect(err[0]).toContain('Signature audit failed [advisory-report]');
  });

  it('rejects an unknown argument before running anything', async () => {
    const runAudit = vi.fn(() => Promise.resolve(execution()));
    const { deps, err } = createDeps(runAudit);

    await expect(runSignatureAuditCli(['--fix'], deps)).resolves.toBe(1);
    expect(runAudit).not.toHaveBeenCalled();
    expect(err).toStrictEqual(['Signature audit failed: Unknown argument: --fix']);
  });

  it.each([
    ['an Error', new Error('spawn pnpm EACCES'), 'Signature audit failed: spawn pnpm EACCES'],
    ['a non-Error rejection', 'pnpm vanished', 'Signature audit failed: pnpm vanished'],
  ])('reports %s raised by the runner', async (_label, reason, expected) => {
    const { deps, err, out } = createDeps(() => Promise.reject(reason));

    await expect(runSignatureAuditCli([], deps)).resolves.toBe(1);
    expect(out).toStrictEqual([]);
    expect(err).toStrictEqual([expected]);
  });
});

describe('SIGNATURE_AUDIT_ARGS', () => {
  it('pins the subcommand and the JSON flag the guard depends on', () => {
    expect([...SIGNATURE_AUDIT_ARGS]).toStrictEqual(['audit', 'signatures', '--json']);
  });
});