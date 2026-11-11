import { RELEASE_CONTRACT_PATH } from './releaseContract';
import type { StepContract } from './workflowContract';

export const SOURCE_SHA_EXPRESSION = '${{ github.event.workflow_run.head_sha }}';
export const SOURCE_RUN_ID_EXPRESSION = '${{ github.event.workflow_run.id }}';
export const MASTER_PUSH_SUCCESS_FILTER = '${{ github.event.workflow_run.event == \'push\' && github.event.workflow_run.head_branch == \'master\' && github.event.workflow_run.conclusion == \'success\' }}';
export const GITHUB_TOKEN_EXPRESSION = '${{ github.token }}';
export const CANDIDATE_DIRECTORY = 'dist/release-candidate';

const SCRIPT_DIRECTORY = 'reviewed-source/.github/scripts/release';

/** Joins the lines of one inline shell step. */
export function sh(...lines: string[]): string {
  return lines.join('\n');
}

export function scriptRun(script: string, argument?: string): string {
  return `bash ${SCRIPT_DIRECTORY}/${script}.sh${argument === undefined ? '' : ` ${argument}`}`;
}

/** The first step of every job that runs reviewed release scripts. */
export const SCRIPT_CHECKOUT_STEP: StepContract = {
  name: 'Check out the reviewed scripts',
  uses: 'actions/checkout',
  with: {
    'fetch-depth': 1,
    path: 'reviewed-source',
    'persist-credentials': false,
    ref: '${{ github.sha }}',
    'sparse-checkout': `.github/scripts\n${RELEASE_CONTRACT_PATH}\n`,
    'sparse-checkout-cone-mode': false,
  },
};

export const ASSERT_CHECKOUT_STEP: StepContract = {
  name: 'Assert checkout identity',
  shell: 'bash',
  run: 'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
};

/** Re-reads the completed verification run through the GitHub API; `env` adds step-level variables. */
export function verifyCompletedRunStep(env: Readonly<Record<string, string>> = {}): StepContract {
  return {
    name: 'Verify the completed verification run',
    shell: 'bash',
    env: { ...env, SOURCE_SHA: '${{ env.SOURCE_SHA }}', SOURCE_CI_RUN_ID: '${{ env.SOURCE_CI_RUN_ID }}' },
    run: sh(
      'set -euo pipefail',
      'run_json="$(gh api "repos/${{ github.repository }}/actions/runs/$SOURCE_CI_RUN_ID")"',
      'test "$(jq -r \'.head_sha\' <<<"$run_json")" = "$SOURCE_SHA"',
      'test "$(jq -r \'.head_branch\' <<<"$run_json")" = master',
      'test "$(jq -r \'.event\' <<<"$run_json")" = push',
      'test "$(jq -r \'.conclusion\' <<<"$run_json")" = success',
    ),
  };
}

/** pnpm, Node.js and the frozen install; `condition` guards each step when given. */
export function toolchainSteps(condition?: string): StepContract[] {
  const guard = condition === undefined ? {} : { if: condition };
  return [
    { name: 'Prepare pnpm', ...guard, uses: 'pnpm/setup', with: { cache: false, install: false, 'node-version-file': false } },
    {
      name: 'Setup Node.js',
      ...guard,
      uses: 'actions/setup-node',
      with: { cache: 'pnpm', 'cache-dependency-path': 'pnpm-lock.yaml', 'node-version-file': '.nvmrc' },
    },
    { name: 'Install frozen dependencies', ...guard, run: 'pnpm install --frozen-lockfile' },
  ];
}