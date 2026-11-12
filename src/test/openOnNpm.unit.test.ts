import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildPackageItem } from './fixtures';
import { openOnNpmCommand } from '../commands/openOnNpm';

describe('openOnNpmCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the npmjs.com page for the package', () => {
    openOnNpmCommand(buildPackageItem({ name: 'react', currentVersion: '^18.0.0', packageFilePath: '/workspace/package.json' }));

    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://www.npmjs.com/package/react');
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it('keeps a scoped name as two path segments', () => {
    openOnNpmCommand(buildPackageItem({ name: '@types/node', currentVersion: '^22.0.0', packageFilePath: '/workspace/package.json' }));

    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://www.npmjs.com/package/@types/node');
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a query separator', 'react?next=1'],
    ['a fragment separator', 'react#readme'],
    ['a path traversal segment pair', 'react/../admin'],
    ['a whitespace character', 'react app'],
    ['a leading hyphen', '-react'],
    ['an empty name', ''],
  ] as const)('does not open a URL for a name with %s', (_label, packageName) => {
    openOnNpmCommand(buildPackageItem({ name: packageName, currentVersion: '^1.0.0', packageFilePath: '/workspace/package.json' }));

    expect(vscode.Uri.parse).not.toHaveBeenCalled();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react' }],
    ['a primitive value', 'react'],
  ] as const)('safely no-ops instead of dereferencing %s', (_label, malformedItem) => {
    expect(() => openOnNpmCommand(malformedItem)).not.toThrow();

    expect(vscode.Uri.parse).not.toHaveBeenCalled();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });
});