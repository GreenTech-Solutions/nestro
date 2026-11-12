import { ClientManager, resolveMutationCoordinatorKey } from '../clients';
import * as utils from '../utils';
import type { OperationCoordinator } from '../utils';
import { fetchUpdateVersions } from './updateCheckFetcher';
import { fetchMetadataOutcomes } from './updateMetadataFetcher';
import { buildUpdatePolicyKey, hasReusableUpdateResult, shouldDebounceUpdateCheck } from './updateCache';
import type { UpdateResultCache } from './updateCache';
import { readCanonicalDependencySpecs } from './packageIdentity';
import { resolveCanonicalPackageLocation } from './packageLocationResolution';
import type { PackageIdentityTuple } from './packageIdentity';
import { classifyUpdateReleaseAges } from './updateReleaseAge';
import { applyUpdateResult } from './updateResultApplication';
import { computeUpdateFingerprint } from './updateFingerprint';
import type {
  CachedUpdateData,
  UpdateFingerprintPolicy,
  UpdateOrchestrationDependencies,
  UpdateOrchestrationRequest,
  UpdateOrchestrationResult,
  UpdateOrchestrationServiceContract,
} from './updateOrchestrationTypes';

const clientManager = new ClientManager();

function detectPackageManager(cwd: string | undefined) {
  return clientManager.detectPackageManager(cwd);
}

export { computeUpdateFingerprint } from './updateFingerprint';
export type {
  CachedUpdateData,
  UpdateFingerprintPolicy,
  UpdateOrchestrationDependencies,
  UpdateOrchestrationRequest,
  UpdateOrchestrationResult,
  UpdateOrchestrationServiceContract,
  UpdateRootFailure,
} from './updateOrchestrationTypes';

function createDefaultDependencies(
  checkCoordinator: OperationCoordinator,
  metadataCoordinator: OperationCoordinator,
): UpdateOrchestrationDependencies {
  return {
    checkCoordinator,
    metadataCoordinator,
    fetchAllLatestVersions: (packageFilePath, target, includePreReleases, minimumReleaseAgeDays) => (
      utils.fetchAllLatestVersions(packageFilePath, target, includePreReleases, minimumReleaseAgeDays)
    ),
    resolveMetadataRegistryKey: (packageName, packageFilePath) => (
      utils.resolveMetadataRegistryKey(
        detectPackageManager,
        packageName,
        packageFilePath,
      )
    ),
    fetchPackageMetadata: (packageName, packageFilePath, signal) => (
      utils.fetchPackageMetadata(
        detectPackageManager,
        packageName,
        packageFilePath,
        signal,
      )
    ),
    // Keeps partial client mocks lazy; the missing export fails only when this dependency runs.
    resolveMutationCoordinatorKey: packageFilePath => resolveMutationCoordinatorKey(packageFilePath),
    resolveCanonicalPackageLocation: packageFilePath => resolveCanonicalPackageLocation(packageFilePath),
    readCanonicalDependencySpecs: (location, identities) => readCanonicalDependencySpecs(location, identities),
    now: () => Date.now(),
  };
}

export class UpdateOrchestrationService implements UpdateOrchestrationServiceContract {
  private cache: UpdateResultCache | undefined;

  private cacheGeneration = 0;

  constructor(private readonly dependencies: UpdateOrchestrationDependencies) {}

  static withCoordinators(
    checkCoordinator: OperationCoordinator,
    metadataCoordinator: OperationCoordinator,
  ): UpdateOrchestrationService {
    return new UpdateOrchestrationService(createDefaultDependencies(checkCoordinator, metadataCoordinator));
  }

  invalidateCache(): void {
    this.cache = undefined;
    this.cacheGeneration += 1;
  }

  computeFingerprint(
    identities: readonly PackageIdentityTuple[],
    policy: UpdateFingerprintPolicy,
  ): Promise<string> {
    return computeUpdateFingerprint(identities, policy, this.dependencies);
  }

  check(request: UpdateOrchestrationRequest): Promise<UpdateOrchestrationResult> {
    return utils.runWithYarnFamilyMemo(() => (
      utils.runWithRegistryConfigMemo(() => this.checkInMemo(request))
    ));
  }

  private async checkInMemo(request: UpdateOrchestrationRequest): Promise<UpdateOrchestrationResult> {
    const policy: UpdateFingerprintPolicy = {
      target: request.target,
      includePreReleases: request.includePreReleases,
      minimumReleaseAgeDays: request.minimumReleaseAgeDays,
    };
    const policyKey = buildUpdatePolicyKey(request.packageFiles, policy);
    const now = this.dependencies.now();
    const cacheGeneration = this.cacheGeneration;
    if (shouldDebounceUpdateCheck(request, this.cache, policyKey, now)) {
      return { kind: 'debounced' };
    }
    if (!request.isCurrent() || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const fingerprint = await this.computeFingerprint(request.identities, policy);
    if (!request.isCurrent() || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const cacheValid = !request.forceAlways
      && hasReusableUpdateResult(this.cache, fingerprint, now);
    request.onCheckStarted?.();
    if (cacheValid) {
      return {
        kind: 'completed',
        data: this.cache?.data ?? new Map<string, CachedUpdateData>(),
        failedPackageFilePaths: [],
        failures: [],
        allFailed: false,
      };
    }
    return this.checkFresh(request, policyKey, fingerprint, cacheGeneration);
  }

  private async checkFresh(
    request: UpdateOrchestrationRequest,
    policyKey: string,
    fingerprint: string,
    cacheGeneration: number,
  ): Promise<UpdateOrchestrationResult> {
    const fetched = await fetchUpdateVersions(request, this.dependencies);
    if (fetched === undefined || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const failedPaths = new Set(fetched.failedPackageFilePaths);
    const allFailed = request.packageFiles.length > 0 && failedPaths.size === request.packageFiles.length;
    if (allFailed) {
      this.cache = undefined;
      return {
        kind: 'completed',
        data: new Map(),
        failedPackageFilePaths: [...failedPaths],
        failures: fetched.failures,
        allFailed: true,
        failure: fetched.firstFailure,
      };
    }

    const successfulIdentities = request.identities.filter(identity => !failedPaths.has(identity.packageFilePath));
    const metadataOutcomes = request.minimumReleaseAgeDays === 0
      ? successfulIdentities.map(() => undefined)
      : await fetchMetadataOutcomes(
          successfulIdentities,
          fetched.coordinationKeys,
          request.signal,
          this.dependencies,
        );
    if (metadataOutcomes === undefined || request.signal.aborted) {
      return { kind: 'discarded', reason: 'cancelled' };
    }

    const updateData = classifyUpdateReleaseAges(
      successfulIdentities,
      request.currentVersions,
      fetched.acceptedVersions,
      metadataOutcomes,
      request.minimumReleaseAgeDays,
    );
    return applyUpdateResult({
      request,
      dependencies: this.dependencies,
      data: updateData,
      failedPackageFilePaths: [...failedPaths],
      failures: fetched.failures,
      policyKey,
      fingerprint,
      cacheGeneration,
      currentCacheGeneration: () => this.cacheGeneration,
      setCache: (cache) => { this.cache = cache; },
    });
  }
}