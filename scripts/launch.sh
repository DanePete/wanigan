#!/usr/bin/env bash
# Launch Foreman.
#
# ELECTRON_RUN_AS_NODE is unset deliberately: VS Code sets it for its extension
# host, so a Foreman started from a VS Code terminal would inherit it and die
# with "Cannot read properties of undefined (reading 'whenReady')".
set -euo pipefail
cd "$(dirname "$0")/.."

WANT="$(cat .nvmrc 2>/dev/null | tr -d 'v \n')"
if [ -n "$WANT" ] && [ -d "$HOME/.nvm/versions/node/v$WANT/bin" ]; then
  export PATH="$HOME/.nvm/versions/node/v$WANT/bin:$PATH"
fi

unset ELECTRON_RUN_AS_NODE
for v in $(env | grep -oE '^VSCODE_[A-Z_]+' || true); do unset "$v"; done

# Always build. `[ -d out ] || npm run build` looks like a cache but is a trap:
# after the first build it never rebuilds again, so every later launch silently
# runs stale code and you debug a bug you already fixed.
npm run build

NEWEST_SRC=$(find src -name '*.ts' -o -name '*.tsx' | xargs stat -f '%m' | sort -n | tail -1)
BUILT=$(stat -f '%m' out/main/index.js)
if [ "$BUILT" -lt "$NEWEST_SRC" ]; then
  echo "Refusing to launch: out/ is older than src/ after a build."
  exit 1
fi

exec npx electron . "$@"
