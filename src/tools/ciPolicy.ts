import { isDeepStrictEqual } from 'node:util';
import { parseDocument, visit } from 'yaml';

export const CODEOWNERS_PATH = '.github/CODEOWNERS';
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const DEPENDABOT_CONFIG_PATH = '.github/dependabot.yml';
export const WORKFLOWS_DIRECTORY_PATH = '.github/workflows';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ACTION_REFERENCE_PATTERN = /^([^/]+\/[^/@]+)@(.+)$/u;
const CI_REVIEWED_ACTIONS: Readonly<Record<string, string>> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'pnpm/setup': '84cb39b217b10273981911c288cd62326dc7c6d2',
};
const REVIEWED_EXTERNAL_ACTIONS: Readonly<Record<string, string>> = {
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1': 'v7.0.1',
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803': 'v6.1.0',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c': 'v8.0.1',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38': 'v6.5.0',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020': 'v7.0.0',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a': 'v7.0.1',
  'HaaLeo/publish-vscode-extension@ca5561daa085dee804bf9f37fe0165785a9b14db': 'v2.0.0',
  'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86': 'v6.0.10',
  'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2': 'v2.0.2',
};
const EXPECTED_CODEOWNERS = '/.github/ @GreenTech-Solutions\n';
const EXPECTED_DEPENDABOT_CONFIG: UnknownRecord = {
  updates: [{
    'commit-message': {
      prefix: 'ci(deps)',
    },
    directory: '/',
    'open-pull-requests-limit': 2,
    'package-ecosystem': 'github-actions',
    schedule: {
      day: 'monday',
      interval: 'weekly',
      time: '04:00',
      timezone: 'UTC',
    },
  }],
  version: 2,
};
const ACTIONLINT_COMMAND = `set -euo pipefail
archive="$RUNNER_TEMP/actionlint_1.7.12_linux_amd64.tar.gz"
curl --fail --silent --show-error --location \\
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \\
  --output "$archive"
printf '%s  %s\\n' 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 "$archive" \\
  | sha256sum --check --strict
tar -xzf "$archive" -C "$RUNNER_TEMP" actionlint
"$RUNNER_TEMP/actionlint" -color .github/workflows/*.yml`;

export interface CiPolicyViolation {
  readonly rule: string;
  readonly message: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string, violations: CiPolicyViolation[]): UnknownRecord {
  if (isRecord(value)) {
    return value;
  }
  violations.push({ rule: 'workflow-shape', message: `${label} must be a mapping` });
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : [];
}

function add(violations: CiPolicyViolation[], rule: string, message: string): void {
  violations.push({ rule, message });
}

function getSteps(job: UnknownRecord): UnknownRecord[] {
  const steps = job.steps;
  return Array.isArray(steps) ? steps.filter(isRecord) : [];
}

function normalizedRun(step: UnknownRecord): string | undefined {
  return asString(step.run)?.trim().replaceAll('\r\n', '\n');
}

const CHECKOUT_STEP: UnknownRecord = {
  name: 'Checkout exact tested commit',
  uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  with: {
    ref: '${{ env.EXPECTED_SHA }}',
    'persist-credentials': false,
  },
};
const IDENTITY_STEP: UnknownRecord = {
  name: 'Assert checkout identity',
  run: 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
  shell: 'bash',
};
const PNPM_STEP: UnknownRecord = {
  name: 'Prepare pnpm',
  uses: 'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2',
  with: {
    cache: false,
    install: false,
  },
};
const NODE_STEP: UnknownRecord = {
  name: 'Setup Node.js',
  uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  with: {
    cache: 'pnpm',
    'cache-dependency-path': 'pnpm-lock.yaml',
    'node-version-file': '.nvmrc',
  },
};
const INSTALL_STEP: UnknownRecord = {
  name: 'Install frozen dependencies',
  run: 'pnpm install --frozen-lockfile',
};
const COMMON_SETUP_STEPS: readonly UnknownRecord[] = [
  CHECKOUT_STEP,
  IDENTITY_STEP,
  PNPM_STEP,
  NODE_STEP,
  INSTALL_STEP,
];
const DISPATCH_RESOLUTION_STEP: UnknownRecord = {
  name: 'Resolve the dispatched pull request',
  if: '${{ github.event_name == \'workflow_dispatch\' }}',
  shell: 'bash',
  env: {
    GH_TOKEN: '${{ github.token }}',
    DISPATCH_PR_NUMBER: '${{ inputs.pr_number }}',
    DISPATCH_HEAD_SHA: '${{ inputs.head_sha }}',
  },
  run: 'set -euo pipefail\n[[ "$DISPATCH_PR_NUMBER" =~ ^[0-9]+$ ]]\npr="$(gh api "repos/${{ github.repository }}/pulls/$DISPATCH_PR_NUMBER")"\ntest "$(echo "$pr" | jq -r \'.head.sha\')" = "$DISPATCH_HEAD_SHA"\ntest "$DISPATCH_HEAD_SHA" = "$EXPECTED_SHA"\ntest "$(echo "$pr" | jq -r \'.state\')" = "open"\ntest "$(echo "$pr" | jq -r \'.base.ref\')" = "master"',
};
const QUALITY_STEPS: readonly UnknownRecord[] = [
  DISPATCH_RESOLUTION_STEP,
  ...COMMON_SETUP_STEPS,
  { name: 'Audit dependencies', run: 'pnpm run audit:dependencies' },
  { name: 'Audit dependency signatures', run: 'pnpm run audit:signatures' },
  { name: 'Strict lint', run: 'pnpm run lint' },
  { name: 'Production typecheck', run: 'pnpm run typecheck' },
  { name: 'Test typecheck', run: 'pnpm exec tsc -p tsconfig.test.json --noEmit' },
  { name: 'Validate workflow syntax', run: ACTIONLINT_COMMAND, shell: 'bash' },
  { name: 'Workflow policy', run: 'pnpm run ci:policy' },
  { name: 'Unit coverage', run: 'pnpm run test:unit:coverage' },
  { name: 'Build', run: 'pnpm run build' },
];
const HOST_STEPS: readonly UnknownRecord[] = [
  ...COMMON_SETUP_STEPS,
  { name: 'Build extension', run: 'pnpm run build' },
  { name: 'Compile integration tests', run: 'pnpm run test:compile' },
  {
    if: '${{ runner.os == \'Linux\' }}',
    name: 'Run Extension Host on Linux',
    run: 'xvfb-run -a pnpm exec vscode-test --label "${{ matrix.channel }}"',
  },
  {
    if: '${{ runner.os != \'Linux\' }}',
    name: 'Run Extension Host',
    run: 'pnpm exec vscode-test --label "${{ matrix.channel }}"',
  },
];
const PACKAGE_STEPS: readonly UnknownRecord[] = [
  ...COMMON_SETUP_STEPS,
  { name: 'Build', run: 'pnpm run build' },
  {
    name: 'Package and verify VSIX',
    run: 'pnpm run check:vsce --out-dir "$CI_ARTIFACT_DIR" --require-clean-worktree',
  },
  {
    env: {
      CI_EVENT_NAME: '${{ github.event_name }}',
      CI_PR_HEAD_SHA: '${{ github.event_name == \'workflow_dispatch\' && inputs.head_sha || github.event.pull_request.head.sha }}',
      CI_RUN_ATTEMPT: '${{ github.run_attempt }}',
      CI_RUN_ID: '${{ github.run_id }}',
      CI_SOURCE_SHA: '${{ env.EXPECTED_SHA }}',
    },
    name: 'Write evidence-only identity',
    run: 'pnpm run ci:evidence --out-dir "$CI_ARTIFACT_DIR"',
  },
  {
    id: 'upload',
    name: 'Upload immutable evidence',
    uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    with: {
      'if-no-files-found': 'error',
      name: 'verify-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
      overwrite: false,
      path: '${{ env.CI_ARTIFACT_DIR }}/*.vsix\n${{ env.CI_ARTIFACT_DIR }}/*.vsix.manifest.txt\n${{ env.CI_ARTIFACT_DIR }}/*.vsix.sha256\n${{ env.CI_ARTIFACT_DIR }}/evidence.json\n',
      'retention-days': 7,
    },
  },
];
const PACKAGED_SMOKE_STEPS: readonly UnknownRecord[] = [
  ...COMMON_SETUP_STEPS,
  { name: 'Compile packaged smoke runner', run: 'pnpm run test:compile' },
  {
    name: 'Download exact immutable evidence',
    uses: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    with: {
      'artifact-ids': '${{ needs.package.outputs.artifact-id }}',
      path: '${{ env.CI_ARTIFACT_DIR }}',
    },
  },
  {
    if: '${{ runner.os == \'Linux\' }}',
    name: 'Verify, install and activate packaged VSIX on Linux',
    run: 'xvfb-run -a pnpm run test:packaged --artifact-dir "${{ env.CI_ARTIFACT_DIR }}" --expected-sha "${{ env.EXPECTED_SHA }}" --channel "${{ matrix.channel }}"',
  },
  {
    if: '${{ runner.os != \'Linux\' }}',
    name: 'Verify, install and activate packaged VSIX',
    run: 'pnpm run test:packaged --artifact-dir "${{ env.CI_ARTIFACT_DIR }}" --expected-sha "${{ env.EXPECTED_SHA }}" --channel "${{ matrix.channel }}"',
  },
];
const REQUIRED_STEP: UnknownRecord = {
  env: {
    HOST_RESULT: '${{ needs.extension-host.result }}',
    PACKAGED_SMOKE_RESULT: '${{ needs.packaged-smoke.result }}',
    PACKAGE_RESULT: '${{ needs.package.result }}',
    QUALITY_RESULT: '${{ needs.quality.result }}',
  },
  name: 'Reject failed or skipped gates',
  run: `test "$QUALITY_RESULT" = success
test "$HOST_RESULT" = success
test "$PACKAGE_RESULT" = success
test "$PACKAGED_SMOKE_RESULT" = success`,
  shell: 'bash',
};

function normalizedStep(step: UnknownRecord): UnknownRecord {
  const normalized = { ...step };
  if (Object.hasOwn(step, 'run')) {
    normalized.run = normalizedRun(step);
  }
  return normalized;
}

function assertExactSteps(
  jobId: string,
  job: UnknownRecord,
  expected: readonly UnknownRecord[],
  violations: CiPolicyViolation[],
): void {
  const rawSteps = job.steps;
  const actual = Array.isArray(rawSteps) && rawSteps.every(isRecord)
    ? rawSteps.map(normalizedStep)
    : [];
  if (!isDeepStrictEqual(actual, expected)) {
    add(violations, 'step-contract', `${jobId} steps must exactly match the reviewed executable descriptors`);
  }
}

function assertJobDescriptor(
  jobId: string,
  job: UnknownRecord,
  expected: UnknownRecord,
  violations: CiPolicyViolation[],
): void {
  const actual = { ...job };
  delete actual.steps;
  if (!isDeepStrictEqual(actual, expected)) {
    add(violations, 'job-contract', `${jobId} must use the exact reviewed job controls`);
  }
}

function hasRequiredRunStep(steps: readonly UnknownRecord[], command: string): boolean {
  return steps.some(step => normalizedRun(step) === command
    && step.if === undefined
    && step.shell === undefined
    && step['continue-on-error'] === undefined);
}

function findActionStep(steps: readonly UnknownRecord[], ownerAndRepo: string): UnknownRecord | undefined {
  return steps.find(step => asString(step.uses)?.startsWith(`${ownerAndRepo}@`) === true);
}

function scalarComment(node: unknown): string | undefined {
  return isRecord(node) ? asString(node.comment)?.trim() : undefined;
}

function parseExecutableActionReference(reference: string): readonly [string, string] | undefined {
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

function assertReviewedExecutableUse(
  referenceValue: unknown,
  referenceNode: unknown,
  location: string,
  violations: CiPolicyViolation[],
): void {
  const reference = asString(referenceValue);
  if (reference === undefined) {
    add(violations, 'immutable-action', `${location} must be a static reviewed action reference`);
    return;
  }
  if (reference.startsWith('./')) {
    add(violations, 'reviewed-local-action', `${location} uses an unreviewed local action or reusable workflow`);
    return;
  }
  if (reference.startsWith('docker://')) {
    add(violations, 'reviewed-docker-action', `${location} uses an unreviewed Docker action image`);
    return;
  }
  const parsed = parseExecutableActionReference(reference);
  if (parsed === undefined || !FULL_SHA_PATTERN.test(parsed[1])) {
    add(violations, 'immutable-action', `${location} must pin an external action to a lowercase full SHA`);
    return;
  }
  const reviewedVersion = REVIEWED_EXTERNAL_ACTIONS[reference];
  if (reviewedVersion === undefined) {
    add(violations, 'reviewed-action', `${location} must use a reviewed action locator and commit`);
    return;
  }
  if (scalarComment(referenceNode) !== reviewedVersion) {
    add(violations, 'action-version-comment', `${location} must identify the reviewed ${reviewedVersion} tag`);
  }
}

function isAutoMergeCommand(command: string): boolean {
  return /\bgh\s+pr\s+merge\b/u.test(command)
    || /enablePullRequestAutoMerge/u.test(command)
    || /(?:gh\s+api|curl\b)[^\n]*\/pulls\/[^\s'"`]+\/merge\b/u.test(command);
}

function isAutoMergeAction(reference: string): boolean {
  const locator = reference.split('@', 1)[0];
  return /(?:^|[/_-])auto-?merge(?:[/_-]|$)/iu.test(locator);
}

export function evaluateDependabotConfigPolicy(source: string): CiPolicyViolation[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map(error => ({ rule: 'dependabot-yaml', message: error.message }));
  }
  let containsNonLiteralYaml = false;
  visit(document, {
    Alias: () => {
      containsNonLiteralYaml = true;
    },
    Node: (_key, node) => {
      if (isRecord(node) && typeof node.anchor === 'string') {
        containsNonLiteralYaml = true;
      }
    },
  });
  if (containsNonLiteralYaml) {
    return [{ rule: 'dependabot-yaml', message: 'Dependabot configuration must not use YAML anchors or aliases' }];
  }
  let value: unknown;
  try {
    value = document.toJS();
  }
  catch (error) {
    return [{
      rule: 'dependabot-yaml',
      message: `Dependabot configuration could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
  if (!isDeepStrictEqual(value, EXPECTED_DEPENDABOT_CONFIG)) {
    return [{
      rule: 'dependabot-contract',
      message: 'Dependabot must use the exact reviewed standalone github-actions update contract',
    }];
  }
  return [];
}

export function evaluateCodeownersPolicy(source: string): CiPolicyViolation[] {
  if (source !== EXPECTED_CODEOWNERS) {
    return [{
      rule: 'codeowners-contract',
      message: '.github must be owned exactly by @GreenTech-Solutions, including CODEOWNERS itself',
    }];
  }
  return [];
}

export function evaluateWorkflowActionPolicy(source: string): CiPolicyViolation[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map(error => ({ rule: 'yaml', message: error.message }));
  }
  let value: unknown;
  try {
    value = document.toJS();
  }
  catch (error) {
    return [{
      rule: 'yaml',
      message: `Workflow could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
  const violations: CiPolicyViolation[] = [];
  const root = asRecord(value, 'workflow', violations);
  const jobs = asRecord(root.jobs, 'jobs', violations);
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob, `jobs.${jobId}`, violations);
    if (Object.hasOwn(job, 'uses')) {
      const reference = asString(job.uses);
      if (reference !== undefined && isAutoMergeAction(reference)) {
        add(violations, 'dependabot-auto-merge', `jobs.${jobId}.uses must not enable automatic merging`);
      }
      assertReviewedExecutableUse(
        job.uses,
        document.getIn(['jobs', jobId, 'uses'], true),
        `jobs.${jobId}.uses`,
        violations,
      );
    }
    if (job.steps === undefined) {
      continue;
    }
    if (!Array.isArray(job.steps)) {
      add(violations, 'workflow-shape', `jobs.${jobId}.steps must be a sequence`);
      continue;
    }
    for (const [index, rawStep] of job.steps.entries()) {
      if (!isRecord(rawStep)) {
        add(violations, 'workflow-shape', `jobs.${jobId}.steps[${index}] must be a mapping`);
        continue;
      }
      if (Object.hasOwn(rawStep, 'uses')) {
        const reference = asString(rawStep.uses);
        if (reference !== undefined && isAutoMergeAction(reference)) {
          add(violations, 'dependabot-auto-merge', `jobs.${jobId}.steps[${index}].uses must not enable automatic merging`);
        }
        assertReviewedExecutableUse(
          rawStep.uses,
          document.getIn(['jobs', jobId, 'steps', index, 'uses'], true),
          `jobs.${jobId}.steps[${index}].uses`,
          violations,
        );
      }
      const command = normalizedRun(rawStep);
      if (command !== undefined && isAutoMergeCommand(command)) {
        add(violations, 'dependabot-auto-merge', `jobs.${jobId}.steps[${index}].run must not enable automatic merging`);
      }
    }
  }
  return violations;
}

function assertExternalActionsPinned(
  jobs: UnknownRecord,
  violations: CiPolicyViolation[],
  rejectJobPermissions = true,
): void {
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob, `jobs.${jobId}`, violations);
    if (rejectJobPermissions && job.permissions !== undefined) {
      add(violations, 'least-permissions', `${jobId} must not override workflow-level permissions`);
    }
    if (job['continue-on-error'] !== undefined || job.defaults !== undefined) {
      add(violations, 'failure-safe-job', `${jobId} must not override failure or shell defaults`);
    }
    if (isRecord(job.env) && Object.hasOwn(job.env, 'EXPECTED_SHA')) {
      add(violations, 'source-identity', `${jobId} must not override EXPECTED_SHA`);
    }
    for (const [index, step] of getSteps(job).entries()) {
      if (step['continue-on-error'] !== undefined || step.if === false || step.if === '${{ false }}') {
        add(violations, 'failure-safe-step', `${jobId} step ${index + 1} must not suppress or disable failures`);
      }
      if (isRecord(step.env) && Object.hasOwn(step.env, 'EXPECTED_SHA')) {
        add(violations, 'source-identity', `${jobId} step ${index + 1} must not override EXPECTED_SHA`);
      }
      const reference = asString(step.uses);
      if (reference === undefined || reference.startsWith('./')) {
        continue;
      }
      const match = ACTION_REFERENCE_PATTERN.exec(reference);
      if (match === null || !FULL_SHA_PATTERN.test(match[2])) {
        add(violations, 'immutable-action', `${jobId} step ${index + 1} must pin an external action to a full SHA`);
      }
      else if (CI_REVIEWED_ACTIONS[match[1]] !== match[2]) {
        add(violations, 'reviewed-action', `${jobId} step ${index + 1} must use the reviewed ${match[1]} commit`);
      }
    }
  }
}

function assertExactCheckout(jobId: string, job: UnknownRecord, violations: CiPolicyViolation[]): void {
  const steps = getSteps(job);
  const checkout = findActionStep(steps, 'actions/checkout');
  const withOptions = isRecord(checkout?.with) ? checkout.with : {};
  if (withOptions.ref !== '${{ env.EXPECTED_SHA }}' || withOptions['persist-credentials'] !== false) {
    add(violations, 'exact-checkout', `${jobId} must checkout EXPECTED_SHA with credentials disabled`);
  }
  const assertion = steps.find(step => normalizedRun(step) === 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
  if (assertion?.shell !== 'bash' || assertion.if !== undefined || assertion['continue-on-error'] !== undefined) {
    add(violations, 'exact-checkout', `${jobId} must assert the checked-out commit identity`);
  }
}

function assertSetup(jobId: string, job: UnknownRecord, violations: CiPolicyViolation[]): void {
  const steps = getSteps(job);
  const pnpmSetup = findActionStep(steps, 'pnpm/setup');
  const pnpmOptions = isRecord(pnpmSetup?.with) ? pnpmSetup.with : {};
  if (pnpmOptions.install !== false || pnpmOptions.cache !== false) {
    add(violations, 'toolchain', `${jobId} must use pnpm/setup without implicit install or duplicate cache`);
  }
  const nodeSetup = findActionStep(steps, 'actions/setup-node');
  const nodeOptions = isRecord(nodeSetup?.with) ? nodeSetup.with : {};
  if (nodeOptions['node-version-file'] !== '.nvmrc'
    || nodeOptions.cache !== 'pnpm'
    || nodeOptions['cache-dependency-path'] !== 'pnpm-lock.yaml') {
    add(violations, 'toolchain', `${jobId} must use .nvmrc and the lockfile-scoped pnpm cache`);
  }
  if (!hasRequiredRunStep(steps, 'pnpm install --frozen-lockfile')) {
    add(violations, 'frozen-install', `${jobId} must install from the frozen lockfile`);
  }
}

function assertQuality(job: UnknownRecord, violations: CiPolicyViolation[]): void {
  const steps = getSteps(job);
  if (steps.length !== 15) {
    add(violations, 'step-allowlist', 'quality must contain exactly the fifteen reviewed gate steps');
  }
  const dispatchStep = steps.find(step => step.name === 'Resolve the dispatched pull request');
  if (dispatchStep === undefined
    || !isDeepStrictEqual(normalizedStep(dispatchStep), DISPATCH_RESOLUTION_STEP)
    || steps[0] !== dispatchStep) {
    add(violations, 'dispatch-identity', 'quality must resolve and verify a dispatched pull request first');
  }
  for (const command of [
    'pnpm run audit:dependencies',
    'pnpm run audit:signatures',
    'pnpm run lint',
    'pnpm run typecheck',
    'pnpm exec tsc -p tsconfig.test.json --noEmit',
    'pnpm run ci:policy',
    'pnpm run test:unit:coverage',
    'pnpm run build',
  ]) {
    if (!hasRequiredRunStep(steps, command)) {
      add(violations, 'quality-gate', `quality must run ${command}`);
    }
  }
  const actionlint = steps.find(step => normalizedRun(step) === ACTIONLINT_COMMAND);
  if (actionlint?.shell !== 'bash' || actionlint.if !== undefined || actionlint['continue-on-error'] !== undefined) {
    add(violations, 'quality-gate', 'quality must download, authenticate and run actionlint with bash');
  }
}

function assertHostMatrix(job: UnknownRecord, violations: CiPolicyViolation[]): void {
  const strategy = asRecord(job.strategy, 'jobs.extension-host.strategy', violations);
  const matrix = asRecord(strategy.matrix, 'jobs.extension-host.strategy.matrix', violations);
  const osValues = asStringArray(matrix.os);
  const channels = asStringArray(matrix.channel);
  if (strategy['fail-fast'] !== false
    || Object.keys(matrix).sort((left, right) => left.localeCompare(right)).join(',') !== 'channel,os'
    || osValues.join(',') !== 'ubuntu-latest,windows-latest,macos-latest'
    || channels.join(',') !== 'minimum,stable') {
    add(violations, 'host-matrix', 'extension-host must cover minimum/stable on Linux, Windows and macOS without fail-fast');
  }
  const steps = getSteps(job);
  if (steps.length !== 9
    || !hasRequiredRunStep(steps, 'pnpm run build')
    || !hasRequiredRunStep(steps, 'pnpm run test:compile')) {
    add(violations, 'step-allowlist', 'extension-host must contain only the reviewed setup, build, compile and channel steps');
  }
  const hasLinuxStep = steps.some(step => normalizedRun(step) === 'xvfb-run -a pnpm exec vscode-test --label "${{ matrix.channel }}"'
    && step.if === '${{ runner.os == \'Linux\' }}');
  const hasOtherStep = steps.some(step => normalizedRun(step) === 'pnpm exec vscode-test --label "${{ matrix.channel }}"'
    && step.if === '${{ runner.os != \'Linux\' }}');
  if (!hasLinuxStep || !hasOtherStep) {
    add(violations, 'host-matrix', 'extension-host must run its selected channel and use Xvfb on Linux');
  }
}

function assertPackage(job: UnknownRecord, violations: CiPolicyViolation[]): void {
  const needs = asStringArray(job.needs);
  if (!['quality', 'extension-host'].every(dependency => needs.includes(dependency)) || job.if !== '${{ success() }}') {
    add(violations, 'failure-safe-needs', 'package must run only after successful quality and Extension Host gates');
  }
  const steps = getSteps(job);
  if (steps.length !== 9 || !hasRequiredRunStep(steps, 'pnpm run build')) {
    add(violations, 'step-allowlist', 'package must contain only the reviewed setup, build, verify, evidence and upload steps');
  }
  const outputs = asRecord(job.outputs, 'jobs.package.outputs', violations);
  if (Object.keys(outputs).length !== 2
    || outputs['artifact-id'] !== '${{ steps.upload.outputs.artifact-id }}'
    || outputs['artifact-digest'] !== '${{ steps.upload.outputs.artifact-digest }}') {
    add(violations, 'artifact-outputs', 'package must expose the immutable upload ID and archive digest');
  }
  if (!hasRequiredRunStep(steps, 'pnpm run check:vsce --out-dir "$CI_ARTIFACT_DIR" --require-clean-worktree')) {
    add(violations, 'package-policy', 'package must require a clean tracked checkout');
  }
  if (!hasRequiredRunStep(steps, 'pnpm run ci:evidence --out-dir "$CI_ARTIFACT_DIR"')) {
    add(violations, 'evidence-only', 'package must write its non-release evidence identity');
  }
  const upload = findActionStep(steps, 'actions/upload-artifact');
  const options = isRecord(upload?.with) ? upload.with : {};
  if (upload?.id !== 'upload') {
    add(violations, 'artifact-outputs', 'verified evidence upload must have the stable upload step ID');
  }
  if (options['if-no-files-found'] !== 'error' || options.overwrite !== false || options['retention-days'] !== 7) {
    add(violations, 'immutable-artifact', 'upload must fail closed, forbid overwrite and retain evidence briefly');
  }
  if (options.path !== '${{ env.CI_ARTIFACT_DIR }}/*.vsix\n${{ env.CI_ARTIFACT_DIR }}/*.vsix.manifest.txt\n${{ env.CI_ARTIFACT_DIR }}/*.vsix.sha256\n${{ env.CI_ARTIFACT_DIR }}/evidence.json\n') {
    add(violations, 'artifact-members', 'upload must contain only the verified VSIX bundle and evidence identity');
  }
}

function assertPackagedSmoke(job: UnknownRecord, violations: CiPolicyViolation[]): void {
  if (job.needs !== 'package' || job.if !== '${{ success() }}') {
    add(violations, 'failure-safe-needs', 'packaged-smoke must run only after package succeeds');
  }
  const strategy = asRecord(job.strategy, 'jobs.packaged-smoke.strategy', violations);
  const matrix = asRecord(strategy.matrix, 'jobs.packaged-smoke.strategy.matrix', violations);
  const osValues = asStringArray(matrix.os);
  const channels = asStringArray(matrix.channel);
  if (strategy['fail-fast'] !== false
    || Object.keys(matrix).sort((left, right) => left.localeCompare(right)).join(',') !== 'channel,os'
    || osValues.join(',') !== 'ubuntu-latest,windows-latest,macos-latest'
    || channels.join(',') !== 'minimum,stable') {
    add(violations, 'packaged-matrix', 'packaged activation must run minimum/stable on Linux, Windows and macOS without fail-fast');
  }
  const steps = getSteps(job);
  if (steps.length !== 9 || !hasRequiredRunStep(steps, 'pnpm run test:compile')) {
    add(violations, 'step-allowlist', 'packaged-smoke must contain only the reviewed setup, download and activation steps');
  }
  const download = findActionStep(steps, 'actions/download-artifact');
  const options = isRecord(download?.with) ? download.with : {};
  if (options['artifact-ids'] !== '${{ needs.package.outputs.artifact-id }}'
    || Object.hasOwn(options, 'name')
    || Object.hasOwn(options, 'pattern')) {
    add(violations, 'exact-artifact-id', 'packaged-smoke must download the producer artifact by exact immutable ID');
  }
  const linuxCommand = 'xvfb-run -a pnpm run test:packaged --artifact-dir "${{ env.CI_ARTIFACT_DIR }}" --expected-sha "${{ env.EXPECTED_SHA }}" --channel "${{ matrix.channel }}"';
  const otherCommand = 'pnpm run test:packaged --artifact-dir "${{ env.CI_ARTIFACT_DIR }}" --expected-sha "${{ env.EXPECTED_SHA }}" --channel "${{ matrix.channel }}"';
  if (!steps.some(step => normalizedRun(step) === linuxCommand && step.if === '${{ runner.os == \'Linux\' }}')
    || !steps.some(step => normalizedRun(step) === otherCommand && step.if === '${{ runner.os != \'Linux\' }}')) {
    add(violations, 'packaged-smoke', 'packaged-smoke must verify, install and activate the VSIX');
  }
}

function assertRequired(job: UnknownRecord, violations: CiPolicyViolation[]): void {
  const needs = asStringArray(job.needs);
  if (!['quality', 'extension-host', 'package', 'packaged-smoke'].every(dependency => needs.includes(dependency))
    || job.if !== '${{ always() }}') {
    add(violations, 'stable-required-gate', 'required must inspect every gate even after failures or skips');
  }
  const steps = getSteps(job);
  if (steps.length !== 1) {
    add(violations, 'step-allowlist', 'required must contain exactly one fail-closed result assertion');
  }
  const expectedRun = `test "$QUALITY_RESULT" = success
test "$HOST_RESULT" = success
test "$PACKAGE_RESULT" = success
test "$PACKAGED_SMOKE_RESULT" = success`;
  const resultStep = steps.find(step => normalizedRun(step) === expectedRun);
  if (resultStep?.shell !== 'bash' || resultStep.if !== undefined || resultStep['continue-on-error'] !== undefined) {
    add(violations, 'stable-required-gate', 'required result assertion must run normally and propagate failure');
  }
  const resultEnv = isRecord(resultStep?.env) ? resultStep.env : {};
  const expectedResults: Record<string, string> = {
    QUALITY_RESULT: '${{ needs.quality.result }}',
    HOST_RESULT: '${{ needs.extension-host.result }}',
    PACKAGE_RESULT: '${{ needs.package.result }}',
    PACKAGED_SMOKE_RESULT: '${{ needs.packaged-smoke.result }}',
  };
  for (const [key, value] of Object.entries(expectedResults)) {
    if (resultEnv[key] !== value) {
      add(violations, 'stable-required-gate', `required must fail closed on ${key}`);
    }
  }
}

export function evaluateCiWorkflowPolicy(source: string): CiPolicyViolation[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map(error => ({ rule: 'yaml', message: error.message }));
  }
  let value: unknown;
  try {
    value = document.toJS();
  }
  catch (error) {
    return [{
      rule: 'yaml',
      message: `Workflow could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
  const violations: CiPolicyViolation[] = [];
  const root = asRecord(value, 'workflow', violations);
  const rootKeys = Object.keys(root).sort((left, right) => left.localeCompare(right));
  if (!isDeepStrictEqual(rootKeys, ['env', 'jobs', 'name', 'on', 'permissions']) || root.name !== 'Verify') {
    add(violations, 'workflow-contract', 'workflow must contain only the reviewed Verify keys');
  }
  if (root.defaults !== undefined) {
    add(violations, 'workflow-defaults', 'workflow must not override run defaults');
  }
  const triggers = asRecord(root.on, 'on', violations);
  const push = isRecord(triggers.push) ? triggers.push : {};
  const pullRequestIsUnconfigured = triggers.pull_request === null
    || (isRecord(triggers.pull_request) && Object.keys(triggers.pull_request).length === 0);
  const pushBranches = asStringArray(push.branches);
  const dispatch = asRecord(triggers.workflow_dispatch, 'on.workflow_dispatch', violations);
  const dispatchInputs = asRecord(dispatch.inputs, 'on.workflow_dispatch.inputs', violations);
  const expectedDispatchInputs: UnknownRecord = {
    pr_number: { required: true, type: 'string' },
    head_sha: { required: true, type: 'string' },
  };
  if (Object.keys(triggers).sort((left, right) => left.localeCompare(right)).join(',') !== 'pull_request,push,workflow_dispatch'
    || !pullRequestIsUnconfigured
    || Object.keys(push).length !== 1
    || pushBranches.length !== 1
    || pushBranches[0] !== 'master'
    || Object.keys(dispatch).length !== 1
    || !isDeepStrictEqual(dispatchInputs, expectedDispatchInputs)) {
    add(violations, 'safe-trigger', 'workflow must use normal pull_request, push and a verified workflow_dispatch, never pull_request_target');
  }
  const permissions = asRecord(root.permissions, 'permissions', violations);
  if (Object.keys(permissions).length !== 2 || permissions.contents !== 'read' || permissions['pull-requests'] !== 'read') {
    add(violations, 'least-permissions', 'workflow permissions must be exactly contents: read and pull-requests: read');
  }
  const env = asRecord(root.env, 'env', violations);
  if (Object.keys(env).sort((left, right) => left.localeCompare(right)).join(',') !== 'CI_ARTIFACT_DIR,EXPECTED_SHA'
    || env.EXPECTED_SHA !== '${{ github.sha }}'
    || env.CI_ARTIFACT_DIR !== 'dist/ci') {
    add(violations, 'source-identity', 'EXPECTED_SHA must be the exact commit GitHub is testing');
  }
  const jobs = asRecord(root.jobs, 'jobs', violations);
  const expectedJobIds = ['quality', 'extension-host', 'package', 'packaged-smoke', 'required'];
  if (Object.keys(jobs).length !== expectedJobIds.length
    || !expectedJobIds.every(jobId => Object.hasOwn(jobs, jobId))) {
    add(violations, 'job-allowlist', 'workflow must contain only the five reviewed verification jobs');
  }
  assertExternalActionsPinned(jobs, violations);
  const quality = asRecord(jobs.quality, 'jobs.quality', violations);
  const extensionHost = asRecord(jobs['extension-host'], 'jobs.extension-host', violations);
  const packageJob = asRecord(jobs.package, 'jobs.package', violations);
  const packagedSmoke = asRecord(jobs['packaged-smoke'], 'jobs.packaged-smoke', violations);
  const required = asRecord(jobs.required, 'jobs.required', violations);
  assertJobDescriptor('quality', quality, {
    name: 'Quality gates',
    'runs-on': 'ubuntu-latest',
  }, violations);
  assertJobDescriptor(
    'extension-host',
    extensionHost,
    {
      if: '${{ success() }}',
      name: 'Extension Host (${{ matrix.os }}, ${{ matrix.channel }})',
      needs: 'quality',
      'runs-on': '${{ matrix.os }}',
      strategy: {
        'fail-fast': false,
        matrix: {
          channel: ['minimum', 'stable'],
          os: ['ubuntu-latest', 'windows-latest', 'macos-latest'],
        },
      },
    },
    violations,
  );
  assertJobDescriptor(
    'package',
    packageJob,
    {
      if: '${{ success() }}',
      name: 'Package verified evidence',
      needs: ['quality', 'extension-host'],
      outputs: {
        'artifact-digest': '${{ steps.upload.outputs.artifact-digest }}',
        'artifact-id': '${{ steps.upload.outputs.artifact-id }}',
      },
      'runs-on': 'ubuntu-latest',
    },
    violations,
  );
  assertJobDescriptor(
    'packaged-smoke',
    packagedSmoke,
    {
      if: '${{ success() }}',
      name: 'Packaged activation (${{ matrix.os }}, ${{ matrix.channel }})',
      needs: 'package',
      'runs-on': '${{ matrix.os }}',
      strategy: {
        'fail-fast': false,
        matrix: {
          channel: ['minimum', 'stable'],
          os: ['ubuntu-latest', 'windows-latest', 'macos-latest'],
        },
      },
    },
    violations,
  );
  assertJobDescriptor(
    'required',
    required,
    {
      if: '${{ always() }}',
      name: 'Verify / Required',
      needs: ['quality', 'extension-host', 'package', 'packaged-smoke'],
      'runs-on': 'ubuntu-latest',
    },
    violations,
  );
  assertExactSteps('quality', quality, QUALITY_STEPS, violations);
  assertExactSteps('extension-host', extensionHost, HOST_STEPS, violations);
  assertExactSteps('package', packageJob, PACKAGE_STEPS, violations);
  assertExactSteps('packaged-smoke', packagedSmoke, PACKAGED_SMOKE_STEPS, violations);
  assertExactSteps('required', required, [REQUIRED_STEP], violations);
  for (const jobId of ['quality', 'extension-host', 'package', 'packaged-smoke']) {
    const job = asRecord(jobs[jobId], `jobs.${jobId}`, violations);
    assertExactCheckout(jobId, job, violations);
    assertSetup(jobId, job, violations);
  }
  assertQuality(quality, violations);
  assertHostMatrix(extensionHost, violations);
  assertPackage(packageJob, violations);
  assertPackagedSmoke(packagedSmoke, violations);
  assertRequired(required, violations);
  return violations;
}