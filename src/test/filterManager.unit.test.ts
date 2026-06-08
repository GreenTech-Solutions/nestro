import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FilterManager } from '../providers';

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
    });

    expect(manager.current).toBe('breaking');
  });

  it('stores a normalized package search query', () => {
    const manager = new FilterManager('all');

    manager.setSearch('  React DOM  ');

    expect(manager.search).toBe('react dom');
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
});
