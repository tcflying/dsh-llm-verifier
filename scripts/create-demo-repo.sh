#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <destination-directory>" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
DESTINATION=$1
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SOURCE_DIR=$(cd -- "$SCRIPT_DIR/../examples/retry-demo" && pwd)

if [[ -e "$DESTINATION" ]]; then
  echo "Destination already exists: $DESTINATION" >&2
  exit 1
fi

mkdir -p -- "$DESTINATION"
cp -R -- "$SOURCE_DIR"/. "$DESTINATION"/

git -C "$DESTINATION" init --initial-branch=main >/dev/null
git -C "$DESTINATION" config user.name "dsh-llm-verifier demo"
git -C "$DESTINATION" config user.email "demo@example.invalid"
git -C "$DESTINATION" add -- README.md package.json src/retry.js test/retry.test.js
git -C "$DESTINATION" commit -m "test: add reproducible retry defect" >/dev/null

printf 'Created clean demo repository: %s\n' "$DESTINATION"
printf 'Baseline command (expected to fail): cd %q && npm test\n' "$DESTINATION"
