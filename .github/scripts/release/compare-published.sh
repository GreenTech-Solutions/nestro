#!/usr/bin/env bash
# Downloads both registry copies of the candidate VSIX and compares them with compare-published.py.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=candidate-lib.sh
source "$(dirname "$0")/candidate-lib.sh"

compare_script="$(dirname "$0")/compare-published.py"
published_dir=dist/published

# Prints the download URL of the candidate in one contract registry; usage: registry_url <registry>.
registry_url() {
  local url
  url="$(contract_value ".registries.$1 | .url + .downloadPath")"
  url="${url//\{publisher\}/$publisher}"
  url="${url//\{name\}/$name}"
  printf '%s\n' "${url//\{version\}/$VERSION}"
}

package_json="$(unzip -p "$CANDIDATE_VSIX" extension/package.json)"
publisher="$(jq -er '.publisher' <<<"$package_json")"
name="$(jq -er '.name' <<<"$package_json")"
require_match "$publisher" '^[A-Za-z0-9._-]+$' publisher
require_match "$name" '^[a-z0-9][a-z0-9-]*$' name
require_match "$VERSION" '^[0-9]+\.[0-9]+\.[0-9]+$' version

max_bytes="$(python3 -I "$compare_script" budget)"
mkdir -p "$published_dir"
curl_args=(
  --fail --silent --show-error --location --compressed
  --proto '=https' --proto-redir '=https' --max-redirs 3
  --connect-timeout 10 --max-time 120 --max-filesize "$max_bytes"
  --retry 45 --retry-delay 20 --retry-all-errors --retry-max-time 900
)
curl "${curl_args[@]}" "$(registry_url marketplace)" --output "$published_dir/marketplace.vsix"
curl "${curl_args[@]}" "$(registry_url openVsx)" --output "$published_dir/openvsx.vsix"
test "$(wc -c < "$published_dir/marketplace.vsix")" -le "$max_bytes"
test "$(wc -c < "$published_dir/openvsx.vsix")" -le "$max_bytes"
python3 -I "$compare_script" compare "$CANDIDATE_VSIX" "$published_dir/marketplace.vsix" "$published_dir/openvsx.vsix"
