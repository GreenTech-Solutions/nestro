import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PackageItem } from '../providers';
import { formatHeldBackDate } from '../utils';

describe('PackageItem', () => {
  it('starts collapsed so details can be expanded inline', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor');

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it.each([
    ['patch', '1.0.0', '1.0.1', 'patch update', 'arrow-small-up'],
    ['minor', '1.0.0', '1.1.0', 'minor update', 'arrow-up'],
    ['breaking', '1.0.0', '2.0.0', 'breaking update', 'triangle-up'],
  ] as const)('exposes %s in visible text and icon', (updateType, current, latest, visibleType, icon) => {
    const item = new PackageItem('pkg', current, latest, updateType);

    expect(item.description).toContain(`${current} → ${latest} (${visibleType})`);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe(icon);
    expect(item.accessibilityInformation?.label).toContain(`Update type: ${updateType}`);
  });

  it('keeps update types distinguishable when color is unavailable', () => {
    const iconIds = (['patch', 'minor', 'breaking'] as const).map((updateType) => {
      const latest = updateType === 'patch' ? '1.0.1' : updateType === 'minor' ? '1.1.0' : '2.0.0';
      return ((new PackageItem('pkg', '1.0.0', latest, updateType).iconPath) as vscode.ThemeIcon).id;
    });

    expect(new Set(iconIds)).toHaveLength(3);
  });

  it('keeps the up-to-date icon and describes the absence of an update', () => {
    const item = new PackageItem('pkg', '1.0.0', undefined, 'none');

    expect((item.iconPath as vscode.ThemeIcon).id).toBe('check');
    expect(item.accessibilityInformation?.label).toContain('Update type: none');
    expect(item.accessibilityInformation?.label).toContain('Latest version: unavailable');
    expect(item.accessibilityInformation?.role).toBeUndefined();
  });

  it.each([
    ['update', { kind: 'update', target: '5.9.3' }, 'Updating typescript to 5.9.3', 'arrow-up'],
    ['remove', { kind: 'remove' }, 'Removing typescript', 'trash'],
    ['install', { kind: 'install' }, 'Installing typescript', 'cloud-download'],
    ['pin', { kind: 'pin' }, 'Pinning typescript version', 'lock'],
    ['switch', { kind: 'switch' }, 'Switching typescript dependency type', 'arrow-swap'],
  ] as const)('renders a %s operation with its own busy presentation', (_kind, operation, tooltip, icon) => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', operation);

    expect(item.operation).toEqual(operation);
    expect(item.contextValue).toBe(`installing-${operation.kind}`);
    expect(item.tooltip).toBe(tooltip);
    expect(item.description).not.toContain('undefined');
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe(icon);
    expect(item.accessibilityInformation?.label).toContain('Active operation:');
  });

  it.each([
    [{ kind: 'update', target: '5.9.3' }, 'Active operation: update in progress to 5.9.3'],
    [{ kind: 'remove' }, 'Active operation: remove in progress'],
    [{ kind: 'install' }, 'Active operation: install in progress'],
    [{ kind: 'pin' }, 'Active operation: pin in progress'],
    [{ kind: 'switch' }, 'Active operation: dependency type switch in progress'],
  ] as const)('describes the %s busy reason to screen readers', (operation, reason) => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', operation);

    expect(item.accessibilityInformation?.label).toContain(reason);
  });

  it('does not render a version target while removing a package', () => {
    const item = new PackageItem('pkg', '^1.0.0', undefined, 'none', { kind: 'remove' });

    expect(item.description).toBe('^1.0.0');
    expect(item.tooltip).toBe('Removing pkg');
    expect(item.description).not.toContain('undefined');
  });

  it('adds vulnerability context and warning icon for vulnerable packages', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', undefined, 'high');

    expect(item.contextValue).toContain('vulnerable-high');
    expect(item.description).toContain('vulnerability: high');
    expect(item.tooltip).toContain('Vulnerability: high');
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('warning');
  });

  it.each([
    ['critical', 'Vulnerability: critical'],
    ['high', 'Vulnerability: high'],
    ['moderate', 'Vulnerability: moderate'],
    ['low', 'Vulnerability: low'],
    ['info', 'Vulnerability: info'],
    [undefined, 'Vulnerability: none detected'],
  ] as const)('describes vulnerability state %s accessibly', (severity, accessibleText) => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', undefined, severity);

    expect(item.accessibilityInformation?.label).toContain(accessibleText);
  });

  it('does not add vulnerability context for packages without vulnerabilities', () => {
    const item = new PackageItem('typescript', '^5.0.0', undefined, 'none');

    expect(item.contextValue).not.toContain('vulnerable');
  });

  it.each([
    ['1.2.3', 'package-pinnable'],
    ['^1.2.3', 'package-pinnable'],
    ['~1.2.3', 'package-pinnable'],
    ['workspace:^1.2.3', 'package-pinnable'],
    ['workspace:~1.2.3-beta.1+meta', 'package-pinnable'],
  ] as const)('marks %s as pinnable in the row context', (currentVersion, contextValue) => {
    const item = new PackageItem('pkg', currentVersion, undefined, 'none');

    expect(item.contextValue).toBe(contextValue);
    expect(item.tooltip).not.toContain('Pin unavailable:');
    expect(item.accessibilityInformation?.label).toContain('Pin capability: available');
  });

  it.each([
    ['workspace:*', 'workspace range is not a concrete version (wildcard version range)'],
    ['file:../local-pkg', 'local file dependency'],
    ['git+https://github.com/foo/bar.git', 'git dependency'],
    ['npm:real-pkg@^1.2.3', 'npm alias dependency'],
    ['>=1.2.3 <2.0.0', 'compound version range'],
    ['>=1.2.3', 'comparator version range'],
    ['Latest', 'dist-tag reference'],
    ['X.2.3', 'wildcard version range'],
  ] as const)('marks unsupported %s as unavailable with a reason', (currentVersion, reason) => {
    const item = new PackageItem('pkg', currentVersion, undefined, 'none');

    expect(item.contextValue).toBe('package-pin-unsupported');
    expect(item.tooltip).toContain(`Pin unavailable: ${reason}`);
    expect(item.accessibilityInformation?.label).toContain(`Pin capability: unavailable — ${reason}`);
  });

  it('keeps the installing context contract while an unsupported spec is busy', () => {
    const item = new PackageItem('pkg', 'workspace:*', '1.0.0', 'minor', { kind: 'update', target: '1.0.0' });

    expect(item.contextValue).toBe('installing-update');
    expect(item.tooltip).not.toContain('Pin unavailable:');
    expect(item.accessibilityInformation?.label).toContain('Pin capability: unavailable while busy');
  });

  it('includes the workspace owner and sanitizes untrusted accessible values', () => {
    const item = new PackageItem(
      'pkg\nname',
      '^1.0.0\u001b[31m',
      '1.1.0\r',
      'minor',
      undefined,
      'high',
      '/workspace/package.json',
      false,
      '^',
      { kind: 'accepted' },
      'web\nowner',
    );

    expect(item.workspaceOwner).toBe('web owner');
    expect(item.accessibilityInformation?.label).toContain('Package name: pkg name');
    expect(item.accessibilityInformation?.label).toContain('Current version: ^1.0.0');
    expect(item.accessibilityInformation?.label).toContain('Latest version: 1.1.0 ');
    expect(item.accessibilityInformation?.label).toContain('Workspace owner: web owner');
    expect(item.accessibilityInformation?.label).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
  });

  it('fails closed when the workspace owner cannot be resolved', () => {
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementationOnce(() => {
      throw new Error('workspace lookup failed');
    });

    const item = new PackageItem('pkg', '^1.0.0', undefined, 'none', undefined, undefined, '/workspace/package.json');

    expect(item.workspaceOwner).toBeUndefined();
    expect(item.accessibilityInformation?.label).toContain('Workspace owner: unavailable');
  });

  it('renders held-back release age with a localized date, not the raw ISO instant', () => {
    const eligibleAt = '2026-06-02T00:00:00.000Z';
    const expectedDate = formatHeldBackDate(eligibleAt);
    const item = new PackageItem(
      'typescript',
      '^5.0.0',
      '5.9.3',
      'minor',
      undefined,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'held-back', version: '6.0.0', eligibleAt },
    );

    expect(item.description).toContain(`Held back 6.0.0 until ${expectedDate}`);
    expect(item.tooltip).toContain(`Held back 6.0.0 until ${expectedDate}`);
    expect(item.accessibilityInformation?.label).toContain(`Held back 6.0.0 until ${expectedDate}`);
    expect(item.description).not.toContain(eligibleAt);
    expect(item.tooltip).not.toContain(eligibleAt);
    expect(item.accessibilityInformation?.label).not.toContain(eligibleAt);
  });

  it('renders the held-back date on the local calendar day, not the UTC one', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const item = new PackageItem(
        'typescript',
        '^5.0.0',
        '5.9.3',
        'minor',
        undefined,
        undefined,
        '/workspace/package.json',
        false,
        '^',
        { kind: 'held-back', version: '6.0.0', eligibleAt: '2026-06-02T00:00:00.000Z' },
      );

      expect(item.description).toContain('Held back 6.0.0 until Jun 1, 2026');
      expect(item.accessibilityInformation?.label).toContain('Held back 6.0.0 until Jun 1, 2026');
    }
    finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to the raw value when the held-back instant cannot be parsed', () => {
    const item = new PackageItem(
      'typescript',
      '^5.0.0',
      '5.9.3',
      'minor',
      undefined,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'held-back', version: '6.0.0', eligibleAt: 'not-a-date' },
    );

    expect(item.description).toContain('Held back 6.0.0 until not-a-date');
    expect(item.tooltip).toContain('Held back 6.0.0 until not-a-date');
    expect(item.accessibilityInformation?.label).toContain('Held back 6.0.0 until not-a-date');
  });

  it('renders unknown release age without blocking the row', () => {
    const item = new PackageItem(
      'typescript',
      '^5.0.0',
      '5.9.3',
      'minor',
      undefined,
      undefined,
      '/workspace/package.json',
      false,
      '^',
      { kind: 'unknown', version: '5.9.3' },
    );

    expect(item.description).toContain('Release age unknown for 5.9.3; update is not blocked.');
    expect(item.contextValue).toBe('outdated-pinnable');
    expect(item.accessibilityInformation?.label).toContain('Release age unknown for 5.9.3; update is not blocked.');
  });
});