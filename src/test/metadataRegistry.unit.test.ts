import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configAwareHttpsMetadataAdapter,
  MetadataAdapterRegistry,
  nativeCliMetadataAdapter,
  resolveMetadataRegistryKey,
  yarnClassicMetadataAdapter,
} from '../utils';
import type { MetadataAdapter, PackageMetadataOutcome } from '../utils';

const detectPackageManagerMock = vi.hoisted(() => vi.fn());
const fetchPackageMetadataFromRegistryMock = vi.hoisted(() => vi.fn());
const runBoundedProcessMock = vi.hoisted(() => vi.fn());
const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/packageManager', () => ({
  detectPackageManager: detectPackageManagerMock,
}));
vi.mock('../utils/registryClient', () => ({
  fetchPackageMetadataFromRegistry: fetchPackageMetadataFromRegistryMock,
  resolvePackageRegistryUrl: vi.fn().mockResolvedValue('https://registry.npmjs.org/'),
}));
vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));
vi.mock('../utils/yarnFamily', () => ({
  resolveYarnFamily: resolveYarnFamilyMock,
}));

const success: PackageMetadataOutcome = {
  kind: 'success',
  result: {
    distTags: { latest: '1.0.0' },
    publishTimes: { kind: 'not-provided' },
    versions: ['1.0.0'],
  },
};

describe('MetadataAdapterRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectPackageManagerMock.mockResolvedValue('npm');
    fetchPackageMetadataFromRegistryMock.mockResolvedValue(success);
    resolveYarnFamilyMock.mockResolvedValue({ family: 'unknown', source: 'version-probe' });
    runBoundedProcessMock.mockResolvedValue({
      kind: 'spawn-error',
      reason: 'command-not-found',
      detail: 'command not found',
      message: 'command not found',
      cause: undefined,
    });
  });

  it('registers the native tier for npm and pnpm and the HTTPS fallback for other managers', () => {
    const registry = new MetadataAdapterRegistry();

    expect(registry.getAdapter('npm')).toBe(nativeCliMetadataAdapter);
    expect(registry.getAdapter('pnpm')).toBe(nativeCliMetadataAdapter);
    expect(registry.getAdapter('yarn')).toBe(yarnClassicMetadataAdapter);
    expect(registry.getAdapter('bun')).toBe(configAwareHttpsMetadataAdapter);
    expect(configAwareHttpsMetadataAdapter.tier).toBe('config-aware-https');
  });

  it('resolves a registry key through the selected package manager', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('pnpm');

    await expect(resolveMetadataRegistryKey('react', '/workspace/package.json'))
      .resolves.toBe('https://registry.npmjs.org/');
    expect(detectPackageManagerMock).toHaveBeenCalledWith('/workspace');
  });

  it('cascades from a native tier that cannot answer to the HTTPS fallback', async () => {
    const nativeResult: PackageMetadataOutcome = { kind: 'transport-error', reason: 'process-failed' };
    const nativeAdapter = createAdapter('native-cli', ['npm'], nativeResult);
    const registry = new MetadataAdapterRegistry([configAwareHttpsMetadataAdapter, nativeAdapter]);

    expect(registry.getAdapter('npm')).toBe(nativeAdapter);
    expect(registry.getAdapter('pnpm')).toBe(configAwareHttpsMetadataAdapter);
    await expect(registry.fetchMetadata({ packageName: 'react' })).resolves.toEqual(success);
    expect(nativeAdapter.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledTimes(1);
  });

  it('uses the Yarn family adapters before the HTTPS fallback', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('yarn');
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'classic', source: 'package-manager' });
    runBoundedProcessMock.mockResolvedValueOnce({
      kind: 'exit',
      stdout: JSON.stringify({
        type: 'inspect',
        data: { 'dist-tags': {}, versions: ['1.0.0'] },
      }),
      stderr: '',
      exitCode: 0,
    });

    await expect(new MetadataAdapterRegistry().fetchMetadata({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
    })).resolves.toMatchObject({
      kind: 'success',
      result: { versions: ['1.0.0'], distTags: {} },
    });
    expect(runBoundedProcessMock).toHaveBeenCalledTimes(1);
    expect(fetchPackageMetadataFromRegistryMock).not.toHaveBeenCalled();
  });

  it('falls through to HTTPS when the Yarn family is unknown without running Yarn', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('yarn');

    await expect(new MetadataAdapterRegistry().fetchMetadata({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
    })).resolves.toEqual(success);
    expect(resolveYarnFamilyMock).toHaveBeenCalled();
    expect(runBoundedProcessMock).not.toHaveBeenCalled();
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledTimes(1);
  });

  it('uses the detected manager and preserves the typed HTTPS result', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('pnpm');

    await expect(new MetadataAdapterRegistry([configAwareHttpsMetadataAdapter]).fetchMetadata({
      packageName: 'react',
      packageFilePath: '/workspace/packages/app/package.json',
    })).resolves.toEqual(success);

    expect(detectPackageManagerMock).toHaveBeenCalledWith('/workspace/packages/app');
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledWith(
      'react',
      '/workspace/packages/app/package.json',
      undefined,
      'pnpm',
    );
  });

  it('does not turn a missing package-manager CLI into unavailable', async () => {
    const registry = new MetadataAdapterRegistry();

    await expect(registry.fetchMetadata({ packageName: 'react', packageFilePath: '/workspace/package.json' })).resolves.toMatchObject({ kind: 'success' });
    expect(runBoundedProcessMock).toHaveBeenCalledTimes(1);
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledTimes(1);
  });

  it('uses the HTTPS tier for Bun without invoking a missing Bun CLI', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('bun');

    await expect(new MetadataAdapterRegistry().fetchMetadata({
      packageName: 'react',
      packageFilePath: '/workspace/package.json',
    })).resolves.toEqual(success);
    expect(runBoundedProcessMock).not.toHaveBeenCalled();
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledWith(
      'react',
      '/workspace/package.json',
      undefined,
      'bun',
    );
  });

  it('stops cascading for cancellation and definitive HTTP status', async () => {
    for (const terminalOutcome of [
      { kind: 'aborted' },
      { kind: 'transport-error', reason: 'http-status', statusCode: 404 },
    ] satisfies PackageMetadataOutcome[]) {
      const firstAdapter = createAdapter('native-cli', ['npm'], terminalOutcome);
      const secondAdapter = createAdapter('config-aware-https', ['npm'], success);
      const registry = new MetadataAdapterRegistry([firstAdapter, secondAdapter]);

      await expect(registry.fetchMetadata({ packageName: 'react' })).resolves.toEqual(terminalOutcome);
      expect(firstAdapter.fetchMetadata).toHaveBeenCalledTimes(1);
      expect(secondAdapter.fetchMetadata).not.toHaveBeenCalled();
    }
  });

  it('returns the last retryable outcome when no later tier is registered', async () => {
    const retryableOutcomes = [
      { kind: 'unavailable', reason: 'configuration-unavailable' },
      { kind: 'unrecognized' },
      { kind: 'malformed', reason: 'json' },
      { kind: 'truncated' },
      { kind: 'overflow', maxBufferBytes: 10 },
      { kind: 'timeout', timeoutMs: 10 },
      { kind: 'transport-error', reason: 'request' },
      { kind: 'transport-error', reason: 'proxy-unsupported' },
    ] satisfies PackageMetadataOutcome[];

    for (const outcome of retryableOutcomes) {
      const adapter = createAdapter('native-cli', ['npm'], outcome);
      const registry = new MetadataAdapterRegistry([adapter]);

      await expect(registry.fetchMetadata({ packageName: 'react' })).resolves.toEqual(outcome);
    }
  });

  it('does not retry a scoped private registry against public npm through the cascade', async () => {
    const privateResult: PackageMetadataOutcome = {
      kind: 'transport-error',
      reason: 'http-status',
      statusCode: 404,
      privateRegistry: true,
    };
    const privateAdapter = createAdapter('config-aware-https', ['npm'], privateResult);
    const publicAdapter = createAdapter('public-npm', ['npm'], success);
    const registry = new MetadataAdapterRegistry([publicAdapter, privateAdapter]);

    await expect(registry.fetchMetadata({
      packageName: '@private/pkg',
      packageFilePath: '/workspace/package.json',
    })).resolves.toEqual(privateResult);
    expect(privateAdapter.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(publicAdapter.fetchMetadata).not.toHaveBeenCalled();
  });

  it('does not retry a marked retryable private outcome against a later tier', async () => {
    const privateResult: PackageMetadataOutcome = {
      kind: 'timeout',
      timeoutMs: 15_000,
      privateRegistry: true,
    };
    const privateAdapter = createAdapter('config-aware-https', ['npm'], privateResult);
    const publicAdapter = createAdapter('public-npm', ['npm'], success);
    const registry = new MetadataAdapterRegistry([publicAdapter, privateAdapter]);

    await expect(registry.fetchMetadata({
      packageName: '@private/pkg',
      packageFilePath: '/workspace/package.json',
    })).resolves.toEqual(privateResult);
    expect(privateAdapter.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(publicAdapter.fetchMetadata).not.toHaveBeenCalled();
  });

  it('classifies adapter-detection and adapter-selection failures separately from unavailable configuration', async () => {
    detectPackageManagerMock.mockRejectedValueOnce(new Error('manager lookup failed'));
    await expect(new MetadataAdapterRegistry().fetchMetadata({ packageName: 'react' })).resolves.toEqual({
      kind: 'transport-error',
      reason: 'selection',
    });

    detectPackageManagerMock.mockResolvedValueOnce('bun');
    await expect(new MetadataAdapterRegistry([]).fetchMetadata({ packageName: 'react' })).resolves.toEqual({
      kind: 'transport-error',
      reason: 'selection',
    });
  });
});

function createAdapter(
  tier: MetadataAdapter['tier'],
  packageManagers: MetadataAdapter['packageManagers'],
  result: PackageMetadataOutcome,
): MetadataAdapter {
  return {
    tier,
    packageManagers,
    fetchMetadata: vi.fn().mockResolvedValue(result),
  };
}