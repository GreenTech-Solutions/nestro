#!/usr/bin/env bash
# Verifies the downloaded release candidate bundle and its source run; usage: verify-candidate.sh dispatch|publish
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=candidate-lib.sh
source "$(dirname "$0")/candidate-lib.sh"

mode="${1:?mode is required}"
candidate="$candidate_dir/$candidate_name"
candidate_keys="$(jq -c '.candidateKeys | sort' "$release_contract")"

jq -e --argjson keys "$candidate_keys" '(keys | sort) == $keys' "$candidate" >/dev/null
test "$(jq -r '.schemaVersion' "$candidate")" = "$(contract_value '.schemaVersions.candidate')"
test "$(jq -r '.candidateRunId' "$candidate")" = "$CANDIDATE_RUN_ID"
source_sha="$(jq -r '.sourceSha' "$candidate")"
ci_run_id="$(jq -r '.ciRunId' "$candidate")"
ci_run_attempt="$(jq -r '.ciRunAttempt' "$candidate")"
version="$(jq -r '.version' "$candidate")"
vsix_file="$(jq -r '.vsixFile' "$candidate")"
require_match "$source_sha" '^[0-9a-f]{40}$' sourceSha
require_match "$ci_run_id" '^[1-9][0-9]*$' ciRunId
require_match "$ci_run_attempt" '^[1-9][0-9]*$' ciRunAttempt
require_match "$version" '^[0-9]+\.[0-9]+\.[0-9]+$' version

case "$mode" in
  dispatch)
    test "$source_sha" = "${SOURCE_SHA:?SOURCE_SHA is required}"
    ;;
  publish)
    test "$GITHUB_REF" = "refs/tags/v$version"
    test "$GITHUB_SHA" = "$source_sha"
    verify_tag_commit "v$version" "$source_sha"
    ;;
  *)
    echo "unsupported mode: $mode" >&2
    exit 1
    ;;
esac

ci_run="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$ci_run_id")"
test "$(jq -r '.name' <<<"$ci_run")" = "$(contract_value '.workflows.verifyName')"
test "$(jq -r '.event' <<<"$ci_run")" = push
test "$(jq -r '.head_branch' <<<"$ci_run")" = master
test "$(jq -r '.head_sha' <<<"$ci_run")" = "$source_sha"
test "$(jq -r '.conclusion' <<<"$ci_run")" = success
verify_bundle_files "$candidate_dir"

if [ "$mode" = publish ]; then
  jq -e --arg source "$source_sha" --arg ci "$ci_run_id" --arg attempt "$ci_run_attempt" \
    --arg vsix "$vsix_file" --argjson schema "$(contract_value '.schemaVersions.provenance')" \
    --slurpfile candidate "$candidate" '
    $candidate[0] as $c
    | .schemaVersion == $schema
    and .sourceSha == $source
    and .ciRunId == $ci
    and .ciRunAttempt == $attempt
    and .eventName == "push"
    and .artifact.file == $vsix
    and .artifact.sha256 == $c.digest
    and .artifact.manifestFile == $c.manifestFile
    and .artifact.manifestSha256 == $c.manifestSha256
    and .artifact.sbomFile == $c.sbomFile
    and .artifact.sbomSha256 == $c.sbomSha256
    and .attestation.subjectName == $vsix
    and .attestation.subjectDigest == ("sha256:" + $c.digest)
    and .attestation.signerWorkflow == .signerWorkflow' "$candidate_dir/$(jq -r '.provenanceFile' "$candidate")" >/dev/null
fi

{
  echo "source-sha=$source_sha"
  echo "tag=v$version"
  echo "version=$version"
  echo "vsix-path=$candidate_dir/$vsix_file"
} >> "$GITHUB_OUTPUT"
