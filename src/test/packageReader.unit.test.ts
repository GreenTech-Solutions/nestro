import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  DependencyTypeConflictError,
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

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toEqual({ count: 2, skippedFiles: [] });

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

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toEqual({ count: 1, skippedFiles: [] });

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

  it('does not write any file when nothing across the workspace needs pinning', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/a/package.json'),
      vscode.Uri.file('/workspace/b/package.json'),
    ]);
    mockReadFileByPath({
      '/workspace/a/package.json': JSON.stringify({ dependencies: { react: '1.0.0' } }),
      '/workspace/b/package.json': JSON.stringify({ dependencies: { vue: '2.0.0' } }),
    });

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toEqual({ count: 0, skippedFiles: [] });

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('reads and classifies every discovered file before writing any of them', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/a/package.json'),
      vscode.Uri.file('/workspace/b/package.json'),
    ]);
    const order: string[] = [];
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: { fsPath: string }) => {
      order.push(`read:${uri.fsPath}`);
      const content = uri.fsPath.endsWith('/a/package.json')
        ? JSON.stringify({ dependencies: { react: '^1.0.0' } })
        : JSON.stringify({ dependencies: { vue: '^2.0.0' } });
      return Promise.resolve(Buffer.from(content));
    });
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation((uri: { fsPath: string }) => {
      order.push(`write:${uri.fsPath}`);
      return Promise.resolve(undefined);
    });

    await pinAllWorkspaceDependencyVersions();

    // Both reads land before either write — a per-file read-then-write loop would
    // interleave them (read a, write a, read b, write b) instead.
    expect(order).toEqual([
      'read:/workspace/a/package.json',
      'read:/workspace/b/package.json',
      'write:/workspace/a/package.json',
      'write:/workspace/b/package.json',
    ]);
  });

  it('skips a manifest that cannot be parsed and still pins the rest', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/a/package.json'),
      vscode.Uri.file('/workspace/b/package.json'),
    ]);
    mockReadFileByPath({
      '/workspace/a/package.json': JSON.stringify({ dependencies: { react: '^1.0.0' } }),
      '/workspace/b/package.json': '{ not valid json',
    });

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toEqual({
      count: 1,
      skippedFiles: ['b/package.json'],
    });

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/a/package.json' }),
      expect.anything(),
    );
  });

  it('treats a null dependencies section as empty instead of throwing', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/package.json'),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: null,
      devDependencies: { react: '^1.0.0' },
    })));

    await expect(pinAllWorkspaceDependencyVersions()).resolves.toEqual({ count: 1, skippedFiles: [] });
  });

  it('rolls an earlier successful write back to its exact original bytes when a later file fails to write', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/a/package.json'),
      vscode.Uri.file('/workspace/b/package.json'),
    ]);
    // Tabs and no trailing newline on b — round-tripping through the wrong bytes
    // (e.g. re-serializing instead of restoring the original buffer) would show up here.
    const originalA = '{\n\t"dependencies": {\n\t\t"react": "^1.0.0"\n\t}\n}\n';
    const originalB = '{"dependencies":{"vue":"^2.0.0"}}';
    mockReadFileByPath({
      '/workspace/a/package.json': originalA,
      '/workspace/b/package.json': originalB,
    });
    // Recorded outside the product code's own try/catch (rollbackPreparedPackageFiles
    // swallows a throw from inside the mock and reports it as a rollback failure
    // instead), so a failed byte assertion here surfaces as this test failing.
    const calls: { path: string; bytes: string }[] = [];
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation((uri, content) => {
      writeCount++;
      calls.push({ path: uri.fsPath, bytes: Buffer.from(content).toString('utf8') });
      // 1: write a (succeeds). 2: write b (fails, triggers rollback).
      // 3: rollback b. 4: rollback a — both succeed and restore original bytes.
      if (writeCount === 2) {
        return Promise.reject(new Error('disk full on b'));
      }
      return Promise.resolve();
    });

    await expect(pinAllWorkspaceDependencyVersions()).rejects.toThrow(new Error('disk full on b'));

    expect(writeCount).toBe(4);
    expect(calls[2]).toEqual({ path: '/workspace/b/package.json', bytes: originalB });
    expect(calls[3]).toEqual({ path: '/workspace/a/package.json', bytes: originalA });
  });

  it('reports a workspace-relative path when the rollback write itself fails', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/apps/a/package.json'),
      vscode.Uri.file('/workspace/apps/b/package.json'),
    ]);
    mockReadFileByPath({
      '/workspace/apps/a/package.json': JSON.stringify({ dependencies: { react: '^1.0.0' } }),
      '/workspace/apps/b/package.json': JSON.stringify({ dependencies: { vue: '^2.0.0' } }),
    });
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(() => {
      writeCount++;
      // 1: write a (succeeds). 2: write b (fails). 3: rollback b (fails too,
      // reported below). 4: rollback a (succeeds, so it never appears in the message).
      if (writeCount === 2) {
        return Promise.reject(new Error('disk full'));
      }
      if (writeCount === 3) {
        return Promise.reject(new Error('rollback failed'));
      }
      return Promise.resolve();
    });

    await expect(pinAllWorkspaceDependencyVersions()).rejects.toThrow(
      'disk full; failed to roll back: apps/b/package.json',
    );
  });

  it('falls back to the file basename when no workspace folder owns the failed path', async () => {
    // findFiles() is mocked directly, so these paths need not actually sit under the
    // default '/workspace' folder — that mismatch is exactly what drives the fallback.
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/outside/a/package.json'),
      vscode.Uri.file('/outside/b/package.json'),
    ]);
    mockReadFileByPath({
      '/outside/a/package.json': JSON.stringify({ dependencies: { react: '^1.0.0' } }),
      '/outside/b/package.json': JSON.stringify({ dependencies: { vue: '^2.0.0' } }),
    });
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(() => {
      writeCount++;
      if (writeCount === 2) {
        return Promise.reject(new Error('disk full'));
      }
      if (writeCount === 3) {
        return Promise.reject(new Error('rollback failed'));
      }
      return Promise.resolve();
    });

    await expect(pinAllWorkspaceDependencyVersions()).rejects.toThrow(
      'disk full; failed to roll back: package.json',
    );
  });
});

function mockReadFileByPath(filesByPath: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: { fsPath: string }) => {
    const content = filesByPath[uri.fsPath];
    if (content === undefined) {
      return Promise.reject(new Error(`no fixture for ${uri.fsPath}`));
    }
    return Promise.resolve(Buffer.from(content));
  });
}

describe('switchDependencyType()', () => {
  const malformedSpecs = [
    ['number', 7, '<number>'],
    ['null', null, '<null>'],
    ['object', { version: '7', path: '/secret/package.json' }, '<object>'],
    ['array', ['7'], '<array>'],
    ['boolean', true, '<boolean>'],
    ['control and ANSI', '\u0000\u001b[31munsafe\u001b[0m\n', ' unsafe '],
    ['long string', 'x'.repeat(300), 'x'.repeat(240)],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  });

  it('moves a package from dependencies to devDependencies and preserves the version string', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { zod: '^3.0.0' },
      devDependencies: { axios: '^1.0.0' },
    }, undefined, 2)));

    await switchDependencyType('/workspace/package.json', 'zod', false, '^3.0.0');

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

    await switchDependencyType('/workspace/package.json', 'axios', true, '^1.0.0');

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(JSON.parse(written)).toEqual({
      dependencies: {
        axios: '^1.0.0',
        react: '^18.0.0',
      },
    });
  });

  it('preserves tabs and a trailing newline when moving into an empty target section', async () => {
    const original = '{\n\t"dependencies": {\n\t\t"zod": "^3.0.0"\n\t}\n}\n';
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(original));

    await switchDependencyType('/workspace/package.json', 'zod', false, '^3.0.0');

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    expect(written).toBe('{\n\t"devDependencies": {\n\t\t"zod": "^3.0.0"\n\t}\n}\n');
  });

  it.each([
    ['same', '^1.2.3'],
    ['different', '~2.0.0'],
  ] as const)('rejects a %s-spec target collision without writing the file', async (_label, targetSpec) => {
    const original = JSON.stringify({
      dependencies: { pkg: '^1.2.3' },
      devDependencies: { pkg: targetSpec },
    }, undefined, 2);
    let document = original;
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(original));
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce((_uri, data) => {
      document = Buffer.from(data).toString('utf8');
      return Promise.resolve();
    });

    const result = switchDependencyType('/workspace/package.json', 'pkg', false, '^1.2.3');

    await expect(result).rejects.toBeInstanceOf(DependencyTypeConflictError);
    await expect(result).rejects.toMatchObject({
      expectedSourceSpec: '^1.2.3',
      actualSourceSpec: '^1.2.3',
      targetSpec,
    });
    await expect(result).rejects.toThrow(new RegExp(`\\^1\\.2\\.3.*${targetSpec === '^1.2.3' ? '\\^1\\.2\\.3' : '~2\\.0\\.0'}`));
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(document).toBe(original);
  });

  it('rejects a changed source spec without writing the file', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify({
      dependencies: { pkg: '~2.0.0' },
    }, undefined, 2)));

    await expect(switchDependencyType('/workspace/package.json', 'pkg', false, '^1.2.3'))
      .rejects.toThrow('source spec changed from ^1.2.3 to ~2.0.0');
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it.each(malformedSpecs)('rejects a malformed %s source spec as a typed no-write conflict', async (_label, sourceSpec, safeSpec) => {
    const original = JSON.stringify({ dependencies: { pkg: sourceSpec } });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(original));

    const result = switchDependencyType('/workspace/package.json', 'pkg', false, '^1.2.3');
    const error = await result.catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DependencyTypeConflictError);
    const conflict = error as DependencyTypeConflictError;
    expect(conflict.expectedSourceSpec).toBe('^1.2.3');
    expect(conflict.actualSourceSpec).toEqual(sourceSpec);
    expect(conflict.hasTargetSpec).toBe(false);
    expect(conflict.message).toContain(`to ${safeSpec}`);
    expect(conflict.message).not.toContain('/workspace/package.json');
    expect(conflict.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it.each(malformedSpecs)('rejects a malformed %s target spec as a typed no-write conflict', async (_label, targetSpec, safeSpec) => {
    const original = JSON.stringify({
      dependencies: { pkg: '^1.2.3' },
      devDependencies: { pkg: targetSpec },
    });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(original));

    const result = switchDependencyType('/workspace/package.json', 'pkg', false, '^1.2.3');
    const error = await result.catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DependencyTypeConflictError);
    const conflict = error as DependencyTypeConflictError;
    expect(conflict.actualSourceSpec).toBe('^1.2.3');
    expect(conflict.targetSpec).toEqual(targetSpec);
    expect(conflict.hasTargetSpec).toBe(true);
    expect(conflict.message).toContain(`target spec ${safeSpec}`);
    expect(conflict.message).not.toContain('/workspace/package.json');
    expect(conflict.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it.each(['constructor', '__proto__'] as const)('switches an own %s source entry when the target only inherits that key', async (packageName) => {
    const dependencies = { other: '^2.0.0' } as Record<string, string>;
    Object.defineProperty(dependencies, packageName, {
      configurable: true,
      enumerable: true,
      value: '^1.0.0',
      writable: true,
    });
    const original = JSON.stringify({
      dependencies,
      devDependencies: { zod: '^3.0.0' },
    });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(original));

    await switchDependencyType('/workspace/package.json', packageName, false, '^1.0.0');

    const written = Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1]).toString('utf8');
    const result = JSON.parse(written) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    expect(result.dependencies).toEqual({ other: '^2.0.0' });
    expect(Object.hasOwn(result.devDependencies ?? {}, packageName)).toBe(true);
    expect(result.devDependencies?.[packageName]).toBe('^1.0.0');
    expect(result.devDependencies?.zod).toBe('^3.0.0');
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