import {
  buildCleanVsixFixture,
  CLEAN_PACKAGE_MANIFEST,
  CLEAN_TRACKED_SOURCE_PATHS,
  toBytes,
} from '.';
import { compareCodeUnits } from '../../shared';
import type { VsixVerifierIo } from '../../tools';

export interface FakeIoOptions {
  readonly archive?: Uint8Array;
  readonly archives?: readonly Uint8Array[];
  readonly manifest?: string;
  readonly manifestBytes?: Uint8Array;
  readonly tracked?: readonly string[];
  readonly symlinks?: readonly string[];
  readonly modified?: readonly string[];
  readonly untracked?: readonly string[];
  readonly packageError?: Error;
  readonly packageCreatesBeforeError?: boolean;
  readonly readVsixError?: Error;
  readonly trackedError?: Error;
  readonly untrackedError?: Error;
  readonly symlinkError?: Error;
  readonly writeErrorAt?: 'manifest' | 'digest';
  readonly ensureError?: Error;
  readonly lockAcquireError?: unknown;
  readonly lockReleaseError?: unknown;
  readonly cleanupErrorValue?: unknown;
  readonly cleanupErrorPathBeforePackage?: string;
  readonly cleanupErrorPathAfterPackage?: string;
  readonly staleArtifactPaths?: readonly string[];
}

export interface FakeIo {
  readonly io: VsixVerifierIo;
  readonly written: Map<string, string>;
  readonly removed: string[];
  readonly ensured: string[];
  readonly packaged: string[];
  readonly locksAcquired: string[];
  readonly locksReleased: string[];
  readonly artifactBytes: (filePath: string) => Uint8Array | undefined;
  readonly artifactPaths: () => string[];
}

export const VSIX_PATH = 'dist/nestro-9.9.9.vsix';
export const MANIFEST_PATH = `${VSIX_PATH}.manifest.txt`;
export const DIGEST_PATH = `${VSIX_PATH}.sha256`;
export const LOCK_PATH = `${VSIX_PATH}.lock`;
export const TARGET_ARTIFACT_PATHS = [VSIX_PATH, MANIFEST_PATH, DIGEST_PATH];

export function createFakeIo(options: FakeIoOptions = {}): FakeIo {
  const files = new Map<string, Uint8Array>([
    ['package.json', options.manifestBytes ?? toBytes(options.manifest ?? CLEAN_PACKAGE_MANIFEST)],
  ]);
  const archive = options.archive ?? buildCleanVsixFixture();
  const written = new Map<string, string>();
  const removed: string[] = [];
  const ensured: string[] = [];
  const packaged: string[] = [];
  const locksAcquired: string[] = [];
  const locksReleased: string[] = [];
  let lockHeld = false;
  for (const stalePath of options.staleArtifactPaths ?? []) {
    files.set(stalePath, toBytes('stale'));
  }

  const io: VsixVerifierIo = {
    packageExtension: (vsixPath: string): Promise<void> => {
      const packageIndex = packaged.length;
      packaged.push(vsixPath);
      if (options.packageError === undefined || options.packageCreatesBeforeError === true) {
        files.set(vsixPath, options.archives?.[packageIndex] ?? archive);
      }
      if (options.packageError) {
        return Promise.reject(options.packageError);
      }
      return Promise.resolve();
    },
    readBinaryFile: (filePath: string): Promise<Uint8Array> => {
      if (filePath.endsWith('.vsix') && options.readVsixError !== undefined) {
        return Promise.reject(options.readVsixError);
      }
      const bytes = files.get(filePath);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`ENOENT: ${filePath}`));
    },
    writeTextFile: (filePath: string, contents: string): Promise<void> => {
      const writeStage = filePath.endsWith('.manifest.txt') ? 'manifest' : 'digest';
      if (options.writeErrorAt === writeStage) {
        return Promise.reject(new Error(`${writeStage} write failed`));
      }
      written.set(filePath, contents);
      files.set(filePath, toBytes(contents));
      return Promise.resolve();
    },
    removeFile: (filePath: string): Promise<void> => {
      removed.push(filePath);
      if (packaged.length === 0 && options.cleanupErrorPathBeforePackage === filePath) {
        return Promise.reject(new Error(`cannot remove stale ${filePath}`));
      }
      if (packaged.length > 0 && options.cleanupErrorPathAfterPackage === filePath) {
        return Promise.reject(options.cleanupErrorValue ?? new Error(`cannot remove ${filePath}`));
      }
      files.delete(filePath);
      written.delete(filePath);
      return Promise.resolve();
    },
    prepareArtifactDirectory: (dirPath: string): Promise<void> => {
      ensured.push(dirPath);
      return options.ensureError === undefined ? Promise.resolve() : Promise.reject(options.ensureError);
    },
    acquireArtifactLock: (lockPath: string) => {
      locksAcquired.push(lockPath);
      if (options.lockAcquireError !== undefined) {
        return Promise.reject(options.lockAcquireError);
      }
      if (lockHeld) {
        return Promise.reject(new Error(`VSIX artifact lock already exists: ${lockPath}`));
      }
      lockHeld = true;
      return Promise.resolve({
        release: (): Promise<void> => {
          locksReleased.push(lockPath);
          if (options.lockReleaseError !== undefined) {
            return Promise.reject(options.lockReleaseError);
          }
          lockHeld = false;
          return Promise.resolve();
        },
      });
    },
    listTrackedFiles: (): Promise<string[]> => options.trackedError === undefined
      ? Promise.resolve([...(options.tracked ?? CLEAN_TRACKED_SOURCE_PATHS)])
      : Promise.reject(options.trackedError),
    listModifiedTrackedFiles: (): Promise<string[]> => Promise.resolve([...(options.modified ?? [])]),
    listUntrackedFiles: (): Promise<string[]> => options.untrackedError === undefined
      ? Promise.resolve([...(options.untracked ?? [])])
      : Promise.reject(options.untrackedError),
    listSymlinkPaths: (candidatePaths: readonly string[]): Promise<string[]> => options.symlinkError === undefined
      ? Promise.resolve(candidatePaths.filter(candidate => (options.symlinks ?? []).includes(candidate)))
      : Promise.reject(options.symlinkError),
  };

  return {
    io,
    written,
    removed,
    ensured,
    packaged,
    locksAcquired,
    locksReleased,
    artifactBytes: (filePath: string): Uint8Array | undefined => files.get(filePath),
    artifactPaths: (): string[] => [...files.keys()]
      .filter(filePath => filePath !== 'package.json')
      .sort(compareCodeUnits),
  };
}