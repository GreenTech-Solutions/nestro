import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CI_WORKFLOW_PATH,
  CODEOWNERS_PATH,
  DEPENDABOT_CONFIG_PATH,
  evaluateCiWorkflowPolicy,
  evaluateCodeownersPolicy,
  evaluateDependabotConfigPolicy,
  WORKFLOWS_DIRECTORY_PATH,
} from './ciPolicy';
import {
  evaluateReleaseCandidateWorkflowPolicy,
  evaluateReleaseConfigPolicy,
  evaluateReleaseDispatchWorkflowPolicy,
  evaluateReleasePrepareWorkflowPolicy,
  evaluateReleaseWorkflowPolicy,
  RELEASE_CANDIDATE_WORKFLOW_PATH,
  RELEASE_CONFIG_PATH,
  RELEASE_DISPATCH_WORKFLOW_PATH,
  RELEASE_PREPARE_WORKFLOW_PATH,
  RELEASE_WORKFLOW_PATH,
} from './releaseWorkflowPolicy';
import { REVIEWED_ACTIONS_PATH } from './reviewedActions';
import type { ReviewedActionsRegistry } from './reviewedActions';
import { evaluateWorkflowActionPolicy, findUnusedReviewedActions, loadReviewedRegistryForPolicy } from './workflowActionPolicy';
import type { WorkflowViolation } from './workflowYaml';
import { describeError } from '../shared';

export interface WorkflowPolicySource {
  readonly path: string;
  readonly source: string;
}

export interface CiPolicyCliDependencies {
  readonly readCodeowners: () => Promise<string>;
  readonly readDependabotConfigs: () => Promise<readonly WorkflowPolicySource[]>;
  readonly readWorkflows: () => Promise<readonly WorkflowPolicySource[]>;
  readonly readReviewedActions: () => Promise<string>;
  readonly readReleaseConfig?: () => Promise<string>;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
}

interface PolicyInputs {
  readonly codeowners: string;
  readonly dependabotConfigs: readonly WorkflowPolicySource[];
  readonly releaseConfig: string | undefined;
  readonly reviewedActions: string;
  readonly workflows: readonly WorkflowPolicySource[];
}

interface LocatedViolation extends WorkflowViolation {
  readonly path: string;
}

const RELEASE_WORKFLOW_POLICIES: ReadonlyMap<string, (source: string, registry: ReviewedActionsRegistry) => readonly WorkflowViolation[]> = new Map([
  [RELEASE_PREPARE_WORKFLOW_PATH, evaluateReleasePrepareWorkflowPolicy],
  [RELEASE_CANDIDATE_WORKFLOW_PATH, evaluateReleaseCandidateWorkflowPolicy],
  [RELEASE_DISPATCH_WORKFLOW_PATH, evaluateReleaseDispatchWorkflowPolicy],
  [RELEASE_WORKFLOW_PATH, evaluateReleaseWorkflowPolicy],
]);

function locate(path: string, violations: readonly WorkflowViolation[]): LocatedViolation[] {
  return violations.map(violation => ({ ...violation, path }));
}

function dependabotViolations(configs: readonly WorkflowPolicySource[]): LocatedViolation[] {
  const violations: LocatedViolation[] = [];
  if (configs.length !== 1 || configs[0]?.path !== DEPENDABOT_CONFIG_PATH) {
    violations.push({
      path: DEPENDABOT_CONFIG_PATH,
      rule: 'dependabot-config-set',
      message: 'require only the canonical dependabot.yml configuration',
    });
  }
  const canonical = configs.find(config => config.path === DEPENDABOT_CONFIG_PATH);
  return canonical === undefined ? violations : [...violations, ...locate(DEPENDABOT_CONFIG_PATH, evaluateDependabotConfigPolicy(canonical.source))];
}

function workflowSetViolations(workflows: readonly WorkflowPolicySource[]): LocatedViolation[] {
  return [CI_WORKFLOW_PATH, ...RELEASE_WORKFLOW_POLICIES.keys()]
    .filter(requiredPath => workflows.every(workflow => workflow.path !== requiredPath))
    .map(path => ({ path, rule: 'workflow-set', message: 'required canonical workflow is missing' }));
}

function releaseConfigViolations(releaseConfig: string | undefined): LocatedViolation[] {
  if (releaseConfig === undefined) {
    return [{ path: RELEASE_CONFIG_PATH, rule: 'release-config', message: 'required release configuration is missing' }];
  }
  return locate(RELEASE_CONFIG_PATH, evaluateReleaseConfigPolicy(releaseConfig));
}

function workflowViolations(
  workflows: readonly WorkflowPolicySource[],
  registry: ReviewedActionsRegistry | undefined,
): LocatedViolation[] {
  return workflows.flatMap(({ path, source }) => {
    const violations: WorkflowViolation[] = [];
    if (registry !== undefined) {
      violations.push(...evaluateWorkflowActionPolicy(source, registry));
      if (path === CI_WORKFLOW_PATH) {
        violations.push(...evaluateCiWorkflowPolicy(source, registry));
      }
      violations.push(...RELEASE_WORKFLOW_POLICIES.get(path)?.(source, registry) ?? []);
    }
    return locate(path, violations);
  });
}

function registryViolations(inputs: PolicyInputs): { registry: ReviewedActionsRegistry | undefined; violations: LocatedViolation[] } {
  const { registry, violations } = loadReviewedRegistryForPolicy(inputs.reviewedActions);
  const unused = registry === undefined ? [] : findUnusedReviewedActions(registry, inputs.workflows.map(workflow => workflow.source));
  return { registry, violations: locate(REVIEWED_ACTIONS_PATH, [...violations, ...unused]) };
}

function evaluateRepositoryPolicy(inputs: PolicyInputs): LocatedViolation[] {
  const reviewed = registryViolations(inputs);
  return [
    ...locate(CODEOWNERS_PATH, evaluateCodeownersPolicy(inputs.codeowners)),
    ...dependabotViolations(inputs.dependabotConfigs),
    ...reviewed.violations,
    ...workflowSetViolations(inputs.workflows),
    ...releaseConfigViolations(inputs.releaseConfig),
    ...workflowViolations(inputs.workflows, reviewed.registry),
  ];
}

async function readPolicyInputs(dependencies: CiPolicyCliDependencies): Promise<PolicyInputs> {
  const [workflows, codeowners, dependabotConfigs, reviewedActions, releaseConfig] = await Promise.all([
    dependencies.readWorkflows(),
    dependencies.readCodeowners(),
    dependencies.readDependabotConfigs(),
    dependencies.readReviewedActions(),
    dependencies.readReleaseConfig?.() ?? Promise.resolve(undefined),
  ]);
  return { codeowners, dependabotConfigs, releaseConfig, reviewedActions, workflows };
}

export async function runCiPolicyCli(dependencies: CiPolicyCliDependencies): Promise<number> {
  let inputs: PolicyInputs;
  try {
    inputs = await readPolicyInputs(dependencies);
  }
  catch (error) {
    dependencies.writeError(`CI workflow policy failed: ${describeError(error)}`);
    return 1;
  }
  const violations = evaluateRepositoryPolicy(inputs);
  for (const violation of violations) {
    dependencies.writeError(`[${violation.rule}] ${violation.path}: ${violation.message}`);
  }
  if (violations.length > 0) {
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
    readReviewedActions: () => readFile(resolve(cwd, REVIEWED_ACTIONS_PATH), 'utf8'),
    readReleaseConfig: () => readFile(resolve(cwd, RELEASE_CONFIG_PATH), 'utf8'),
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