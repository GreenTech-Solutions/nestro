import type { CanonicalPackageLocation, CanonicalPackageLocationResult, PackageIdentityTuple } from './packageIdentity';
import type { NcuUpdateTarget, OperationCoordinator, PackageMetadataOutcome, ReleaseAgeState } from '../utils';

export interface CachedUpdateData {
  readonly acceptedVersion: string | undefined;
  readonly releaseAge: ReleaseAgeState;
}

export interface UpdateFingerprintPolicy {
  readonly target: NcuUpdateTarget;
  readonly includePreReleases: boolean;
  readonly minimumReleaseAgeDays: number;
}

export interface UpdateOrchestrationRequest {
  readonly identities: readonly PackageIdentityTuple[];
  readonly currentVersions: ReadonlyMap<string, string>;
  readonly packageFiles: readonly string[];
  readonly target: NcuUpdateTarget;
  readonly includePreReleases: boolean;
  readonly minimumReleaseAgeDays: number;
  readonly forceAlways: boolean;
  readonly debounceSeconds: number;
  readonly lastCheckTime: number | undefined;
  readonly signal: AbortSignal;
  /** Provider-owned operation and snapshot generation guard. */
  readonly isCurrent: () => boolean;
  /** Re-reads the live policy right before committing a fetch, catching a setting changed mid-flight. */
  readonly resolveCurrentPolicy: () => UpdateFingerprintPolicy;
  readonly onCheckStarted?: () => void;
  readonly onCheckCompleted?: () => void;
  readonly onRootFailure?: () => void;
  readonly onDiscarded?: () => void;
}

export interface UpdateRootFailure {
  readonly packageFilePath: string;
  readonly error: unknown;
}

export type UpdateOrchestrationResult
  = | {
    readonly kind: 'completed';
    readonly data: ReadonlyMap<string, CachedUpdateData>;
    readonly failedPackageFilePaths: readonly string[];
    readonly failures: readonly UpdateRootFailure[];
    readonly allFailed: boolean;
    readonly failure?: unknown;
  }
  | { readonly kind: 'debounced' }
  | {
    readonly kind: 'discarded';
    readonly reason: 'cancelled' | 'stale' | 'invalidated';
  };

export interface UpdateOrchestrationDependencies {
  readonly checkCoordinator: OperationCoordinator;
  readonly metadataCoordinator: OperationCoordinator;
  readonly fetchAllLatestVersions: (
    packageFilePath: string,
    target: NcuUpdateTarget,
    includePreReleases: boolean,
    minimumReleaseAgeDays: number,
  ) => Promise<ReadonlyMap<string, string>>;
  readonly resolveMetadataRegistryKey: (
    packageName: string,
    packageFilePath: string,
  ) => Promise<string | undefined>;
  readonly fetchPackageMetadata: (
    packageName: string,
    packageFilePath: string,
    signal: AbortSignal,
  ) => Promise<PackageMetadataOutcome>;
  readonly resolveMutationCoordinatorKey: (
    packageFilePath: string,
  ) => Promise<string>;
  readonly resolveCanonicalPackageLocation: (
    packageFilePath: string,
  ) => Promise<CanonicalPackageLocationResult>;
  readonly readCanonicalDependencySpecs: (
    location: CanonicalPackageLocation,
    identities: readonly PackageIdentityTuple[],
  ) => Promise<(string | undefined)[]>;
  readonly now: () => number;
}

export interface UpdateOrchestrationServiceContract {
  check(request: UpdateOrchestrationRequest): Promise<UpdateOrchestrationResult>;
  invalidateCache(): void;
  computeFingerprint(
    identities: readonly PackageIdentityTuple[],
    policy: UpdateFingerprintPolicy,
  ): Promise<string>;
}