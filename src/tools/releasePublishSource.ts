import { isDeepStrictEqual } from 'node:util';
import { add, exactKeys, hasRun, steps } from './releaseWorkflowSteps';
import type { ReleaseWorkflowPolicyViolation, UnknownRecord } from './releaseWorkflowSteps';
import { reviewedActionReference } from './reviewedActions';

export const SCRIPT_CHECKOUT_STEP_NAME = 'Check out the reviewed scripts';

const MANIFEST_STEP_NAME = 'Verify the candidate manifest, tag and digest';
const SCRIPT_CHECKOUT_OPTIONS = {
  'fetch-depth': 1,
  path: 'reviewed-source',
  'persist-credentials': false,
  ref: '${{ steps.manifest.outputs.source-sha }}',
  'sparse-checkout': '.github/scripts',
  'sparse-checkout-cone-mode': false,
} as const;

function isCheckoutStep(step: UnknownRecord): boolean {
  return typeof step.uses === 'string' && /^actions\/checkout(?:@|$)/iu.test(step.uses.trim());
}

function referencesSecret(step: UnknownRecord): boolean {
  return JSON.stringify(step).includes('secrets.');
}

export function assertNoBuildOrCheckout(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const hasForbiddenOperation = (run: string): boolean => run.includes('actions/checkout')
    || /\b(?:pnpm|npm|yarn|bun)\s+(?:ci|install|exec|dlx)\b/u.test(run)
    || /\bnpx\b/u.test(run)
    || /\b(?:pnpm|npm|yarn|bun)\s+run\s+build\b/u.test(run)
    || run.includes('tsdown')
    || /\b(?:git\s+checkout|git\s+clone)\b/u.test(run);
  if (steps(job).some(isCheckoutStep) || hasRun(job, hasForbiddenOperation)) {
    add(violations, 'publish-boundary', 'protected publish and finalizer jobs must not checkout, install or build');
  }
}

function assertScriptCheckout(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const all = steps(job);
  const index = all.findIndex(step => step.name === SCRIPT_CHECKOUT_STEP_NAME);
  const manifestIndex = all.findIndex(step => step.name === MANIFEST_STEP_NAME);
  const firstSecretIndex = all.findIndex(referencesSecret);
  const step = all[index];
  if (step === undefined
    || step.uses !== reviewedActionReference('actions/checkout')
    || !exactKeys(step, ['name', 'uses', 'with'])
    || !isDeepStrictEqual(step.with, SCRIPT_CHECKOUT_OPTIONS)
    || manifestIndex < 0
    || index < manifestIndex
    || (firstSecretIndex >= 0 && index > firstSecretIndex)) {
    add(violations, 'script-checkout', 'publish must check out only .github/scripts at the verified candidate source SHA, without persisted credentials, after the manifest check and before any credential step');
  }
}

export function assertPublishSourceBoundary(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const otherSteps = steps(job).filter(step => step.name !== SCRIPT_CHECKOUT_STEP_NAME);
  assertNoBuildOrCheckout({ steps: otherSteps }, violations);
  assertScriptCheckout(job, violations);
}