import { isDeepStrictEqual } from 'node:util';
import { RELEASE_CONTRACT_PATH } from './releaseContract';
import { add, asRecord, exactKeys, hasRun, normalizedRun, steps } from './releaseWorkflowSteps';
import type { ReleaseWorkflowPolicyViolation, UnknownRecord } from './releaseWorkflowSteps';
import { reviewedActionReference } from './reviewedActions';

export const SCRIPT_CHECKOUT_STEP_NAME = 'Check out the reviewed scripts';

const SCRIPT_DIRECTORY = 'reviewed-source/.github/scripts/release';
const SCRIPT_CALL_PATTERN = /^bash reviewed-source\/\.github\/scripts\/release\/[a-z][a-z-]*\.sh(?: [a-z]+| "\$[A-Z_]+")?$/u;
const SCRIPT_CHECKOUT_OPTIONS = {
  'fetch-depth': 1,
  path: 'reviewed-source',
  'persist-credentials': false,
  ref: '${{ github.sha }}',
  'sparse-checkout': `.github/scripts\n${RELEASE_CONTRACT_PATH}\n`,
  'sparse-checkout-cone-mode': false,
} as const;

export function releaseScriptRun(script: string, argument?: string): string {
  return `bash ${SCRIPT_DIRECTORY}/${script}.sh${argument === undefined ? '' : ` ${argument}`}`;
}

export function isReleaseScriptCall(run: string): boolean {
  return SCRIPT_CALL_PATTERN.test(run);
}

function isCheckoutStep(step: UnknownRecord): boolean {
  return typeof step.uses === 'string' && /^actions\/checkout(?:@|$)/iu.test(step.uses.trim());
}

export function assertNoBuildOrCheckout(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const hasForbiddenOperation = (run: string): boolean => run.includes('actions/checkout')
    || /\b(?:pnpm|npm|yarn|bun)\s+(?:ci|install|exec|dlx)\b/u.test(run)
    || /\bnpx\b/u.test(run)
    || /\b(?:pnpm|npm|yarn|bun)\s+run\s+build\b/u.test(run)
    || run.includes('tsdown')
    || /\b(?:git\s+checkout|git\s+clone)\b/u.test(run);
  if (steps(job).some(isCheckoutStep) || hasRun(job, hasForbiddenOperation)) {
    add(violations, 'publish-boundary', 'protected release jobs must not checkout, install or build');
  }
}

function assertScriptCheckout(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const [step] = steps(job);
  if (step?.name !== SCRIPT_CHECKOUT_STEP_NAME
    || step.uses !== reviewedActionReference('actions/checkout')
    || !exactKeys(step, ['name', 'uses', 'with'])
    || !isDeepStrictEqual(step.with, SCRIPT_CHECKOUT_OPTIONS)) {
    add(violations, 'script-checkout', 'release jobs must start by checking out only the reviewed release scripts and contract at the workflow commit, without persisted credentials');
  }
}

export function assertScriptCheckoutBoundary(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const otherSteps = steps(job).filter(step => step.name !== SCRIPT_CHECKOUT_STEP_NAME);
  assertNoBuildOrCheckout({ steps: otherSteps }, violations);
  assertScriptCheckout(job, violations);
}

export function assertScriptStep(
  step: UnknownRecord | undefined,
  expected: { readonly run: string; readonly env?: Readonly<Record<string, string>>; readonly id?: string },
  rule: string,
  message: string,
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  if (step === undefined
    || step.shell !== 'bash'
    || step.id !== expected.id
    || normalizedRun(step) !== expected.run
    || !isDeepStrictEqual(asRecord(step.env) ?? {}, expected.env ?? {})) {
    add(violations, rule, message);
  }
}