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
import { resolveCanonicalPackageLocation } from './packageIdentity';

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

    const packageFilePaths = [...new Set(entries.map(entry => entry.packageFilePath))];
    let packageReadFailed = false;
    const failedPackageReadDetails: PackageReadFailure[] = (entries.skippedFiles ?? []).map(file => ({
      packageFilePath: file.packageFilePath,
      error: file.error,
    }));
    try {
      const discoveredPackageFilePaths = await this.discoverPackageFilePaths();
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
    const baselines = new Map<string, CanonicalPackageLocation>();
    const canonicalManifestOwners = new Map<string, string>();
    const collidingManifestPaths = new Set<string>();
    for (const packageFilePath of new Set(entries.map(entry => entry.packageFilePath))) {
      const location = await this.dependencies.resolveCanonicalPackageLocation(packageFilePath);
      if (signal?.aborted) {
        return undefined;
      }
      if (location.ok) {
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
    }
    if (signal?.aborted) {
      return undefined;
    }

    return Object.freeze({
      entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
      packageFilePaths: Object.freeze([...packageFilePaths]),
      readablePackageFilePaths: Object.freeze([...readablePackageFilePaths]),
      failedPackageReadPaths: Object.freeze([...failedPackageReadPaths]),
      failedPackageReadDetails: Object.freeze(failedPackageReadDetails.map(failure => Object.freeze({ ...failure }))),
      packageLocationBaselines: baselines,
      packageReadFailed,
    });
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