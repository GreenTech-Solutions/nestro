import { computeUpdateFingerprint } from './updateFingerprint';
import type {
  CachedUpdateData,
  UpdateOrchestrationDependencies,
  UpdateOrchestrationRequest,
  UpdateOrchestrationResult,
  UpdateRootFailure,
} from './updateOrchestrationTypes';
import type { UpdateResultCache } from './updateCache';

export interface UpdateResultApplicationOptions {
  readonly request: UpdateOrchestrationRequest;
  readonly dependencies: UpdateOrchestrationDependencies;
  readonly data: ReadonlyMap<string, CachedUpdateData>;
  readonly failedPackageFilePaths: readonly string[];
  readonly failures: readonly UpdateRootFailure[];
  readonly policyKey: string;
  readonly fingerprint: string;
  readonly cacheGeneration: number;
  readonly currentCacheGeneration: () => number;
  readonly setCache: (cache: UpdateResultCache | undefined) => void;
}

export async function applyUpdateResult(
  options: UpdateResultApplicationOptions,
): Promise<UpdateOrchestrationResult> {
  const { request } = options;
  if (!request.isCurrent() || request.signal.aborted) {
    return { kind: 'discarded', reason: 'cancelled' };
  }

  const currentPolicy = request.resolveCurrentPolicy();
  const afterFingerprint = await computeUpdateFingerprint(
    request.identities,
    currentPolicy,
    options.dependencies,
  );
  if (!request.isCurrent() || request.signal.aborted) {
    return { kind: 'discarded', reason: 'cancelled' };
  }
  if (afterFingerprint !== options.fingerprint) {
    request.onDiscarded?.();
    return { kind: 'discarded', reason: 'stale' };
  }
  if (options.cacheGeneration !== options.currentCacheGeneration()) {
    request.onDiscarded?.();
    return { kind: 'discarded', reason: 'invalidated' };
  }

  if (options.failedPackageFilePaths.length > 0) {
    options.setCache(undefined);
  }
  else {
    options.setCache({
      data: options.data,
      timestamp: options.dependencies.now(),
      policyKey: options.policyKey,
      fingerprint: options.fingerprint,
    });
  }
  return {
    kind: 'completed',
    data: options.data,
    failedPackageFilePaths: options.failedPackageFilePaths,
    failures: options.failures,
    allFailed: false,
  };
}