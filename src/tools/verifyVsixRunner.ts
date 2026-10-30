import { normalizeArtifactOutDir } from './artifactOutDir';
import { COMPRESSED_SIZE_BUDGET_BYTES, PACKAGED_FILE_COUNT_BUDGET } from './releaseContract';
import { verifyVsixPackage } from './verifyVsix';
import type { VerifyVsixOptions, VerifyVsixResult, VsixVerifierIo } from './verifyVsix';
import type { PolicyViolation } from './vsixPolicyTypes';
import { describeError } from '../shared';

export const DEFAULT_OUT_DIR = 'dist';

export interface VerifyVsixCliDependencies {
  readonly io: VsixVerifierIo;
  readonly writeOut: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export function parseVerifyVsixArgs(argv: readonly string[]): VerifyVsixOptions {
  let outDir = DEFAULT_OUT_DIR;
  let requireCleanWorktree = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--require-clean-worktree') {
      requireCleanWorktree = true;
      continue;
    }
    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--out-dir requires a directory argument');
      }
      outDir = normalizeArtifactOutDir(value);
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { outDir, requireCleanWorktree };
}

function formatViolation(violation: PolicyViolation): string {
  return `  [${violation.kind}] ${violation.path} — ${violation.detail}`;
}

/** Reports a rejected package on stderr; the manifest stream stays empty. */
function reportRejection(result: VerifyVsixResult, writeError: (line: string) => void): void {
  writeError(`VSIX policy rejected ${result.report.violations.length} finding(s):`);
  for (const violation of result.report.violations) {
    writeError(formatViolation(violation));
  }
  writeError(`Rejected VSIX artifacts removed: ${result.vsixPath}, ${result.manifestPath}, ${result.digestPath}`);
}

function reportAcceptance(result: VerifyVsixResult, deps: VerifyVsixCliDependencies): void {
  for (const sourcePath of result.report.sourcePaths) {
    deps.writeOut(sourcePath);
  }

  deps.writeError(
    `VSIX verified: ${result.report.packagedFileCount}/${PACKAGED_FILE_COUNT_BUDGET} files, `
    + `${result.compressedBytes}/${COMPRESSED_SIZE_BUDGET_BYTES} compressed bytes, `
    + `${result.report.bundleClosure.length} bundle files reachable from the entrypoint.`,
  );
  deps.writeError(`  package:  ${result.vsixPath}`);
  deps.writeError(`  manifest: ${result.manifestPath}`);
  deps.writeError(`  sha256:   ${result.digest}`);
}

/**
 * Writes diagnostics to stderr and the manifest to stdout, but only stdout once the package is
 * accepted: a caller piping this into `grep` for the entrypoint takes its exit status from grep,
 * so emitting the manifest before the verdict would let a rejected, deleted package still "pass".
 */
export async function runVerifyVsixCli(
  argv: readonly string[],
  deps: VerifyVsixCliDependencies,
): Promise<number> {
  let result: VerifyVsixResult;
  try {
    result = await verifyVsixPackage(deps.io, parseVerifyVsixArgs(argv));
  }
  catch (error) {
    deps.writeError(`VSIX verification failed: ${describeError(error)}`);
    return 1;
  }

  // Warnings are reported before the verdict branches: a rejected package is
  // the run where diagnostics matter most, and stderr never feeds the manifest
  // stream, so this cannot weaken the stdout contract above.
  for (const warning of result.report.warnings) {
    deps.writeError(`VSIX warning: ${warning}`);
  }

  if (result.report.violations.length > 0) {
    reportRejection(result, deps.writeError);
    return 1;
  }
  reportAcceptance(result, deps);
  return 0;
}