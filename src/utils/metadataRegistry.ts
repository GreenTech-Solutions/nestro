import path from 'node:path';
import { nativeCliMetadataAdapter } from './nativeMetadataClient';
import { fetchPackageMetadataFromRegistry, resolvePackageRegistryUrl } from './registryClient';
import type { MetadataOutcome } from './metadataRunner';
import { runWithYarnFamilyMemo } from './yarnFamily';
import { yarnClassicMetadataAdapter, yarnModernMetadataAdapter } from './yarnMetadataClient';
import { PACKAGE_MANAGER_NAMES } from '../shared';
import type { PackageManager } from '../shared';

export type MetadataAdapterTier = 'native-cli' | 'config-aware-https';

export interface PublishTimesProvided {
  kind: 'provided';
  byVersion: Readonly<Record<string, string>>;
}

export interface PublishTimesNotProvided {
  kind: 'not-provided';
}

export type PublishTimes = PublishTimesProvided | PublishTimesNotProvided;

export interface PackageMetadata {
  versions: readonly string[];
  distTags: Readonly<Record<string, string>>;
  publishTimes: PublishTimes;
}

export type PackageMetadataOutcome = MetadataOutcome<PackageMetadata>;

export interface MetadataRequest {
  packageName: string;
  packageFilePath?: string;
  packageManager?: PackageManager;
  signal?: AbortSignal;
}

export interface MetadataAdapter {
  readonly tier: MetadataAdapterTier;
  readonly packageManagers: readonly PackageManager[];
  fetchMetadata(request: MetadataRequest): Promise<PackageMetadataOutcome>;
}

type PackageManagerDetector = (cwd: string | undefined) => Promise<PackageManager>;

const tierOrder: Readonly<Record<MetadataAdapterTier, number>> = {
  'native-cli': 0,
  'config-aware-https': 1,
};

export const configAwareHttpsMetadataAdapter: MetadataAdapter = {
  tier: 'config-aware-https',
  packageManagers: PACKAGE_MANAGER_NAMES,
  fetchMetadata: request => fetchPackageMetadataFromRegistry(
    request.packageName,
    request.packageFilePath,
    request.signal,
    request.packageManager,
  ),
};

export class MetadataAdapterRegistry {
  private readonly adapters: readonly MetadataAdapter[];

  constructor(
    private readonly detectPackageManager: PackageManagerDetector,
    adapters: readonly MetadataAdapter[] = [
      nativeCliMetadataAdapter,
      yarnClassicMetadataAdapter,
      yarnModernMetadataAdapter,
      configAwareHttpsMetadataAdapter,
    ],
  ) {
    this.adapters = [...adapters].sort((left, right) => tierOrder[left.tier] - tierOrder[right.tier]);
  }

  getAdapter(packageManager: PackageManager): MetadataAdapter | undefined {
    return this.adapters.find(adapter => adapter.packageManagers.includes(packageManager));
  }

  private getAdapters(packageManager: PackageManager): readonly MetadataAdapter[] {
    return this.adapters.filter(adapter => adapter.packageManagers.includes(packageManager));
  }

  fetchMetadata(request: MetadataRequest): Promise<PackageMetadataOutcome> {
    return runWithYarnFamilyMemo(() => this.fetchMetadataInMemo(request));
  }

  private async fetchMetadataInMemo(request: MetadataRequest): Promise<PackageMetadataOutcome> {
    let packageManager: PackageManager;
    try {
      packageManager = await this.detectPackageManager(
        request.packageFilePath === undefined ? undefined : path.dirname(request.packageFilePath),
      );
    }
    catch {
      return { kind: 'transport-error', reason: 'selection' };
    }

    const adapters = this.getAdapters(packageManager);
    if (adapters.length === 0) {
      return { kind: 'transport-error', reason: 'selection' };
    }

    let lastOutcome: PackageMetadataOutcome | undefined;
    for (const adapter of adapters) {
      const outcome = await adapter.fetchMetadata({ ...request, packageManager });
      lastOutcome = outcome;
      if (!shouldTryNextTier(outcome)) {
        return outcome;
      }
    }

    return lastOutcome ?? { kind: 'transport-error', reason: 'selection' };
  }
}

// Cascades when a tier cannot answer; cancellation and definitive HTTP status stop the chain.
function shouldTryNextTier(outcome: PackageMetadataOutcome): boolean {
  if (hasPrivateRegistryMarker(outcome)) {
    return false;
  }

  switch (outcome.kind) {
    case 'success':
    case 'aborted':
      return false;
    case 'transport-error':
      return outcome.reason !== 'http-status';
    case 'unavailable':
    case 'unrecognized':
    case 'malformed':
    case 'truncated':
    case 'overflow':
    case 'timeout':
      return true;
  }
}

function hasPrivateRegistryMarker(outcome: PackageMetadataOutcome): boolean {
  return outcome.privateRegistry === true;
}

export async function fetchPackageMetadata(
  detectPackageManager: PackageManagerDetector,
  packageName: string,
  packageFilePath?: string,
  signal?: AbortSignal,
): Promise<PackageMetadataOutcome> {
  return await new MetadataAdapterRegistry(detectPackageManager).fetchMetadata({ packageName, packageFilePath, signal });
}

export async function resolveMetadataRegistryKey(
  detectPackageManager: PackageManagerDetector,
  packageName: string,
  packageFilePath?: string,
): Promise<string | undefined> {
  try {
    const packageManager = await detectPackageManager(
      packageFilePath === undefined ? undefined : path.dirname(packageFilePath),
    );
    return await resolvePackageRegistryUrl(packageName, packageFilePath, packageManager);
  }
  catch {
    return undefined;
  }
}