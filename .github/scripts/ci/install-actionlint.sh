#!/usr/bin/env bash
# Installs the reviewed actionlint release and lints every workflow with it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
registry="$root/.github/reviewed-actions.json"
version="$(jq -er '.actionlint.version' "$registry")"
sha256="$(jq -er '.actionlint.sha256' "$registry")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]]

work="${RUNNER_TEMP:-$(mktemp -d)}"
name="actionlint_${version}_linux_amd64.tar.gz"
archive="$work/$name"
curl --fail --silent --show-error --location \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/${name}" \
  --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$work" actionlint

cd "$root"
"$work/actionlint" -color .github/workflows/*.yml
