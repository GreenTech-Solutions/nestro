import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configAwareHttpsMetadataAdapter,
  fetchPackageMetadata,
  MetadataAdapterRegistry,
} from '../utils';
import type { MetadataAdapter, PackageMetadataOutcome } from '../utils';

const detectPackageManagerMock = vi.hoisted(() => vi.fn());
const fetchPackageMetadataFromRegistryMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/packageManager', () => ({
  detectPackageManager: detectPackageManagerMock,
}));
vi.mock('../utils/registryClient', () => ({
  fetchPackageMetadataFromRegistry: fetchPackageMetadataFromRegistryMock,
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
  });

  it('registers the HTTPS fallback for every detected package manager', () => {
    const registry = new MetadataAdapterRegistry();

    expect(registry.getAdapter('npm')).toBe(configAwareHttpsMetadataAdapter);
    expect(registry.getAdapter('pnpm')).toBe(configAwareHttpsMetadataAdapter);
    expect(registry.getAdapter('yarn')).toBe(configAwareHttpsMetadataAdapter);
    expect(registry.getAdapter('bun')).toBe(configAwareHttpsMetadataAdapter);
    expect(configAwareHttpsMetadataAdapter.tier).toBe('config-aware-https');
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

  it('uses the detected manager and preserves the typed HTTPS result', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('pnpm');

    await expect(fetchPackageMetadata('react', '/workspace/packages/app/package.json')).resolves.toEqual(success);

    expect(detectPackageManagerMock).toHaveBeenCalledWith('/workspace/packages/app');
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledWith(
      'react',
      '/workspace/packages/app/package.json',
      undefined,
    );
  });

  it('does not turn a missing package-manager CLI into unavailable', async () => {
    const nativeAdapter = createAdapter('native-cli', ['npm'], {
      kind: 'transport-error',
      reason: 'command-not-found',
    });
    const registry = new MetadataAdapterRegistry([nativeAdapter, configAwareHttpsMetadataAdapter]);

    await expect(registry.fetchMetadata({ packageName: 'react' })).resolves.toMatchObject({ kind: 'success' });
    expect(nativeAdapter.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(fetchPackageMetadataFromRegistryMock).toHaveBeenCalledTimes(1);
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
    ] satisfies PackageMetadataOutcome[];

    for (const outcome of retryableOutcomes) {
      const adapter = createAdapter('native-cli', ['npm'], outcome);
      const registry = new MetadataAdapterRegistry([adapter]);

      await expect(registry.fetchMetadata({ packageName: 'react' })).resolves.toEqual(outcome);
    }
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