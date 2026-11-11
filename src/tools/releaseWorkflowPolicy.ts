import { validatePrepareReleaseConfig } from './releaseAnalyzer';
import { RELEASE_CANDIDATE_CONTRACT } from './releaseCandidateContract';
import { RELEASE_CONTRACT } from './releaseContract';
import { RELEASE_DISPATCH_CONTRACT } from './releaseDispatchContract';
import { RELEASE_PREPARE_CONTRACT } from './releasePrepareContract';
import { RELEASE_PUBLISH_CONTRACT, RELEASE_SECRET_STEPS } from './releasePublishContract';
import type { ReviewedActionsRegistry } from './reviewedActions';
import { checkWorkflowContract } from './workflowContract';
import type { WorkflowContract } from './workflowContract';
import { isRecord, loadStrictYaml } from './workflowYaml';
import type { WorkflowViolation } from './workflowYaml';

export const RELEASE_PREPARE_WORKFLOW_PATH = '.github/workflows/release-prepare.yml';
export const RELEASE_CANDIDATE_WORKFLOW_PATH = '.github/workflows/release-candidate.yml';
export const RELEASE_DISPATCH_WORKFLOW_PATH = '.github/workflows/release-dispatch.yml';
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
export const RELEASE_CONFIG_PATH = '.releaserc.json';

const NO_SECRET_STEPS: ReadonlySet<string> = new Set();
const SECRET_NAMES: ReadonlySet<string> = new Set([
  RELEASE_CONTRACT.secrets.marketplace,
  RELEASE_CONTRACT.secrets.openVsx,
  ...RELEASE_CONTRACT.secrets.rejectedAliases,
]);
const SECRET_REFERENCE = new RegExp(`\\bsecrets\\.(?:${[...SECRET_NAMES].join('|')})\\b`, 'u');

function referencesSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return SECRET_REFERENCE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(referencesSecret);
  }
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) => SECRET_NAMES.has(key) || referencesSecret(entry));
  }
  return false;
}

function secretHolders(workflow: Record<string, unknown>, allowedSteps: ReadonlySet<string>): string[] {
  const { jobs, ...header } = workflow;
  const holders = referencesSecret(header) ? ['workflow'] : [];
  for (const [jobId, job] of Object.entries(isRecord(jobs) ? jobs : {})) {
    const { steps, ...controls } = isRecord(job) ? job : { steps: undefined };
    if (referencesSecret(controls)) {
      holders.push(jobId);
    }
    for (const step of Array.isArray(steps) ? steps : []) {
      const name = isRecord(step) ? step.name : undefined;
      if (referencesSecret(step) && !(typeof name === 'string' && allowedSteps.has(`${jobId}/${name}`))) {
        holders.push(`${jobId}/${String(name)}`);
      }
    }
  }
  return holders;
}

/** Registry credentials may appear only on the named steps, never in headers, job controls or other steps. */
function secretBoundaryViolations(workflow: unknown, allowedSteps: ReadonlySet<string>): WorkflowViolation[] {
  const holders = isRecord(workflow) ? secretHolders(workflow, allowedSteps) : [];
  return holders.map(holder => ({ rule: 'secret-boundary', message: `${holder} must not reference registry publishing credentials` }));
}

function evaluateReleaseContract(
  source: string,
  contract: WorkflowContract,
  registry: ReviewedActionsRegistry,
  allowedSecretSteps: ReadonlySet<string>,
): WorkflowViolation[] {
  const loaded = loadStrictYaml(source, { rule: 'yaml', subject: 'Workflow' });
  if (!loaded.loaded) {
    return loaded.violations;
  }
  return [
    ...checkWorkflowContract(loaded.value, contract, registry),
    ...secretBoundaryViolations(loaded.value, allowedSecretSteps),
  ];
}

export function evaluateReleasePrepareWorkflowPolicy(source: string, registry: ReviewedActionsRegistry): WorkflowViolation[] {
  return evaluateReleaseContract(source, RELEASE_PREPARE_CONTRACT, registry, NO_SECRET_STEPS);
}

export function evaluateReleaseCandidateWorkflowPolicy(source: string, registry: ReviewedActionsRegistry): WorkflowViolation[] {
  return evaluateReleaseContract(source, RELEASE_CANDIDATE_CONTRACT, registry, NO_SECRET_STEPS);
}

export function evaluateReleaseDispatchWorkflowPolicy(source: string, registry: ReviewedActionsRegistry): WorkflowViolation[] {
  return evaluateReleaseContract(source, RELEASE_DISPATCH_CONTRACT, registry, NO_SECRET_STEPS);
}

export function evaluateReleaseWorkflowPolicy(source: string, registry: ReviewedActionsRegistry): WorkflowViolation[] {
  return evaluateReleaseContract(source, RELEASE_PUBLISH_CONTRACT, registry, RELEASE_SECRET_STEPS);
}

export function evaluateReleaseConfigPolicy(source: string): WorkflowViolation[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  }
  catch (error) {
    return [{ rule: 'release-config', message: `release config is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const configViolations = validatePrepareReleaseConfig(value);
  return configViolations.map(message => ({ rule: 'release-config', message }));
}