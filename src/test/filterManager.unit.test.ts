import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createFilterQuickPickItems, FILTER_TYPES, getFilterLabel } from '../providers/FilterManager';
import { FilterManager, isFilterType } from '../providers';

describe('FilterManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the configured initial filter', () => {
    const manager = new FilterManager('hasUpdates');

    expect(manager.current).toBe('hasUpdates');
  });

  it('emits change events when the filter changes', () => {
    const manager = new FilterManager('all');
    const listener = vi.fn();
    manager.onDidChange(listener);

    manager.set('minor');

    expect(manager.current).toBe('minor');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not emit when setting the current filter again', () => {
    const manager = new FilterManager('all');
    const listener = vi.fn();
    manager.onDidChange(listener);

    manager.set('all');

    expect(listener).not.toHaveBeenCalled();
  });

  it('shows the vulnerable filter once when requested repeatedly', () => {
    const manager = new FilterManager('all');
    const listener = vi.fn();
    manager.onDidChange(listener);

    manager.showVulnerable();
    manager.showVulnerable();

    expect(manager.current).toBe('vulnerable');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('updates the filter from the picker selection', async () => {
    const manager = new FilterManager('all');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'Breaking',
      filterType: 'breaking',
    } as vscode.QuickPickItem & { filterType: 'breaking' });

    await manager.showPicker({
      all: 2,
      hasUpdates: 1,
      patch: 0,
      minor: 0,
      breaking: 1,
      vulnerable: 0,
    });

    expect(manager.current).toBe('breaking');
  });

  it('keeps the vulnerable filter out of the picker and replaces it with a normal filter', async () => {
    const manager = new FilterManager('all');
    manager.showVulnerable();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'Patch',
      filterType: 'patch',
    } as vscode.QuickPickItem & { filterType: 'patch' });

    await manager.showPicker({
      all: 2,
      hasUpdates: 1,
      patch: 1,
      minor: 0,
      breaking: 0,
      vulnerable: 1,
    });

    const [items] = vi.mocked(vscode.window.showQuickPick).mock.calls[0] as [
      (vscode.QuickPickItem & { filterType: string; iconPath: vscode.ThemeIcon })[],
      unknown,
    ];
    expect(items.map(item => item.filterType)).toEqual(FILTER_TYPES);
    expect(items.every(item => item.iconPath.id !== 'circle-filled')).toBe(true);
    expect(manager.current).toBe('patch');
  });

  it('stores a normalized package search query', () => {
    const manager = new FilterManager('all');

    manager.setSearch('  React DOM  ');

    expect(manager.search).toBe('react dom');
  });

  it('clears the package search query', () => {
    const manager = new FilterManager('all');

    manager.setSearch('react');
    manager.clearSearch();

    expect(manager.search).toBe('');
  });

  it('opens a search input with a clear button', async () => {
    const manager = new FilterManager('all');
    const listeners: {
      accept?: () => void;
      hide?: () => void;
      trigger?: (button: vscode.QuickInputButton) => void;
    } = {};
    const inputBox = {
      title: '',
      prompt: '',
      placeholder: '',
      value: 'react',
      buttons: [] as vscode.QuickInputButton[],
      show: vi.fn(),
      hide: vi.fn(() => listeners.hide?.()),
      dispose: vi.fn(),
      onDidAccept: vi.fn((listener: () => void) => {
        listeners.accept = listener;
        return { dispose: vi.fn() } as vscode.Disposable;
      }),
      onDidHide: vi.fn((listener: () => void) => {
        listeners.hide = listener;
        return { dispose: vi.fn() } as vscode.Disposable;
      }),
      onDidTriggerButton: vi.fn((listener: (button: vscode.QuickInputButton) => void) => {
        listeners.trigger = listener;
        return { dispose: vi.fn() } as vscode.Disposable;
      }),
    };
    vi.mocked(vscode.window.createInputBox).mockReturnValue(inputBox as unknown as vscode.InputBox);

    const pending = manager.showSearch();
    const clearButton = inputBox.buttons[0];
    listeners.trigger?.(clearButton);
    expect(inputBox.value).toBe('');
    listeners.accept?.();
    await pending;

    expect(manager.search).toBe('');
  });

  it('uses the correct severity labels for patch and minor filters', () => {
    expect(getFilterLabel('patch')).toBe('Patch');
    expect(getFilterLabel('minor')).toBe('Minor');
  });

  it('shows the correct labels in filter quick-pick items', () => {
    const items = createFilterQuickPickItems({
      all: 4,
      hasUpdates: 3,
      patch: 1,
      minor: 1,
      breaking: 1,
      vulnerable: 0,
    }, 'patch');

    expect(items.map(item => item.label)).toEqual([
      'All',
      'Has Updates',
      'Patch',
      'Minor',
      'Breaking',
    ]);
  });

  it('accepts every declared filter type', () => {
    for (const value of FILTER_TYPES) {
      expect(isFilterType(value)).toBe(true);
    }
  });

  it('rejects runtime values that are not a declared filter type', () => {
    const invalidValues: readonly unknown[] = [undefined, null, '', 'not-a-filter', 0, 42, {}, [], true];

    for (const value of invalidValues) {
      expect(isFilterType(value)).toBe(false);
    }
  });
});