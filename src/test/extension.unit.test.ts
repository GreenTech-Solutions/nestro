import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { PackagesProvider } from '../providers';
import {
  copyPackageNameCommand,
  installUpdateCommand,
  openAuditReportCommand,
  openOnNpmCommand,
  openStatusReportCommand,
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
  copyPackageNameCommand: vi.fn(),
  installUpdateCommand: vi.fn(),
  openAuditReportCommand: vi.fn(),
  openStatusReportCommand: vi.fn(),
  openOnNpmCommand: vi.fn(),
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
    this.getAuditReport = vi.fn(() => ({ projects: [], failures: [] }));
    this.getStatusReport = vi.fn(() => ({
      packageReadFailures: [],
      updateFailures: [],
      auditFailures: [],
      fileLabels: [],
    }));
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

interface ManifestCommand {
  readonly command: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly commands: readonly ManifestCommand[];
  };
}

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

// Sourced directly from contributes.commands in package.json — the real source of truth —
// rather than a hardcoded copy, so this list cannot silently drift from the manifest
// (CLAUDE.md convention: command IDs must match exactly between package.json and registerCommand).
const REGISTERED_COMMAND_IDS = manifest.contributes.commands.map(entry => entry.command);

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

    expect(freshVscode.window.createOutputChannel).toHaveBeenCalledWith('Nestro', { log: true });
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

  it('invokes every registered command handler without throwing, matching a real Command Palette invocation with no argument', () => {
    activate(makeContext());

    const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
    expect(calls).toHaveLength(REGISTERED_COMMAND_IDS.length);
    for (const [, handler] of calls) {
      expect(() => handler(undefined as never)).not.toThrow();
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
    handlers.get('nestro.openOnNpm')?.(item);
    handlers.get('nestro.copyPackageName')?.(item);
    handlers.get('nestro.openAuditReport')?.();
    handlers.get('nestro.openStatusReport')?.();

    expect(installUpdateCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(pickVersionCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(switchDepTypeCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(pinVersionCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(removePackageCommand).toHaveBeenCalledWith(item, expect.any(Object));
    expect(runInstallCommand).toHaveBeenCalledTimes(1);
    expect(updateAllVisibleCommand).toHaveBeenCalledWith(expect.any(Object));
    expect(pinAllVersionsCommand).toHaveBeenCalledWith(expect.any(Object));
    expect(openOnNpmCommand).toHaveBeenCalledWith(item);
    expect(copyPackageNameCommand).toHaveBeenCalledWith(item);
    expect(openAuditReportCommand).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
    expect(openStatusReportCommand).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
  });

  it('applies every valid filter through nestro.setFilter', () => {
    activate(makeContext());
    const handlers = new Map(vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([id, handler]) => [id, handler] as const,
    ));
    const provider = vi.mocked(PackagesProvider).mock.instances[0] as unknown as PackagesProvider;

    for (const filterType of ['all', 'hasUpdates', 'patch', 'minor', 'breaking']) {
      handlers.get('nestro.setFilter')?.(filterType);
    }

    expect(vi.mocked(provider.setFilter).mock.calls.map(([type]) => type))
      .toEqual(['all', 'hasUpdates', 'patch', 'minor', 'breaking']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['an arbitrary string', 'not-a-filter'],
    ['a number', 42],
    ['a plain object', {}],
    ['an array', []],
    ['true', true],
  ])('rejects %s from nestro.setFilter without touching the active filter', (_label, value) => {
    activate(makeContext());
    const handlers = new Map(vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([id, handler]) => [id, handler] as const,
    ));
    const provider = vi.mocked(PackagesProvider).mock.instances[0] as unknown as PackagesProvider;

    expect(() => handlers.get('nestro.setFilter')?.(value)).not.toThrow();
    expect(provider.setFilter).not.toHaveBeenCalled();
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