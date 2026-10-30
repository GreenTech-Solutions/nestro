#!/usr/bin/env bash
# Verifies the completed release candidate workflow run; usage: verify-run.sh [expected-head-sha]
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=candidate-lib.sh
source "$(dirname "$0")/candidate-lib.sh"

require_match "$CANDIDATE_RUN_ID" '^[1-9][0-9]*$' 'candidate run ID'
run_json="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$CANDIDATE_RUN_ID")"
test "$(jq -r '.id | tostring' <<<"$run_json")" = "$CANDIDATE_RUN_ID"
test "$(jq -r '.name' <<<"$run_json")" = "$(contract_value '.workflows.releaseCandidateName')"
test "$(jq -r '.event' <<<"$run_json")" = workflow_run
test "$(jq -r '.head_branch' <<<"$run_json")" = master
test "$(jq -r '.conclusion' <<<"$run_json")" = success
if [ "$#" -gt 0 ]; then
  require_match "$1" '^[0-9a-f]{40}$' 'expected head SHA'
  test "$(jq -r '.head_sha' <<<"$run_json")" = "$1"
fi
