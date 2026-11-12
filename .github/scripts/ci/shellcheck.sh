#!/usr/bin/env bash
# Runs shellcheck over every shell script under .github/scripts.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
test -n "$(find .github/scripts -type f -name '*.sh' -print -quit)"
find .github/scripts -type f -name '*.sh' -exec shellcheck {} +
