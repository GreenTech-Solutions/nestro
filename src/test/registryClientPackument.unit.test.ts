import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePackument } from '../utils/metadata/packument';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('node:https', () => ({
  get: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

const detectPackageManagerMock = vi.hoisted(() => vi.fn());
const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/packageManager', () => ({
  detectPackageManager: detectPackageManagerMock,
}));
vi.mock('../utils/yarnFamily', async () => {
  const { runWithYarnFamilyMemoPassthrough } = await import('./fixtures/yarnFamilyMemo');
  return {
    resolveYarnFamily: resolveYarnFamilyMock,
    runWithYarnFamilyMemo: runWithYarnFamilyMemoPassthrough,
  };
});

describe('fetchPackageMetadataFromRegistry()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    vi.mocked(readFile).mockRejectedValue(new Error('missing npmrc'));
    detectPackageManagerMock.mockResolvedValue('yarn');
    resolveYarnFamilyMock.mockResolvedValue({ family: 'unknown', source: 'version-probe' });
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses publish times at the parser boundary', () => {
    expect(parsePackument({
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.0.0': {}, '2.0.0': {} },
      time: {
        created: '2020-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        '1.0.0': '2020-02-01T00:00:00.000Z',
      },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: { latest: '2.0.0' },
        publishTimes: {
          kind: 'provided',
          byVersion: { '1.0.0': '2020-02-01T00:00:00.000Z' },
        },
        versions: ['2.0.0', '1.0.0'],
      },
    });
  });

  it('distinguishes a source without publish times from a version without a time', () => {
    expect(parsePackument({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: {},
        publishTimes: { kind: 'not-provided' },
        versions: ['1.0.0'],
      },
    });

    expect(parsePackument({
      'dist-tags': {},
      versions: { '1.0.0': {}, '2.0.0': {} },
      time: { '1.0.0': '2020-02-01T00:00:00.000Z' },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: {},
        publishTimes: {
          kind: 'provided',
          byVersion: { '1.0.0': '2020-02-01T00:00:00.000Z' },
        },
        versions: ['2.0.0', '1.0.0'],
      },
    });
  });

  it('degrades malformed auxiliary publish-time fields without discarding metadata', () => {
    const base = {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
    };

    expect(parsePackument({ ...base, time: null })).toMatchObject({
      kind: 'recognized',
      result: { publishTimes: { kind: 'not-provided' } },
    });
    expect(parsePackument({ ...base, time: { '1.0.0': 1700000000000 } })).toMatchObject({
      kind: 'recognized',
      result: { publishTimes: { kind: 'provided', byVersion: {} } },
    });
    expect(parsePackument({
      ...base,
      time: { '1.0.0': '2020-01-01T00:00:00.000Z', unpublished: { name: 'x' } },
    })).toMatchObject({
      kind: 'recognized',
      result: {
        publishTimes: {
          kind: 'provided',
          byVersion: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        },
      },
    });
  });

  it('classifies unknown and malformed packument schemas', () => {
    expect(parsePackument(null)).toEqual({ kind: 'unrecognized' });
    expect(parsePackument({})).toEqual({ kind: 'unrecognized' });
    expect(parsePackument({ 'dist-tags': [], versions: {} })).toEqual({ kind: 'malformed' });
  });
});