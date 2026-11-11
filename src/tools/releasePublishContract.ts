import { RELEASE_CONTRACT } from './releaseContract';
import { CANDIDATE_DIRECTORY, GITHUB_TOKEN_EXPRESSION, SCRIPT_CHECKOUT_STEP, scriptRun, sh } from './releaseWorkflowParts';
import type { StepContract, WorkflowContract } from './workflowContract';

const { marketplace: MARKETPLACE_SECRET, openVsx: OPEN_VSX_SECRET } = RELEASE_CONTRACT.secrets;
const CANDIDATE_RUN_INPUT = '${{ inputs.candidate_run_id }}';
const MANIFEST_VSIX_PATH = '${{ steps.manifest.outputs.vsix-path }}';
const FINALIZE_RELEASE_INPUTS = { TAG: '${{ steps.release.outputs.tag }}', VSIX_FILE: '${{ steps.release.outputs.vsix-file }}' };

/** Publish steps that may receive registry credentials, keyed by `job/step`. */
export const RELEASE_SECRET_STEPS: ReadonlySet<string> = new Set([
  'publish/Publish to the Visual Studio Marketplace',
  'publish/Publish to Open VSX',
]);

const RESOLVE_CANDIDATE_ARTIFACT = sh(
  'set -euo pipefail',
  '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]',
  'artifacts="$(gh api "repos/${{ github.repository }}/actions/runs/$CANDIDATE_RUN_ID/artifacts")"',
  `candidates="$(jq --argjson id "$ARTIFACT_ID" '[.artifacts[] | select(.id == $id and (.name | startswith("${RELEASE_CONTRACT.artifactPrefixes.releaseCandidate}")) and (.expired == false))]' <<<"$artifacts")"`,
  'count="$(jq \'length\' <<<"$candidates")"',
  'test "$count" = 1',
  'echo \'has-candidate=true\' >> "$GITHUB_OUTPUT"',
  'echo "id=$ARTIFACT_ID" >> "$GITHUB_OUTPUT"',
);

function publishStep(name: string, secret: string, registryUrl: string): StepContract {
  return {
    name,
    uses: 'HaaLeo/publish-vscode-extension',
    env: { [secret]: `\${{ secrets.${secret} }}` },
    with: { extensionFile: MANIFEST_VSIX_PATH, pat: `\${{ env.${secret} }}`, registryUrl, skipDuplicate: true },
  };
}

const PUBLISH_STEPS: readonly StepContract[] = [
  SCRIPT_CHECKOUT_STEP,
  {
    name: 'Verify the candidate workflow run',
    shell: 'bash',
    env: { CANDIDATE_RUN_ID: CANDIDATE_RUN_INPUT, GH_TOKEN: GITHUB_TOKEN_EXPRESSION },
    run: scriptRun('verify-run'),
  },
  {
    name: 'Resolve the exact candidate artifact',
    id: 'artifact',
    shell: 'bash',
    env: { ARTIFACT_ID: '${{ inputs.artifact_id }}', CANDIDATE_RUN_ID: CANDIDATE_RUN_INPUT, GH_TOKEN: GITHUB_TOKEN_EXPRESSION },
    run: RESOLVE_CANDIDATE_ARTIFACT,
  },
  {
    name: 'Download the exact candidate artifact',
    uses: 'actions/download-artifact',
    with: {
      'artifact-ids': '${{ steps.artifact.outputs.id }}',
      'github-token': GITHUB_TOKEN_EXPRESSION,
      path: CANDIDATE_DIRECTORY,
      'run-id': CANDIDATE_RUN_INPUT,
    },
  },
  {
    name: 'Verify the candidate manifest, tag and digest',
    id: 'manifest',
    shell: 'bash',
    env: { CANDIDATE_RUN_ID: CANDIDATE_RUN_INPUT, GH_TOKEN: GITHUB_TOKEN_EXPRESSION },
    run: scriptRun('verify-candidate', 'publish'),
  },
  {
    name: 'Verify protected candidate attestation',
    shell: 'bash',
    env: { GH_TOKEN: GITHUB_TOKEN_EXPRESSION, VSIX_PATH: MANIFEST_VSIX_PATH, SOURCE_SHA: '${{ steps.manifest.outputs.source-sha }}' },
    run: scriptRun('verify-attestation'),
  },
  publishStep('Publish to the Visual Studio Marketplace', MARKETPLACE_SECRET, RELEASE_CONTRACT.registries.marketplace.url),
  publishStep('Publish to Open VSX', OPEN_VSX_SECRET, RELEASE_CONTRACT.registries.openVsx.url),
  {
    name: 'Compare post-publish registry copies',
    shell: 'bash',
    env: { CANDIDATE_VSIX: MANIFEST_VSIX_PATH, VERSION: '${{ steps.manifest.outputs.version }}' },
    run: scriptRun('compare-published'),
  },
];

const FINALIZE_STEPS: readonly StepContract[] = [
  SCRIPT_CHECKOUT_STEP,
  {
    name: 'Download the exact published candidate',
    uses: 'actions/download-artifact',
    with: {
      'artifact-ids': '${{ needs.publish.outputs.artifact-id }}',
      'github-token': GITHUB_TOKEN_EXPRESSION,
      path: CANDIDATE_DIRECTORY,
      'run-id': CANDIDATE_RUN_INPUT,
    },
  },
  { name: 'Verify the exact source tag', id: 'release', shell: 'bash', run: scriptRun('finalize-release', 'verify') },
  { name: 'Create the GitHub release if absent', id: 'create', shell: 'bash', env: FINALIZE_RELEASE_INPUTS, run: scriptRun('finalize-release', 'create') },
  {
    name: 'Verify an existing GitHub release safely',
    if: '${{ steps.create.outputs.already-released == \'true\' }}',
    shell: 'bash',
    env: FINALIZE_RELEASE_INPUTS,
    run: scriptRun('finalize-release', 'reconcile'),
  },
];

export const RELEASE_PUBLISH_CONTRACT: WorkflowContract = {
  header: {
    name: 'Release',
    on: {
      workflow_dispatch: {
        inputs: {
          artifact_id: { description: 'Immutable release candidate artifact ID', required: true, type: 'string' },
          candidate_run_id: { description: 'Release candidate workflow run ID', required: true, type: 'string' },
        },
      },
    },
    permissions: {},
    concurrency: { 'cancel-in-progress': false, group: 'release' },
  },
  jobs: {
    publish: {
      controls: {
        name: 'Publish the verified candidate',
        if: '${{ startsWith(github.ref, \'refs/tags/v\') }}',
        environment: 'release',
        permissions: { actions: 'read', attestations: 'read', contents: 'read' },
        'runs-on': 'ubuntu-latest',
        outputs: {
          'artifact-id': '${{ steps.artifact.outputs.id }}',
          'has-candidate': '${{ steps.artifact.outputs.has-candidate }}',
        },
      },
      steps: PUBLISH_STEPS,
    },
    finalize: {
      controls: {
        name: 'Finalize the GitHub release',
        needs: 'publish',
        if: '${{ needs.publish.outputs.has-candidate == \'true\' }}',
        permissions: { actions: 'read', contents: 'write' },
        'runs-on': 'ubuntu-latest',
        env: { GH_REPO: '${{ github.repository }}', GH_TOKEN: GITHUB_TOKEN_EXPRESSION },
      },
      steps: FINALIZE_STEPS,
    },
  },
};