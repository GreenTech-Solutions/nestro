import { RELEASE_CONTRACT } from './releaseContract';
import { ASSERT_CHECKOUT_STEP, MASTER_PUSH_SUCCESS_FILTER, sh, SOURCE_RUN_ID_EXPRESSION, SOURCE_SHA_EXPRESSION, toolchainSteps, verifyCompletedRunStep } from './releaseWorkflowParts';
import type { StepContract, WorkflowContract } from './workflowContract';

const WRITE_PERMISSIONS = { actions: 'write', contents: 'write', 'pull-requests': 'write' };
const NEW_RELEASE = '${{ steps.existing.outputs.is-existing == \'false\' }}';
const VERSION_PR_EXISTS = '${{ steps.existing.outputs.is-existing == \'true\' || steps.prepare.outputs.release-needed == \'true\' }}';

const REJECT_STALE_MASTER = sh(
  'set -euo pipefail',
  'git fetch origin master --quiet',
  'test "$(git rev-parse origin/master)" = "$SOURCE_SHA"',
);

const REJECT_COMPETING_PULL_REQUESTS = sh(
  'set -euo pipefail',
  'releases="$(gh pr list --state open --base master --json number,headRefName,headRefOid,baseRefName)"',
  'count="$(jq \'[.[] | select(.headRefName | test("^release/v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$"))] | length\' <<<"$releases")"',
  'if [ "$count" -gt 1 ]; then',
  '  echo \'more than one open release pull request exists\' >&2',
  '  exit 1',
  'fi',
  'if [ "$count" = 1 ]; then',
  '  release="$(jq \'[.[] | select(.headRefName | test("^release/v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$"))][0]\' <<<"$releases")"',
  '  test "$(jq -r \'.baseRefName\' <<<"$release")" = master',
  '  number="$(jq -r \'.number\' <<<"$release")"',
  '  head_sha="$(jq -r \'.headRefOid\' <<<"$release")"',
  '  commit="$(gh api "repos/${{ github.repository }}/git/commits/$head_sha")"',
  '  test "$(jq \'.parents | length\' <<<"$commit")" = 1',
  '  if [ "$(jq -r \'.parents[0].sha\' <<<"$commit")" != "$SOURCE_SHA" ]; then',
  '    echo \'existing release pull request is stale relative to the verified master SHA\' >&2',
  '    exit 1',
  '  fi',
  '  changed_files="$(gh api --paginate "repos/${{ github.repository }}/pulls/$number/files" --jq \'.[].filename\' | sort)"',
  '  test "$changed_files" = $\'CHANGELOG.md\\npackage.json\'',
  '  {',
  '    echo \'is-existing=true\'',
  '    echo "number=$number"',
  '    echo "branch=$(jq -r \'.headRefName\' <<<"$release")"',
  '    echo "head-sha=$head_sha"',
  '  } >> "$GITHUB_OUTPUT"',
  'else',
  '  echo \'is-existing=false\' >> "$GITHUB_OUTPUT"',
  'fi',
);

const CREATE_VERSION_PULL_REQUEST = sh(
  'set -euo pipefail',
  'version="${{ steps.prepare.outputs.version }}"',
  'branch="release/v$version"',
  'git checkout -b "$branch"',
  'git config user.name \'github-actions[bot]\'',
  'git config user.email \'github-actions[bot]@users.noreply.github.com\'',
  'git add package.json CHANGELOG.md',
  'git commit -m "ci(release): prepare v$version"',
  'git push origin "$branch"',
  'gh pr create --base master --head "$branch" \\',
  '  --title "ci(release): prepare v$version" \\',
  '  --body-file dist/release/notes.md',
);

const RESOLVE_VERSION_PULL_REQUEST = sh(
  'set -euo pipefail',
  'if [ "$IS_EXISTING" = true ]; then',
  '  number="${{ steps.existing.outputs.number }}"',
  '  branch="${{ steps.existing.outputs.branch }}"',
  'else',
  '  branch="release/v${{ steps.prepare.outputs.version }}"',
  '  number="$(gh pr list --state open --base master --head "$branch" --json number --jq \'.[0].number\')"',
  'fi',
  'test -n "$number"',
  'pr="$(gh api "repos/${{ github.repository }}/pulls/$number")"',
  'test "$(jq -r \'.state\' <<<"$pr")" = open',
  'test "$(jq -r \'.base.ref\' <<<"$pr")" = master',
  'test "$(jq -r \'.head.ref\' <<<"$pr")" = "$branch"',
  'head_sha="$(jq -r \'.head.sha\' <<<"$pr")"',
  'test "$head_sha" != null',
  'if [ "$IS_EXISTING" = true ]; then',
  '  test "$head_sha" = "$EXISTING_HEAD_SHA"',
  'fi',
  '{',
  '  echo "number=$number"',
  '  echo "branch=$branch"',
  '  echo "head-sha=$head_sha"',
  '} >> "$GITHUB_OUTPUT"',
);

const DISPATCH_VERIFICATION = sh(
  'set -euo pipefail',
  'gh workflow run ci.yml --ref "$PR_BRANCH" \\',
  '  -f "pr_number=$PR_NUMBER" \\',
  '  -f "head_sha=$PR_HEAD_SHA"',
);

const PREPARE_STEPS: readonly StepContract[] = [
  verifyCompletedRunStep(),
  {
    name: 'Checkout the exact tested commit',
    uses: 'actions/checkout',
    with: { 'fetch-depth': 0, 'persist-credentials': true, ref: '${{ env.SOURCE_SHA }}' },
  },
  ASSERT_CHECKOUT_STEP,
  { name: 'Reject a stale master', shell: 'bash', run: REJECT_STALE_MASTER },
  { name: 'Reject competing release pull requests', id: 'existing', shell: 'bash', run: REJECT_COMPETING_PULL_REQUESTS },
  ...toolchainSteps(NEW_RELEASE),
  { name: 'Analyze and prepare the next release', if: NEW_RELEASE, id: 'prepare', run: 'pnpm run release:prepare --out-dir dist/release' },
  {
    name: 'Create the version pull request',
    if: '${{ steps.existing.outputs.is-existing == \'false\' && steps.prepare.outputs.release-needed == \'true\' }}',
    shell: 'bash',
    run: CREATE_VERSION_PULL_REQUEST,
  },
  {
    name: 'Resolve the exact version pull request',
    id: 'pull-request',
    if: VERSION_PR_EXISTS,
    shell: 'bash',
    env: {
      EXISTING_HEAD_SHA: '${{ steps.existing.outputs.head-sha }}',
      IS_EXISTING: '${{ steps.existing.outputs.is-existing }}',
    },
    run: RESOLVE_VERSION_PULL_REQUEST,
  },
  {
    name: 'Dispatch exact-head verification for the version pull request',
    if: VERSION_PR_EXISTS,
    shell: 'bash',
    env: {
      PR_NUMBER: '${{ steps.pull-request.outputs.number }}',
      PR_HEAD_SHA: '${{ steps.pull-request.outputs.head-sha }}',
      PR_BRANCH: '${{ steps.pull-request.outputs.branch }}',
    },
    run: DISPATCH_VERIFICATION,
  },
];

export const RELEASE_PREPARE_CONTRACT: WorkflowContract = {
  header: {
    name: 'Release prepare',
    on: { workflow_run: { types: ['completed'], workflows: [RELEASE_CONTRACT.workflows.verifyName] } },
    permissions: WRITE_PERMISSIONS,
    concurrency: { 'cancel-in-progress': false, group: 'release-prepare' },
    env: {
      SOURCE_SHA: SOURCE_SHA_EXPRESSION,
      SOURCE_CI_RUN_ID: SOURCE_RUN_ID_EXPRESSION,
      RELEASE_REPOSITORY_URL: 'https://github.com/${{ github.repository }}',
    },
  },
  jobs: {
    prepare: {
      controls: {
        name: 'Prepare the version pull request',
        if: MASTER_PUSH_SUCCESS_FILTER,
        permissions: WRITE_PERMISSIONS,
        'runs-on': 'ubuntu-latest',
        env: { GH_TOKEN: '${{ github.token }}' },
      },
      steps: PREPARE_STEPS,
    },
  },
};