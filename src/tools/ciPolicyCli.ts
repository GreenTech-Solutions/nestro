import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CI_WORKFLOW_PATH,
  evaluateCiWorkflowPolicy,
  evaluateWorkflowActionPolicy,
  WORKFLOWS_DIRECTORY_PATH,
} from './ciPolicy';

export interface WorkflowPolicySource {
  readonly path: string;
  readonly source: string;
}

export interface CiPolicyCliDependencies {
  readonly readWorkflows: () => Promise<readonly WorkflowPolicySource[]>;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
}

export async function runCiPolicyCli(dependencies: CiPolicyCliDependencies): Promise<number> {
  let workflows: readonly WorkflowPolicySource[];
  try {
    workflows = await dependencies.readWorkflows();
  }
  catch (error) {
    dependencies.writeError(`CI workflow policy failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let rejected = false;
  const ciWorkflow = workflows.find(workflow => workflow.path === CI_WORKFLOW_PATH);
  if (ciWorkflow === undefined) {
    dependencies.writeError(`[workflow-set] ${CI_WORKFLOW_PATH}: required canonical workflow is missing`);
    rejected = true;
  }
  for (const workflow of workflows) {
    const violations = evaluateWorkflowActionPolicy(workflow.source);
    if (workflow.path === CI_WORKFLOW_PATH) {
      violations.push(...evaluateCiWorkflowPolicy(workflow.source));
    }
    for (const violation of violations) {
      dependencies.writeError(`[${violation.rule}] ${workflow.path}: ${violation.message}`);
      rejected = true;
    }
  }
  if (rejected) {
    return 1;
  }
  dependencies.writeOut('CI workflow policy verified');
  return 0;
}

export function createNodeCiPolicyCliDependencies(cwd: string): CiPolicyCliDependencies {
  return {
    readWorkflows: async () => {
      const directory = resolve(cwd, WORKFLOWS_DIRECTORY_PATH);
      const entries = await readdir(directory, { withFileTypes: true });
      const names = entries
        .filter(entry => entry.isFile() && /\.ya?ml$/u.test(entry.name))
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));
      return Promise.all(names.map(async name => ({
        path: `${WORKFLOWS_DIRECTORY_PATH}/${name}`,
        source: await readFile(resolve(directory, name), 'utf8'),
      })));
    },
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