import { describe, expect, it, vi } from 'vitest';
import { openAuditReportCommand } from '../commands';
import {
  cloneAuditAdvisory,
  createAuditAdvisory,
  formatAuditReport,
  inferPathAttribution,
  mergeAttribution,
  mergeAuditAdvisories,
  mergePathAttributions,
  parseAuditOutcome,
  parseBunAuditOutcome,
  parseYarnAuditOutcome,
  toAuditResult,
  validateAdvisoryUrl,
} from '../utils';
import type { AuditAdvisory, AuditOutcome } from '../utils';
import type { AuditProjectSummary } from '../providers';

function advisories(outcome: AuditOutcome): readonly AuditAdvisory[] {
  if (outcome.kind !== 'advisories') {
    throw new Error(`Expected advisories, received ${outcome.kind}.`);
  }
  return outcome.advisories ?? [];
}

function projectSummary(advisory: AuditAdvisory): AuditProjectSummary {
  return {
    project: {
      projectRoot: '/workspace/apps/web',
      workspaceFolder: '/workspace',
      packageManager: advisory.manager,
      lockfilePath: '/workspace/apps/web/package-lock.json',
      originManifests: ['/workspace/apps/web/package.json'],
    },
    status: 'success',
    manager: advisory.manager,
    schema: advisory.schema,
    vulnerabilities: new Map([[advisory.packageName, advisory.severity]]),
    advisories: [advisory],
  };
}

describe('structured audit adapters', () => {
  it('preserves npm v2 evidence without inventing a resolved version', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      exitCode: 1,
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          lodash: {
            name: 'lodash',
            severity: 'high',
            range: '<4.17.21',
            nodes: ['node_modules/lodash'],
            isDirect: true,
            via: [{ id: 'GHSA-lodash', title: 'Prototype issue', url: 'https://example.test/GHSA-lodash' }],
            id: 42,
            fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
          },
        },
        metadata: { vulnerabilities: { total: 1 } },
      }),
    });

    const [advisory] = advisories(outcome);
    expect(advisory).toMatchObject({
      packageName: 'lodash',
      severity: 'high',
      affectedRange: '<4.17.21',
      resolvedPaths: ['node_modules/lodash'],
      resolvedVersions: [],
      attribution: 'direct',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-lodash',
      fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
    });
    expect(advisory.via.map(entry => entry.identity)).toEqual(['GHSA-lodash']);
  });

  it('tolerates malformed optional via/fix fields without manufacturing values', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      exitCode: 1,
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          lodash: {
            name: 'lodash',
            severity: 'high',
            range: '<5.0.0',
            via: ['dependency-name', 42, null, {}],
            fixAvailable: {},
          },
        },
        metadata: { vulnerabilities: { total: 1 } },
      }),
    });
    const [advisory] = advisories(outcome);
    expect(advisory.fixAvailable).toBeUndefined();
    expect(advisory.via).toEqual([{ identity: 'dependency-name' }]);
  });

  it('maps schema-only outcomes to their manager provenance when legacy callers omit it', () => {
    const base = { kind: 'clean' as const, exitCode: 0, vulnerabilities: new Map(), total: 0 as const };
    expect(toAuditResult({ ...base, schema: 'yarn-modern-npm-audit' }).manager).toBe('yarn');
    expect(toAuditResult({ ...base, schema: 'bun-bulk-advisory' }).manager).toBe('bun');
  });

  it('keeps npm v1 finding path and installed version evidence', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      exitCode: 1,
      stdout: JSON.stringify({
        advisories: {
          1234: {
            module_name: 'lodash',
            severity: 'moderate',
            vulnerable_versions: '<4.17.21',
            url: 'https://example.test/1234',
            findings: [{ version: '4.17.20', paths: ['node_modules/lodash'], isDirect: true }],
          },
        },
        metadata: { vulnerabilities: { total: 1 } },
      }),
    });

    expect(advisories(outcome)[0]).toMatchObject({
      resolvedPaths: ['node_modules/lodash'],
      resolvedVersions: ['4.17.20'],
      attribution: 'direct',
      schema: 'npm-v1-advisories',
    });
  });

  it('retains numeric npm v2 advisory identities when no via record supplies one', () => {
    const outcome = parseAuditOutcome({
      command: 'npm',
      exitCode: 1,
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          1234: {
            name: 'lodash',
            id: 1234,
            severity: 'high',
            range: '<5.0.0',
          },
        },
        metadata: { vulnerabilities: { total: 1 } },
      }),
    });
    expect(advisories(outcome)[0].advisoryId).toBe('1234');
  });

  it('retains Yarn Modern virtual dependents as via provenance, never as filesystem paths', () => {
    const outcome = parseYarnAuditOutcome('modern', {
      command: 'yarn',
      stderr: '',
      exitCode: 1,
      stdout: JSON.stringify({
        value: 'lodash',
        children: {
          ID: 'YN-EXAMPLE',
          Issue: 'Prototype issue',
          URL: 'https://example.test/yarn',
          Severity: 'high',
          'Vulnerable Versions': '<4.17.21',
          'Tree Versions': ['4.17.20'],
          Dependents: ['workspace:apps/web', 'virtual:abc'],
        },
      }),
    });

    const [advisory] = advisories(outcome);
    expect(advisory.resolvedPaths).toEqual([]);
    expect(advisory.resolvedVersions).toEqual(['4.17.20']);
    expect(advisory.attribution).toBe('unknown');
    expect(advisory.via.map(entry => entry.identity)).toEqual(['virtual:abc', 'workspace:apps/web']);
  });

  it('keeps Bun bulk findings report-only because the schema has no graph proof', () => {
    const outcome = parseBunAuditOutcome({
      command: 'bun',
      exitCode: 1,
      stdout: JSON.stringify({
        lodash: [{
          id: 'BUN-1',
          title: 'Prototype issue',
          url: 'https://example.test/bun',
          severity: 'high',
          vulnerable_versions: '<4.17.21',
          cwe: [],
        }],
      }),
    });

    expect(advisories(outcome)[0]).toMatchObject({
      resolvedPaths: [],
      resolvedVersions: [],
      attribution: 'unknown',
      manager: 'bun',
      schema: 'bun-bulk-advisory',
    });
  });
});

describe('advisory identity and report safety', () => {
  it('merges duplicates losslessly with deterministic primary fields and conservative fix state', () => {
    const first = createAuditAdvisory({
      packageName: 'lodash',
      severity: 'low',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-1',
      title: 'Z title',
      url: 'https://example.test/z',
      affectedRange: '<5.0.0',
      resolvedPaths: ['packages/a/node_modules/lodash'],
      resolvedVersions: ['4.0.0'],
      attribution: 'direct',
      via: [{ identity: 'via-z', title: 'Z' }],
      fixAvailable: true,
    });
    const second = createAuditAdvisory({
      packageName: 'lodash',
      severity: 'critical',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-1',
      title: 'A title',
      url: 'https://example.test/a',
      affectedRange: '<4.5.0',
      resolvedPaths: ['packages/b/node_modules/lodash'],
      resolvedVersions: ['4.1.0'],
      attribution: 'transitive',
      via: [{ identity: 'via-a', title: 'A' }],
      fixAvailable: false,
    });
    const third = createAuditAdvisory({
      packageName: 'lodash',
      severity: 'high',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-1',
      fixAvailable: undefined,
    });

    const [merged] = mergeAuditAdvisories([first, second, third]);
    expect(merged.severity).toBe('critical');
    expect(merged.title).toBe('A title');
    expect(merged.urls).toEqual(['https://example.test/a', 'https://example.test/z']);
    expect(merged.resolvedPaths).toEqual(['packages/a/node_modules/lodash', 'packages/b/node_modules/lodash']);
    expect(merged.via.map(entry => entry.identity)).toEqual(['via-a', 'via-z']);
    expect(merged.fixAvailable).toBeUndefined();
  });

  it('does not merge distinct advisory IDs and marks title/range fallback identities unstable', () => {
    const base = {
      packageName: 'lodash' as const,
      severity: 'high' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
    };
    const first = createAuditAdvisory({ ...base, advisoryId: 'A' });
    const second = createAuditAdvisory({ ...base, advisoryId: 'B' });
    const fallback = createAuditAdvisory({ ...base, title: 'Issue', affectedRange: '<2.0.0' });
    expect(mergeAuditAdvisories([first, second, fallback])).toHaveLength(3);
    expect(fallback.identityStability).toBe('unstable');
  });

  it('preserves mutation safety and merges path/via evidence conservatively', () => {
    const original = createAuditAdvisory({
      packageName: 'react',
      severity: 'high',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-clone',
      source: 'npm',
      title: 'Issue',
      url: 'https://example.test/clone',
      affectedRange: '<19.0.0',
      resolvedPaths: ['node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'direct',
      via: [{ identity: 'cause', title: 'Z', severity: 'low' }],
      fixAvailable: { name: 'react', version: '19.0.0', isSemVerMajor: true },
    });
    const clone = cloneAuditAdvisory(original);
    (clone.resolvedPaths as string[]).push('injected');
    (clone.via[0] as { title?: string }).title = 'injected';
    expect(original.resolvedPaths).toEqual(['node_modules/react']);
    expect(original.via[0].title).toBe('Z');

    expect(inferPathAttribution('react', [])).toBe('unknown');
    expect(inferPathAttribution('react', ['node_modules/react'])).toBe('direct');
    expect(inferPathAttribution('react', ['node_modules/a/node_modules/react'])).toBe('transitive');
    expect(inferPathAttribution('react', ['app@1.0.0 > react@18.0.0'])).toBe('transitive');
    expect(inferPathAttribution('react', ['node_modules/react', 'node_modules/a/node_modules/react'])).toBe('unknown');
    expect(inferPathAttribution('react', ['workspace:.'])).toBe('direct');
    expect(mergeAttribution('direct', 'direct')).toBe('direct');
    expect(mergeAttribution('direct', 'transitive')).toBe('unknown');
    expect(mergePathAttributions([])).toBe('unknown');
    expect(mergePathAttributions(['unknown', 'direct'])).toBe('direct');
    expect(mergePathAttributions(['direct', 'transitive'])).toBe('unknown');
    expect(mergePathAttributions(['transitive'])).toBe('transitive');

    const sameVia = createAuditAdvisory({
      ...original,
      title: undefined,
      source: undefined,
      url: undefined,
      affectedRange: undefined,
      via: [{ identity: 'cause', id: 'b', title: 'A', range: '<1.0.0' }],
      fixAvailable: { name: 'react', version: '19.0.0', isSemVerMajor: true },
    });
    const differentFix = createAuditAdvisory({
      ...original,
      title: undefined,
      source: undefined,
      url: undefined,
      affectedRange: undefined,
      via: [{ identity: 'cause', id: 'a', title: 'B', range: '<2.0.0' }],
      fixAvailable: { name: 'react', version: '20.0.0', isSemVerMajor: true },
    });
    const [mergedSame] = mergeAuditAdvisories([original, sameVia]);
    expect(mergedSame.via[0]).toMatchObject({ identity: 'cause', id: 'b', title: 'A', range: '<1.0.0' });
    expect(mergeAuditAdvisories([original, differentFix])[0].fixAvailable).toBeUndefined();
  });

  it('renders sanitized plain text and rejects unsafe advisory URLs', () => {
    const advisory = createAuditAdvisory({
      packageName: 'bad\nname\u001b[31m',
      severity: 'high',
      manager: 'npm',
      schema: 'npm-v1-advisories',
      title: 'line one\nline two',
      url: 'javascript:alert(1)',
      affectedRange: '<2.0.0\nInjected: true\u2028Also injected',
      resolvedPaths: ['/workspace/apps/web/node_modules/bad'],
      resolvedVersions: ['1.0.0'],
      attribution: 'direct',
      via: [{ identity: 'via\nsecret' }],
    });
    const report = formatAuditReport([projectSummary(advisory)]);
    expect(report).not.toContain('\u001b');
    expect(report).not.toMatch(/\nInjected: true/);
    expect(report).not.toContain('\u2028');
    expect(report).toContain('URL: not provided');
    expect(validateAdvisoryUrl('javascript:alert(1)')).toBeUndefined();
    expect(validateAdvisoryUrl('file:///tmp/advisory')).toBeUndefined();
    expect(validateAdvisoryUrl('https://user:pass@example.test/advisory')).toBeUndefined();
    expect(validateAdvisoryUrl('https://example.test/advisory')).toBe('https://example.test/advisory');
  });

  it('renders all safe optional report fields and keeps paths workspace-relative', () => {
    const base = {
      packageName: 'react',
      severity: 'moderate' as const,
      manager: 'npm' as const,
      schema: 'npm-v2-vulnerabilities' as const,
      affectedRange: '<19.0.0',
      resolvedPaths: ['workspace:apps/web', '../../private/secret', '/workspace/apps/web/node_modules/react', '/private/outside/node_modules/react'],
      resolvedVersions: ['18.0.0'],
      attribution: 'unknown' as const,
      via: [{ identity: 'dependency' }],
      source: 'registry',
    };
    const report = formatAuditReport([
      {
        ...projectSummary(createAuditAdvisory({ ...base, advisoryId: 'true', fixAvailable: true })),
        project: { ...projectSummary(createAuditAdvisory(base)).project, projectRoot: '/workspace' },
      },
      {
        ...projectSummary(createAuditAdvisory({ ...base, advisoryId: 'false', fixAvailable: false })),
        project: { ...projectSummary(createAuditAdvisory(base)).project, projectRoot: '/elsewhere/project' },
        status: 'failure',
      },
      projectSummary(createAuditAdvisory({
        ...base,
        advisoryId: 'object',
        fixAvailable: { name: 'react', version: '19.0.0', isSemVerMajor: true },
      })),
      projectSummary(createAuditAdvisory({
        ...base,
        advisoryId: 'object-no-target',
        fixAvailable: {},
      })),
    ]);
    expect(report).toContain('Fix available: yes');
    expect(report).toContain('Fix available: no');
    expect(report).toContain('Fix available: available (semver-major): react@19.0.0');
    expect(report).toContain('Fix available: available');
    expect(report).toContain('workspace:apps/web (virtual locator)');
    expect(report).toContain('(outside project)');
    expect(report).not.toContain('../../private/secret');
    expect(report).toContain('Source: registry');
    expect(report).toContain('Project 1: (root)');
    expect(report).toContain('Project 2: (external project)');
  });

  it('keeps clean, multiple-project and partial-failure states reachable without leaking failure detail', () => {
    const advisory = createAuditAdvisory({
      packageName: 'lodash',
      severity: 'high',
      manager: 'npm',
      schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-1',
      affectedRange: '<5.0.0',
    });
    const clean = {
      ...projectSummary(advisory),
      vulnerabilities: new Map<string, 'high'>(),
      advisories: [],
    } satisfies AuditProjectSummary;
    const failed = {
      ...clean,
      status: 'failure' as const,
      failure: { reason: 'audit-failed', detail: '/private/secrets/registry-token stderr' },
    } satisfies AuditProjectSummary;
    const report = formatAuditReport(
      [clean, projectSummary(advisory), failed],
      [{ packageFilePaths: ['/workspace/missing/package.json'], reason: 'workspace-escape', detail: '/private/secrets/cwd' }],
    );
    expect(report).toContain('Status: Clean');
    expect(report).toContain('1 advisory row(s)');
    expect(report).toContain('Status: Incomplete');
    expect(report).toContain('Unassigned audit projects: 1');
    expect(report).not.toContain('registry-token');
    expect(report).not.toContain('/private/secrets');
  });

  it('replaces and foregrounds one reusable output channel', () => {
    const replace = vi.fn();
    const show = vi.fn();
    const provider = { getAuditReport: vi.fn(() => ({ projects: [], failures: [] })) };
    openAuditReportCommand(
      provider,
      { replace, show } as unknown as import('vscode').OutputChannel,
    );

    expect(replace).toHaveBeenCalledWith(expect.stringContaining('No audit results are available'));
    expect(show).toHaveBeenCalledWith(true);
  });

  it('commands a report for clean, advisory, multiple-project and partial snapshots', () => {
    const advisory = createAuditAdvisory({
      packageName: 'react', severity: 'high', manager: 'npm', schema: 'npm-v2-vulnerabilities',
      advisoryId: 'GHSA-command', title: 'Command issue', affectedRange: '<19.0.0',
    });
    const clean = {
      ...projectSummary(advisory), vulnerabilities: new Map<string, 'high'>(), advisories: [],
    } satisfies AuditProjectSummary;
    const failed = {
      ...clean, status: 'failure' as const, failure: { reason: 'audit-failed', detail: 'secret' },
    } satisfies AuditProjectSummary;
    const replace = vi.fn();
    const provider = {
      getAuditReport: vi.fn(() => ({
        projects: [clean, projectSummary(advisory), failed],
        failures: [{ packageFilePaths: ['/workspace/rejected/package.json'], reason: 'rejected', detail: 'secret' }],
      })),
    };

    openAuditReportCommand(provider, { replace, show: vi.fn() } as unknown as import('vscode').OutputChannel);

    const output = replace.mock.calls[0][0] as string;
    expect(output).toContain('Project 1');
    expect(output).toContain('Project 2');
    expect(output).toContain('Status: Incomplete');
    expect(output).toContain('Unassigned audit projects: 1');
    expect(output).not.toContain('secret');
  });
});