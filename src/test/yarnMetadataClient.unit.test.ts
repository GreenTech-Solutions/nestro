import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPackageMetadataFromYarnClassic,
  fetchPackageMetadataFromYarnModern,
  parseYarnClassicMetadata,
  parseYarnModernMetadata,
} from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());
const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));
vi.mock('../utils/yarnFamily', () => ({
  resolveYarnFamily: resolveYarnFamilyMock,
}));

const request = {
  packageName: 'react',
  packageFilePath: '/workspace/apps/web/package.json',
  packageManager: 'yarn' as const,
};

const metadata = {
  'dist-tags': { latest: '2.0.0' },
  versions: ['1.0.0', '2.0.0'],
  time: { '2.0.0': '2024-01-01T00:00:00.000Z' },
};

describe('Yarn native metadata clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveYarnFamilyMock.mockResolvedValue({ family: 'classic', source: 'package-manager' });
  });

  it('runs the Classic wrapped command in the package root', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify({ type: 'inspect', data: metadata }),
      stderr: '',
      exitCode: 0,
    });

    await expect(fetchPackageMetadataFromYarnClassic(request)).resolves.toEqual({
      kind: 'success',
      result: {
        distTags: { latest: '2.0.0' },
        publishTimes: { kind: 'provided', byVersion: { '2.0.0': '2024-01-01T00:00:00.000Z' } },
        versions: ['1.0.0', '2.0.0'],
      },
    });
    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'yarn',
      ['info', 'react', '--json'],
      expect.objectContaining({ cwd: '/workspace/apps/web', signal: undefined }),
    );
  });

  it('runs the Modern npm plugin command in the package root', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'package-manager' });
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify(metadata),
      stderr: '',
      exitCode: 0,
    });

    await expect(fetchPackageMetadataFromYarnModern(request)).resolves.toMatchObject({
      kind: 'success',
      result: { versions: ['1.0.0', '2.0.0'] },
    });
    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'yarn',
      ['npm', 'info', 'react', '--json'],
      expect.objectContaining({ cwd: '/workspace/apps/web' }),
    );
  });

  it.each([
    ['unknown family', { family: 'unknown', source: 'conflicting-markers' }],
    ['wrong family', { family: 'modern', source: 'project-markers' }],
  ] as const)('does not run a metadata command for a %s', async (_label, family) => {
    resolveYarnFamilyMock.mockResolvedValueOnce(family);

    await expect(fetchPackageMetadataFromYarnClassic(request)).resolves.toEqual({ kind: 'unrecognized' });
    expect(runBoundedProcessMock).not.toHaveBeenCalled();
  });

  it('skips family resolution when the request has no package root or is not Yarn', async () => {
    await expect(fetchPackageMetadataFromYarnClassic({ packageName: 'react' })).resolves.toEqual({
      kind: 'transport-error',
      reason: 'process-failed',
    });
    await expect(fetchPackageMetadataFromYarnModern({
      ...request,
      packageManager: 'npm',
    })).resolves.toEqual({
      kind: 'transport-error',
      reason: 'process-failed',
    });
    expect(resolveYarnFamilyMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'timeout', timeoutMs: 20 }, { kind: 'timeout', timeoutMs: 20 }],
    [{ kind: 'aborted' }, { kind: 'aborted' }],
    [{ kind: 'overflow', maxBufferBytes: 30 }, { kind: 'overflow', maxBufferBytes: 30 }],
    [{ kind: 'spawn-error', reason: 'command-not-found' }, { kind: 'transport-error', reason: 'command-not-found' }],
    [{ kind: 'spawn-error', reason: 'process-failed' }, { kind: 'transport-error', reason: 'process-failed' }],
  ] as const)('maps bounded process outcome %j', async (processOutcome, expected) => {
    runBoundedProcessMock.mockResolvedValueOnce(processOutcome);

    await expect(fetchPackageMetadataFromYarnClassic(request)).resolves.toEqual(expected);
  });

  it('maps a non-zero command exit to a retryable process failure', async () => {
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: '',
      stderr: 'lookup failed',
      exitCode: 1,
    });

    await expect(fetchPackageMetadataFromYarnClassic(request)).resolves.toEqual({
      kind: 'transport-error',
      reason: 'process-failed',
    });
  });

  it.each([
    ['malformed JSON', '{', { kind: 'malformed', reason: 'json' }],
    ['wrong-family JSON', JSON.stringify(metadata), { kind: 'unrecognized' }],
    ['malformed schema', JSON.stringify({ type: 'inspect', data: { ...metadata, versions: [1] } }), { kind: 'malformed', reason: 'schema' }],
  ] as const)('validates the Classic document for %s', async (_label, stdout, expected) => {
    runBoundedProcessMock.mockResolvedValueOnce({ kind: 'exit', stdout, stderr: '', exitCode: 0 });

    await expect(fetchPackageMetadataFromYarnClassic(request)).resolves.toEqual(expected);
  });

  it('rejects a Classic wrapper when parsing Modern output', () => {
    expect(parseYarnModernMetadata({ type: 'inspect', data: metadata })).toEqual({ kind: 'unrecognized' });
    expect(parseYarnClassicMetadata(metadata)).toEqual({ kind: 'unrecognized' });
  });

  it('rejects invalid direct Modern fields without guessing their meaning', () => {
    expect(parseYarnModernMetadata({ ...metadata, 'dist-tags': { latest: 2 } })).toEqual({ kind: 'malformed' });
    expect(parseYarnModernMetadata({ ...metadata, versions: { '1.0.0': {} } })).toMatchObject({
      kind: 'recognized',
      result: { versions: ['1.0.0'] },
    });
    expect(parseYarnModernMetadata({ ...metadata, versions: { '1.0.0': 'invalid' } })).toEqual({ kind: 'malformed' });
    expect(parseYarnModernMetadata({ ...metadata, versions: 1 })).toEqual({ kind: 'malformed' });
    expect(parseYarnModernMetadata({ ...metadata, 'dist-tags': [] })).toEqual({ kind: 'malformed' });
    expect(parseYarnModernMetadata({})).toEqual({ kind: 'unrecognized' });
  });
});