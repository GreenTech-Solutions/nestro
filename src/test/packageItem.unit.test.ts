import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { PackageItem } from '../providers';

describe('PackageItem', () => {
  it('starts collapsed so details can be expanded inline', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor');

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
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
  });

  it('keeps the installing context contract while an unsupported spec is busy', () => {
    const item = new PackageItem('pkg', 'workspace:*', '1.0.0', 'minor', { kind: 'update', target: '1.0.0' });

    expect(item.contextValue).toBe('installing-update');
    expect(item.tooltip).not.toContain('Pin unavailable:');
  });

  it('renders held-back release age in accessible row text', () => {
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

    expect(item.description).toContain('Held back 6.0.0 until 2026-06-02T00:00:00.000Z');
    expect(item.tooltip).toContain('Held back 6.0.0 until 2026-06-02T00:00:00.000Z');
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
  });
});