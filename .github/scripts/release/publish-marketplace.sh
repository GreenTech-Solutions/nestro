#!/usr/bin/env bash
# Publishes the verified VSIX to the Visual Studio Marketplace through GitHub OIDC trusted publishing.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=candidate-lib.sh
source "$(dirname "$0")/candidate-lib.sh"

tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/publish-tool"

assert_vsix_file_name "$(basename "$VSIX_PATH")"
test -f "$VSIX_PATH"
test ! -L "$VSIX_PATH"

: "${ACTIONS_ID_TOKEN_REQUEST_URL:?the job must grant id-token: write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?the job must grant id-token: write}"

pinned_version="$(jq -er '.dependencies["@vscode/vsce"]' "$tool_dir/package.json")"
installed_version="$(jq -er '.version' "$tool_dir/node_modules/@vscode/vsce/package.json")"
require_match "$pinned_version" '^[0-9]+\.[0-9]+\.[0-9]+$' 'pinned vsce version'
test "$installed_version" = "$pinned_version"

"$tool_dir/node_modules/.bin/vsce" publish --oidc --packagePath "$VSIX_PATH" --skip-duplicate
