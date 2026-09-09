import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  findWorkspacePackageJsonFiles,
  getWorkspacePackageFilePath,
  getWorkspacePackageFilePaths,
  readPackageFile,
  toWorkspaceRelativePackageFilePath,
  writeManyPreparedPackageFilesAtomically,
  writePreparedPackageFile,
} from '../utils';
import type { PreparedPackageFile } from '../utils';

describe('getWorkspacePackageFilePath()', () => {
  resetWorkspaceFoldersBeforeEach();

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

describe('readPackageFile()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the uri, original bytes and decoded raw text', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from('{"name":"pkg"}'));

    const file = await readPackageFile('/workspace/package.json');

    expect(file.uri.fsPath).toBe('/workspace/package.json');
    expect(file.raw).toBe('{"name":"pkg"}');
    expect(Buffer.from(file.original).toString('utf8')).toBe('{"name":"pkg"}');
  });

  it('reads an existing URI without replacing its scheme or identity', async () => {
    const uri = vscode.Uri.file('/workspace/package.json');
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from('{"name":"pkg"}'));

    const file = await readPackageFile(uri);

    expect(file.uri).toBe(uri);
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(uri);
  });
});

describe('writePreparedPackageFile()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  });

  it('writes the updated bytes verbatim', async () => {
    const file: PreparedPackageFile = {
      uri: vscode.Uri.file('/workspace/package.json'),
      original: Buffer.from('{}'),
      updated: Buffer.from('{"name":"pkg"}'),
    };

    await writePreparedPackageFile(file);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(file.uri, file.updated);
  });
});

describe('writeManyPreparedPackageFilesAtomically()', () => {
  resetWorkspaceFoldersBeforeEach();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function prepared(fsPath: string, original: string, updated: string): PreparedPackageFile {
    return {
      uri: vscode.Uri.file(fsPath),
      original: Buffer.from(original),
      updated: Buffer.from(updated),
    };
  }

  it('writes every file in order when all writes succeed', async () => {
    const order: string[] = [];
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation((uri: { fsPath: string }) => {
      order.push(uri.fsPath);
      return Promise.resolve();
    });
    const files = [
      prepared('/workspace/a/package.json', '{}', '{"a":1}'),
      prepared('/workspace/b/package.json', '{}', '{"b":1}'),
    ];

    await writeManyPreparedPackageFilesAtomically(files);

    expect(order).toEqual(['/workspace/a/package.json', '/workspace/b/package.json']);
  });

  it('rolls back only successfully written files in reverse order on failure', async () => {
    const files = [
      prepared('/workspace/a/package.json', 'original-a', 'updated-a'),
      prepared('/workspace/b/package.json', 'original-b', 'updated-b'),
      prepared('/workspace/c/package.json', 'original-c', 'updated-c'),
    ];
    const calls: { path: string; bytes: string }[] = [];
    let writeCount = 0;
    const writeError = new Error('disk full on c');
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation((uri: { fsPath: string }, content: Uint8Array) => {
      writeCount++;
      calls.push({ path: uri.fsPath, bytes: Buffer.from(content).toString('utf8') });
      if (writeCount === 3) {
        return Promise.reject(writeError);
      }
      return Promise.resolve();
    });

    const error: unknown = await writeManyPreparedPackageFilesAtomically(files).catch((err: unknown) => err);

    expect(error).toBe(writeError);
    expect(writeCount).toBe(5);
    expect(calls).toEqual([
      { path: '/workspace/a/package.json', bytes: 'updated-a' },
      { path: '/workspace/b/package.json', bytes: 'updated-b' },
      { path: '/workspace/c/package.json', bytes: 'updated-c' },
      { path: '/workspace/b/package.json', bytes: 'original-b' },
      { path: '/workspace/a/package.json', bytes: 'original-a' },
    ]);
  });

  it('propagates the original error unchanged when rollback fully succeeds', async () => {
    const files = [
      prepared('/workspace/a/package.json', 'original-a', 'updated-a'),
      prepared('/workspace/b/package.json', 'original-b', 'updated-b'),
    ];
    let writeCount = 0;
    const writeError = new Error('disk full');
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(() => {
      writeCount++;
      // 1: write a succeeds. 2: write b fails. 3: rollback a succeeds.
      if (writeCount === 2) {
        return Promise.reject(writeError);
      }
      return Promise.resolve();
    });

    const error: unknown = await writeManyPreparedPackageFilesAtomically(files).catch((err: unknown) => err);

    expect(error).toBe(writeError);
    expect(writeCount).toBe(3);
  });

  it('appends the workspace-relative rollback failures to the error message when rollback itself fails', async () => {
    const files = [
      prepared('/workspace/apps/a/package.json', 'original-a', 'updated-a'),
      prepared('/workspace/apps/b/package.json', 'original-b', 'updated-b'),
    ];
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(() => {
      writeCount++;
      // 1: write a succeeds. 2: write b fails. 3: rollback a fails.
      if (writeCount === 2) {
        return Promise.reject(new Error('disk full'));
      }
      if (writeCount === 3) {
        return Promise.reject(new Error('rollback failed'));
      }
      return Promise.resolve();
    });

    await expect(writeManyPreparedPackageFilesAtomically(files)).rejects.toThrow(
      'disk full; failed to roll back: apps/a/package.json',
    );
  });

  it('does not attempt rollback when the first write fails', async () => {
    const files = [
      prepared('/workspace/a/package.json', 'original-a', 'updated-a'),
      prepared('/workspace/b/package.json', 'original-b', 'updated-b'),
    ];
    const writeError = new Error('disk full on a');
    let writeCount = 0;
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation((uri: { fsPath: string }, content: Uint8Array) => {
      writeCount++;
      expect(uri.fsPath).toBe('/workspace/a/package.json');
      expect(Buffer.from(content).toString('utf8')).toBe('updated-a');
      return Promise.reject(writeError);
    });

    const error: unknown = await writeManyPreparedPackageFilesAtomically(files).catch((err: unknown) => err);

    expect(error).toBe(writeError);
    expect(writeCount).toBe(1);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does nothing and resolves when there is nothing to write', async () => {
    await expect(writeManyPreparedPackageFilesAtomically([])).resolves.toBeUndefined();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('findWorkspacePackageJsonFiles() / getWorkspacePackageFilePaths()', () => {
  resetWorkspaceFoldersBeforeEach();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
  });

  it('returns no files when no workspace folder is open', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [],
    });

    await expect(findWorkspacePackageJsonFiles()).resolves.toEqual([]);
    expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  });

  it('uses an explicit glob instead of the configured monorepoGlob', async () => {
    await findWorkspacePackageJsonFiles('apps/*/package.json');

    expect(vscode.workspace.findFiles).toHaveBeenCalledWith('apps/*/package.json', '**/node_modules/**');
  });

  it('maps discovered files to their filesystem paths', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
      vscode.Uri.file('/workspace/package.json'),
      vscode.Uri.file('/workspace/apps/a/package.json'),
    ]);

    await expect(getWorkspacePackageFilePaths()).resolves.toEqual([
      '/workspace/package.json',
      '/workspace/apps/a/package.json',
    ]);
  });
});

describe('toWorkspaceRelativePackageFilePath()', () => {
  resetWorkspaceFoldersBeforeEach();

  it('strips the owning workspace folder root', () => {
    expect(toWorkspaceRelativePackageFilePath('/workspace/apps/a/package.json')).toBe('apps/a/package.json');
  });

  it('falls back to the file basename when no workspace folder owns the path', () => {
    expect(toWorkspaceRelativePackageFilePath('/outside/package.json')).toBe('package.json');
  });
});

function resetWorkspaceFoldersBeforeEach(): void {
  beforeEach(() => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
  });
}