import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { extractVersionPrefix, updateWorkspaceDependencyVersions } from '../utils';

describe('extractVersionPrefix()', () => {
  it.each([
    ['^1.0.0', '^'],
    ['~1.2.3', '~'],
    ['>=1.0.0', '>='],
    ['1.0.0', ''],
    ['*', ''],
    ['workspace:^', ''],
  ])('extracts %s as %s', (versionString, expectedPrefix) => {
    expect(extractVersionPrefix(versionString)).toBe(expectedPrefix);
  });
});

describe('updateWorkspaceDependencyVersions()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  });

  it('preserves the existing version prefix when updating package.json', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^17.0.0' },
    }, undefined, 2)));

    await updateWorkspaceDependencyVersions([{ name: 'react', version: '18.0.0' }]);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
  });
});