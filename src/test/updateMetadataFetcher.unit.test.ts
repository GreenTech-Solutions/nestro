import { describe, expect, it, vi } from 'vitest';
import { fetchMetadataOutcomes } from '../providers/updateMetadataFetcher';
import type { PackageIdentityTuple } from '../providers/packageIdentity';
import type { UpdateCheckProgress, UpdateOrchestrationDependencies } from '../providers/updateOrchestrationTypes';
import { OperationCoordinator } from '../utils/operationCoordinator';

class RejectFirstMetadataCoordinator extends OperationCoordinator {
  private calls = 0;

  override runExclusive<TResult>(key: string, operation: () => Promise<TResult>): Promise<TResult> {
    this.calls += 1;
    return this.calls === 1
      ? Promise.reject(new Error('registry-key coordination failed'))
      : super.runExclusive(key, operation);
  }
}

describe('fetchMetadataOutcomes()', () => {
  it('uses the unresolved-registry fallback after coordinator rejection and reports request completion', async () => {
    const packageFilePath = '/workspace/package.json';
    const identity: PackageIdentityTuple = {
      packageName: 'react',
      packageFilePath,
      section: 'dependencies',
    };
    const progress: UpdateCheckProgress[] = [];
    const dependencies = {
      metadataCoordinator: new RejectFirstMetadataCoordinator(4),
      resolveMetadataRegistryKey: vi.fn().mockResolvedValue('https://registry.example/'),
      fetchPackageMetadata: vi.fn().mockRejectedValue(new Error('metadata request failed')),
    } as unknown as UpdateOrchestrationDependencies;

    const outcomes = await fetchMetadataOutcomes(
      [identity],
      new Map([[packageFilePath, '/workspace']]),
      new AbortController().signal,
      dependencies,
      event => progress.push(event),
    );

    expect(outcomes).toEqual([undefined]);
    expect(dependencies.resolveMetadataRegistryKey).not.toHaveBeenCalled();
    expect(dependencies.fetchPackageMetadata).toHaveBeenCalledWith(
      'react',
      packageFilePath,
      expect.any(AbortSignal),
    );
    expect(progress).toEqual([
      { phase: 'release-dates', completed: 0, total: 1 },
      { phase: 'release-dates', completed: 1, total: 1 },
    ]);
  });
});