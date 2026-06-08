import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  extractVersionPrefix,
  readAllWorkspaceDependencies,
  setVersionPin,
  switchDependencyType,
  updateDependencyVersionsInFile,
  updateWorkspaceDependencyVersions,
} from '../utils';

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

describe('readAllWorkspaceDependencies()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
  });

  it('returns dependencies from one package.json with the package file path', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '^5.0.0' },
    })));

    await expect(readAllWorkspaceDependencies()).resolves.toEqual([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/package.json',
      },
      {
        name: 'vite',
        current: '^5.0.0',
        dev: true,
        versionPrefix: '^',
        packageFilePath: '/workspace/package.json',
      },
    ]);
  });

  it('returns dependencies from multiple package files', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/apps/frontend/package.json'),
      vscode.Uri.file('/workspace/packages/ui/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile)
      .mockResolvedValueOnce(Buffer.from(JSON.stringify({ dependencies: { react: '^18.0.0' } })))
      .mockResolvedValueOnce(Buffer.from(JSON.stringify({ dependencies: { '@scope/ui': '^1.0.0' } })));

    await expect(readAllWorkspaceDependencies()).resolves.toEqual([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/apps/frontend/package.json',
      },
      {
        name: '@scope/ui',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
  });

  it('skips invalid package.json files and continues reading the rest', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/bad/package.json'),
      vscode.Uri.file('/workspace/good/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile)
      .mockResolvedValueOnce(Buffer.from('{'))
      .mockResolvedValueOnce(Buffer.from(JSON.stringify({ dependencies: { react: '^18.0.0' } })));

    await expect(readAllWorkspaceDependencies()).resolves.toEqual([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/good/package.json',
      },
    ]);
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

  it('updates dependencies in a specific package file', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^17.0.0' },
    }, undefined, 2)));

    await updateDependencyVersionsInFile('/workspace/apps/frontend/package.json', [
      { name: 'react', version: '18.0.0' },
    ]);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/apps/frontend/package.json' }),
      expect.any(Buffer),
    );
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
  });
});

describe('switchDependencyType()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  });

  it('moves a package from dependencies to devDependencies and preserves the version string', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { zod: '^3.0.0' },
      devDependencies: { axios: '^1.0.0' },
    }, undefined, 2)));

    await switchDependencyType('/workspace/package.json', 'zod', false);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      devDependencies: {
        axios: '^1.0.0',
        zod: '^3.0.0',
      },
    });
  });

  it('moves a package from devDependencies to dependencies and preserves the version string', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { axios: '^1.0.0' },
    }, undefined, 2)));

    await switchDependencyType('/workspace/package.json', 'axios', true);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: {
        axios: '^1.0.0',
        react: '^18.0.0',
      },
    });
  });
});

describe('setVersionPin()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  });

  it('removes the version prefix when pinning a dependency', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
    }, undefined, 2)));

    await setVersionPin('/workspace/package.json', 'react', true);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '18.0.0' },
    });
  });

  it('adds a caret when unpinning a dependency', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '18.0.0' },
    }, undefined, 2)));

    await setVersionPin('/workspace/package.json', 'react', false);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
  });
});