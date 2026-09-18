import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { StatusItem } from '../providers';

describe('StatusItem', () => {
  it('is a non-collapsible leaf row with the shared status contextValue and themed icon', () => {
    const item = new StatusItem('Last update check', '10:45 AM', 'clock');

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(item.contextValue).toBe('status');
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('clock');
    expect(item.command).toBeUndefined();
  });

  it('applies the theme color to the icon when one is given', () => {
    const item = new StatusItem('Audit incomplete', '1 package root failed', 'warning', 'charts.yellow');

    expect((item.iconPath as vscode.ThemeIcon).color).toEqual(new vscode.ThemeColor('charts.yellow'));
  });

  it('sets no command and no tooltip when neither actionable nor an explicit command is given', () => {
    const item = new StatusItem('No dependencies to manage', 'This package.json has no dependencies yet.', 'info');

    expect(item.command).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
    expect(item.accessibilityInformation).toBeUndefined();
  });

  it('opens the diagnostics report and builds tooltip/a11y text when actionable with a description', () => {
    const item = new StatusItem('Update check incomplete', '2 package roots failed', 'warning', 'charts.yellow', true);

    expect(item.command).toEqual({ command: 'nestro.openStatusReport', title: 'Open detailed diagnostics' });
    expect(item.tooltip).toBe('Update check incomplete: Open detailed diagnostics');
    expect(item.accessibilityInformation?.label).toBe(
      'Update check incomplete. 2 package roots failed. Open detailed diagnostics',
    );
  });

  it('drops the description segment from tooltip/a11y text when actionable with an empty description', () => {
    const item = new StatusItem('Workspace package loading failed', '', 'warning', 'charts.yellow', true);

    expect(item.accessibilityInformation?.label).toBe('Workspace package loading failed. Open detailed diagnostics');
  });

  it('binds the given command instead of the diagnostics report when one is passed, with a description', () => {
    const item = new StatusItem('Filter: Patch', '1 of 3', 'filter', undefined, false, {
      command: 'nestro.showFilterPicker',
      title: 'Change filter',
    });

    expect(item.command).toEqual({ command: 'nestro.showFilterPicker', title: 'Change filter' });
    expect(item.tooltip).toBe('Filter: Patch. 1 of 3. Change filter');
    expect(item.accessibilityInformation?.label).toBe('Filter: Patch. 1 of 3. Change filter');
  });

  it('drops the description segment from tooltip/a11y text for an explicit command with an empty description', () => {
    const item = new StatusItem('Checking updates…', '', 'loading~spin', undefined, false, {
      command: 'nestro.checkUpdates',
      title: 'Check again',
    });

    expect(item.tooltip).toBe('Checking updates…. Check again');
    expect(item.accessibilityInformation?.label).toBe('Checking updates…. Check again');
  });

  it('prefers the explicit command over actionable when both are given', () => {
    const item = new StatusItem('Search: "react"', '1 package', 'search', undefined, true, {
      command: 'nestro.searchPackages',
      title: 'Edit search',
    });

    expect(item.command).toEqual({ command: 'nestro.searchPackages', title: 'Edit search' });
  });
});