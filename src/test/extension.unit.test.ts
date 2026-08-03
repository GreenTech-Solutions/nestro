import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { PackagesProvider } from '../providers';

vi.mock('../providers', () => ({
  FilterManager: vi.fn(function (this: Record<string, unknown>, initialFilter: string) {
    this.current = initialFilter;
    this.set = vi.fn();
    this.showPicker = vi.fn().mockResolvedValue(undefined);
    this.dispose = vi.fn();
    this.onDidChange = vi.fn();
  }),
  isFilterType: (value: unknown): boolean => (
    typeof value === 'string'
    && ['all', 'hasUpdates', 'patch', 'minor', 'breaking'].includes(value)
  ),
  PackagesProvider: vi.fn(function (this: Record<string, unknown>) {
    this.attachTreeView = vi.fn();
    this.loadPackages = vi.fn().mockResolvedValue(undefined);
    this.checkUpdates = vi.fn().mockResolvedValue(undefined);
    this.runAudit = vi.fn().mockResolvedValue(undefined);
    this.invalidateUpdateCache = vi.fn();
    this.setFilter = vi.fn();
    this.resetUpdateData = vi.fn();
    this.showFilterPicker = vi.fn().mockResolvedValue(undefined);
    this.showSearch = vi.fn().mockResolvedValue(undefined);
    this.clearSearch = vi.fn();
    this.getVisibleOutdatedPackages = vi.fn(() => []);
    this.suppressingWrites = false;
    this.dispose = vi.fn();
    this.onDidChangeTreeData = vi.fn();
    this.getTreeItem = vi.fn();
    this.getChildren = vi.fn(() => []);
  }),
  PackageItem: vi.fn(),
}));

// Every command id activate() is expected to register with VS Code.
const REGISTERED_COMMAND_IDS = [
  'nestro.refresh',
  'nestro.installUpdate',
  'nestro.switchDepType',
  'nestro.pinVersion',
  'nestro.removePackage',
  'nestro.runAudit',
  'nestro.runInstall',
  'nestro.updateAllVisible',
  'nestro.openOnNpm',
  'nestro.copyPackageName',
  'nestro.searchPackages',
  'nestro.clearSearchQuery',
];

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

  it.each(REGISTERED_COMMAND_IDS)('registers %s command', (commandId) => {
    activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      commandId,
      expect.any(Function),
    );
  });

  it('creates tree view for nestro.packagesView', () => {
    activate(makeContext());
    expect(vscode.window.createTreeView).toHaveBeenCalledWith(
      'nestro.packagesView',
      expect.objectContaining({
        showCollapseAll: true,
        treeDataProvider: expect.any(Object),
      }),
    );
  });

  it('pushes all disposables to context.subscriptions', () => {
    const ctx = makeContext();
    activate(ctx);
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(20);
  });

  it('creates Nestro output channel', async () => {
    vi.resetModules();
    const freshVscode = await import('vscode');
    const extension = await import('../extension');

    extension.activate(makeContext());

    expect(freshVscode.window.createOutputChannel).toHaveBeenCalledWith('Nestro');
  });

  it('passes configured default filter to the packages provider', () => {
    mockNestroConfiguration({ defaultFilter: 'hasUpdates' });

    activate(makeContext());

    expect(PackagesProvider).toHaveBeenCalledWith(expect.objectContaining({ current: 'hasUpdates' }));
  });

  it('uses all as the default filter when the setting is missing', () => {
    activate(makeContext());

    expect(PackagesProvider).toHaveBeenCalledWith(expect.objectContaining({ current: 'all' }));
  });

  it('falls back to all when the default filter setting is invalid', () => {
    mockNestroConfiguration({ defaultFilter: 'invalid-filter' });

    activate(makeContext());

    expect(PackagesProvider).toHaveBeenCalledWith(expect.objectContaining({ current: 'all' }));
  });
});

describe('deactivate()', () => {
  it('runs without errors', () => {
    expect(() => deactivate()).not.toThrow();
  });
});