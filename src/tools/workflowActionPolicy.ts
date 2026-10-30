import type { Document } from 'yaml';
import { FULL_SHA_PATTERN, parseReviewedActionsRegistry, REVIEWED_ACTIONS_PATH } from './reviewedActions';
import type { ReviewedActionsRegistry } from './reviewedActions';
import { asString, isRecord, loadStrictYaml } from './workflowYaml';
import type { UnknownRecord, WorkflowViolation } from './workflowYaml';

export interface ReviewedRegistryLoad {
  readonly registry: ReviewedActionsRegistry | undefined;
  readonly violations: WorkflowViolation[];
}

function normalizedRun(step: UnknownRecord): string | undefined {
  return asString(step.run)?.trim().replaceAll('\r\n', '\n');
}

function scalarComment(node: unknown): string | undefined {
  return isRecord(node) ? asString(node.comment)?.trim() : undefined;
}

function splitActionReference(reference: string): readonly [string, string] | undefined {
  const separator = reference.lastIndexOf('@');
  if (separator <= 0 || separator === reference.length - 1) {
    return undefined;
  }
  const locator = reference.slice(0, separator);
  const ref = reference.slice(separator + 1);
  const segments = locator.split('/');
  if (segments.length < 2
    || segments.some(segment => segment.length === 0 || segment.includes('@') || /\s/u.test(segment))
    || /\s/u.test(ref)) {
    return undefined;
  }
  return [locator, ref];
}

function reviewedTag(registry: ReviewedActionsRegistry, locator: string, ref: string): string | undefined {
  const action = Object.hasOwn(registry.actions, locator) ? registry.actions[locator] : undefined;
  return action?.sha === ref ? action.tag : undefined;
}

function assertReviewedExecutableUse(
  registry: ReviewedActionsRegistry,
  referenceValue: unknown,
  referenceNode: unknown,
  location: string,
  violations: WorkflowViolation[],
): void {
  const reference = asString(referenceValue);
  if (reference === undefined) {
    violations.push({ rule: 'immutable-action', message: `${location} must be a static reviewed action reference` });
    return;
  }
  if (reference.startsWith('./')) {
    violations.push({ rule: 'reviewed-local-action', message: `${location} uses an unreviewed local action or reusable workflow` });
    return;
  }
  if (reference.startsWith('docker://')) {
    violations.push({ rule: 'reviewed-docker-action', message: `${location} uses an unreviewed Docker action image` });
    return;
  }
  const parsed = splitActionReference(reference);
  if (parsed === undefined || !FULL_SHA_PATTERN.test(parsed[1])) {
    violations.push({ rule: 'immutable-action', message: `${location} must pin an external action to a lowercase full SHA` });
    return;
  }
  const tag = reviewedTag(registry, parsed[0], parsed[1]);
  if (tag === undefined) {
    violations.push({ rule: 'reviewed-action', message: `${location} must use a reviewed action locator and commit` });
  }
  else if (scalarComment(referenceNode) !== tag) {
    violations.push({ rule: 'action-version-comment', message: `${location} must identify the reviewed ${tag} tag` });
  }
}

function isAutoMergeCommand(command: string): boolean {
  return /\bgh\s+pr\s+merge\b/u.test(command)
    || /enablePullRequestAutoMerge/u.test(command)
    || /(?:gh\s+api|curl\b)[^\n]*\/pulls\/[^\s'"`]+\/merge\b/u.test(command);
}

function isAutoMergeAction(reference: string): boolean {
  return /(?:^|[/_-])auto-?merge(?:[/_-]|$)/iu.test(reference.split('@', 1)[0]);
}

function checkUses(
  registry: ReviewedActionsRegistry,
  holder: UnknownRecord,
  node: unknown,
  location: string,
  violations: WorkflowViolation[],
): void {
  if (!Object.hasOwn(holder, 'uses')) {
    return;
  }
  const reference = asString(holder.uses);
  if (reference !== undefined && isAutoMergeAction(reference)) {
    violations.push({ rule: 'dependabot-auto-merge', message: `${location} must not enable automatic merging` });
  }
  assertReviewedExecutableUse(registry, holder.uses, node, location, violations);
}

function checkSteps(
  registry: ReviewedActionsRegistry,
  document: Document,
  jobId: string,
  steps: unknown[],
  violations: WorkflowViolation[],
): void {
  for (const [index, step] of steps.entries()) {
    const location = `jobs.${jobId}.steps[${index}]`;
    if (!isRecord(step)) {
      violations.push({ rule: 'workflow-shape', message: `${location} must be a mapping` });
      continue;
    }
    checkUses(registry, step, document.getIn(['jobs', jobId, 'steps', index, 'uses'], true), `${location}.uses`, violations);
    const command = normalizedRun(step);
    if (command !== undefined && isAutoMergeCommand(command)) {
      violations.push({ rule: 'dependabot-auto-merge', message: `${location}.run must not enable automatic merging` });
    }
  }
}

/** Checks every executable `uses` and `run` of one workflow against the reviewed registry. */
export function evaluateWorkflowActionPolicy(source: string, registry: ReviewedActionsRegistry): WorkflowViolation[] {
  const loaded = loadStrictYaml(source, { rule: 'yaml', subject: 'Workflow' });
  if (!loaded.loaded) {
    return loaded.violations;
  }
  const violations: WorkflowViolation[] = [];
  const root = isRecord(loaded.value) ? loaded.value : {};
  if (!isRecord(loaded.value)) {
    violations.push({ rule: 'workflow-shape', message: 'workflow must be a mapping' });
  }
  const jobs = isRecord(root.jobs) ? root.jobs : {};
  if (!isRecord(root.jobs)) {
    violations.push({ rule: 'workflow-shape', message: 'jobs must be a mapping' });
  }
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isRecord(job)) {
      violations.push({ rule: 'workflow-shape', message: `jobs.${jobId} must be a mapping` });
      continue;
    }
    checkUses(registry, job, loaded.document.getIn(['jobs', jobId, 'uses'], true), `jobs.${jobId}.uses`, violations);
    if (job.steps !== undefined && !Array.isArray(job.steps)) {
      violations.push({ rule: 'workflow-shape', message: `jobs.${jobId}.steps must be a sequence` });
    }
    else if (job.steps !== undefined) {
      checkSteps(registry, loaded.document, jobId, job.steps, violations);
    }
  }
  return violations;
}

function usedLocators(source: string): string[] {
  const loaded = loadStrictYaml(source, { rule: 'yaml', subject: 'Workflow' });
  const jobs = loaded.loaded && isRecord(loaded.value) && isRecord(loaded.value.jobs) ? Object.values(loaded.value.jobs) : [];
  return jobs.filter(isRecord).flatMap((job) => {
    const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
    return [job, ...steps].map(holder => asString(holder.uses)).flatMap((reference) => {
      const parsed = reference === undefined ? undefined : splitActionReference(reference);
      return parsed === undefined ? [] : [parsed[0]];
    });
  });
}

/** Reports every registry entry that no workflow uses, so the registry cannot keep dead pins. */
export function findUnusedReviewedActions(registry: ReviewedActionsRegistry, workflowSources: readonly string[]): WorkflowViolation[] {
  const used = new Set(workflowSources.flatMap(usedLocators));
  return Object.keys(registry.actions)
    .filter(locator => !used.has(locator))
    .map(locator => ({ rule: 'unused-registry-entry', message: `${locator} is in the reviewed registry but no workflow uses it` }));
}

/** Parses the registry file for policy use; a malformed registry is a violation, not an exception. */
export function loadReviewedRegistryForPolicy(source: string): ReviewedRegistryLoad {
  try {
    return { registry: parseReviewedActionsRegistry(source), violations: [] };
  }
  catch (error) {
    const prefix = `${REVIEWED_ACTIONS_PATH}: `;
    const message = error instanceof Error ? error.message : String(error);
    return {
      registry: undefined,
      violations: [{ rule: 'reviewed-registry', message: message.startsWith(prefix) ? message.slice(prefix.length) : message }],
    };
  }
}