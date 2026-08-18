import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate } from '../extension';
import { PackageItem } from '../providers';

vi.mock('../providers', async () => {
  // isPackageItem/PackageItem come from the real module: the guard these commands rely on
  // does a genuine `instanceof PackageItem` check, so this suite constructs real instances
  // below rather than a plain object shape, matching what the real tree view passes.
  const actual = await vi.importActual<typeof import('../providers')>('../providers');
  return {
    ...actual,
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
  };
});

function makeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function getRegisteredCommand(command: string): (item: unknown) => void {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === command);
  if (call === undefined) {
    throw new Error(`Command ${command} was not registered.`);
  }
  return call[1] as (item: unknown) => void;
}

function makePackageItem(packageName: string): PackageItem {
  return new PackageItem(packageName, '1.0.0', undefined, 'none', false, undefined, '/workspace/package.json');
}

describe('npm link commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens an npmjs.com package page', () => {
    activate(makeContext());
    getRegisteredCommand('nestro.openOnNpm')(makePackageItem('react'));

    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://www.npmjs.com/package/react');
    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
    );
  });

  it('opens an npmjs.com page for scoped packages', () => {
    activate(makeContext());
    getRegisteredCommand('nestro.openOnNpm')(makePackageItem('@types/node'));

    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://www.npmjs.com/package/@types/node');
  });

  it('copies the package name', () => {
    activate(makeContext());
    getRegisteredCommand('nestro.copyPackageName')(makePackageItem('react'));

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('react');
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react' }],
  ] as const)('nestro.openOnNpm safely no-ops instead of dereferencing %s', (_label, malformedItem) => {
    activate(makeContext());
    getRegisteredCommand('nestro.openOnNpm')(malformedItem);

    expect(vscode.Uri.parse).not.toHaveBeenCalled();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react' }],
  ] as const)('nestro.copyPackageName safely no-ops instead of dereferencing %s', (_label, malformedItem) => {
    activate(makeContext());
    getRegisteredCommand('nestro.copyPackageName')(malformedItem);

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
});