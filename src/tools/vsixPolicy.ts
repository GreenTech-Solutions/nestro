import { COMPRESSED_SIZE_BUDGET_BYTES, PACKAGED_FILE_COUNT_BUDGET } from './releaseContract';
import { checkBundle } from './vsixBundle';
import { checkSecrets } from './vsixSecretScan';
import type { PackagedFile, PolicyViolation, VsixPolicyInput, VsixPolicyReport } from './vsixPolicyTypes';
import {
  classifyForbidden,
  collectSymlinkCandidates,
  isAllowlisted,
  toSourcePath,
  VSIX_ARCHIVE_METADATA_PATHS,
  VSIX_BUILD_OUTPUT_PREFIX,
  VSIX_EXTENSION_PREFIX,
  VSIX_STATIC_ALLOWLIST,
} from './vsixRules';
import { compareCodeUnits } from '../shared';

/** Layers the content policy for the published `.vsix`: shape, allowlist, bundle, symlinks, git tracking, secrets, budgets. */

function checkArchiveShape(input: VsixPolicyInput, violations: PolicyViolation[]): PackagedFile[] {
  const packagedFiles: PackagedFile[] = [];
  const seenMetadata = new Set<string>();
  for (const entry of input.entries) {
    if (VSIX_ARCHIVE_METADATA_PATHS.includes(entry.path)) {
      seenMetadata.add(entry.path);
      continue;
    }
    if (!entry.path.startsWith(VSIX_EXTENSION_PREFIX)) {
      violations.push({
        kind: 'unexpected-file',
        path: entry.path,
        detail: 'archive entry is neither vsce metadata nor extension content',
      });
      continue;
    }
    packagedFiles.push({ packagePath: entry.path.slice(VSIX_EXTENSION_PREFIX.length), entry });
  }
  for (const metadataPath of VSIX_ARCHIVE_METADATA_PATHS) {
    if (!seenMetadata.has(metadataPath)) {
      violations.push({ kind: 'archive-metadata-missing', path: metadataPath, detail: 'vsce metadata entry is missing' });
    }
  }
  return packagedFiles;
}

function checkAllowlist(packagedFiles: readonly PackagedFile[], violations: PolicyViolation[]): void {
  for (const file of packagedFiles) {
    const forbiddenClass = classifyForbidden(file.packagePath);
    if (forbiddenClass !== null) {
      violations.push({
        kind: 'forbidden-file',
        path: file.packagePath,
        detail: `forbidden class "${forbiddenClass}"`,
      });
    }
    else if (!isAllowlisted(file.packagePath)) {
      violations.push({
        kind: 'unexpected-file',
        path: file.packagePath,
        detail: 'path is not on the VSIX allowlist',
      });
    }
  }
  const packagePaths = new Set(packagedFiles.map(file => file.packagePath));
  for (const rule of VSIX_STATIC_ALLOWLIST) {
    if (!packagePaths.has(rule.packagePath)) {
      violations.push({
        kind: 'missing-required-file',
        path: rule.packagePath,
        detail: `required package file is missing (source ${rule.sourcePath})`,
      });
    }
  }
}

function checkSymlinks(
  input: VsixPolicyInput,
  packagedFiles: readonly PackagedFile[],
  violations: PolicyViolation[],
): void {
  for (const file of packagedFiles) {
    if (file.entry.isSymlink) {
      violations.push({ kind: 'symlink', path: file.packagePath, detail: 'archive entry is stored as a symlink' });
    }
  }
  const symlinks = new Set(input.symlinkSourcePaths);
  for (const sourcePath of collectSymlinkCandidates(packagedFiles.map(file => file.packagePath))) {
    if (symlinks.has(sourcePath)) {
      violations.push({ kind: 'symlink', path: sourcePath, detail: 'packaged path resolves through a symlink on disk' });
    }
  }
}

function checkTracked(
  input: VsixPolicyInput,
  packagedFiles: readonly PackagedFile[],
  violations: PolicyViolation[],
  warnings: string[],
): void {
  const tracked = new Set(input.trackedSourcePaths);
  const modified = new Set(input.modifiedTrackedPaths);
  const directlyUntracked = new Set<string>();
  if (input.requireCleanWorktree) {
    for (const sourcePath of [...modified].sort(compareCodeUnits)) {
      violations.push({
        kind: 'modified-tracked-file',
        path: sourcePath,
        detail: 'tracked file is modified in the working tree, so verification did not use a clean checkout',
      });
    }
  }
  for (const file of packagedFiles) {
    if (file.packagePath.startsWith(VSIX_BUILD_OUTPUT_PREFIX)) {
      continue;
    }
    const sourcePath = toSourcePath(file.packagePath);
    if (!tracked.has(sourcePath)) {
      directlyUntracked.add(sourcePath);
      violations.push({
        kind: 'untracked-file',
        path: sourcePath,
        detail: 'packaged file is not tracked by git, so it cannot come from a clean checkout',
      });
      continue;
    }
    if (input.requireCleanWorktree || !modified.has(sourcePath)) {
      continue;
    }
    warnings.push(
      `${sourcePath} is tracked but modified in the working tree, `
      + 'so the package does not match a clean checkout',
    );
  }
  if (input.requireCleanWorktree) {
    const untracked = new Set(input.untrackedWorktreePaths);
    for (const sourcePath of [...untracked].sort(compareCodeUnits)) {
      if (directlyUntracked.has(sourcePath)) {
        continue;
      }
      violations.push({
        kind: 'untracked-worktree-file',
        path: sourcePath,
        detail: 'untracked file is present in the working tree, so verification did not use a clean checkout',
      });
    }
  }
}

function checkBudgets(input: VsixPolicyInput, packagedFileCount: number, violations: PolicyViolation[]): void {
  if (packagedFileCount > PACKAGED_FILE_COUNT_BUDGET) {
    violations.push({
      kind: 'file-count-budget',
      path: '(package)',
      detail: `${packagedFileCount} packaged files exceed the budget of ${PACKAGED_FILE_COUNT_BUDGET}`,
    });
  }
  if (input.compressedBytes > COMPRESSED_SIZE_BUDGET_BYTES) {
    violations.push({
      kind: 'size-budget',
      path: '(package)',
      detail: `${input.compressedBytes} compressed bytes exceed the budget of ${COMPRESSED_SIZE_BUDGET_BYTES}`,
    });
  }
}

/** Runs every layer of the policy and returns all violations, never just the first. */
export function evaluateVsixPolicy(input: VsixPolicyInput): VsixPolicyReport {
  const violations: PolicyViolation[] = [];
  const warnings: string[] = [];
  const packagedFiles = checkArchiveShape(input, violations);
  checkAllowlist(packagedFiles, violations);
  const bundleClosure = checkBundle(packagedFiles, violations);
  checkSymlinks(input, packagedFiles, violations);
  checkTracked(input, packagedFiles, violations, warnings);
  checkSecrets(input.entries, violations);
  checkBudgets(input, packagedFiles.length, violations);

  const packagePaths = packagedFiles.map(file => file.packagePath).sort(compareCodeUnits);
  const sourcePaths = packagePaths.map(toSourcePath).sort(compareCodeUnits);
  return {
    violations,
    warnings,
    packagePaths,
    sourcePaths,
    bundleClosure,
    packagedFileCount: packagedFiles.length,
  };
}