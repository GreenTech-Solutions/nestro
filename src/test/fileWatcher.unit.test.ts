import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerPackageJsonWatcher } from '../extension';

describe('registerPackageJsonWatcher()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes packages 500ms after package.json changes', () => {
    const provider = makeProvider(false);

    registerPackageJsonWatcher(makeContext(), provider);
    getWatcherHandler('onDidChange')();
    vi.advanceTimersByTime(499);
    expect(provider.loadPackages).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('debounces several rapid file events into one refresh', () => {
    const provider = makeProvider(false);

    registerPackageJsonWatcher(makeContext(), provider);
    getWatcherHandler('onDidChange')();
    vi.advanceTimersByTime(100);
    getWatcherHandler('onDidCreate')();
    vi.advanceTimersByTime(100);
    getWatcherHandler('onDidChange')();
    vi.advanceTimersByTime(500);

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('does not refresh while provider writes are suppressed', () => {
    const provider = makeProvider(true);

    registerPackageJsonWatcher(makeContext(), provider);
    getWatcherHandler('onDidChange')();
    vi.advanceTimersByTime(500);

    expect(provider.loadPackages).not.toHaveBeenCalled();
  });

  it('refreshes immediately when package.json is deleted', () => {
    const provider = makeProvider(false);

    registerPackageJsonWatcher(makeContext(), provider);
    getWatcherHandler('onDidDelete')();

    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });
});

function makeProvider(suppressingWrites: boolean): {
  loadPackages: ReturnType<typeof vi.fn<() => Promise<void>>>;
  suppressingWrites: boolean;
} {
  return {
    loadPackages: vi.fn().mockResolvedValue(undefined),
    suppressingWrites,
  };
}

function makeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function getWatcherHandler(
  event: 'onDidChange' | 'onDidCreate' | 'onDidDelete',
): () => void {
  const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[0].value;
  return vi.mocked(watcher[event]).mock.calls[0][0];
}