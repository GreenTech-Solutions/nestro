import type { VsixArchiveEntry } from './vsixArchive';

export type ViolationKind
  = | 'unexpected-file'
    | 'forbidden-file'
    | 'missing-required-file'
    | 'archive-metadata-missing'
    | 'symlink'
    | 'manifest-invalid'
    | 'entrypoint-missing'
    | 'bundle-missing-chunk'
    | 'bundle-orphan-file'
    | 'bundle-invalid-path'
    | 'secret'
    | 'unscanned-file'
    | 'untracked-file'
    | 'untracked-worktree-file'
    | 'modified-tracked-file'
    | 'file-count-budget'
    | 'size-budget';

export interface PolicyViolation {
  readonly kind: ViolationKind;
  readonly path: string;
  readonly detail: string;
}

export interface VsixPolicyInput {
  readonly entries: readonly VsixArchiveEntry[];
  /** Size of the `.vsix` file itself, i.e. the compressed size budget subject. */
  readonly compressedBytes: number;
  /** Output of `git ls-files`; used to reject packaged source files that are not tracked. */
  readonly trackedSourcePaths: readonly string[];
  /** Repository paths that are symlinks on disk, including ancestor directories. */
  readonly symlinkSourcePaths: readonly string[];
  /**
   * Tracked repository paths that differ from HEAD in the working tree: being tracked proves
   * the file exists in the repository, not that the packaged bytes match the committed bytes
   * (the difference between a CI checkout and a `vsce package` run from a working machine).
   */
  readonly modifiedTrackedPaths: readonly string[];
  /** Untracked, non-ignored repository paths present in the working tree. */
  readonly untrackedWorktreePaths: readonly string[];
  /**
   * When set, any tracked working-tree modification is a violation, including build inputs
   * that do not map to a packaged path. Off by default so local verification works mid-change;
   * the release pipeline enables it to require a literal clean checkout.
   */
  readonly requireCleanWorktree: boolean;
}

export interface VsixPolicyReport {
  readonly violations: readonly PolicyViolation[];
  /** Non-fatal observations. Reported on stderr, never on the manifest stream. */
  readonly warnings: readonly string[];
  /** Allowlisted paths relative to the extension root, sorted. */
  readonly packagePaths: readonly string[];
  /** Repository paths behind those packaged files, sorted. */
  readonly sourcePaths: readonly string[];
  /** Bundle files reachable from the manifest entrypoint, sorted. */
  readonly bundleClosure: readonly string[];
  readonly packagedFileCount: number;
}

/** An archive entry under the extension root, keyed by its path inside that root. */
export interface PackagedFile {
  readonly packagePath: string;
  readonly entry: VsixArchiveEntry;
}