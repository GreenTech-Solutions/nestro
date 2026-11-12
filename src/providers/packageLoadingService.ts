import * as utils from '../utils';
import { logger } from '../utils';
import type {
  PackageFileEntries,
  PackageFileEntry,
  PackageReadFailure,
} from '../utils';
import type {
  CanonicalPackageLocation,
  CanonicalPackageLocationResult,
} from './packageIdentity';
import { resolveCanonicalPackageLocation } from './packageLocationResolution';

export interface PackageLoadingSnapshot {
  readonly entries: readonly PackageFileEntry[];
  readonly packageFilePaths: readonly string[];
  readonly readablePackageFilePaths: readonly string[];
  readonly failedPackageReadPaths: readonly string[];
  /** Detailed read failures are optional for compatibility with injected test services. */
  readonly failedPackageReadDetails?: readonly PackageReadFailure[];
  readonly packageLocationBaselines: ReadonlyMap<string, CanonicalPackageLocation>;
  readonly packageReadFailed: boolean;
}

export interface PackageLoadingServiceContract {
  load(signal?: AbortSignal): Promise<PackageLoadingSnapshot | undefined>;
  readPackageEntries(): Promise<PackageFileEntries>;
  discoverPackageFilePaths(): Promise<readonly string[]>;
}

export interface PackageLoadingDependencies {
  readonly readPackageEntries: () => Promise<PackageFileEntries>;
  readonly discoverPackageFilePaths: () => Promise<readonly string[]>;
  readonly resolveCanonicalPackageLocation: (
    packageFilePath: string,
  ) => Promise<CanonicalPackageLocationResult>;
}

interface PackageFilePathsSnapshot {
  readonly packageFilePaths: string[];
  readonly readablePackageFilePaths: string[];
  readonly failedPackageReadPaths: string[];
  readonly failedPackageReadDetails: PackageReadFailure[];
  readonly packageReadFailed: boolean;
}

const DEFAULT_DEPENDENCIES: PackageLoadingDependencies = {
  readPackageEntries: () => utils.readAllWorkspaceDependencies(),
  discoverPackageFilePaths: () => utils.getWorkspacePackageFilePaths(),
  resolveCanonicalPackageLocation,
};

export class PackageLoadingService implements PackageLoadingServiceContract {
  constructor(private readonly dependencies: PackageLoadingDependencies = DEFAULT_DEPENDENCIES) {}

  async load(signal?: AbortSignal): Promise<PackageLoadingSnapshot | undefined> {
    const entries = await this.readPackageEntries();
    if (signal?.aborted) {
      return undefined;
    }

    const paths = await collectPackageFilePaths(entries, this, signal);
    if (paths === undefined) {
      return undefined;
    }
    const baselines = await buildPackageLocationBaselines(entries, this.dependencies, signal);
    if (baselines === undefined) {
      return undefined;
    }
    return freezePackageLoadingSnapshot(entries, paths, baselines);
  }

  readPackageEntries(): Promise<PackageFileEntries> {
    return this.dependencies.readPackageEntries();
  }

  discoverPackageFilePaths(): Promise<readonly string[]> {
    return this.dependencies.discoverPackageFilePaths();
  }
}

function freezePackageLocation(location: CanonicalPackageLocation): CanonicalPackageLocation {
  return Object.freeze({
    ...location,
    fileStamp: Object.freeze({ ...location.fileStamp }),
  });
}

async function collectPackageFilePaths(
  entries: PackageFileEntries,
  service: PackageLoadingService,
  signal?: AbortSignal,
): Promise<PackageFilePathsSnapshot | undefined> {
  const packageFilePaths = [...new Set(entries.map(entry => entry.packageFilePath))];
  let packageReadFailed = false;
  const failedPackageReadDetails: PackageReadFailure[] = (entries.skippedFiles ?? []).map(file => ({
    packageFilePath: file.packageFilePath,
    error: file.error,
  }));
  try {
    const discoveredPackageFilePaths = await service.discoverPackageFilePaths();
    if (signal?.aborted) {
      return undefined;
    }
    packageFilePaths.push(...discoveredPackageFilePaths.filter(
      packageFilePath => !packageFilePaths.includes(packageFilePath),
    ));
  }
  catch {
    packageReadFailed = true;
    failedPackageReadDetails.push({
      packageFilePath: '',
      error: 'Failed to discover workspace package files.',
    });
    logger.warn('Failed to discover workspace package files; using loaded package entries.');
  }
  if (signal?.aborted) {
    return undefined;
  }
  const failedPackageReadPaths = (entries.skippedFiles ?? []).map(file => file.packageFilePath);
  for (const packageFilePath of failedPackageReadPaths) {
    if (!packageFilePaths.includes(packageFilePath)) {
      packageFilePaths.push(packageFilePath);
    }
  }
  const failedPackageReadPathSet = new Set(failedPackageReadPaths);
  const readablePackageFilePaths = packageFilePaths.filter(
    packageFilePath => !failedPackageReadPathSet.has(packageFilePath),
  );
  return {
    packageFilePaths,
    readablePackageFilePaths,
    failedPackageReadPaths,
    failedPackageReadDetails,
    packageReadFailed,
  };
}

async function buildPackageLocationBaselines(
  entries: PackageFileEntries,
  dependencies: PackageLoadingDependencies,
  signal?: AbortSignal,
): Promise<Map<string, CanonicalPackageLocation> | undefined> {
  const baselines = new Map<string, CanonicalPackageLocation>();
  const canonicalManifestOwners = new Map<string, string>();
  const collidingManifestPaths = new Set<string>();
  for (const packageFilePath of new Set(entries.map(entry => entry.packageFilePath))) {
    const location = await dependencies.resolveCanonicalPackageLocation(packageFilePath);
    if (signal?.aborted) {
      return undefined;
    }
    if (!location.ok) {
      continue;
    }
    const canonicalOwner = canonicalManifestOwners.get(location.value.packageFilePath);
    if (canonicalOwner !== undefined && canonicalOwner !== packageFilePath) {
      collidingManifestPaths.add(canonicalOwner);
      collidingManifestPaths.add(packageFilePath);
      baselines.delete(canonicalOwner);
      baselines.delete(packageFilePath);
      continue;
    }
    canonicalManifestOwners.set(location.value.packageFilePath, packageFilePath);
    if (!collidingManifestPaths.has(packageFilePath)) {
      baselines.set(packageFilePath, freezePackageLocation(location.value));
    }
  }
  return signal?.aborted ? undefined : baselines;
}

function freezePackageLoadingSnapshot(
  entries: PackageFileEntries,
  paths: PackageFilePathsSnapshot,
  packageLocationBaselines: ReadonlyMap<string, CanonicalPackageLocation>,
): PackageLoadingSnapshot {
  return Object.freeze({
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
    packageFilePaths: Object.freeze([...paths.packageFilePaths]),
    readablePackageFilePaths: Object.freeze([...paths.readablePackageFilePaths]),
    failedPackageReadPaths: Object.freeze([...paths.failedPackageReadPaths]),
    failedPackageReadDetails: Object.freeze(paths.failedPackageReadDetails.map(failure => Object.freeze({ ...failure }))),
    packageLocationBaselines,
    packageReadFailed: paths.packageReadFailed,
  });
}