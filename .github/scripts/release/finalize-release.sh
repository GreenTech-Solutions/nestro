#!/usr/bin/env bash
# Finalizes the GitHub release from the published candidate; usage: finalize-release.sh verify|create|reconcile
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=candidate-lib.sh
source "$(dirname "$0")/candidate-lib.sh"

verify_source() {
  local candidate="$candidate_dir/$candidate_name" version source_sha vsix_file
  version="$(jq -r '.version' "$candidate")"
  source_sha="$(jq -r '.sourceSha' "$candidate")"
  vsix_file="$(jq -r '.vsixFile' "$candidate")"
  test "$GITHUB_REF" = "refs/tags/v$version"
  verify_tag_commit "v$version" "$source_sha"
  verify_bundle_files "$candidate_dir"
  jq -r '.notes' "$candidate" > "$candidate_dir/notes.md"
  {
    echo "tag=v$version"
    echo "vsix-file=$vsix_file"
  } >> "$GITHUB_OUTPUT"
}

# shellcheck disable=SC2153
create_release() {
  local -a assets=()
  local name
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo 'already-released=true' >> "$GITHUB_OUTPUT"
    return 0
  fi
  while IFS= read -r name; do
    assets+=("$candidate_dir/$name")
  done < <(bundle_member_names "$VSIX_FILE")
  gh release create "$TAG" "${assets[@]}" \
    --notes-file "$candidate_dir/notes.md" \
    --title "$TAG" \
    --verify-tag
  echo 'already-released=false' >> "$GITHUB_OUTPUT"
}

# shellcheck disable=SC2153
reconcile_release() {
  local release expected_names unexpected_names asset_names name
  release="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG")"
  test "$(jq -r '.tag_name' <<<"$release")" = "$TAG"
  mkdir -p dist/existing-release
  expected_names="$(bundle_member_names "$VSIX_FILE" | sort)"
  unexpected_names="$(jq -r '.assets[].name' <<<"$release" | sort | comm -23 - <(printf '%s\n' "$expected_names"))"
  test -z "$unexpected_names"
  while IFS= read -r name; do
    if jq -e --arg name "$name" '.assets[] | select(.name == $name)' <<<"$release" >/dev/null; then
      gh release download "$TAG" --dir dist/existing-release --pattern "$name"
      cmp "$candidate_dir/$name" "dist/existing-release/$name"
    else
      gh release upload "$TAG" "$candidate_dir/$name"
    fi
  done <<<"$expected_names"
  release="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG")"
  asset_names="$(jq -r '.assets[].name' <<<"$release" | sort)"
  test "$asset_names" = "$expected_names"
}

assert_release_inputs() {
  require_match "$TAG" '^v[0-9]+\.[0-9]+\.[0-9]+$' tag
  assert_vsix_file_name "$VSIX_FILE"
}

case "${1:?command is required}" in
  verify)
    verify_source
    ;;
  create)
    assert_release_inputs
    create_release
    ;;
  reconcile)
    assert_release_inputs
    reconcile_release
    ;;
  *)
    echo "unsupported command: $1" >&2
    exit 1
    ;;
esac
