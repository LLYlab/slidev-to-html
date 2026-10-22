#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required: https://nodejs.org/ (22.12 or newer)" >&2
  exit 1
fi
exec node tools/setup.mjs "$@"
