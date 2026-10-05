import { runDependencyAuditCli } from './auditDependencies';
import type { DependencyAuditCliDependencies } from './auditDependencies';
import { createNodePnpmRunner } from './auditSignaturesCli';
import { createStreamLineWriter } from './verifyVsixCli';

/** Node bindings for the dependency audit gate; the decision lives in `auditDependencies.ts`. */

export function createNodeDependencyAuditCliDependencies(
  cwd: string,
  platform: string,
  env: NodeJS.ProcessEnv,
): DependencyAuditCliDependencies {
  return {
    runAudit: createNodePnpmRunner(cwd, platform),
    writeOut: createStreamLineWriter(process.stdout),
    writeError: createStreamLineWriter(process.stderr),
    githubActions: env.GITHUB_ACTIONS === 'true',
  };
}

/** Process entrypoint, named for this tool like the other tool CLIs re-exported by the barrel. */
export function mainDependencyAudit(
  argv: readonly string[],
  cwd: string,
  platform: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return runDependencyAuditCli(argv, createNodeDependencyAuditCliDependencies(cwd, platform, env));
}

/* v8 ignore start -- process bootstrap: only reachable when node runs this file directly */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void mainDependencyAudit(process.argv.slice(2), process.cwd(), process.platform, process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */