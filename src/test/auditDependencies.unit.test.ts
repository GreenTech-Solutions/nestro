import { describe, expect, it, vi } from 'vitest';
import {
  describeDependencyAdvisory,
  evaluateDependencyAudit,
  FULL_AUDIT_ARGS,
  GRAPH_BLOCKING_SEVERITY,
  parseDependencyAuditArgs,
  parseDependencyAuditReport,
  PRODUCTION_AUDIT_ARGS,
  PRODUCTION_BLOCKING_SEVERITY,
  runDependencyAuditCli,
} from '../tools';
import type { AuditSeverity, DependencyAuditCliDependencies, DependencyAuditExecution } from '../tools';

const PROD_COMMAND = 'pnpm audit --prod --json';
const FULL_COMMAND = 'pnpm audit --json';

/** Verbatim `pnpm audit --prod --json` on pnpm 11.20.0 against this repository (exit 0). */
const CLEAN_PRODUCTION_REPORT = `{
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
    "devDependencies": 0,
    "optionalDependencies": 0,
    "totalDependencies": 1
  }
}
`;

/** `pnpm audit --json` on pnpm 11.20.0 against this repository (exit 1), paths trimmed to two. */
const DEV_HIGH_REPORT = `{
  "advisories": {
    "1240992": {
      "findings": [
        {
          "version": "3.0.3",
          "paths": [
            ".>@semantic-release/changelog>semantic-release>@semantic-release/commit-analyzer>micromatch>braces",
            ".>@semantic-release/changelog>semantic-release>micromatch>braces"
          ],
          "dev": true,
          "optional": false,
          "bundled": false
        }
      ],
      "id": 1240992,
      "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
      "module_name": "braces",
      "vulnerable_versions": "<=3.0.3",
      "patched_versions": ">=3.0.4",
      "severity": "high",
      "cwe": "CWE-674",
      "github_advisory_id": "GHSA-vfj7-8cjw-p6xm",
      "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"
    }
  },
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 1,
      "critical": 0
    },
    "dependencies": 1,
    "devDependencies": 858,
    "optionalDependencies": 128,
    "totalDependencies": 859
  }
}
`;

interface AdvisoryFixture {
  readonly ghsa: string;
  readonly moduleName: string;
  readonly severity: AuditSeverity;
}

function report(...advisories: readonly AdvisoryFixture[]): string {
  const vulnerabilities: Record<AuditSeverity, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const entries = advisories.map((advisory, index) => {
    vulnerabilities[advisory.severity] += 1;
    return [String(index + 1), {
      findings: [{ version: '1.0.0', paths: [`.>${advisory.moduleName}`] }],
      id: index + 1,
      title: `${advisory.moduleName} is vulnerable`,
      module_name: advisory.moduleName,
      vulnerable_versions: '<1.0.1',
      severity: advisory.severity,
      github_advisory_id: advisory.ghsa,
      url: `https://github.com/advisories/${advisory.ghsa}`,
    }] as const;
  });
  return JSON.stringify({ advisories: Object.fromEntries(entries), metadata: { vulnerabilities } });
}

function execution(command: string, stdout: string, exitCode: number | undefined, stderr = ''): DependencyAuditExecution {
  return { command, stdout, stderr, exitCode };
}

function prod(stdout: string, exitCode = 0): DependencyAuditExecution {
  return execution(PROD_COMMAND, stdout, exitCode);
}

function full(stdout: string, exitCode = 0): DependencyAuditExecution {
  return execution(FULL_COMMAND, stdout, exitCode);
}

const CLEAN = report();

describe('dependency audit constants', () => {
  it('audits the production graph and the full graph as JSON', () => {
    expect(PRODUCTION_AUDIT_ARGS).toStrictEqual(['audit', '--prod', '--json']);
    expect(FULL_AUDIT_ARGS).toStrictEqual(['audit', '--json']);
  });

  it('blocks production at moderate and the whole graph at critical', () => {
    expect(PRODUCTION_BLOCKING_SEVERITY).toBe('moderate');
    expect(GRAPH_BLOCKING_SEVERITY).toBe('critical');
  });
});

describe('parseDependencyAuditArgs()', () => {
  it('accepts no arguments and rejects any argument', () => {
    expect(() => parseDependencyAuditArgs([])).not.toThrow();
    expect(() => parseDependencyAuditArgs(['--audit-level', 'high'])).toThrow('Unknown argument: --audit-level');
  });
});

describe('parseDependencyAuditReport()', () => {
  it('reads a real advisory report', () => {
    expect(parseDependencyAuditReport(full(DEV_HIGH_REPORT, 1))).toStrictEqual({
      kind: 'report',
      advisories: [{
        key: '1240992',
        id: 'GHSA-vfj7-8cjw-p6xm',
        moduleName: 'braces',
        severity: 'high',
        title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
        url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
        vulnerableVersions: '<=3.0.3',
        installedVersions: ['3.0.3'],
      }],
    });
  });

  it('reads a real clean report', () => {
    expect(parseDependencyAuditReport(prod(CLEAN_PRODUCTION_REPORT))).toStrictEqual({ kind: 'report', advisories: [] });
  });

  it('falls back to the report key and empty text when optional advisory fields are missing', () => {
    const stdout = JSON.stringify({
      advisories: { 42: { module_name: 'left-pad', severity: 'low', findings: [{ version: '1.0.0' }, { version: '1.0.0' }, 'junk', {}] } },
      metadata: { vulnerabilities: { low: 1 } },
    });

    expect(parseDependencyAuditReport(full(stdout, 1))).toStrictEqual({
      kind: 'report',
      advisories: [{
        key: '42',
        id: '42',
        moduleName: 'left-pad',
        severity: 'low',
        title: '',
        url: '',
        vulnerableVersions: '',
        installedVersions: ['1.0.0'],
      }],
    });
  });

  it('treats an advisory without findings as having no installed version', () => {
    const stdout = JSON.stringify({
      advisories: { 1: { module_name: 'x', severity: 'info', github_advisory_id: 'GHSA-x' } },
      metadata: { vulnerabilities: { info: 1 } },
    });

    const parsed = parseDependencyAuditReport(full(stdout));

    expect(parsed.kind === 'report' && parsed.advisories[0]?.installedVersions).toStrictEqual([]);
  });

  it('strips control characters from registry text', () => {
    const stdout = JSON.stringify({
      advisories: { 1: { module_name: 'evil', severity: 'low', github_advisory_id: 'GHSA-1', title: 'line\n::error::forged\r\u0007end' } },
      metadata: { vulnerabilities: { low: 1 } },
    });

    const parsed = parseDependencyAuditReport(full(stdout, 1));

    expect(parsed.kind === 'report' && parsed.advisories[0]?.title).toBe('line ::error::forged end');
  });

  it.each([
    ['process-failed', execution(FULL_COMMAND, '', undefined, 'spawn ENOENT'), 'never reported an exit code; stderr: spawn ENOENT'],
    ['empty-output', execution(FULL_COMMAND, '  \n', 1), 'wrote no report to stdout (exit code 1)'],
    ['malformed-json', execution(FULL_COMMAND, 'Progress: resolved 846', 1), 'is not JSON (exit code 1)'],
    ['audit-error', execution(FULL_COMMAND, '{"error":{"code":"pnpm","message":"fetch failed"}}', 1), 'failed (exit code 1): fetch failed'],
    ['audit-error', execution(FULL_COMMAND, '{"error":{}}', 1), 'failed (exit code 1): <no message>'],
    ['unrecognized-schema', execution(FULL_COMMAND, '[]', 0), 'is not a pnpm advisory report'],
    ['unrecognized-schema', execution(FULL_COMMAND, '{"advisories":{}}', 0), 'is not a pnpm advisory report'],
    ['unrecognized-schema', execution(FULL_COMMAND, '{"advisories":{},"metadata":{}}', 0), 'is not a pnpm advisory report'],
    ['unrecognized-schema', execution(FULL_COMMAND, '{"advisories":{"7":{"module_name":"x","severity":"urgent"}},"metadata":{"vulnerabilities":{}}}', 1), 'advisory 7 without a known severity'],
    ['unrecognized-schema', execution(FULL_COMMAND, '{"advisories":{"7":{"severity":"low"}},"metadata":{"vulnerabilities":{}}}', 1), 'advisory 7 without a known severity'],
    ['unrecognized-schema', execution(FULL_COMMAND, '{"advisories":{"7":null},"metadata":{"vulnerabilities":{}}}', 1), 'advisory 7 without a known severity'],
    ['unrecognized-schema', execution(FULL_COMMAND, '{"advisories":{},"metadata":{"vulnerabilities":{"high":2}}}', 1), 'counted vulnerabilities in its summary but listed no advisory'],
    ['unexpected-exit', execution(FULL_COMMAND, CLEAN, 1, 'ERR_PNPM_AUDIT'), 'reported 0 advisory(ies) but exited with code 1; stderr: ERR_PNPM_AUDIT'],
    ['unexpected-exit', execution(FULL_COMMAND, DEV_HIGH_REPORT, 2), 'reported 1 advisory(ies) but exited with code 2'],
    ['unexpected-exit', execution(FULL_COMMAND, DEV_HIGH_REPORT, -1), 'exited with code -1'],
  ])('rejects %s', (reason, run, detail) => {
    const parsed = parseDependencyAuditReport(run);

    expect(parsed).toMatchObject({ kind: 'rejected', reason });
    expect(parsed.kind === 'rejected' && parsed.detail).toContain(detail);
    expect(parsed.kind === 'rejected' && parsed.detail).toContain(FULL_COMMAND);
  });

  it('ignores non-numeric summary counts when no advisory is listed', () => {
    expect(parseDependencyAuditReport(full('{"advisories":{},"metadata":{"vulnerabilities":{"high":"2"}}}'))).toStrictEqual({ kind: 'report', advisories: [] });
  });
});

describe('evaluateDependencyAudit()', () => {
  it('passes the real reports and reports the development advisory as a warning', () => {
    const outcome = evaluateDependencyAudit(prod(CLEAN_PRODUCTION_REPORT), full(DEV_HIGH_REPORT, 1));

    expect(outcome).toMatchObject({ kind: 'passed', blocking: [] });
    expect(outcome.kind === 'passed' && outcome.warnings.map(a => [a.id, a.scope])).toStrictEqual([['GHSA-vfj7-8cjw-p6xm', 'development']]);
  });

  it.each([
    ['a low production advisory', 'low', false],
    ['a moderate production advisory', 'moderate', true],
    ['a high production advisory', 'high', true],
  ] as const)('treats %s as blocking: %s', (_label, severity, blocks) => {
    const shipped = report({ ghsa: 'GHSA-p', moduleName: 'npm-check-updates', severity });

    const outcome = evaluateDependencyAudit(prod(shipped, 1), full(shipped, 1));

    expect(outcome.kind).toBe(blocks ? 'failed' : 'passed');
    const bucket = outcome.kind === 'rejected' ? [] : blocks ? outcome.blocking : outcome.warnings;
    expect(bucket.map(a => [a.id, a.scope])).toStrictEqual([['GHSA-p', 'production']]);
  });

  it.each([
    ['high', 'passed'],
    ['critical', 'failed'],
  ] as const)('treats a %s development advisory as %s', (severity, kind) => {
    const outcome = evaluateDependencyAudit(prod(CLEAN), full(report({ ghsa: 'GHSA-d', moduleName: 'eslint', severity }), 1));

    expect(outcome.kind).toBe(kind);
  });

  it('sorts both buckets by severity, then package, then advisory id', () => {
    const dev = report(
      { ghsa: 'GHSA-b', moduleName: 'zod', severity: 'low' },
      { ghsa: 'GHSA-c', moduleName: 'acorn', severity: 'moderate' },
      { ghsa: 'GHSA-a2', moduleName: 'acorn', severity: 'high' },
      { ghsa: 'GHSA-a1', moduleName: 'acorn', severity: 'high' },
      { ghsa: 'GHSA-x', moduleName: 'yaml', severity: 'critical' },
      { ghsa: 'GHSA-w', moduleName: 'braces', severity: 'critical' },
    );

    const outcome = evaluateDependencyAudit(prod(CLEAN), full(dev, 1));

    expect(outcome.kind === 'failed' && outcome.blocking.map(a => a.id)).toStrictEqual(['GHSA-w', 'GHSA-x']);
    expect(outcome.kind === 'failed' && outcome.warnings.map(a => a.id)).toStrictEqual(['GHSA-a1', 'GHSA-a2', 'GHSA-c', 'GHSA-b']);
  });

  it('keeps every report entry of one GHSA and scopes each entry by its own key', () => {
    const entry = (moduleName: string, range: string): Record<string, unknown> => ({
      module_name: moduleName,
      severity: 'moderate',
      vulnerable_versions: range,
      github_advisory_id: 'GHSA-3wwx-pv8p-q78v',
    });
    const reportOf = (entries: Record<string, unknown>): string =>
      JSON.stringify({ advisories: entries, metadata: { vulnerabilities: { moderate: Object.keys(entries).length } } });
    const shipped = { 1239934: entry('undici', '>=6.25.0 <6.28.1') };

    const outcome = evaluateDependencyAudit(
      prod(reportOf(shipped), 1),
      full(reportOf({ ...shipped, 1239933: entry('undici', '>=7.28.0 <7.29.1') }), 1),
    );

    expect(outcome.kind === 'failed' && outcome.blocking.map(a => [a.key, a.scope])).toStrictEqual([['1239934', 'production']]);
    expect(outcome.kind === 'failed' && outcome.warnings.map(a => [a.key, a.scope])).toStrictEqual([['1239933', 'development']]);
  });

  it('orders entries that share package and GHSA by report key', () => {
    const entries = Object.fromEntries(['20', '10'].map(key => [key, { module_name: 'undici', severity: 'low', github_advisory_id: 'GHSA-u' }]));
    const stdout = JSON.stringify({ advisories: entries, metadata: { vulnerabilities: { low: 2 } } });

    const outcome = evaluateDependencyAudit(prod(CLEAN), full(stdout, 1));

    expect(outcome.kind === 'passed' && outcome.warnings.map(a => a.key)).toStrictEqual(['10', '20']);
  });

  it('rejects when either audit is unusable', () => {
    expect(evaluateDependencyAudit(prod(''), full(CLEAN))).toMatchObject({ kind: 'rejected', reason: 'empty-output' });
    expect(evaluateDependencyAudit(prod(CLEAN), full('{', 1))).toMatchObject({ kind: 'rejected', reason: 'malformed-json' });
  });
});

describe('describeDependencyAdvisory()', () => {
  it('describes an advisory on one line', () => {
    expect(describeDependencyAdvisory({
      key: '1240992',
      id: 'GHSA-vfj7-8cjw-p6xm',
      moduleName: 'braces',
      severity: 'high',
      title: 'stack exhaustion',
      url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
      vulnerableVersions: '<=3.0.3',
      installedVersions: ['3.0.3', '3.0.2'],
      scope: 'development',
    })).toBe('high development advisory GHSA-vfj7-8cjw-p6xm: braces <=3.0.3 (installed 3.0.3, 3.0.2) — stack exhaustion https://github.com/advisories/GHSA-vfj7-8cjw-p6xm');
  });

  it('omits the parts the registry did not provide', () => {
    expect(describeDependencyAdvisory({
      key: '42',
      id: '42',
      moduleName: 'left-pad',
      severity: 'low',
      title: '',
      url: '',
      vulnerableVersions: '*',
      installedVersions: [],
      scope: 'production',
    })).toBe('low production advisory 42: left-pad *');
  });
});

describe('runDependencyAuditCli()', () => {
  function createDeps(
    runs: Readonly<Record<string, DependencyAuditExecution>>,
    githubActions = false,
  ): DependencyAuditCliDependencies & { readonly out: string[]; readonly err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      githubActions,
      runAudit: vi.fn((args: readonly string[]) => {
        const run = runs[args.join(' ')];
        return run === undefined
          ? Promise.reject(new Error(`unexpected pnpm ${args.join(' ')}`))
          : Promise.resolve(run);
      }),
      writeOut: (line: string) => out.push(line),
      writeError: (line: string) => err.push(line),
    };
  }

  const REAL_RUNS = {
    'audit --prod --json': prod(CLEAN_PRODUCTION_REPORT),
    'audit --json': full(DEV_HIGH_REPORT, 1),
  };

  it('runs the production audit before the full audit', async () => {
    const deps = createDeps(REAL_RUNS);

    await runDependencyAuditCli([], deps);

    expect(vi.mocked(deps.runAudit).mock.calls).toStrictEqual([[PRODUCTION_AUDIT_ARGS], [FULL_AUDIT_ARGS]]);
  });

  it('passes with plain warnings outside GitHub Actions', async () => {
    const deps = createDeps(REAL_RUNS);

    await expect(runDependencyAuditCli([], deps)).resolves.toBe(0);
    expect(deps.out).toStrictEqual([
      'warning: high development advisory GHSA-vfj7-8cjw-p6xm: braces <=3.0.3 (installed 3.0.3) — braces vulnerable to stack-exhaustion denial of service through deeply nested patterns https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
      'No blocking advisory; 1 advisory(ies) reported as warnings',
    ]);
    expect(deps.err).toStrictEqual([]);
  });

  it('emits escaped workflow-command warnings in GitHub Actions', async () => {
    const deps = createDeps({
      'audit --prod --json': prod(CLEAN),
      'audit --json': full(report({ ghsa: 'GHSA-100%', moduleName: 'pct', severity: 'low' }), 1),
    }, true);

    await expect(runDependencyAuditCli([], deps)).resolves.toBe(0);
    expect(deps.out[0]).toBe('::warning title=Dependency audit::low development advisory GHSA-100%25: pct <1.0.1 (installed 1.0.0) — pct is vulnerable https://github.com/advisories/GHSA-100%25');
  });

  it('fails on a blocking advisory and still prints the warnings', async () => {
    const shipped = report({ ghsa: 'GHSA-p', moduleName: 'npm-check-updates', severity: 'moderate' });
    const deps = createDeps({
      'audit --prod --json': prod(shipped, 1),
      'audit --json': full(report(
        { ghsa: 'GHSA-p', moduleName: 'npm-check-updates', severity: 'moderate' },
        { ghsa: 'GHSA-d', moduleName: 'eslint', severity: 'high' },
      ), 1),
    });

    await expect(runDependencyAuditCli([], deps)).resolves.toBe(1);
    expect(deps.out).toStrictEqual(['warning: high development advisory GHSA-d: eslint <1.0.1 (installed 1.0.0) — eslint is vulnerable https://github.com/advisories/GHSA-d']);
    expect(deps.err).toStrictEqual([
      'Dependency audit failed: moderate production advisory GHSA-p: npm-check-updates <1.0.1 (installed 1.0.0) — npm-check-updates is vulnerable https://github.com/advisories/GHSA-p',
      '1 blocking advisory(ies): production dependencies block at moderate, every dependency blocks at critical',
    ]);
  });

  it('fails on a rejected audit without printing a verdict', async () => {
    const deps = createDeps({ 'audit --prod --json': prod(CLEAN), 'audit --json': full('{"error":{"message":"fetch failed"}}', 1) });

    await expect(runDependencyAuditCli([], deps)).resolves.toBe(1);
    expect(deps.out).toStrictEqual([]);
    expect(deps.err).toStrictEqual(['Dependency audit failed [audit-error]: pnpm audit --json failed (exit code 1): fetch failed']);
  });

  it('fails on an unknown argument before running pnpm', async () => {
    const deps = createDeps(REAL_RUNS);

    await expect(runDependencyAuditCli(['--prod'], deps)).resolves.toBe(1);
    expect(deps.runAudit).not.toHaveBeenCalled();
    expect(deps.err).toStrictEqual(['Dependency audit failed: Unknown argument: --prod']);
  });

  it('fails when the runner itself throws', async () => {
    const deps = createDeps({});

    await expect(runDependencyAuditCli([], deps)).resolves.toBe(1);
    expect(deps.err).toStrictEqual(['Dependency audit failed: unexpected pnpm audit --prod --json']);
  });

  it('describes a non-Error runner failure', async () => {
    const deps = createDeps({});
    vi.mocked(deps.runAudit).mockRejectedValueOnce('pnpm vanished');

    await expect(runDependencyAuditCli([], deps)).resolves.toBe(1);
    expect(deps.err).toStrictEqual(['Dependency audit failed: pnpm vanished']);
  });
});