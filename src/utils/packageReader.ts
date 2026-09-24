import * as path from 'path';
import { logger } from './logger';
import {
  extractVersionPrefix,
  parsePackageJson,
  prepareDependencyType,
  prepareDependencyVersions,
  preparePinAllVersions,
  prepareVersionPin,
} from './packageTransforms';
import type { DependencySection, PackageFileDependencyUpdates, PackageVersionUpdate } from './packageTransforms';
import {
  findWorkspacePackageJsonFiles,
  getWorkspacePackageFilePath,
  readPackageFile,
  toWorkspaceRelativePackageFilePath,
  writeManyPreparedPackageFilesAtomically,
  writePreparedPackageFile,
} from './packageRepository';
import type { PreparedPackageFile } from './packageRepository';

export interface PackageEntry {
  name: string;
  current: string;
  dev: boolean;
  versionPrefix: string;
}

export interface PackageFileEntry extends PackageEntry {
  packageFilePath: string;
}

export interface SkippedPackageFile {
  packageFilePath: string;
  error: string;
}

/** Read failure retained for a diagnostics snapshot without exposing mutable parser state. */
export interface PackageReadFailure {
  packageFilePath: string;
  error: string;
}

export type PackageFileEntries = PackageFileEntry[] & {
  readonly skippedFiles?: readonly SkippedPackageFile[];
};

export async function updateWorkspaceDependencyVersions(updates: readonly PackageVersionUpdate[]): Promise<void> {
  const packageFilePath = getWorkspacePackageFilePath();
  if (packageFilePath === undefined) {
    throw new Error('No workspace folder found.');
  }

  await updateDependencyVersionsInFile(packageFilePath, updates);
}

export async function updateDependencyVersionsInFile(
  packageFilePath: string,
  updates: readonly PackageVersionUpdate[],
): Promise<void> {
  const file = await readPackageFile(packageFilePath);
  await writePreparedPackageFile({
    uri: file.uri,
    original: file.original,
    updated: Buffer.from(prepareDependencyVersions(file.raw, updates)),
  });
}

export async function updateDependencyVersionsInFilesAtomically(
  files: readonly PackageFileDependencyUpdates[],
): Promise<void> {
  const prepared: PreparedPackageFile[] = [];
  for (const file of files) {
    const rawFile = await readPackageFile(file.packageFilePath);
    prepared.push({
      uri: rawFile.uri,
      original: rawFile.original,
      updated: Buffer.from(prepareDependencyVersions(rawFile.raw, file.updates)),
    });
  }
  await writeManyPreparedPackageFilesAtomically(prepared);
}

export async function switchDependencyType(
  packageFilePath: string,
  packageName: string,
  currentlyDev: boolean,
  expectedSourceSpec: string,
): Promise<void> {
  const file = await readPackageFile(packageFilePath);
  await writePreparedPackageFile({
    uri: file.uri,
    original: file.original,
    updated: Buffer.from(prepareDependencyType(file.raw, packageName, currentlyDev, expectedSourceSpec)),
  });
}

export async function setVersionPin(
  packageFilePath: string,
  packageName: string,
  section: DependencySection,
  expectedSpec: string,
  pin: boolean,
): Promise<void> {
  const file = await readPackageFile(packageFilePath);
  await writePreparedPackageFile({
    uri: file.uri,
    original: file.original,
    updated: Buffer.from(prepareVersionPin(file.raw, packageName, section, expectedSpec, pin)),
  });
}

export interface PinAllVersionsResult {
  count: number;
  skippedFiles: readonly string[];
}

/**
 * Pins every pinnable dependency across every workspace `package.json`. A manifest that
 * cannot be read or parsed is skipped instead of aborting the run; the rest are all
 * classified before the first write and committed through the shared write/rollback engine.
 */
export async function pinAllWorkspaceDependencyVersions(): Promise<PinAllVersionsResult> {
  const files = await findWorkspacePackageJsonFiles();
  const prepared: PreparedPackageFile[] = [];
  const skippedFiles: string[] = [];
  let count = 0;
  for (const uri of files) {
    let result: ReturnType<typeof preparePinAllVersions>;
    let rawFile: Awaited<ReturnType<typeof readPackageFile>>;
    try {
      rawFile = await readPackageFile(uri);
      result = preparePinAllVersions(rawFile.raw);
    }
    catch (err) {
      skippedFiles.push(toWorkspaceRelativePackageFilePath(uri.fsPath));
      logger.error(`Failed to read package.json at ${uri.toString()} for Pin All; skipping it.`, err);
      continue;
    }
    count += result.count;
    if (result.updated !== undefined) {
      prepared.push({
        uri: rawFile.uri,
        original: rawFile.original,
        updated: Buffer.from(result.updated),
      });
    }
  }
  await writeManyPreparedPackageFilesAtomically(prepared);
  return { count, skippedFiles };
}

export async function readWorkspaceDependencies(): Promise<PackageEntry[]> {
  const entries = await readAllWorkspaceDependencies();
  return entries.map(({ name, current, dev, versionPrefix }) => ({ name, current, dev, versionPrefix }));
}

export async function readAllWorkspaceDependencies(glob?: string): Promise<PackageFileEntries> {
  const files = await findWorkspacePackageJsonFiles(glob);
  if (files.length === 0) {
    logger.info('No workspace package.json found.');
    return createPackageFileEntries([], []);
  }

  const results: PackageFileEntry[] = [];
  const skippedFiles: SkippedPackageFile[] = [];
  for (const uri of files) {
    try {
      const file = await readPackageFile(uri);
      const json = parsePackageJson(file.raw);
      const packageFilePath = uri.fsPath;

      results.push(
        ...Object.entries(json.dependencies ?? {}).map(([name, current]) => ({
          name,
          current: current as string,
          dev: false,
          versionPrefix: extractVersionPrefix(current as string),
          packageFilePath,
        })),
        ...Object.entries(json.devDependencies ?? {}).map(([name, current]) => ({
          name,
          current: current as string,
          dev: true,
          versionPrefix: extractVersionPrefix(current as string),
          packageFilePath,
        })),
      );
    }
    catch (err) {
      skippedFiles.push({
        packageFilePath: uri.fsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.error(`Failed to read workspace package.json at ${uri.toString()}; skipping.`, err);
    }
  }
  return createPackageFileEntries(results, skippedFiles);
}

function createPackageFileEntries(
  entries: PackageFileEntry[],
  skippedFiles: readonly SkippedPackageFile[],
): PackageFileEntries {
  Object.defineProperty(entries, 'skippedFiles', {
    value: skippedFiles,
    enumerable: false,
  });
  return entries as PackageFileEntries;
}

export function getPackageDirectory(packageFilePath: string): string {
  return path.dirname(packageFilePath);
}