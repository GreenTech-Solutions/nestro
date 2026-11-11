import { isDeepStrictEqual } from 'node:util';
import type { ReviewedActionsRegistry } from './reviewedActions';
import { compareCodeUnits, isRecord } from '../shared';
import type { UnknownRecord, WorkflowViolation } from './workflowYaml';

/** One reviewed step; `uses` names a registry locator and is checked against the registry commit. */
export interface StepContract {
  readonly name: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: UnknownRecord;
  readonly env?: UnknownRecord;
  readonly shell?: string;
  readonly run?: string;
}

/** `controls` holds every job key except `steps`, compared as a whole. */
export interface JobContract {
  readonly controls: UnknownRecord;
  readonly steps: readonly StepContract[];
}

/** `header` holds every top-level key except `jobs` (name, on, permissions, env, ...), compared as a whole. */
export interface WorkflowContract {
  readonly header: UnknownRecord;
  readonly jobs: Readonly<Record<string, JobContract>>;
}

const HEADER_RULES: Readonly<Record<string, string>> = {
  env: 'env-contract',
  on: 'trigger-contract',
  permissions: 'permissions-contract',
};

function normalizeRun(run: string): string {
  return run.trim().replaceAll('\r\n', '\n');
}

function differingKeys(actual: UnknownRecord, expected: UnknownRecord): string[] {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .filter(key => !isDeepStrictEqual(actual[key], expected[key]))
    .sort(compareCodeUnits);
}

function expandStep(step: StepContract, registry: ReviewedActionsRegistry, violations: WorkflowViolation[]): UnknownRecord {
  const { run, uses, ...rest } = step;
  const expanded: UnknownRecord = { ...rest };
  if (run !== undefined) {
    expanded.run = normalizeRun(run);
  }
  if (uses !== undefined) {
    const action = Object.hasOwn(registry.actions, uses) ? registry.actions[uses] : undefined;
    if (action === undefined) {
      violations.push({ rule: 'reviewed-action', message: `contract step "${step.name}" uses ${uses}, which is not in the reviewed registry` });
    }
    expanded.uses = `${uses}@${action?.sha ?? 'unreviewed'}`;
  }
  return expanded;
}

function normalizeActualStep(step: UnknownRecord): UnknownRecord {
  return typeof step.run === 'string' ? { ...step, run: normalizeRun(step.run) } : step;
}

function checkSteps(
  jobId: string,
  actualSteps: unknown,
  expected: readonly StepContract[],
  registry: ReviewedActionsRegistry,
  violations: WorkflowViolation[],
): void {
  const actual = Array.isArray(actualSteps) ? actualSteps : [];
  if (actual.length !== expected.length) {
    violations.push({ rule: 'step-allowlist', message: `${jobId} must contain exactly the ${expected.length} reviewed steps` });
  }
  for (const [index, contractStep] of expected.entries()) {
    const step: unknown = actual[index];
    if (step === undefined) {
      break;
    }
    const expectedStep = expandStep(contractStep, registry, violations);
    const actualStep = isRecord(step) ? normalizeActualStep(step) : {};
    if (!isRecord(step) || !isDeepStrictEqual(actualStep, expectedStep)) {
      const keys = differingKeys(actualStep, expectedStep);
      violations.push({
        rule: 'step-contract',
        message: `${jobId} step ${index + 1} (${contractStep.name}) must match the reviewed step${keys.length === 0 ? '' : `; differs in: ${keys.join(', ')}`}`,
      });
    }
  }
}

function checkJob(
  jobId: string,
  job: UnknownRecord,
  contract: JobContract,
  registry: ReviewedActionsRegistry,
  violations: WorkflowViolation[],
): void {
  const { steps, ...controls } = job;
  if (!isDeepStrictEqual(controls, contract.controls)) {
    violations.push({
      rule: 'job-contract',
      message: `${jobId} must use the exact reviewed job controls; differs in: ${differingKeys(controls, contract.controls).join(', ')}`,
    });
  }
  checkSteps(jobId, steps, contract.steps, registry, violations);
}

function checkJobs(
  jobs: unknown,
  contract: WorkflowContract,
  registry: ReviewedActionsRegistry,
  violations: WorkflowViolation[],
): void {
  if (!isRecord(jobs)) {
    violations.push({ rule: 'workflow-shape', message: 'jobs must be a mapping' });
    return;
  }
  const expectedIds = Object.keys(contract.jobs);
  const actualIds = Object.keys(jobs);
  if (actualIds.length !== expectedIds.length || !expectedIds.every(jobId => Object.hasOwn(jobs, jobId))) {
    violations.push({ rule: 'job-allowlist', message: `workflow must contain exactly the reviewed jobs: ${expectedIds.join(', ')}` });
  }
  for (const [jobId, jobContract] of Object.entries(contract.jobs)) {
    const job = Object.hasOwn(jobs, jobId) ? jobs[jobId] : undefined;
    if (isRecord(job)) {
      checkJob(jobId, job, jobContract, registry, violations);
    }
    else if (job !== undefined) {
      violations.push({ rule: 'workflow-shape', message: `jobs.${jobId} must be a mapping` });
    }
  }
}

/** Compares a parsed workflow with its contract; any difference from the contract is a violation. */
export function checkWorkflowContract(
  workflow: unknown,
  contract: WorkflowContract,
  registry: ReviewedActionsRegistry,
): WorkflowViolation[] {
  if (!isRecord(workflow)) {
    return [{ rule: 'workflow-shape', message: 'workflow must be a mapping' }];
  }
  const { jobs, ...header } = workflow;
  const violations: WorkflowViolation[] = [];
  for (const key of new Set([...Object.keys(header), ...Object.keys(contract.header)])) {
    if (!isDeepStrictEqual(header[key], contract.header[key])) {
      violations.push({ rule: Object.hasOwn(HEADER_RULES, key) ? HEADER_RULES[key] : 'workflow-contract', message: `workflow ${key} must match the reviewed contract` });
    }
  }
  checkJobs(jobs, contract, registry, violations);
  return violations;
}