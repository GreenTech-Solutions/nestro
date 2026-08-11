import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePnpmExecutable, runSignatureAuditCli, SIGNATURE_AUDIT_ARGS } from './auditSignatures';
import type { SignatureAuditCliDependencies, SignatureAuditExecution } from './auditSignatures';
import { createStreamLineWriter } from './verifyVsixCli';

/**
 * Node bindings for the signature audit guard. Everything that touches the
 * process lives here; the decision in `auditSignatures.ts` stays pure so both
 * the accepting and the rejecting side can be exercised without a registry.
 *
 * The guard spawns pnpm itself rather than being piped its output. A pipe would
 * hand the exit status to the last process in it and drop the audit's own code
 * — the same false-green shape `src/tools/verifyVsix.ts` documents for
 * `check:vsce | grep`.
 */

/** Same child-output ceiling the VSIX verifier uses; a signature report is far smaller. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Builds the runner for `pnpm audit signatures --json`.
 *
 * A failing audit is a normal result here, not an exception: the exit code and
 * whatever was written to stdout are handed to the pure evaluator, which is the
 * only place allowed to decide what they mean. Only a spawn failure leaves the
 * exit code undefined, and the evaluator rejects that too.
 */
export function createNodeSignatureAuditRunner(
  cwd: string,
  platform: string,
): () => Promise<SignatureAuditExecution> {
  const executable = resolvePnpmExecutable(platform);
  const command = `${executable} ${SIGNATURE_AUDIT_ARGS.join(' ')}`;

  return async (): Promise<SignatureAuditExecution> => {
    try {
      const { stderr, stdout } = await execFileAsync(executable, [...SIGNATURE_AUDIT_ARGS], {
        cwd,
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
      });
      return { command, stdout, stderr, exitCode: 0 };
    }
    catch (error) {
      const details = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const exitCode = typeof details.code === 'number' ? details.code : undefined;
      const stderr = exitCode === undefined
        ? `${executable} could not run: ${error instanceof Error ? error.message : String(error)}`
        : readString(details.stderr);
      return { command, stdout: readString(details.stdout), stderr, exitCode };
    }
  };
}

export function createNodeSignatureAuditCliDependencies(
  cwd: string,
  platform: string,
): SignatureAuditCliDependencies {
  return {
    runAudit: createNodeSignatureAuditRunner(cwd, platform),
    writeOut: createStreamLineWriter(process.stdout),
    writeError: createStreamLineWriter(process.stderr),
  };
}

/** Process entrypoint. Named for this tool because the barrel also re-exports the VSIX verifier's `main`. */
export function mainSignatureAudit(argv: readonly string[], cwd: string, platform: string): Promise<number> {
  return runSignatureAuditCli(argv, createNodeSignatureAuditCliDependencies(cwd, platform));
}

/* v8 ignore start -- process bootstrap: only reachable when node runs this file directly */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void mainSignatureAudit(process.argv.slice(2), process.cwd(), process.platform).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */