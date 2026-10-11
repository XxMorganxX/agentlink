#!/usr/bin/env bash
# One static binary per target. Bun is only a compiler here: the package has no
# runtime dependencies and the user's machine needs neither Node nor Bun.
set -euo pipefail
cd "$(dirname "$0")/.."
targets="${*:-bun-darwin-arm64 bun-darwin-x64}"
mkdir -p dist
for target in $targets; do
  out="dist/agentlink-${target#bun-}"
  bun build --compile --target="$target" src/bin.ts --outfile "$out"
  echo "built $out"
done
