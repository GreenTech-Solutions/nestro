import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const fsMock = vi.hoisted(() => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMock);

import { resolveCanonicalPackageLocation } from '../providers/packageIdentity';

const WORKSPACE_PATH = '/workspace';
const REQUESTED_ALIAS_PATH = '/WORKSPACE/package.json';
const CANONICAL_PACKAGE_PATH = '/workspace/package.json';

type SymlinkProof = 'different-entry' | 'different-inode' | 'lstat-failure';

function makeStats(dev: number, ino: number, symbolicLink: boolean): {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  isSymbolicLink: () => boolean;
} {
  return {
    dev,
    ino,
    size: 12,
    mtimeMs: 1,
    isSymbolicLink: () => symbolicLink,
  };
}

function configureFilesystem(proof: SymlinkProof): void {
  fsMock.realpath.mockImplementation((candidate: string) => Promise.resolve(
    candidate === REQUESTED_ALIAS_PATH ? CANONICAL_PACKAGE_PATH : candidate,
  ));
  const packageStats = makeStats(1, 2, false);
  fsMock.stat.mockResolvedValue(packageStats);
  fsMock.readFile.mockResolvedValue(Buffer.from('{}'));

  let lstatCall = 0;
  fsMock.lstat.mockImplementation(() => {
    lstatCall += 1;
    if (proof === 'lstat-failure') {
      throw new Error('controlled lstat failure');
    }
    if (proof === 'different-entry') {
      return Promise.resolve(makeStats(1, 2, lstatCall === 1));
    }
    return Promise.resolve(makeStats(1, lstatCall === 1 ? 3 : 4, true));
  });
}

describe('resolveCanonicalPackageLocation() filesystem proof', () => {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;

  afterEach(() => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: previousWorkspaceFolders,
    });
    vi.clearAllMocks();
  });

  it.each([
    ['a symlink entry differing from the canonical directory entry', 'different-entry'],
    ['two symlink entries with different device/inode identities', 'different-inode'],
    ['an lstat failure while proving the case-only alias', 'lstat-failure'],
  ] as const)('rejects a case-only alias when %s', async (_label, proof) => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: WORKSPACE_PATH } }],
    });
    configureFilesystem(proof);

    await expect(resolveCanonicalPackageLocation(REQUESTED_ALIAS_PATH)).resolves.toEqual({
      ok: false,
      reason: 'cross-workspace',
    });
    expect(fsMock.lstat).toHaveBeenCalled();
  });
});