import { bundleUploadPaths, RELEASE_CONTRACT } from './releaseContract';
import type { StepContract, WorkflowContract } from './workflowContract';

const CI_SCRIPT_DIRECTORY = '.github/scripts/ci';
const EXPECTED_SHA_EXPRESSION = '${{ env.EXPECTED_SHA }}';
const LINUX_ONLY = '${{ runner.os == \'Linux\' }}';
const NOT_LINUX = '${{ runner.os != \'Linux\' }}';
const PACKAGED_SMOKE_ARGS = 'test:packaged --artifact-dir "${{ env.CI_ARTIFACT_DIR }}" --expected-sha "${{ env.EXPECTED_SHA }}" --channel "${{ matrix.channel }}"';

function scriptRun(script: string): string {
  return `bash ${CI_SCRIPT_DIRECTORY}/${script}`;
}

const SETUP_STEPS: readonly StepContract[] = [
  {
    name: 'Checkout exact tested commit',
    uses: 'actions/checkout',
    with: { ref: EXPECTED_SHA_EXPRESSION, 'persist-credentials': false },
  },
  { name: 'Assert checkout identity', shell: 'bash', run: 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"' },
  {
    name: 'Prepare pnpm',
    uses: 'pnpm/setup',
    with: { cache: false, install: false, 'node-version-file': false },
  },
  {
    name: 'Setup Node.js',
    uses: 'actions/setup-node',
    with: { cache: 'pnpm', 'cache-dependency-path': 'pnpm-lock.yaml', 'node-version-file': '.nvmrc' },
  },
  { name: 'Install frozen dependencies', run: 'pnpm install --frozen-lockfile' },
];

const MATRIX_STRATEGY = {
  'fail-fast': false,
  matrix: {
    channel: ['minimum', 'stable'],
    os: ['ubuntu-latest', 'windows-latest', 'macos-latest'],
  },
};

const DISPATCH_STEP: StepContract = {
  name: 'Resolve the dispatched pull request',
  if: '${{ github.event_name == \'workflow_dispatch\' }}',
  shell: 'bash',
  env: {
    GH_TOKEN: '${{ github.token }}',
    DISPATCH_PR_NUMBER: '${{ inputs.pr_number }}',
    DISPATCH_HEAD_SHA: '${{ inputs.head_sha }}',
  },
  // Stays inline: it must validate the dispatched head before any code from that commit is checked out.
  run: 'set -euo pipefail\n[[ "$DISPATCH_PR_NUMBER" =~ ^[0-9]+$ ]]\npr="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$DISPATCH_PR_NUMBER")"\ntest "$(echo "$pr" | jq -r \'.head.sha\')" = "$DISPATCH_HEAD_SHA"\ntest "$DISPATCH_HEAD_SHA" = "$EXPECTED_SHA"\ntest "$(echo "$pr" | jq -r \'.state\')" = "open"\ntest "$(echo "$pr" | jq -r \'.base.ref\')" = "master"',
};

const QUALITY_STEPS: readonly StepContract[] = [
  DISPATCH_STEP,
  ...SETUP_STEPS,
  { name: 'Audit dependencies', run: 'pnpm run audit:dependencies' },
  { name: 'Audit dependency signatures', run: 'pnpm run audit:signatures' },
  { name: 'Strict lint', run: 'pnpm run lint' },
  { name: 'Production typecheck', run: 'pnpm run typecheck' },
  { name: 'Test typecheck', run: 'pnpm exec tsc -p tsconfig.test.json --noEmit' },
  { name: 'Validate workflow syntax', shell: 'bash', run: scriptRun('install-actionlint.sh') },
  { name: 'Lint CI shell scripts', shell: 'bash', run: scriptRun('shellcheck.sh') },
  { name: 'Workflow policy', run: 'pnpm run ci:policy' },
  { name: 'Unit coverage', run: 'pnpm run test:unit:coverage' },
  { name: 'Build', run: 'pnpm run build' },
];

const HOST_STEPS: readonly StepContract[] = [
  ...SETUP_STEPS,
  { name: 'Build extension', run: 'pnpm run build' },
  { name: 'Compile integration tests', run: 'pnpm run test:compile' },
  { name: 'Run Extension Host on Linux', if: LINUX_ONLY, run: 'xvfb-run -a pnpm exec vscode-test --label "${{ matrix.channel }}"' },
  { name: 'Run Extension Host', if: NOT_LINUX, run: 'pnpm exec vscode-test --label "${{ matrix.channel }}"' },
];

const PACKAGE_STEPS: readonly StepContract[] = [
  ...SETUP_STEPS,
  { name: 'Build', run: 'pnpm run build' },
  { name: 'Package and verify VSIX', run: 'pnpm run check:vsce --out-dir "$CI_ARTIFACT_DIR" --require-clean-worktree' },
  {
    name: 'Write evidence-only identity',
    env: {
      CI_EVENT_NAME: '${{ github.event_name }}',
      CI_PR_HEAD_SHA: '${{ github.event_name == \'workflow_dispatch\' && inputs.head_sha || github.event.pull_request.head.sha }}',
      CI_RUN_ATTEMPT: '${{ github.run_attempt }}',
      CI_RUN_ID: '${{ github.run_id }}',
      CI_SOURCE_SHA: EXPECTED_SHA_EXPRESSION,
    },
    run: 'pnpm run ci:evidence --out-dir "$CI_ARTIFACT_DIR"',
  },
  {
    name: 'Write deterministic provenance bundle',
    env: {
      PROVENANCE_CI_RUN_ATTEMPT: '${{ github.run_attempt }}',
      PROVENANCE_CI_RUN_ID: '${{ github.run_id }}',
      PROVENANCE_EVENT_NAME: '${{ github.event_name }}',
      PROVENANCE_REPOSITORY: '${{ github.repository }}',
      PROVENANCE_SIGNER_WORKFLOW: `\${{ github.repository }}/${RELEASE_CONTRACT.workflows.signerPath}`,
      PROVENANCE_SOURCE_SHA: EXPECTED_SHA_EXPRESSION,
    },
    run: 'pnpm run release:provenance --artifact-dir "$CI_ARTIFACT_DIR"',
  },
  { name: 'Resolve the exact VSIX attestation subject', id: 'subject', shell: 'bash', run: scriptRun('resolve-vsix-subject.sh') },
  {
    name: 'Attest the exact VSIX subject',
    if: '${{ github.event_name == \'push\' && github.ref == \'refs/heads/master\' }}',
    uses: 'actions/attest-build-provenance',
    with: { 'subject-path': '${{ steps.subject.outputs.path }}' },
  },
  {
    name: 'Upload immutable evidence',
    id: 'upload',
    uses: 'actions/upload-artifact',
    with: {
      'if-no-files-found': 'error',
      name: `${RELEASE_CONTRACT.artifactPrefixes.verifyEvidence}\${{ github.run_id }}-\${{ github.run_attempt }}`,
      overwrite: false,
      path: bundleUploadPaths('verify', '${{ env.CI_ARTIFACT_DIR }}'),
      'retention-days': 7,
    },
  },
];

const PACKAGED_SMOKE_STEPS: readonly StepContract[] = [
  ...SETUP_STEPS,
  { name: 'Compile packaged smoke runner', run: 'pnpm run test:compile' },
  {
    name: 'Download exact immutable evidence',
    uses: 'actions/download-artifact',
    with: { 'artifact-ids': '${{ needs.package.outputs.artifact-id }}', path: '${{ env.CI_ARTIFACT_DIR }}' },
  },
  { name: 'Verify, install and activate packaged VSIX on Linux', if: LINUX_ONLY, run: `xvfb-run -a pnpm run ${PACKAGED_SMOKE_ARGS}` },
  { name: 'Verify, install and activate packaged VSIX', if: NOT_LINUX, run: `pnpm run ${PACKAGED_SMOKE_ARGS}` },
];

// Stays inline: four one-line assertions are the gate itself.
const REQUIRED_STEP: StepContract = {
  name: 'Reject failed or skipped gates',
  env: {
    HOST_RESULT: '${{ needs.extension-host.result }}',
    PACKAGED_SMOKE_RESULT: '${{ needs.packaged-smoke.result }}',
    PACKAGE_RESULT: '${{ needs.package.result }}',
    QUALITY_RESULT: '${{ needs.quality.result }}',
  },
  shell: 'bash',
  run: 'test "$QUALITY_RESULT" = success\ntest "$HOST_RESULT" = success\ntest "$PACKAGE_RESULT" = success\ntest "$PACKAGED_SMOKE_RESULT" = success',
};

export const CI_WORKFLOW_CONTRACT: WorkflowContract = {
  header: {
    name: RELEASE_CONTRACT.workflows.verifyName,
    on: {
      pull_request: null,
      push: { branches: ['master'] },
      workflow_dispatch: {
        inputs: {
          head_sha: { required: true, type: 'string' },
          pr_number: { required: true, type: 'string' },
        },
      },
    },
    permissions: { contents: 'read', 'pull-requests': 'read' },
    env: { CI_ARTIFACT_DIR: 'dist/ci', EXPECTED_SHA: '${{ github.sha }}' },
  },
  jobs: {
    quality: {
      controls: { name: 'Quality gates', 'runs-on': 'ubuntu-latest' },
      steps: QUALITY_STEPS,
    },
    'extension-host': {
      controls: {
        if: '${{ success() }}',
        name: 'Extension Host (${{ matrix.os }}, ${{ matrix.channel }})',
        needs: 'quality',
        'runs-on': '${{ matrix.os }}',
        strategy: MATRIX_STRATEGY,
      },
      steps: HOST_STEPS,
    },
    package: {
      controls: {
        if: '${{ success() }}',
        name: 'Package verified evidence',
        needs: ['quality', 'extension-host'],
        outputs: {
          'artifact-digest': '${{ steps.upload.outputs.artifact-digest }}',
          'artifact-id': '${{ steps.upload.outputs.artifact-id }}',
        },
        permissions: { attestations: 'write', contents: 'read', 'id-token': 'write' },
        'runs-on': 'ubuntu-latest',
      },
      steps: PACKAGE_STEPS,
    },
    'packaged-smoke': {
      controls: {
        if: '${{ success() }}',
        name: 'Packaged activation (${{ matrix.os }}, ${{ matrix.channel }})',
        needs: 'package',
        'runs-on': '${{ matrix.os }}',
        strategy: MATRIX_STRATEGY,
      },
      steps: PACKAGED_SMOKE_STEPS,
    },
    required: {
      controls: {
        if: '${{ always() }}',
        name: 'Verify / Required',
        needs: ['quality', 'extension-host', 'package', 'packaged-smoke'],
        'runs-on': 'ubuntu-latest',
      },
      steps: [REQUIRED_STEP],
    },
  },
};