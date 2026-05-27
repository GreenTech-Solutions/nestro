import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { PackagesProvider } from '../providers';

vi.mock('../providers', () => ({
  isFilterType: (value: unknown): boolean => (
    typeof value === 'string'
    && ['all', 'hasUpdates', 'patch', 'minor', 'breaking'].includes(value)
  ),
  PackagesProvider: vi.fn(function (this: Record<string, unknown>) {
    this.loadPackages = vi.fn().mockResolvedValue(undefined);
    this.checkUpdates = vi.fn().mockResolvedValue(undefined);
    this.setFilter = vi.fn();
    this.showFilterPicker = vi.fn().mockResolvedValue(undefined);
    this.getVisibleOutdatedPackages = vi.fn(() => []);
    this.dispose = vi.fn();
    this.onDidChangeTreeData = vi.fn();
    this.getTreeItem = vi.fn();
    this.getChildren = vi.fn(() => []);
  }),
  PackageItem: vi.fn(),
}));

function makeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function mockNestroConfiguration(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}

describe('activate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNestroConfiguration({});
  });

  it('registers nestro.helloWorld command', () => {
    activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'nestro.helloWorld',
      expect.any(Function),
    );
  });

  it('registers nestro.refresh command', () => {
    activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'nestro.refresh',
      expect.any(Function),
    );
  });

  it('registers nestro.installUpdate command', () => {
    activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'nestro.installUpdate',
      expect.any(Function),
    );
  });

  it('registers nestro.runInstall command', () => {
    activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'nestro.runInstall',
      expect.any(Function),
    );
  });

  it('registers nestro.updateAllVisible command', () => {
    activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'nestro.updateAllVisible',
      expect.any(Function),
    );
  });

  it('registers tree data provider for nestro.packagesView', () => {
    activate(makeContext());
    expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
      'nestro.packagesView',
      expect.any(Object),
    );
  });

  it('pushes all disposables to context.subscriptions', () => {
    const ctx = makeContext();
    activate(ctx);
    expect(ctx.subscriptions).toHaveLength(12);
  });

  it('creates Nestro output channel', async () => {
    vi.resetModules();
    const freshVscode = await import('vscode');
    const extension = await import('../extension');

    extension.activate(makeContext());

    expect(freshVscode.window.createOutputChannel).toHaveBeenCalledWith('Nestro');
  });

  it('helloWorld handler calls showInformationMessage', () => {
    activate(makeContext());
    const handler = vi.mocked(vscode.commands.registerCommand).mock.calls[0][1] as () => void;
    handler();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Hello World from Nestro again!',
    );
  });

  it('passes configured default filter to the packages provider', () => {
    mockNestroConfiguration({ defaultFilter: 'hasUpdates' });

    activate(makeContext());

    expect(PackagesProvider).toHaveBeenCalledWith('hasUpdates');
  });

  it('uses all as the default filter when the setting is missing', () => {
    activate(makeContext());

    expect(PackagesProvider).toHaveBeenCalledWith('all');
  });

  it('falls back to all when the default filter setting is invalid', () => {
    mockNestroConfiguration({ defaultFilter: 'invalid-filter' });

    activate(makeContext());

    expect(PackagesProvider).toHaveBeenCalledWith('all');
  });
});

describe('deactivate()', () => {
  it('runs without errors', () => {
    expect(() => deactivate()).not.toThrow();
  });
});