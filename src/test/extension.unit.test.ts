import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { PackagesProvider } from '../providers';
import {
  installUpdateCommand,
  pickVersionCommand,
  pinAllVersionsCommand,
  pinVersionCommand,
  removePackageCommand,
  runInstallCommand,
  switchDepTypeCommand,
  updateAllVisibleCommand,
} from '../commands';

// Every command handler in activate() is a thin one-line delegation to an already
// independently-tested command function; stubbing them keeps handler invocation below
// safe (no real network/task/file-system side effects) while still proving the wiring.
vi.mock('../commands', () => ({
  installUpdateCommand: vi.fn(),
  pickVersionCommand: vi.fn(),
  pinAllVersionsCommand: vi.fn(),
  pinVersionCommand: vi.fn(),
  removePackageCommand: vi.fn(),
  runInstallCommand: vi.fn(),
  switchDepTypeCommand: vi.fn(),
  updateAllVisibleCommand: vi.fn(),
}));

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

// Every command id activate() is expected to register with VS Code — must match
// contributes.commands in package.json exactly (CLAUDE.md convention).
const REGISTERED_COMMAND_IDS = [
  'nestro.refresh',
  'nestro.checkUpdates',
  'nestro.installUpdate',
  'nestro.pickVersion',
  'nestro.switchDepType',
  'nestro.pinVersion',
  'nestro.removePackage',
  'nestro.runAudit',
  'nestro.runInstall',
  'nestro.updateAllVisible',
  'nestro.pinAllVersions',
  'nestro.openOnNpm',
  'nestro.copyPackageName',
  'nestro.setFilter',
  'nestro.showFilterPicker',
  'nestro.searchPackages',
  'nestro.clearSearchQuery',
  'nestro.openSettings',
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

  it('invokes every registered command handler without throwing', () => {
    activate(makeContext());

    const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
    expect(calls).toHaveLength(REGISTERED_COMMAND_IDS.length);
    for (const [, handler] of calls) {
      expect(() => handler({} as never)).not.toThrow();
    }
  });

  it('delegates package-scoped command handlers to their command function with the clicked item', () => {
    activate(makeContext());
    const item = { packageName: 'react' } as unknown as vscode.TreeItem;
    const handlers = new Map(vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([id, handler]) => [id, handler] as const,
    ));

    handlers.get('nestro.installUpdate')?.(item);
    handlers.get('nestro.pickVersion')?.(item);
    handlers.get('nestro.switchDepType')?.(item);
    handlers.get('nestro.pinVersion')?.(item);
    handlers.get('nestro.removePackage')?.(item);
    handlers.get('nestro.runInstall')?.();
    handlers.get('nestro.updateAllVisible')?.();
    handlers.get('nestro.pinAllVersions')?.();

    expect(installUpdateCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(pickVersionCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(switchDepTypeCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(pinVersionCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(removePackageCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(runInstallCommand).toHaveBeenCalledTimes(1);
    expect(updateAllVisibleCommand).toHaveBeenCalledWith(expect.any(Object));
    expect(pinAllVersionsCommand).toHaveBeenCalledWith(expect.any(Object));
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)('runs startup checks according to configuration (checkUpdatesOnStartup=%s, runAuditOnStartup=%s)', async (checkUpdatesOnStartup, runAuditOnStartup) => {
    mockNestroConfiguration({ checkUpdatesOnStartup, runAuditOnStartup });

    activate(makeContext());
    const provider = vi.mocked(PackagesProvider).mock.instances[0] as unknown as PackagesProvider;
    await (provider.loadPackages as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await Promise.resolve();

    expect(provider.checkUpdates).toHaveBeenCalledTimes(checkUpdatesOnStartup ? 1 : 0);
    expect(provider.runAudit).toHaveBeenCalledTimes(runAuditOnStartup ? 1 : 0);
  });
});

describe('deactivate()', () => {
  it('runs without errors', () => {
    expect(() => deactivate()).not.toThrow();
  });
});