import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { copyPackageNameCommand } from '../commands/copyPackageName';
import { PackageItem } from '../providers';

describe('copyPackageNameCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies the package name to the clipboard', () => {
    copyPackageNameCommand(new PackageItem('react', '^18.0.0', undefined, 'none', false, undefined, '/workspace/package.json'));

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('react');
  });

  it.each([
    ['undefined (Command Palette invocation with no context item)', undefined],
    ['a malformed non-PackageItem object', { packageName: 'react' }],
    ['a primitive value', 'react'],
  ] as const)('safely no-ops instead of dereferencing %s', (_label, malformedItem) => {
    expect(() => copyPackageNameCommand(malformedItem)).not.toThrow();

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
});