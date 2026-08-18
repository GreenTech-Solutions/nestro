import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CI_WORKFLOW_PATH,
  CODEOWNERS_PATH,
  DEPENDABOT_CONFIG_PATH,
  evaluateCiWorkflowPolicy,
  evaluateCodeownersPolicy,
  evaluateDependabotConfigPolicy,
  evaluateWorkflowActionPolicy,
  WORKFLOWS_DIRECTORY_PATH,
} from './ciPolicy';

export interface WorkflowPolicySource {
  readonly path: string;
  readonly source: string;
}

export interface CiPolicyCliDependencies {
  readonly readCodeowners: () => Promise<string>;
  readonly readDependabotConfigs: () => Promise<readonly WorkflowPolicySource[]>;
  readonly readWorkflows: () => Promise<readonly WorkflowPolicySource[]>;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
}

export async function runCiPolicyCli(dependencies: CiPolicyCliDependencies): Promise<number> {
  let workflows: readonly WorkflowPolicySource[];
  let codeowners: string;
  let dependabotConfigs: readonly WorkflowPolicySource[];
  try {
    [workflows, codeowners, dependabotConfigs] = await Promise.all([
      dependencies.readWorkflows(),
      dependencies.readCodeowners(),
      dependencies.readDependabotConfigs(),
    ]);
  }
  catch (error) {
    dependencies.writeError(`CI workflow policy failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let rejected = false;
  for (const violation of evaluateCodeownersPolicy(codeowners)) {
    dependencies.writeError(`[${violation.rule}] ${CODEOWNERS_PATH}: ${violation.message}`);
    rejected = true;
  }
  if (dependabotConfigs.length !== 1 || dependabotConfigs[0]?.path !== DEPENDABOT_CONFIG_PATH) {
    dependencies.writeError(
      `[dependabot-config-set] ${DEPENDABOT_CONFIG_PATH}: require only the canonical dependabot.yml configuration`,
    );
    rejected = true;
  }
  const dependabotConfig = dependabotConfigs.find(config => config.path === DEPENDABOT_CONFIG_PATH);
  if (dependabotConfig !== undefined) {
    for (const violation of evaluateDependabotConfigPolicy(dependabotConfig.source)) {
      dependencies.writeError(`[${violation.rule}] ${DEPENDABOT_CONFIG_PATH}: ${violation.message}`);
      rejected = true;
    }
  }
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
    readCodeowners: () => readFile(resolve(cwd, CODEOWNERS_PATH), 'utf8'),
    readDependabotConfigs: async () => {
      const directory = resolve(cwd, '.github');
      const entries = await readdir(directory, { withFileTypes: true });
      const names = entries
        .filter(entry => entry.isFile() && /^dependabot\.ya?ml$/u.test(entry.name))
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));
      return Promise.all(names.map(async name => ({
        path: `.github/${name}`,
        source: await readFile(resolve(directory, name), 'utf8'),
      })));
    },
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