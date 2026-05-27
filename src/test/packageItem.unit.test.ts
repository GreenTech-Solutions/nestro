import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { PackageItem } from '../providers';

describe('PackageItem', () => {
  it('starts collapsed so details can be expanded inline', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor');

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('uses a spinner context while an update is installing', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', true);

    expect(item.contextValue).toBe('installing');
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('loading~spin');
  });

  it('adds vulnerability context and warning icon for vulnerable packages', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', false, 'high');

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
});