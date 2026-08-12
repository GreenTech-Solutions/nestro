import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CI_WORKFLOW_PATH, evaluateCiWorkflowPolicy } from './ciPolicy';

export interface CiPolicyCliDependencies {
  readonly readWorkflow: () => Promise<string>;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
}

export async function runCiPolicyCli(dependencies: CiPolicyCliDependencies): Promise<number> {
  let source: string;
  try {
    source = await dependencies.readWorkflow();
  }
  catch (error) {
    dependencies.writeError(`CI workflow policy failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const violations = evaluateCiWorkflowPolicy(source);
  if (violations.length > 0) {
    for (const violation of violations) {
      dependencies.writeError(`[${violation.rule}] ${violation.message}`);
    }
    return 1;
  }
  dependencies.writeOut('CI workflow policy verified');
  return 0;
}

export function createNodeCiPolicyCliDependencies(cwd: string): CiPolicyCliDependencies {
  return {
    readWorkflow: () => readFile(resolve(cwd, CI_WORKFLOW_PATH), 'utf8'),
    writeOut: message => process.stdout.write(`${message}\n`),
    writeError: message => process.stderr.write(`${message}\n`),
  };
}

/* v8 ignore start -- process bootstrap */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runCiPolicyCli(createNodeCiPolicyCliDependencies(process.cwd())).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */