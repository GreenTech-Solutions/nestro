import { startRootOperations } from '../utils';
import type { RootOperationResult } from '../utils';
import {
  addPackageUpdatesByIdentity,
  groupPackageIdentitiesByFile,
} from './packageIdentity';
import type { UpdateOrchestrationDependencies, UpdateOrchestrationRequest, UpdateRootFailure } from './updateOrchestrationTypes';

interface CoordinationKeyResults {
  readonly keys: ReadonlyMap<string, string>;
  readonly failures: ReadonlyMap<string, unknown>;
}

export interface UpdateVersionFetchResult {
  readonly coordinationKeys: ReadonlyMap<string, string>;
  readonly acceptedVersions: ReadonlyMap<string, string>;
  readonly failedPackageFilePaths: readonly string[];
  readonly failures: readonly UpdateRootFailure[];
  readonly firstFailure: unknown;
}

export async function fetchUpdateVersions(
  request: UpdateOrchestrationRequest,
  dependencies: UpdateOrchestrationDependencies,
): Promise<UpdateVersionFetchResult | undefined> {
  const coordination = await resolveCheckCoordinationKeys(request.packageFiles, request.signal, dependencies);
  if (coordination === undefined) {
    return undefined;
  }

  coordination.failures.forEach(() => request.onRootFailure?.());
  const entries = createFetchEntries(request.packageFiles, coordination.keys);
  const outcomes = await fetchLatestVersionOutcomes(request, dependencies, entries);
  if (outcomes === undefined || request.signal.aborted) {
    return undefined;
  }

  return collectVersionFetchResults(request, coordination, entries, outcomes);
}

async function resolveCheckCoordinationKeys(
  packageFiles: readonly string[],
  signal: AbortSignal,
  dependencies: UpdateOrchestrationDependencies,
): Promise<CoordinationKeyResults | undefined> {
  const resolutionRun = startRootOperations(
    packageFiles,
    packageFilePath => packageFilePath,
    dependencies.checkCoordinator,
    signal,
    packageFilePath => dependencies.resolveMutationCoordinatorKey(packageFilePath),
  );
  const results = await resolutionRun.result;
  return signal.aborted ? undefined : collectCoordinationKeyResults(packageFiles, results);
}

function collectCoordinationKeyResults(
  packageFiles: readonly string[],
  results: readonly RootOperationResult<string>[],
): CoordinationKeyResults {
  const keys = new Map<string, string>();
  const failures = new Map<string, unknown>();
  results.forEach((result, index) => {
    const packageFilePath = packageFiles[index];
    if (packageFilePath === undefined) {
      return;
    }
    if (result.status === 'success') {
      keys.set(packageFilePath, result.value);
    }
    else if (result.status === 'failure') {
      failures.set(packageFilePath, result.error);
    }
  });
  return { keys, failures };
}

function createFetchEntries(
  packageFiles: readonly string[],
  coordinationKeys: ReadonlyMap<string, string>,
): readonly (readonly [string, string])[] {
  return packageFiles.flatMap((packageFilePath) => {
    const coordinationKey = coordinationKeys.get(packageFilePath);
    return coordinationKey === undefined ? [] : [[packageFilePath, coordinationKey]];
  });
}

function fetchLatestVersionOutcomes(
  request: UpdateOrchestrationRequest,
  dependencies: UpdateOrchestrationDependencies,
  entries: readonly (readonly [string, string])[],
): Promise<readonly RootOperationResult<ReadonlyMap<string, string>>[] | undefined> {
  const fetchRun = startRootOperations(
    entries,
    ([, coordinationKey]) => coordinationKey,
    dependencies.checkCoordinator,
    request.signal,
    ([packageFilePath]) => dependencies.fetchAllLatestVersions(
      packageFilePath,
      request.target,
      request.includePreReleases,
      request.minimumReleaseAgeDays,
    ),
  );
  return fetchRun.result;
}

function collectVersionFetchResults(
  request: UpdateOrchestrationRequest,
  coordination: CoordinationKeyResults,
  entries: readonly (readonly [string, string])[],
  outcomes: readonly RootOperationResult<ReadonlyMap<string, string>>[],
): UpdateVersionFetchResult {
  const acceptedVersions = new Map<string, string>();
  const failures = new Map(coordination.failures);
  const identitiesByPackageFile = groupPackageIdentitiesByFile(request.identities);
  outcomes.forEach((outcome, index) => {
    const packageFilePath = entries[index]?.[0];
    if (packageFilePath === undefined || outcome.status !== 'failure') {
      if (packageFilePath !== undefined && outcome.status === 'success') {
        addPackageUpdatesByIdentity(
          acceptedVersions,
          identitiesByPackageFile.get(packageFilePath) ?? [],
          outcome.value,
        );
      }
      return;
    }
    failures.set(packageFilePath, outcome.error);
    request.onRootFailure?.();
  });

  const orderedFailures = request.packageFiles.flatMap((packageFilePath) => {
    const error = failures.get(packageFilePath);
    return failures.has(packageFilePath) ? [{ packageFilePath, error }] : [];
  });
  return {
    coordinationKeys: coordination.keys,
    acceptedVersions,
    failedPackageFilePaths: orderedFailures.map(failure => failure.packageFilePath),
    failures: orderedFailures,
    firstFailure: orderedFailures[0]?.error,
  };
}