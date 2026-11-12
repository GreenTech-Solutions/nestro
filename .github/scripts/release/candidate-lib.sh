# Helpers shared by the release scripts; sourced, never executed.
# shellcheck shell=bash

release_contract="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/release-contract.json"
# shellcheck disable=SC2034
candidate_dir=dist/release-candidate

contract_value() {
  jq -er "$1" "$release_contract"
}

candidate_name="$(contract_value '.bundle.candidate')"
sbom_name="$(contract_value '.bundle.sbom')"
provenance_name="$(contract_value '.bundle.provenance')"
manifest_suffix="$(contract_value '.bundle.manifestSuffix')"
digest_suffix="$(contract_value '.bundle.digestSuffix')"
vsix_extension="$(contract_value '.bundle.vsixExtension')"

# Prints the candidate bundle member file names for one VSIX file name, in contract order.
bundle_member_names() {
  local vsix_file="$1" role
  while IFS= read -r role; do
    case "$role" in
      vsix) printf '%s\n' "$vsix_file" ;;
      manifest) printf '%s%s\n' "$vsix_file" "$manifest_suffix" ;;
      digest) printf '%s%s\n' "$vsix_file" "$digest_suffix" ;;
      sbom) printf '%s\n' "$sbom_name" ;;
      provenance) printf '%s\n' "$provenance_name" ;;
      candidate) printf '%s\n' "$candidate_name" ;;
      *) echo "unsupported bundle role: $role" >&2; return 1 ;;
    esac
  done < <(contract_value '.bundle.candidateMembers[]')
}

# Exits unless the value matches the extended regex; usage: require_match <value> <pattern> <label>.
require_match() {
  [[ "$1" =~ $2 ]] || { echo "$3 is malformed" >&2; exit 1; }
}

assert_vsix_file_name() {
  require_match "$1" "^[A-Za-z0-9._-]+${vsix_extension//./\\.}\$" 'VSIX file name'
}

# Asserts that a tag resolves to the given commit; usage: verify_tag_commit <tag> <sha>.
verify_tag_commit() {
  local tag_json
  tag_json="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$1")"
  test "$(jq -r '.object.type' <<<"$tag_json")" = commit
  test "$(jq -r '.object.sha' <<<"$tag_json")" = "$2"
}

sha256_of() {
  sha256sum "$1" | cut -d ' ' -f 1
}

# Checks the downloaded bundle against its manifest: names, member set, digest and sidecar hashes.
verify_bundle_files() {
  local candidate="$1/$candidate_name"
  local vsix_file digest digest_file expected_members actual_members field
  vsix_file="$(jq -r '.vsixFile' "$candidate")"
  digest="$(jq -r '.digest' "$candidate")"
  digest_file="$(jq -r '.digestFile' "$candidate")"
  assert_vsix_file_name "$vsix_file"
  require_match "$digest" '^[0-9a-f]{64}$' digest
  test "$digest_file" = "$vsix_file$digest_suffix"
  test "$(jq -r '.manifestFile' "$candidate")" = "$vsix_file$manifest_suffix"
  test "$(jq -r '.sbomFile' "$candidate")" = "$sbom_name"
  test "$(jq -r '.provenanceFile' "$candidate")" = "$provenance_name"
  for field in manifestSha256 sbomSha256 provenanceSha256; do
    require_match "$(jq -r ".$field" "$candidate")" '^[0-9a-f]{64}$' "$field"
  done
  test "$(sha256_of "$1/$vsix_file")" = "$digest"
  expected_members="$(bundle_member_names "$vsix_file" | sort)"
  actual_members="$(find "$1" -maxdepth 1 -type f -exec basename {} \; | sort)"
  test "$actual_members" = "$expected_members"
  (cd "$1" && sha256sum --check --strict "$digest_file")
  test "$(sha256_of "$1/$vsix_file$manifest_suffix")" = "$(jq -r '.manifestSha256' "$candidate")"
  test "$(sha256_of "$1/$sbom_name")" = "$(jq -r '.sbomSha256' "$candidate")"
  test "$(sha256_of "$1/$provenance_name")" = "$(jq -r '.provenanceSha256' "$candidate")"
}
