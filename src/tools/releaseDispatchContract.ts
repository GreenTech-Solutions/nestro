import { RELEASE_CONTRACT } from './releaseContract';
import { GITHUB_TOKEN_EXPRESSION, SCRIPT_CHECKOUT_STEP, scriptRun, sh, SOURCE_RUN_ID_EXPRESSION, SOURCE_SHA_EXPRESSION } from './releaseWorkflowParts';
import type { StepContract, WorkflowContract } from './workflowContract';

const HAS_CANDIDATE = '${{ steps.artifact.outputs.has-candidate == \'true\' }}';

const RESOLVE_CANDIDATE_ARTIFACT = sh(
  'set -euo pipefail',
  'artifacts="$(gh api "repos/${{ github.repository }}/actions/runs/$CANDIDATE_RUN_ID/artifacts")"',
  `candidates="$(jq '[.artifacts[] | select((.name | startswith("${RELEASE_CONTRACT.artifactPrefixes.releaseCandidate}")) and (.expired == false))]' <<<"$artifacts")"`,
  'count="$(jq \'length\' <<<"$candidates")"',
  'if [ "$count" = 0 ]; then',
  '  echo \'has-candidate=false\' >> "$GITHUB_OUTPUT"',
  '  exit 0',
  'fi',
  'test "$count" = 1',
  'echo \'has-candidate=true\' >> "$GITHUB_OUTPUT"',
  'echo "id=$(jq -r \'.[0].id\' <<<"$candidates")" >> "$GITHUB_OUTPUT"',
);

const CREATE_SOURCE_TAG = sh(
  'set -euo pipefail',
  'verify_tag() {',
  '  tag_json="$(gh api "repos/${{ github.repository }}/git/ref/tags/$TAG")"',
  '  test "$(jq -r \'.object.type\' <<<"$tag_json")" = commit',
  '  test "$(jq -r \'.object.sha\' <<<"$tag_json")" = "$SOURCE_SHA"',
  '}',
  'if gh api "repos/${{ github.repository }}/git/ref/tags/$TAG" >/dev/null 2>&1; then',
  '  verify_tag',
  'elif ! gh api --method POST "repos/${{ github.repository }}/git/refs" \\',
  '  -f "ref=refs/tags/$TAG" -f "sha=$SOURCE_SHA"; then',
  '  verify_tag',
  'fi',
);

const DISPATCH_PUBLISH = sh(
  'set -euo pipefail',
  'gh workflow run release.yml --ref "$TAG" \\',
  '  -f "candidate_run_id=$CANDIDATE_RUN_ID" \\',
  '  -f "artifact_id=$ARTIFACT_ID"',
);

const DISPATCH_STEPS: readonly StepContract[] = [
  SCRIPT_CHECKOUT_STEP,
  { name: 'Verify the candidate workflow run', shell: 'bash', run: scriptRun('verify-run', '"$SOURCE_SHA"') },
  { name: 'Resolve the exact candidate artifact', id: 'artifact', shell: 'bash', run: RESOLVE_CANDIDATE_ARTIFACT },
  {
    name: 'Download the exact candidate artifact',
    if: HAS_CANDIDATE,
    uses: 'actions/download-artifact',
    with: {
      'artifact-ids': '${{ steps.artifact.outputs.id }}',
      'github-token': GITHUB_TOKEN_EXPRESSION,
      path: 'dist/release-candidate',
      'run-id': '${{ github.event.workflow_run.id }}',
    },
  },
  { name: 'Verify the candidate and source run', id: 'candidate', if: HAS_CANDIDATE, shell: 'bash', run: scriptRun('verify-candidate', 'dispatch') },
  {
    name: 'Create or verify the exact source tag',
    if: HAS_CANDIDATE,
    shell: 'bash',
    env: { SOURCE_SHA: '${{ steps.candidate.outputs.source-sha }}', TAG: '${{ steps.candidate.outputs.tag }}' },
    run: CREATE_SOURCE_TAG,
  },
  {
    name: 'Dispatch protected publish on the tag',
    if: HAS_CANDIDATE,
    shell: 'bash',
    env: { ARTIFACT_ID: '${{ steps.artifact.outputs.id }}', TAG: '${{ steps.candidate.outputs.tag }}' },
    run: DISPATCH_PUBLISH,
  },
];

export const RELEASE_DISPATCH_CONTRACT: WorkflowContract = {
  header: {
    name: 'Release dispatch',
    on: { workflow_run: { types: ['completed'], workflows: [RELEASE_CONTRACT.workflows.releaseCandidateName] } },
    permissions: {},
    env: { CANDIDATE_RUN_ID: SOURCE_RUN_ID_EXPRESSION, SOURCE_SHA: SOURCE_SHA_EXPRESSION },
    concurrency: { 'cancel-in-progress': false, group: 'release-dispatch' },
  },
  jobs: {
    dispatch: {
      controls: {
        name: 'Tag and dispatch the verified candidate',
        if: '${{ github.event.workflow_run.conclusion == \'success\' && github.event.workflow_run.head_branch == \'master\' }}',
        permissions: { actions: 'write', contents: 'write' },
        'runs-on': 'ubuntu-latest',
        env: { GH_REPO: '${{ github.repository }}', GH_TOKEN: GITHUB_TOKEN_EXPRESSION },
      },
      steps: DISPATCH_STEPS,
    },
  },
};