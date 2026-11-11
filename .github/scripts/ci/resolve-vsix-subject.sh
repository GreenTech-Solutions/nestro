#!/usr/bin/env bash
# Publishes the single packaged VSIX path as the attestation subject step output.
set -euo pipefail

mapfile -t subjects < <(find "$CI_ARTIFACT_DIR" -maxdepth 1 -type f -name '*.vsix' -print)
test "${#subjects[@]}" = 1
case "${subjects[0]}" in
  "$CI_ARTIFACT_DIR"/*.vsix) ;;
  *) echo 'VSIX subject escaped the artifact directory' >&2; exit 1 ;;
esac
printf 'path=%s\n' "${subjects[0]}" >> "$GITHUB_OUTPUT"
