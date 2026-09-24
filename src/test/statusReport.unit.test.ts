import { describe, expect, it, vi } from 'vitest';
import { openStatusReportCommand } from '../commands';
import { formatStatusReport } from '../utils';
import type { StatusReportSnapshot } from '../utils';

const FILE_LABELS = [
  {
    packageFilePath: '/workspace/apps/web/package.json',
    label: 'web — apps/web',
    order: 0,
  },
  {
    packageFilePath: '/workspace/packages/web/package.json',
    label: 'packages — web',
    order: 1,
  },
] as const;

function snapshot(overrides: Partial<StatusReportSnapshot> = {}): StatusReportSnapshot {
  return {
    packageReadFailures: [],
    updateFailures: [],
    auditFailures: [],
    fileLabels: FILE_LABELS,
    ...overrides,
  };
}

describe('status diagnostics report', () => {
  it('renders one failure per section with owner-qualified labels', () => {
    const report = formatStatusReport(snapshot({
      packageReadFailures: [{
        packageFilePaths: ['/workspace/apps/web/package.json'],
        reason: 'invalid-json',
        detail: 'Unexpected token in package.json',
      }],
      updateFailures: [{
        packageFilePaths: ['/workspace/packages/web/package.json'],
        reason: 'registry-unavailable',
        detail: 'request failed',
      }],
      auditFailures: [{
        packageFilePaths: [],
        reason: 'audit-failed',
        detail: 'No project root was resolved',
      }],
    }));

    expect(report).toContain('Package read failures');
    expect(report).toContain('- web — apps/web');
    expect(report).toContain('Update check failures');
    expect(report).toContain('- packages — web');
    expect(report).toContain('Security audit failures');
    expect(report).toContain('(workspace operation)');
  });

  it('keeps long and scoped failure details bounded and safe', () => {
    const report = formatStatusReport(snapshot({
      updateFailures: [{
        packageFilePaths: ['/workspace/apps/web/package.json'],
        reason: 'registry-failed\n[error] forged',
        detail: 'https://ci:secret-token@registry.internal/@scope/very-long-package '
          + 'file:///Users/private/encoded%20secret/package.json '
          + 'file:///C:/Users/private/package.json file://server/share/private/package.json '
          + 'cwd=/Users/alice/project/package.json manifest=C:\\Users\\alice\\project\\package.json '
          + `password=short-secret _authToken=secret-value /Users/private/hidden/package.json ${'x'.repeat(3000)}\u001b[31mred\u001b[0m`,
      }],
    }));

    expect(report).not.toContain('/workspace/apps/web/package.json');
    expect(report).not.toContain('/Users/private/hidden/package.json');
    expect(report).not.toContain('file://');
    expect(report).not.toContain('encoded%20secret');
    expect(report).not.toContain('C:/Users/private');
    expect(report).not.toContain('server/share/private');
    expect(report).not.toContain('/Users/alice/project');
    expect(report).not.toContain('C:\\Users\\alice');
    expect(report).not.toContain('short-secret');
    expect(report).not.toContain('secret-token');
    expect(report).not.toContain('_authToken=secret-value');
    expect(report).not.toContain('\u001b');
    expect(report).not.toMatch(/\n\[error\] forged/);
    expect(report.length).toBeLessThan(2500);
  });

  it('sorts failures by the stable owner-qualified label order', () => {
    const report = formatStatusReport(snapshot({
      updateFailures: [
        { packageFilePaths: ['/workspace/packages/web/package.json'], reason: 'b' },
        { packageFilePaths: ['/workspace/apps/web/package.json'], reason: 'a' },
      ],
    }));
    expect(report.indexOf('- web — apps/web')).toBeLessThan(report.indexOf('- packages — web'));
  });

  it('uses safe fallback labels for unknown package paths and optional fields', () => {
    const report = formatStatusReport(snapshot({
      updateFailures: [
        { packageFilePaths: ['/unknown/z/package.json'] },
        { packageFilePaths: ['/unknown/a/package.json'], detail: 'plain detail' },
        { packageFilePaths: [] },
      ],
    }));

    expect(report).toContain('- (package file)');
    expect(report).toContain('- (workspace operation)');
    expect(report).toContain('Details: plain detail');
    expect(report).not.toContain('/unknown/');
  });

  it('renders an empty snapshot without stale sections', () => {
    const report = formatStatusReport(snapshot());
    expect(report).toContain('No package operation failures are available.');
    expect(report).not.toContain('Package read failures');
    expect(report).not.toContain('Update check failures');
    expect(report).not.toContain('Security audit failures');
  });
});

describe('openStatusReportCommand', () => {
  it('reuses the supplied channel for each invocation', () => {
    const channel = {
      replace: vi.fn(),
      show: vi.fn(),
    } as unknown as import('vscode').OutputChannel;
    const provider = {
      getStatusReport: vi.fn(() => snapshot()),
    };

    openStatusReportCommand(provider, channel);
    openStatusReportCommand(provider, channel);

    expect(provider.getStatusReport).toHaveBeenCalledTimes(2);
    expect(channel.replace).toHaveBeenCalledTimes(2);
    expect(channel.show).toHaveBeenNthCalledWith(1, true);
    expect(channel.show).toHaveBeenNthCalledWith(2, true);
  });
});