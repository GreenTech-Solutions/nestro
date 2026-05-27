import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate } from '../extension';
import type { PackageItem } from '../providers';

vi.mock('../providers', () => ({
  FilterManager: vi.fn(function (this: Record<string, unknown>) {
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
    this.setFilter = vi.fn();
    this.resetUpdateData = vi.fn();
    this.showFilterPicker = vi.fn().mockResolvedValue(undefined);
    this.suppressingWrites = false;
    this.dispose = vi.fn();
  }),
  PackageItem: vi.fn(),
}));

function makeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function getRegisteredCommand(command: string): (item: PackageItem) => void {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === command);
  if (call === undefined) {
    throw new Error(`Command ${command} was not registered.`);
  }
  return call[1] as (item: PackageItem) => void;
}

describe('npm link commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens an npmjs.com package page', () => {
    activate(makeContext());
    getRegisteredCommand('nestro.openOnNpm')({ packageName: 'react' } as PackageItem);

    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://www.npmjs.com/package/react');
    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
    );
  });

  it('opens an npmjs.com page for scoped packages', () => {
    activate(makeContext());
    getRegisteredCommand('nestro.openOnNpm')({ packageName: '@types/node' } as PackageItem);

    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://www.npmjs.com/package/@types/node');
  });

  it('copies the package name', () => {
    activate(makeContext());
    getRegisteredCommand('nestro.copyPackageName')({ packageName: 'react' } as PackageItem);

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('react');
  });
});