import { describe, expect, it, vi } from 'vitest';
import type {
  PackageLoadingServiceContract,
  PackageLoadingSnapshot,
} from '../providers';
import type { PackageFileEntry } from '../utils';
import type {
  CachedUpdateData,
  UpdateOrchestrationResult,
  UpdateOrchestrationServiceContract,
  UpdateRootFailure,
} from '../providers/updateOrchestrationService';
import { createProvider } from './fixtures/providerStub';

const packageFilePath = '/workspace/package.json';

function createSnapshot(): PackageLoadingSnapshot {
  const entries: PackageFileEntry[] = [{
    name: 'react',
    current: '18.0.0',
    dev: false,
    versionPrefix: '',
    packageFilePath,
  }];
  return {
    entries,
    packageFilePaths: [packageFilePath],
    readablePackageFilePaths: [],
    failedPackageReadPaths: [packageFilePath],
    packageLocationBaselines: new Map(),
    packageReadFailed: true,
  };
}

function completedUpdateResult(failures: readonly UpdateRootFailure[]): UpdateOrchestrationResult {
  return {
    kind: 'completed',
    data: new Map<string, CachedUpdateData>(),
    failedPackageFilePaths: [packageFilePath],
    failures,
    allFailed: false,
  };
}

describe('PackagesProvider failure snapshots', () => {
  it('fills missing read and update failure details from the failed paths', async () => {
    const results = [
      completedUpdateResult([]),
      completedUpdateResult([{ packageFilePath, error: 'registry unavailable' }]),
    ];
    const loadingService: PackageLoadingServiceContract = {
      load: vi.fn(() => Promise.resolve(createSnapshot())),
      readPackageEntries: vi.fn(() => Promise.resolve([])),
      discoverPackageFilePaths: vi.fn(() => Promise.resolve([])),
    };
    const check = vi.fn<UpdateOrchestrationServiceContract['check']>(() => Promise.resolve(
      results.shift() ?? completedUpdateResult([]),
    ));
    const updateService: UpdateOrchestrationServiceContract = {
      check,
      invalidateCache: vi.fn(),
      computeFingerprint: () => Promise.resolve('fingerprint'),
    };
    const provider = createProvider({
      packageLoadingService: loadingService,
      updateOrchestrationService: updateService,
    });
    try {
      await provider.loadPackages();

      expect(provider.getStatusReport().packageReadFailures).toEqual([
        {
          packageFilePaths: [packageFilePath],
          reason: 'package-read-failed',
          detail: undefined,
        },
        {
          packageFilePaths: [],
          reason: 'package-discovery-failed',
          detail: 'Failed to discover workspace package files.',
        },
      ]);

      await provider.checkUpdates();

      expect(provider.getStatusReport().updateFailures).toEqual([
        {
          packageFilePaths: [packageFilePath],
          reason: 'update-check-failed',
          detail: undefined,
        },
      ]);

      await provider.checkUpdates();

      expect(provider.getStatusReport().updateFailures).toEqual([
        {
          packageFilePaths: [packageFilePath],
          reason: 'update-check-failed',
          detail: 'registry unavailable',
        },
      ]);
    }
    finally {
      provider.dispose();
    }
  });
});