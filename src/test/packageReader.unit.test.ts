import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  extractVersionPrefix,
  getWorkspacePackageFilePath,
  pinAllWorkspaceDependencyVersions,
  readAllWorkspaceDependencies,
  readWorkspaceDependencies,
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

describe('getWorkspacePackageFilePath()', () => {
  afterEach(() => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
  });

  it('joins the first workspace folder with package.json', () => {
    expect(getWorkspacePackageFilePath()).toBe('/workspace/package.json');
  });

  it('returns undefined when no workspace folder is open', () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: undefined,
    });

    expect(getWorkspacePackageFilePath()).toBeUndefined();
  });
});

describe('readWorkspaceDependencies()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
  });

  it('projects entries to name/current/dev/versionPrefix, dropping the file path', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '5.0.0' },
    })));

    await expect(readWorkspaceDependencies()).resolves.toEqual([
      { name: 'react', current: '^18.0.0', dev: false, versionPrefix: '^' },
      { name: 'vite', current: '5.0.0', dev: true, versionPrefix: '' },
    ]);
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

    const result = await readAllWorkspaceDependencies();

    expect(result).toEqual([
      {
        name: 'react',
        current: '^18.0.0',
        dev: false,
        versionPrefix: '^',
        packageFilePath: '/workspace/good/package.json',
      },
    ]);
    expect(result.skippedFiles).toEqual([
      {
        packageFilePath: '/workspace/bad/package.json',
        error: expect.any(String),
      },
    ]);
  });

  it('returns every skipped path when all package.json files are invalid', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/bad/package.json'),
      vscode.Uri.file('/workspace/unreadable/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile)
      .mockRejectedValueOnce(new Error('malformed package.json'))
      .mockRejectedValueOnce(new Error('permission denied'));

    const result = await readAllWorkspaceDependencies();

    expect(result).toEqual([]);
    expect(result.skippedFiles).toEqual([
      { packageFilePath: '/workspace/bad/package.json', error: 'malformed package.json' },
      { packageFilePath: '/workspace/unreadable/package.json', error: 'permission denied' },
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

    await updateWorkspaceDependencyVersions([{ name: 'react', version: '18.0.0', section: 'dependencies' }]);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
    expect(written).toContain('\n  "dependencies":');
    expect(written).toContain('\n    "react": "^18.0.0"');
  });

  it('updates dependencies in a specific package file', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^17.0.0' },
    }, undefined, 2)));

    await updateDependencyVersionsInFile('/workspace/apps/frontend/package.json', [
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/apps/frontend/package.json' }),
      expect.any(Buffer),
    );
    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
    expect(written).toContain('\n  "dependencies":');
    expect(written).toContain('\n    "react": "^18.0.0"');
  });

  it('preserves tab indentation when updating package.json', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^17.0.0' },
    }, undefined, '\t')));

    await updateDependencyVersionsInFile('/workspace/package.json', [
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
    expect(written).toContain('\n\t"dependencies":');
    expect(written).toContain('\n\t\t"react": "^18.0.0"');
    expect(written).not.toContain('\n "dependencies":');
  });

  it('preserves 4-space indentation when updating package.json', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '^17.0.0' },
    }, undefined, 4)));

    await updateDependencyVersionsInFile('/workspace/package.json', [
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
    expect(written).toContain('\n    "dependencies":');
    expect(written).toContain('\n        "react": "^18.0.0"');
  });

  it('updates only the requested section when a package exists in dependencies and devDependencies', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    }, undefined, 2)));

    await updateDependencyVersionsInFile('/workspace/package.json', [
      { name: 'typescript', version: '5.9.3', section: 'devDependencies' },
    ]);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { typescript: '^4.0.0' },
      devDependencies: { typescript: '~5.9.3' },
    });
  });
});

describe('pinAllWorkspaceDependencyVersions()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  });

  it('pins concrete workspace ranges while preserving the workspace protocol', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: {
        react: 'workspace:^1.2.3',
        vue: 'workspace:~2.3.4',
        internal: 'workspace:*',
        pending: 'workspace:^',
      },
    }, undefined, 2)));

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toBe(2);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: {
        react: 'workspace:1.2.3',
        vue: 'workspace:2.3.4',
        internal: 'workspace:*',
        pending: 'workspace:^',
      },
    });
  });

  it('skips unsupported specs without constructing a caret or writing them', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: {
        alias: 'npm:real-pkg@^1.2.3',
        file: 'file:../local-pkg',
        git: 'git+https://github.com/foo/bar.git',
        wildcard: 'X.2.3',
        comparator: '>=1.2.3',
        exact: '1.2.3',
        range: '~1.2.3',
      },
    }, undefined, 2)));

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toBe(1);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: {
        alias: 'npm:real-pkg@^1.2.3',
        file: 'file:../local-pkg',
        git: 'git+https://github.com/foo/bar.git',
        wildcard: 'X.2.3',
        comparator: '>=1.2.3',
        exact: '1.2.3',
        range: '1.2.3',
      },
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

    await setVersionPin('/workspace/package.json', 'react', 'dependencies', '^18.0.0', true);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '18.0.0' },
    });
  });

  it('adds a caret when unpinning a dependency', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { react: '18.0.0' },
    }, undefined, 2)));

    await setVersionPin('/workspace/package.json', 'react', 'dependencies', '18.0.0', false);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { react: '^18.0.0' },
    });
  });

  it('preserves the workspace: protocol when pinning a concrete workspace range', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { internal: 'workspace:^1.2.3' },
    }, undefined, 2)));

    await setVersionPin('/workspace/package.json', 'internal', 'dependencies', 'workspace:^1.2.3', true);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { internal: 'workspace:1.2.3' },
    });
  });

  it('pins only the caller-specified section when the same name is duplicated in both', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { lodash: '^4.0.0' },
      devDependencies: { lodash: '^3.0.0' },
    }, undefined, 2)));

    await setVersionPin('/workspace/package.json', 'lodash', 'devDependencies', '^3.0.0', true);

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: { lodash: '^4.0.0' },
      devDependencies: { lodash: '3.0.0' },
    });
  });

  it.each([
    ['workspace:*', 'workspace range is not a concrete version (wildcard version range)'],
    ['file:../local-pkg', 'local file dependency'],
    ['git+https://github.com/foo/bar.git', 'git dependency'],
    ['npm:real-pkg@^1.2.3', 'npm alias dependency'],
    ['latest', 'dist-tag reference'],
    ['*', 'wildcard version range'],
    ['>=1.2.3 <2.0.0', 'compound version range'],
    ['>=1.2.3', 'comparator version range'],
  ] as const)('rejects %s without writing the file', async (current, reason) => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { pkg: current },
    }, undefined, 2)));

    await expect(setVersionPin('/workspace/package.json', 'pkg', 'dependencies', current, false))
      .rejects.toThrow(`Cannot toggle pin for pkg: ${reason}.`);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a missing package without writing the file', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: {},
    }, undefined, 2)));

    await expect(setVersionPin('/workspace/package.json', 'missing', 'dependencies', '1.2.3', true))
      .rejects.toThrow('Package action is no longer available. Refresh the package list and try again.');
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});