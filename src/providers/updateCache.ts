import { compareCodeUnits } from '../shared';
import { UPDATE_CACHE_TTL_MS } from '../config';
import type { CachedUpdateData } from './updateOrchestrationTypes';
import type { UpdateFingerprintPolicy, UpdateOrchestrationRequest } from './updateOrchestrationTypes';

export interface UpdateResultCache {
  readonly data: ReadonlyMap<string, CachedUpdateData>;
  readonly timestamp: number;
  readonly policyKey: string;
  readonly fingerprint: string;
}

export function buildUpdatePolicyKey(
  packageFiles: readonly string[],
  policy: UpdateFingerprintPolicy,
): string {
  return JSON.stringify({
    files: [...packageFiles].sort(compareCodeUnits),
    target: policy.target,
    includePreReleases: policy.includePreReleases,
    minimumReleaseAgeDays: policy.minimumReleaseAgeDays,
  });
}

export function shouldDebounceUpdateCheck(
  request: UpdateOrchestrationRequest,
  cache: UpdateResultCache | undefined,
  policyKey: string,
  now: number,
): boolean {
  return !request.forceAlways
    && cache !== undefined
    && cache.policyKey === policyKey
    && isFresh(cache.timestamp, now)
    && request.lastCheckTime !== undefined
    && request.debounceSeconds > 0
    && now - request.lastCheckTime < request.debounceSeconds * 1000;
}

export function hasReusableUpdateResult(
  cache: UpdateResultCache | undefined,
  fingerprint: string,
  now: number,
): boolean {
  return cache !== undefined
    && cache.fingerprint === fingerprint
    && isFresh(cache.timestamp, now);
}

function isFresh(timestamp: number, now: number): boolean {
  return now - timestamp < UPDATE_CACHE_TTL_MS;
}