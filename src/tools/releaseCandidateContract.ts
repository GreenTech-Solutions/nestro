import { bundleUploadPaths, RELEASE_CONTRACT } from './releaseContract';
import { ASSERT_CHECKOUT_STEP, CANDIDATE_DIRECTORY, GITHUB_TOKEN_EXPRESSION, MASTER_PUSH_SUCCESS_FILTER, SOURCE_RUN_ID_EXPRESSION, SOURCE_SHA_EXPRESSION, toolchainSteps, verifyCompletedRunStep } from './releaseWorkflowParts';
import type { StepContract, WorkflowContract } from './workflowContract';

const CANDIDATE_STEPS: readonly StepContract[] = [
  verifyCompletedRunStep({ GH_TOKEN: GITHUB_TOKEN_EXPRESSION }),
  {
    name: 'Checkout the exact versioned commit',
    uses: 'actions/checkout',
    with: { 'fetch-depth': 0, 'persist-credentials': false, ref: '${{ env.SOURCE_SHA }}' },
  },
  ASSERT_CHECKOUT_STEP,
  ...toolchainSteps(),
  {
    name: 'Download the exact verified evidence',
    uses: 'actions/download-artifact',
    with: {
      'github-token': GITHUB_TOKEN_EXPRESSION,
      name: `${RELEASE_CONTRACT.artifactPrefixes.verifyEvidence}\${{ github.event.workflow_run.id }}-\${{ github.event.workflow_run.run_attempt }}`,
      path: 'dist/ci',
      'run-id': '${{ github.event.workflow_run.id }}',
    },
  },
  {
    name: 'Build the candidate manifest',
    id: 'candidate',
    env: {
      RELEASE_CANDIDATE_RUN_ID: '${{ github.run_id }}',
      RELEASE_CI_RUN_ID: '${{ env.SOURCE_CI_RUN_ID }}',
      RELEASE_REPOSITORY: '${{ github.repository }}',
      RELEASE_SOURCE_SHA: '${{ env.SOURCE_SHA }}',
      RELEASE_SIGNER_WORKFLOW: `\${{ github.repository }}/${RELEASE_CONTRACT.workflows.signerPath}`,
    },
    run: 'pnpm run release:candidate --artifact-dir dist/ci --out-dir dist/release-candidate',
  },
  {
    name: 'Upload the immutable candidate',
    if: '${{ steps.candidate.outputs.is-candidate == \'true\' }}',
    uses: 'actions/upload-artifact',
    with: {
      'if-no-files-found': 'error',
      name: '${{ steps.candidate.outputs.artifact-name }}',
      overwrite: false,
      path: bundleUploadPaths('candidate', CANDIDATE_DIRECTORY),
      'retention-days': 90,
    },
  },
];

export const RELEASE_CANDIDATE_CONTRACT: WorkflowContract = {
  header: {
    name: RELEASE_CONTRACT.workflows.releaseCandidateName,
    on: { workflow_run: { types: ['completed'], workflows: [RELEASE_CONTRACT.workflows.verifyName] } },
    permissions: {},
    env: { SOURCE_SHA: SOURCE_SHA_EXPRESSION, SOURCE_CI_RUN_ID: SOURCE_RUN_ID_EXPRESSION },
  },
  jobs: {
    candidate: {
      controls: {
        name: 'Build the immutable release candidate',
        if: MASTER_PUSH_SUCCESS_FILTER,
        permissions: { actions: 'read', contents: 'read' },
        'runs-on': 'ubuntu-latest',
        outputs: {
          'artifact-name': '${{ steps.candidate.outputs.artifact-name }}',
          'is-candidate': '${{ steps.candidate.outputs.is-candidate }}',
          version: '${{ steps.candidate.outputs.version }}',
        },
      },
      steps: CANDIDATE_STEPS,
    },
  },
};