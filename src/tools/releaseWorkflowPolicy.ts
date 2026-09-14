import { isDeepStrictEqual } from 'node:util';
import { parseDocument, visit } from 'yaml';
import { validatePrepareReleaseConfig } from './releaseAnalyzer';

export const RELEASE_PREPARE_WORKFLOW_PATH = '.github/workflows/release-prepare.yml';
export const RELEASE_CANDIDATE_WORKFLOW_PATH = '.github/workflows/release-candidate.yml';
export const RELEASE_DISPATCH_WORKFLOW_PATH = '.github/workflows/release-dispatch.yml';
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
export const RELEASE_CONFIG_PATH = '.releaserc.json';

export interface ReleaseWorkflowPolicyViolation {
  readonly rule: string;
  readonly message: string;
}

type UnknownRecord = Record<string, unknown>;

const SOURCE_SHA_EXPRESSION = '${{ github.event.workflow_run.head_sha }}';
const SOURCE_RUN_ID_EXPRESSION = '${{ github.event.workflow_run.id }}';
const CANDIDATE_ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  download: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  node: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  pnpm: 'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2',
  upload: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
} as const;
const PUBLISH_ACTION = 'HaaLeo/publish-vscode-extension@ca5561daa085dee804bf9f37fe0165785a9b14db';
const PREPARE_TRIGGER = {
  workflow_run: {
    types: ['completed'],
    workflows: ['Verify'],
  },
} as const;
const CANDIDATE_TRIGGER = PREPARE_TRIGGER;
const DISPATCH_TRIGGER = {
  workflow_run: {
    types: ['completed'],
    workflows: ['Release candidate'],
  },
} as const;
const PUBLISH_TRIGGER = {
  workflow_dispatch: {
    inputs: {
      artifact_id: {
        description: 'Immutable release candidate artifact ID',
        required: true,
        type: 'string',
      },
      candidate_run_id: {
        description: 'Release candidate workflow run ID',
        required: true,
        type: 'string',
      },
    },
  },
} as const;
const PREPARE_RUN_FILTER = 'github.event.workflow_run.event == \'push\' && github.event.workflow_run.head_branch == \'master\' && github.event.workflow_run.conclusion == \'success\'';
const CANDIDATE_RUN_FILTER = PREPARE_RUN_FILTER;
const DISPATCH_RUN_FILTER = 'github.event.workflow_run.conclusion == \'success\' && github.event.workflow_run.head_branch == \'master\'';
const PUBLISH_RUN_FILTER = 'startsWith(github.ref, \'refs/tags/v\')';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function add(violations: ReleaseWorkflowPolicyViolation[], rule: string, message: string): void {
  violations.push({ rule, message });
}

function keys(value: UnknownRecord | undefined): string[] {
  return value === undefined ? [] : Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function exactKeys(value: UnknownRecord | undefined, expected: readonly string[]): boolean {
  return JSON.stringify(keys(value)) === JSON.stringify([...expected].sort((left, right) => left.localeCompare(right)));
}

function normalizedRun(step: UnknownRecord): string {
  return asString(step.run)?.trim().replaceAll('\r\n', '\n') ?? '';
}

function steps(job: UnknownRecord | undefined): UnknownRecord[] {
  return Array.isArray(job?.steps) ? job.steps.filter(isRecord) : [];
}

function findStep(job: UnknownRecord | undefined, name: string): UnknownRecord | undefined {
  return steps(job).find(step => step.name === name);
}

function assertStepNames(
  job: UnknownRecord | undefined,
  expected: readonly string[],
  rule: string,
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  const actual = steps(job).map(step => asString(step.name) ?? '');
  if (!isDeepStrictEqual(actual, expected)) {
    add(violations, rule, 'release jobs must contain only the reviewed executable steps in order');
  }
}

function hasRun(job: UnknownRecord | undefined, predicate: (run: string, step: UnknownRecord) => boolean): boolean {
  return steps(job).some(step => predicate(normalizedRun(step), step));
}

function hasAction(job: UnknownRecord | undefined, reference: string): UnknownRecord | undefined {
  return steps(job).find(step => step.uses === reference);
}

function hasSecretReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\bsecrets\.(?:VSCE_PAT|OVSX_PAT|VSCE_TOKEN|OPEN_VSX_TOKEN)\b/u.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasSecretReference);
  }
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) => /^(?:VSCE_PAT|OVSX_PAT|VSCE_TOKEN|OPEN_VSX_TOKEN)$/u.test(key)
      || hasSecretReference(entry));
  }
  return false;
}

function publishStepsWithSecrets(job: UnknownRecord | undefined): UnknownRecord[] {
  return steps(job).filter(hasSecretReference);
}

function parseWorkflow(source: string): { root: UnknownRecord; violations: ReleaseWorkflowPolicyViolation[] } {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return { root: {}, violations: document.errors.map(error => ({ rule: 'yaml', message: error.message })) };
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
    return {
      root: {},
      violations: [{ rule: 'yaml', message: 'release workflows must not use YAML anchors or aliases' }],
    };
  }
  try {
    const value = document.toJS();
    if (!isRecord(value)) {
      return { root: {}, violations: [{ rule: 'workflow-shape', message: 'workflow must be a mapping' }] };
    }
    return { root: value, violations: [] };
  }
  catch (error) {
    return {
      root: {},
      violations: [{
        rule: 'yaml',
        message: `release workflow could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

function assertTrigger(
  root: UnknownRecord,
  expected: Readonly<Record<string, unknown>>,
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  const trigger = asRecord(root.on);
  if (!isDeepStrictEqual(trigger, expected)) {
    add(violations, 'release-trigger', 'release workflow must consume only the reviewed completed workflow_run');
  }
}

function assertExactWorkflowRoot(
  root: UnknownRecord,
  expectedName: string,
  expectedRootKeys: readonly string[],
  violations: ReleaseWorkflowPolicyViolation[],
): void {
  if (root.name !== expectedName || !exactKeys(root, expectedRootKeys)) {
    add(violations, 'release-workflow-contract', `${expectedName} must use the exact reviewed workflow shape`);
  }
}

function assertCompletedRunIdentity(
  job: UnknownRecord | undefined,
  expectedFilter: string,
  violations: ReleaseWorkflowPolicyViolation[],
  expectedEvent = 'push',
): void {
  if (job?.if !== `\${{ ${expectedFilter} }}`) {
    add(violations, 'release-run-identity', 'release jobs must run only for a successful master verification run');
  }
  const check = steps(job).find(step => normalizedRun(step).includes('actions/runs/')
    && normalizedRun(step).includes('.head_sha')
    && normalizedRun(step).includes('.head_branch')
    && normalizedRun(step).includes('.event')
    && normalizedRun(step).includes('.conclusion'));
  if (check === undefined) {
    add(violations, 'release-run-identity', 'release jobs must re-check the completed run through the GitHub API');
    return;
  }
  const run = normalizedRun(check);
  if (!run.includes('SOURCE_SHA') || !run.includes('master') || !run.includes(expectedEvent) || !run.includes('success')) {
    add(violations, 'release-run-identity', 'release API checks must bind the exact source, branch, event and conclusion');
  }
}

function assertNoForbiddenSecrets(root: UnknownRecord, violations: ReleaseWorkflowPolicyViolation[]): void {
  if (hasSecretReference(root)) {
    add(violations, 'secret-boundary', 'preparation and candidate workflows must not reference publishing credentials');
  }
}

function assertNoMerge(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  if (hasRun(job, run => /\bgh\s+pr\s+merge\b|enablePullRequestAutoMerge|\/merge\b/u.test(run))) {
    add(violations, 'no-merge', 'preparation must create a reviewable pull request but never merge it');
  }
}

export function evaluateReleasePrepareWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release prepare', ['concurrency', 'env', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, PREPARE_TRIGGER, violations);
  if (!isDeepStrictEqual(root.permissions, { actions: 'write', contents: 'write', 'pull-requests': 'write' })) {
    add(violations, 'least-permissions', 'preparation must have only actions, contents and pull-requests write permissions');
  }
  const concurrency = asRecord(root.concurrency);
  if (!isDeepStrictEqual(concurrency, { 'cancel-in-progress': false, group: 'release-prepare' })) {
    add(violations, 'retry-safety', 'preparation must serialize retries without cancelling an active run');
  }
  const env = asRecord(root.env);
  if (env?.SOURCE_SHA !== SOURCE_SHA_EXPRESSION || env?.SOURCE_CI_RUN_ID !== SOURCE_RUN_ID_EXPRESSION
    || typeof env.RELEASE_REPOSITORY_URL !== 'string') {
    add(violations, 'source-identity', 'preparation must bind source SHA and verification run ID from workflow_run');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['prepare'])) {
    add(violations, 'job-allowlist', 'preparation must contain only the preparation job');
  }
  const job = asRecord(jobs?.prepare);
  if (job?.name !== 'Prepare the version pull request'
    || job['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(job.permissions, { actions: 'write', contents: 'write', 'pull-requests': 'write' })) {
    add(violations, 'job-contract', 'preparation must use the least scoped write-capable job');
  }
  assertCompletedRunIdentity(job, PREPARE_RUN_FILTER, violations);
  assertNoForbiddenSecrets(root, violations);
  assertNoMerge(job, violations);
  assertStepNames(job, [
    'Verify the completed verification run',
    'Checkout the exact tested commit',
    'Assert checkout identity',
    'Reject a stale master',
    'Reject competing release pull requests',
    'Prepare pnpm',
    'Setup Node.js',
    'Install frozen dependencies',
    'Analyze and prepare the next release',
    'Create the version pull request',
    'Resolve the exact version pull request',
    'Dispatch exact-head verification for the version pull request',
  ], 'step-allowlist', violations);
  const checkout = hasAction(job, CANDIDATE_ACTIONS.checkout);
  const checkoutOptions = asRecord(checkout?.with);
  if (!exactKeys(checkoutOptions, ['fetch-depth', 'persist-credentials', 'ref'])
    || checkoutOptions?.ref !== '${{ env.SOURCE_SHA }}'
    || checkoutOptions['fetch-depth'] !== 0
    || checkoutOptions['persist-credentials'] !== true) {
    add(violations, 'exact-checkout', 'preparation must checkout the verified source SHA with write credentials only for its PR branch');
  }
  if (!hasRun(job, run => run === 'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"')) {
    add(violations, 'exact-checkout', 'preparation must assert the checked-out source SHA');
  }
  if (!hasRun(job, run => run.includes('git rev-parse origin/master') && run.includes('SOURCE_SHA'))) {
    add(violations, 'stale-master', 'preparation must reject a stale master before creating a release branch');
  }
  const competing = findStep(job, 'Reject competing release pull requests');
  if (competing === undefined
    || !normalizedRun(competing).includes('gh pr list')
    || !normalizedRun(competing).includes('more than one open release pull request exists')
    || !normalizedRun(competing).includes('.parents[0].sha')
    || !normalizedRun(competing).includes('SOURCE_SHA')
    || !normalizedRun(competing).includes('$\'CHANGELOG.md\\npackage.json\'')) {
    add(violations, 'duplicate-version-pr', 'preparation must reject competing, stale or non-canonical version pull requests');
  }
  const analyze = findStep(job, 'Analyze and prepare the next release');
  if (analyze === undefined || normalizedRun(analyze) !== 'pnpm run release:prepare -- --out-dir dist/release'
    || asRecord(analyze.env)?.RELEASE_CONFIG !== RELEASE_CONFIG_PATH) {
    add(violations, 'isolated-analysis', 'preparation must use the isolated analyze-and-notes configuration');
  }
  if (!hasRun(job, run => run.includes('git add package.json CHANGELOG.md') && run.includes('git commit -m "ci(release): prepare v$version"'))) {
    add(violations, 'version-pr', 'preparation must commit only package.json and CHANGELOG.md on the version branch');
  }
  if (!hasRun(job, run => run.includes('git push origin "$branch"') && run.includes('gh pr create --base master'))) {
    add(violations, 'version-pr', 'preparation must push and open a version pull request');
  }
  const resolvePullRequest = findStep(job, 'Resolve the exact version pull request');
  const resolvePullRequestEnv = asRecord(resolvePullRequest?.env);
  if (resolvePullRequest === undefined
    || resolvePullRequestEnv?.EXISTING_HEAD_SHA !== '${{ steps.existing.outputs.head-sha }}'
    || resolvePullRequestEnv?.IS_EXISTING !== '${{ steps.existing.outputs.is-existing }}'
    || !normalizedRun(resolvePullRequest).includes('test "$head_sha" = "$EXISTING_HEAD_SHA"')) {
    add(violations, 'dispatch-identity', 'preparation must bind the final PR read to the already validated existing head SHA');
  }
  const dispatch = findStep(job, 'Dispatch exact-head verification for the version pull request');
  if (dispatch === undefined
    || !normalizedRun(dispatch).includes('gh workflow run ci.yml --ref "$PR_BRANCH"')
    || !normalizedRun(dispatch).includes('-f "pr_number=$PR_NUMBER"')
    || !normalizedRun(dispatch).includes('-f "head_sha=$PR_HEAD_SHA"')) {
    add(violations, 'dispatch-identity', 'preparation must explicitly dispatch verification for the exact PR number and head SHA');
  }
  return violations;
}

export function evaluateReleaseCandidateWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release candidate', ['env', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, CANDIDATE_TRIGGER, violations);
  if (!isRecord(root.permissions) || keys(asRecord(root.permissions)).length !== 0) {
    add(violations, 'least-permissions', 'candidate workflow must start with no write permissions');
  }
  const env = asRecord(root.env);
  if (env?.SOURCE_SHA !== SOURCE_SHA_EXPRESSION || env?.SOURCE_CI_RUN_ID !== SOURCE_RUN_ID_EXPRESSION) {
    add(violations, 'source-identity', 'candidate workflow must bind the verified source SHA and run ID');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['candidate'])) {
    add(violations, 'job-allowlist', 'candidate workflow must contain only the candidate job');
  }
  const job = asRecord(jobs?.candidate);
  if (job?.name !== 'Build the immutable release candidate'
    || job['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(job.permissions, { actions: 'read', contents: 'read' })) {
    add(violations, 'job-contract', 'candidate job must use read-only artifact and source permissions');
  }
  assertCompletedRunIdentity(job, CANDIDATE_RUN_FILTER, violations);
  assertNoForbiddenSecrets(root, violations);
  assertStepNames(job, [
    'Verify the completed verification run',
    'Checkout the exact versioned commit',
    'Assert checkout identity',
    'Prepare pnpm',
    'Setup Node.js',
    'Install frozen dependencies',
    'Download the exact verified evidence',
    'Build the candidate manifest',
    'Upload the immutable candidate',
  ], 'step-allowlist', violations);
  if (hasRun(job, run => /\bgit\s+(push|commit)|\bgh\s+pr\s+merge\b/u.test(run))) {
    add(violations, 'candidate-side-effects', 'candidate workflow must not mutate the repository or merge pull requests');
  }
  const checkout = hasAction(job, CANDIDATE_ACTIONS.checkout);
  const checkoutOptions = asRecord(checkout?.with);
  if (!exactKeys(checkoutOptions, ['fetch-depth', 'persist-credentials', 'ref'])
    || checkoutOptions?.ref !== '${{ env.SOURCE_SHA }}'
    || checkoutOptions['fetch-depth'] !== 0
    || checkoutOptions['persist-credentials'] !== false) {
    add(violations, 'exact-checkout', 'candidate must checkout only the verified source SHA without credentials');
  }
  if (!hasRun(job, run => run === 'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"')) {
    add(violations, 'exact-checkout', 'candidate must assert the checked-out source SHA');
  }
  if (!hasRun(job, run => run === 'pnpm install --frozen-lockfile')) {
    add(violations, 'frozen-install', 'candidate tooling must use the frozen lockfile');
  }
  const download = hasAction(job, CANDIDATE_ACTIONS.download);
  const downloadOptions = asRecord(download?.with);
  if (!exactKeys(downloadOptions, ['github-token', 'name', 'path', 'run-id'])
    || downloadOptions?.['run-id'] !== '${{ github.event.workflow_run.id }}'
    || downloadOptions?.name !== 'verify-evidence-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}'
    || downloadOptions?.path !== 'dist/ci') {
    add(violations, 'exact-artifact', 'candidate must download evidence from the exact completed verification run');
  }
  const buildManifest = findStep(job, 'Build the candidate manifest');
  if (buildManifest === undefined
    || normalizedRun(buildManifest) !== 'pnpm run release:candidate -- --artifact-dir dist/ci --out-dir dist/release-candidate'
    || asRecord(buildManifest.env)?.RELEASE_SOURCE_SHA !== '${{ env.SOURCE_SHA }}'
    || asRecord(buildManifest.env)?.RELEASE_CI_RUN_ID !== '${{ env.SOURCE_CI_RUN_ID }}'
    || asRecord(buildManifest.env)?.RELEASE_CANDIDATE_RUN_ID !== '${{ github.run_id }}') {
    add(violations, 'candidate-manifest', 'candidate manifest must bind source, verification run and candidate run identities');
  }
  const upload = hasAction(job, CANDIDATE_ACTIONS.upload);
  const uploadOptions = asRecord(upload?.with);
  if (!exactKeys(uploadOptions, ['if-no-files-found', 'name', 'overwrite', 'path', 'retention-days'])
    || upload?.if !== '${{ steps.candidate.outputs.is-candidate == \'true\' }}'
    || uploadOptions?.overwrite !== false
    || uploadOptions?.['retention-days'] !== 90
    || typeof uploadOptions?.name !== 'string'
    || !asString(uploadOptions.path)?.includes('candidate.json')) {
    add(violations, 'immutable-candidate', 'candidate upload must be immutable, retained and include the manifest');
  }
  if (hasRun(job, run => /\bpnpm run build\b|\btsdown\b/u.test(run))) {
    add(violations, 'single-build', 'candidate workflow must not rebuild the VSIX');
  }
  return violations;
}

export function evaluateReleaseDispatchWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release dispatch', ['concurrency', 'env', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, DISPATCH_TRIGGER, violations);
  if (!isRecord(root.permissions) || keys(asRecord(root.permissions)).length !== 0) {
    add(violations, 'least-permissions', 'dispatch workflow must start with no permissions');
  }
  const concurrency = asRecord(root.concurrency);
  if (!isDeepStrictEqual(concurrency, { 'cancel-in-progress': false, group: 'release-dispatch' })) {
    add(violations, 'retry-safety', 'dispatch must serialize retries without cancelling an active run');
  }
  const env = asRecord(root.env);
  if (env?.SOURCE_SHA !== SOURCE_SHA_EXPRESSION || env?.CANDIDATE_RUN_ID !== SOURCE_RUN_ID_EXPRESSION) {
    add(violations, 'source-identity', 'dispatch must bind the candidate source SHA and run ID from workflow_run');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['dispatch'])) {
    add(violations, 'job-allowlist', 'dispatch must contain only the release dispatch job');
  }
  const job = asRecord(jobs?.dispatch);
  const jobEnv = asRecord(job?.env);
  if (job?.name !== 'Tag and dispatch the verified candidate'
    || job['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(job.permissions, { actions: 'write', contents: 'write' })
    || !isDeepStrictEqual(jobEnv, {
      GH_REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ github.token }}',
    })) {
    add(violations, 'job-contract', 'dispatch must use the least scoped write-capable job');
  }
  assertCompletedRunIdentity(job, DISPATCH_RUN_FILTER, violations, 'workflow_run');
  assertNoForbiddenSecrets(root, violations);
  assertStepNames(job, [
    'Verify the candidate workflow run',
    'Resolve the exact candidate artifact',
    'Download the exact candidate artifact',
    'Verify the candidate and source run',
    'Create or verify the exact source tag',
    'Dispatch protected publish on the tag',
  ], 'step-allowlist', violations);
  assertNoBuildOrCheckout(job, violations);
  const artifactResolution = findStep(job, 'Resolve the exact candidate artifact');
  if (artifactResolution === undefined
    || (!normalizedRun(artifactResolution).includes('/actions/runs/${{ github.event.workflow_run.id }}/artifacts')
      && !normalizedRun(artifactResolution).includes('/actions/runs/$CANDIDATE_RUN_ID/artifacts'))
    || !normalizedRun(artifactResolution).includes('release-candidate-')
    || !normalizedRun(artifactResolution).includes('count')) {
    add(violations, 'exact-artifact', 'dispatch must resolve one candidate artifact from the exact completed candidate run');
  }
  const download = hasAction(job, CANDIDATE_ACTIONS.download);
  const downloadOptions = asRecord(download?.with);
  if (!exactKeys(downloadOptions, ['artifact-ids', 'github-token', 'path', 'run-id'])
    || downloadOptions?.['artifact-ids'] !== '${{ steps.artifact.outputs.id }}'
    || downloadOptions?.['run-id'] !== '${{ github.event.workflow_run.id }}'
    || downloadOptions?.path !== 'dist/release-candidate') {
    add(violations, 'exact-artifact', 'dispatch must download the resolved candidate by immutable artifact ID and run ID');
  }
  const verify = findStep(job, 'Verify the candidate and source run');
  if (verify === undefined
    || !normalizedRun(verify).includes('.sourceSha')
    || !normalizedRun(verify).includes('.ciRunId')
    || !normalizedRun(verify).includes('.digest')
    || !normalizedRun(verify).includes('sha256sum --check')) {
    add(violations, 'candidate-integrity', 'dispatch must verify source, candidate run, CI run and digest before tagging');
  }
  const tag = findStep(job, 'Create or verify the exact source tag');
  if (tag === undefined
    || !normalizedRun(tag).includes('git/ref/tags/')
    || !normalizedRun(tag).includes('SOURCE_SHA')
    || !normalizedRun(tag).includes('refs/tags/')) {
    add(violations, 'exact-tag', 'dispatch must create or verify the version tag at the manifest source SHA');
  }
  const releaseDispatch = findStep(job, 'Dispatch protected publish on the tag');
  if (releaseDispatch === undefined
    || !normalizedRun(releaseDispatch).includes('gh workflow run release.yml --ref "$TAG"')
    || !normalizedRun(releaseDispatch).includes('-f "candidate_run_id=$CANDIDATE_RUN_ID"')
    || !normalizedRun(releaseDispatch).includes('-f "artifact_id=$ARTIFACT_ID"')) {
    add(violations, 'dispatch-identity', 'dispatch must pass the exact candidate run and artifact IDs to release.yml on the version tag');
  }
  return violations;
}

function assertNoBuildOrCheckout(job: UnknownRecord | undefined, violations: ReleaseWorkflowPolicyViolation[]): void {
  const hasForbiddenOperation = (run: string): boolean => run.includes('actions/checkout')
    || /\b(?:pnpm|npm|yarn|bun)\s+(?:ci|install|exec|dlx)\b/u.test(run)
    || /\bnpx\b/u.test(run)
    || /\b(?:pnpm|npm|yarn|bun)\s+run\s+build\b/u.test(run)
    || run.includes('tsdown')
    || /\b(?:git\s+checkout|git\s+clone)\b/u.test(run);
  if (hasAction(job, CANDIDATE_ACTIONS.checkout) !== undefined || hasRun(job, hasForbiddenOperation)) {
    add(violations, 'publish-boundary', 'protected publish and finalizer jobs must not checkout, install or build');
  }
}

export function evaluateReleaseWorkflowPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
  const parsed = parseWorkflow(source);
  const violations = [...parsed.violations];
  if (violations.length > 0) {
    return violations;
  }
  const root = parsed.root;
  assertExactWorkflowRoot(root, 'Release', ['concurrency', 'jobs', 'name', 'on', 'permissions'], violations);
  assertTrigger(root, PUBLISH_TRIGGER, violations);
  if (!isRecord(root.permissions) || keys(asRecord(root.permissions)).length !== 0) {
    add(violations, 'least-permissions', 'release workflow must start with no permissions');
  }
  const concurrency = asRecord(root.concurrency);
  if (!isDeepStrictEqual(concurrency, { 'cancel-in-progress': false, group: 'release' })) {
    add(violations, 'protected-environment', 'release must serialize the protected release group without cancelling it');
  }
  const jobs = asRecord(root.jobs);
  if (!exactKeys(jobs, ['finalize', 'publish'])) {
    add(violations, 'job-allowlist', 'release must contain only publish and finalizer jobs');
  }
  const publish = asRecord(jobs?.publish);
  const finalize = asRecord(jobs?.finalize);
  if (publish?.name !== 'Publish the verified candidate'
    || publish?.['runs-on'] !== 'ubuntu-latest'
    || publish?.environment !== 'release'
    || !isDeepStrictEqual(publish.permissions, { actions: 'read' })) {
    add(violations, 'protected-environment', 'publish must use the release environment and actions-read permissions only');
  }
  if (publish?.if !== `\${{ ${PUBLISH_RUN_FILTER} }}`) {
    add(violations, 'release-run-identity', 'publish must require a version tag workflow dispatch');
  }
  if (finalize?.name !== 'Finalize the GitHub release'
    || finalize?.needs !== 'publish'
    || finalize?.if !== '${{ needs.publish.outputs.has-candidate == \'true\' }}'
    || finalize?.['runs-on'] !== 'ubuntu-latest'
    || !isDeepStrictEqual(finalize.permissions, { actions: 'read', contents: 'write' })
    || !isDeepStrictEqual(asRecord(finalize.env), {
      GH_REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ github.token }}',
    })) {
    add(violations, 'finalizer-boundary', 'finalizer must run only after publish and use GitHub contents write without registry credentials');
  }
  assertNoForbiddenSecrets(finalize ?? {}, violations);
  if (isRecord(publish?.env) && hasSecretReference(publish.env)) {
    add(violations, 'secret-boundary', 'publish credentials must not be inherited by the publish job');
  }
  const publishOutputs = asRecord(publish?.outputs);
  if (!isDeepStrictEqual(publishOutputs, {
    'artifact-id': '${{ steps.artifact.outputs.id }}',
    'has-candidate': '${{ steps.artifact.outputs.has-candidate }}',
  })) {
    add(violations, 'artifact-outputs', 'publish must expose only the resolved artifact ID and candidate decision');
  }
  assertStepNames(publish, [
    'Verify the candidate workflow run',
    'Resolve the exact candidate artifact',
    'Download the exact candidate artifact',
    'Verify the candidate manifest, tag and digest',
    'Publish to the Visual Studio Marketplace',
    'Publish to Open VSX',
  ], 'step-allowlist', violations);
  assertStepNames(finalize, [
    'Download the exact published candidate',
    'Verify the exact source tag',
    'Create the GitHub release if absent',
    'Verify an existing GitHub release safely',
  ], 'step-allowlist', violations);
  assertNoBuildOrCheckout(publish, violations);
  assertNoBuildOrCheckout(finalize, violations);
  if (hasRun(finalize, run => /\bgit\s+(?:push|commit)\b|git\/refs\b.*(?:POST|create)/u.test(run))) {
    add(violations, 'finalizer-boundary', 'finalizer must use the GitHub API without mutating source history or creating tags');
  }
  const dispatchIdentity = findStep(publish, 'Verify the candidate workflow run');
  const dispatchIdentityEnv = asRecord(dispatchIdentity?.env);
  if (dispatchIdentity === undefined
    || dispatchIdentityEnv?.CANDIDATE_RUN_ID !== '${{ inputs.candidate_run_id }}'
    || !normalizedRun(dispatchIdentity).includes('actions/runs/')) {
    add(violations, 'dispatch-identity', 'release must validate the exact candidate workflow run input');
  }
  const artifactResolution = findStep(publish, 'Resolve the exact candidate artifact');
  if (artifactResolution === undefined
    || !normalizedRun(artifactResolution).includes('/actions/runs/$CANDIDATE_RUN_ID/artifacts')
    || !normalizedRun(artifactResolution).includes('ARTIFACT_ID')
    || (!normalizedRun(artifactResolution).includes('count') && !normalizedRun(artifactResolution).includes('length'))) {
    add(violations, 'exact-artifact', 'release must resolve the dispatched artifact from the exact candidate workflow run');
  }
  const download = hasAction(publish, CANDIDATE_ACTIONS.download);
  const downloadOptions = asRecord(download?.with);
  if (!exactKeys(downloadOptions, ['artifact-ids', 'github-token', 'path', 'run-id'])
    || downloadOptions?.['artifact-ids'] !== '${{ steps.artifact.outputs.id }}'
    || downloadOptions?.['run-id'] !== '${{ inputs.candidate_run_id }}'
    || downloadOptions?.path !== 'dist/release-candidate') {
    add(violations, 'exact-artifact', 'release must download the dispatched artifact by immutable ID and run ID');
  }
  const verify = findStep(publish, 'Verify the candidate manifest, tag and digest');
  if (verify === undefined
    || !normalizedRun(verify).includes('.sourceSha')
    || !normalizedRun(verify).includes('.ciRunId')
    || !normalizedRun(verify).includes('.candidateRunId')
    || !normalizedRun(verify).includes('.digest')
    || !normalizedRun(verify).includes('sha256sum --check')
    || !normalizedRun(verify).includes('git/ref/tags/')
    || !normalizedRun(verify).includes('GITHUB_REF')
    || !normalizedRun(verify).includes('refs/tags/v')) {
    add(violations, 'candidate-integrity', 'release must verify source, tag, candidate run, CI run and digest before using credentials');
  }
  const marketplace = findStep(publish, 'Publish to the Visual Studio Marketplace');
  const openVsx = findStep(publish, 'Publish to Open VSX');
  if (marketplace === undefined || !exactKeys(asRecord(marketplace?.env), ['VSCE_PAT'])
    || asRecord(marketplace.env)?.VSCE_PAT !== '${{ secrets.VSCE_PAT }}'
    || openVsx === undefined || !exactKeys(asRecord(openVsx?.env), ['OVSX_PAT'])
    || asRecord(openVsx.env)?.OVSX_PAT !== '${{ secrets.OVSX_PAT }}'
    || marketplace?.uses !== PUBLISH_ACTION
    || openVsx?.uses !== PUBLISH_ACTION) {
    add(violations, 'secret-boundary', 'registry credentials must be scoped to their individual publish steps');
  }
  const marketplaceWith = asRecord(marketplace?.with);
  const openVsxWith = asRecord(openVsx?.with);
  if (!exactKeys(marketplaceWith, ['extensionFile', 'pat', 'registryUrl', 'skipDuplicate'])
    || marketplaceWith?.extensionFile !== '${{ steps.manifest.outputs.vsix-path }}'
    || marketplaceWith?.pat !== '${{ env.VSCE_PAT }}'
    || marketplaceWith?.registryUrl !== 'https://marketplace.visualstudio.com'
    || marketplaceWith?.skipDuplicate !== true
    || !exactKeys(openVsxWith, ['extensionFile', 'pat', 'registryUrl', 'skipDuplicate'])
    || openVsxWith?.extensionFile !== '${{ steps.manifest.outputs.vsix-path }}'
    || openVsxWith?.pat !== '${{ env.OVSX_PAT }}'
    || openVsxWith?.registryUrl !== 'https://open-vsx.org'
    || openVsxWith?.skipDuplicate !== true) {
    add(violations, 'publish-bytes', 'both registries must use the reviewed publisher with the same downloaded VSIX and registry URL');
  }
  if (publishStepsWithSecrets(publish).some(step => step !== marketplace && step !== openVsx)) {
    add(violations, 'secret-boundary', 'verification and artifact steps must not receive registry credentials');
  }
  const finalizerDownload = hasAction(finalize, CANDIDATE_ACTIONS.download);
  const finalizerDownloadOptions = asRecord(finalizerDownload?.with);
  if (!exactKeys(finalizerDownloadOptions, ['artifact-ids', 'github-token', 'path', 'run-id'])
    || finalizerDownloadOptions?.['artifact-ids'] !== '${{ needs.publish.outputs.artifact-id }}'
    || finalizerDownloadOptions?.['run-id'] !== '${{ inputs.candidate_run_id }}'
    || finalizerDownloadOptions?.path !== 'dist/release-candidate') {
    add(violations, 'finalizer-artifact', 'finalizer must consume the exact dispatched artifact already verified and published');
  }
  const tagVerify = findStep(finalize, 'Verify the exact source tag');
  if (tagVerify === undefined
    || !normalizedRun(tagVerify).includes('git/ref/tags/')
    || !normalizedRun(tagVerify).includes('.sourceSha')
    || !normalizedRun(tagVerify).includes('refs/tags/v')) {
    add(violations, 'finalizer-boundary', 'finalizer must verify the pre-created tag points at the candidate source SHA');
  }
  if (!hasRun(finalize, run => run.includes('gh release create') && run.includes('candidate.json') && run.includes('$VSIX_FILE'))) {
    add(violations, 'finalizer-boundary', 'finalizer must attach the same VSIX and candidate manifest to the GitHub release');
  }
  if (!hasRun(finalize, run => run.includes('already-released'))
    || !hasRun(finalize, run => run.includes('release download')
      && run.includes('release upload')
      && run.includes('cmp '))) {
    add(violations, 'retry-safety', 'finalizer must safely verify existing assets and repair a partially-created release');
  }
  return violations;
}

export function evaluateReleaseConfigPolicy(source: string): ReleaseWorkflowPolicyViolation[] {
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