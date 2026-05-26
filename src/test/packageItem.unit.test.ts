import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { PackageItem } from '../providers';

describe('PackageItem', () => {
  it('uses a spinner context while an update is installing', () => {
    const item = new PackageItem('typescript', '^5.0.0', '5.9.3', 'minor', true);

    expect(item.contextValue).toBe('installing');
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('loading~spin');
  });
});