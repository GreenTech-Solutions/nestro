import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePnpmLauncher, runSignatureAuditCli, SIGNATURE_AUDIT_ARGS } from './auditSignatures';
import type { SignatureAuditCliDependencies, SignatureAuditExecution } from './auditSignatures';
import { createStreamLineWriter } from './verifyVsixCli';
import { runCliAsEntry } from './cliBootstrap';
import { asString, describeError } from '../shared';

/**
 * Node bindings for the signature audit guard: everything touching the process lives here, so
 * the pure decision in `auditSignatures.ts` can be exercised without a registry. Spawns pnpm
 * itself rather than being piped its output, which would drop the audit's own exit code.
 */

/** Same child-output ceiling the VSIX verifier uses; a signature report is far smaller. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

/**
 * A failing audit is a normal result here, not an exception: the exit code and stdout are
 * handed to the pure evaluator, which alone decides what they mean. Only a spawn failure
 * leaves the exit code undefined, which the evaluator also rejects.
 */
export function createNodePnpmRunner(
  cwd: string,
  platform: string,
): (args: readonly string[]) => Promise<SignatureAuditExecution> {
  const { executable, shell } = resolvePnpmLauncher(platform);

  return async (args: readonly string[]): Promise<SignatureAuditExecution> => {
    const command = `${executable} ${args.join(' ')}`;
    try {
      const { stderr, stdout } = await execFileAsync(executable, [...args], {
        cwd,
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        shell,
      });
      return { command, stdout, stderr, exitCode: 0 };
    }
    catch (error) {
      const details = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const exitCode = typeof details.code === 'number' ? details.code : undefined;
      const stderr = exitCode === undefined
        ? `${executable} could not run: ${describeError(error)}`
        : (asString(details.stderr) ?? '');
      return { command, stdout: (asString(details.stdout) ?? ''), stderr, exitCode };
    }
  };
}

export function createNodeSignatureAuditRunner(
  cwd: string,
  platform: string,
): () => Promise<SignatureAuditExecution> {
  const runPnpm = createNodePnpmRunner(cwd, platform);
  return () => runPnpm(SIGNATURE_AUDIT_ARGS);
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
runCliAsEntry(typeof module === 'undefined' ? undefined : module, () => mainSignatureAudit(process.argv.slice(2), process.cwd(), process.platform));
/* v8 ignore stop */