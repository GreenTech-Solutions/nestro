import path from 'node:path';
import type { PackageManager } from '../clients';
import { detectPackageManager } from './packageManager';
import { nativeCliMetadataAdapter } from './nativeMetadataClient';
import { fetchPackageMetadataFromRegistry } from './registryClient';
import type { MetadataOutcome } from './metadataRunner';
import { yarnClassicMetadataAdapter, yarnModernMetadataAdapter } from './yarnMetadataClient';

export type MetadataAdapterTier = 'native-cli' | 'config-aware-https' | 'public-npm';

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

const packageManagers: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];
const tierOrder: Readonly<Record<MetadataAdapterTier, number>> = {
  'native-cli': 0,
  'config-aware-https': 1,
  'public-npm': 2,
};

export const configAwareHttpsMetadataAdapter: MetadataAdapter = {
  tier: 'config-aware-https',
  packageManagers,
  fetchMetadata: request => fetchPackageMetadataFromRegistry(
    request.packageName,
    request.packageFilePath,
    request.signal,
    request.packageManager,
  ),
};

export class MetadataAdapterRegistry {
  private readonly adapters: readonly MetadataAdapter[];

  constructor(adapters: readonly MetadataAdapter[] = [
    nativeCliMetadataAdapter,
    yarnClassicMetadataAdapter,
    yarnModernMetadataAdapter,
    configAwareHttpsMetadataAdapter,
  ]) {
    this.adapters = [...adapters].sort((left, right) => tierOrder[left.tier] - tierOrder[right.tier]);
  }

  getAdapter(packageManager: PackageManager): MetadataAdapter | undefined {
    return this.adapters.find(adapter => adapter.packageManagers.includes(packageManager));
  }

  private getAdapters(packageManager: PackageManager): readonly MetadataAdapter[] {
    return this.adapters.filter(adapter => adapter.packageManagers.includes(packageManager));
  }

  async fetchMetadata(request: MetadataRequest): Promise<PackageMetadataOutcome> {
    let packageManager: PackageManager;
    try {
      packageManager = await detectPackageManager(
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

export const metadataAdapterRegistry = new MetadataAdapterRegistry();

export async function fetchPackageMetadata(
  packageName: string,
  packageFilePath?: string,
  signal?: AbortSignal,
): Promise<PackageMetadataOutcome> {
  return await metadataAdapterRegistry.fetchMetadata({ packageName, packageFilePath, signal });
}