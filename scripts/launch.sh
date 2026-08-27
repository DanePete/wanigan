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

[ -d out ] || npm run build
exec npx electron . "$@"
