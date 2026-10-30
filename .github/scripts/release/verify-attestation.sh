#!/usr/bin/env bash
# Verifies the GitHub attestation of the candidate VSIX against the signer workflow and source commit.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=candidate-lib.sh
source "$(dirname "$0")/candidate-lib.sh"

require_match "$SOURCE_SHA" '^[0-9a-f]{40}$' 'source SHA'
gh attestation verify "$VSIX_PATH" \
  --repo "$GITHUB_REPOSITORY" \
  --signer-workflow "$GITHUB_REPOSITORY/$(contract_value '.workflows.signerPath')" \
  --source-ref refs/heads/master \
  --source-digest "$SOURCE_SHA"
