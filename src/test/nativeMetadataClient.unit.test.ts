import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPackageMetadataFromNativeCli, parseNativeCliMetadata } from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

describe('native metadata client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the selected manager in the package root and returns publish times', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify({
        'dist-tags': { latest: '2.0.0' },
        versions: ['1.0.0', '2.0.0'],
        time: {
          created: '2020-01-01T00:00:00.000Z',
          '2.0.0': '2024-01-01T00:00:00.000Z',
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    await expect(fetchPackageMetadataFromNativeCli({
      packageName: 'react',
      packageFilePath: '/workspace/apps/web/package.json',
      packageManager: 'pnpm',
    })).resolves.toEqual({
      kind: 'success',
      result: {
        distTags: { latest: '2.0.0' },
        publishTimes: { kind: 'provided', byVersion: { '2.0.0': '2024-01-01T00:00:00.000Z' } },
        versions: ['1.0.0', '2.0.0'],
      },
    });
    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'pnpm',
      ['view', 'react', '--json'],
      expect.objectContaining({ cwd: '/workspace/apps/web', signal: undefined }),
    );
  });

  it('accepts a full packument-shaped versions object without guessing another schema', () => {
    expect(parseNativeCliMetadata({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: { latest: '1.0.0' },
        publishTimes: { kind: 'provided', byVersion: { '1.0.0': '2020-01-01T00:00:00.000Z' } },
        versions: ['1.0.0', '1.1.0'],
      },
    });
  });

  it.each([
    ['missing fields', '{}', { kind: 'unrecognized' }],
    ['malformed JSON', '{', { kind: 'malformed', reason: 'json' }],
  ] as const)('maps %s output to an incomplete result', async (_label, stdout, expected) => {
    runBoundedProcessMock.mockResolvedValueOnce({ kind: 'exit', stdout, stderr: '', exitCode: 0 });

    await expect(fetchPackageMetadataFromNativeCli({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      packageManager: 'npm',
    })).resolves.toEqual(expected);
  });

  it('maps invalid recognized fields to malformed schema', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify({ 'dist-tags': [], versions: ['1.0.0'] }),
      stderr: '',
      exitCode: 0,
    });

    await expect(fetchPackageMetadataFromNativeCli({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      packageManager: 'npm',
    })).resolves.toEqual({ kind: 'malformed', reason: 'schema' });
  });

  it('rejects malformed version entries instead of treating their keys as versions', () => {
    expect(parseNativeCliMetadata({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': 'not-version-metadata' },
    })).toEqual({ kind: 'malformed' });
    expect(parseNativeCliMetadata({
      'dist-tags': { latest: 1 },
      versions: { '1.0.0': {} },
    })).toEqual({ kind: 'malformed' });
  });

  it('marks a valid document without a time field as not-provided', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify({ 'dist-tags': {}, versions: [] }),
      stderr: '',
      exitCode: 0,
    });

    await expect(fetchPackageMetadataFromNativeCli({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      packageManager: 'npm',
    })).resolves.toMatchObject({
      kind: 'success',
      result: { publishTimes: { kind: 'not-provided' } },
    });
  });

  it('maps a non-zero native command exit to a retryable process failure', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify({ 'dist-tags': {}, versions: [] }),
      stderr: 'package lookup failed',
      exitCode: 1,
    });

    await expect(fetchPackageMetadataFromNativeCli({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      packageManager: 'npm',
    })).resolves.toEqual({ kind: 'transport-error', reason: 'process-failed' });
  });

  it.each([
    [{ kind: 'timeout', timeoutMs: 20 }, { kind: 'timeout', timeoutMs: 20 }],
    [{ kind: 'aborted' }, { kind: 'aborted' }],
    [{ kind: 'overflow', maxBufferBytes: 30 }, { kind: 'overflow', maxBufferBytes: 30 }],
    [{ kind: 'spawn-error', reason: 'command-not-found' }, { kind: 'transport-error', reason: 'command-not-found' }],
    [{ kind: 'spawn-error', reason: 'process-failed' }, { kind: 'transport-error', reason: 'process-failed' }],
  ] as const)('maps bounded process outcome %j', async (processOutcome, expected) => {
    runBoundedProcessMock.mockResolvedValueOnce(processOutcome);

    await expect(fetchPackageMetadataFromNativeCli({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
      packageManager: 'npm',
    })).resolves.toEqual(expected);
  });

  it('skips native execution when no package root or manager was supplied', async () => {
    await expect(fetchPackageMetadataFromNativeCli({ packageName: 'react' })).resolves.toEqual({
      kind: 'transport-error',
      reason: 'process-failed',
    });
    expect(runBoundedProcessMock).not.toHaveBeenCalled();
  });
});