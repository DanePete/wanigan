#!/usr/bin/env bash
# Foreman's headless CLI.
#
# It runs the app binary with --cli and no window, because better-sqlite3 is
# compiled against Electron's V8 ABI — a plain `node` script loading it fails
# with ERR_DLOPEN_FAILED. See the header of src/main/cli.ts.
#
#   npm run cli -- runs
#   npm run cli -- status run_20260827_181500_a1b2
set -uo pipefail
cd "$(dirname "$0")/.."

WANT="$(cat .nvmrc 2>/dev/null | tr -d 'v \n')"
if [ -n "$WANT" ] && [ -d "$HOME/.nvm/versions/node/v$WANT/bin" ]; then
  export PATH="$HOME/.nvm/versions/node/v$WANT/bin:$PATH"
fi

# Same reason as scripts/launch.sh: VS Code sets ELECTRON_RUN_AS_NODE for its
# extension host, and an Electron app that inherits it gets a path string back
# from require('electron') and dies before it reaches any of our code.
unset ELECTRON_RUN_AS_NODE
for v in $(env | grep -oE '^VSCODE_[A-Z_]+' || true); do unset "$v"; done

# Build only when out/ is actually behind src/. This may run every few minutes
# from cron, where an unconditional rebuild would cost more than the poll it is
# there to do — but a plain `[ -d out ]` check is the trap the launcher warns
# about, because after the first build it never rebuilds again and every later
# run silently executes stale code.
STALE=''
if [ -f out/main/index.js ]; then
  STALE=$(find src \( -name '*.ts' -o -name '*.tsx' \) -newer out/main/index.js -print | head -1)
fi
if [ ! -f out/main/index.js ] || [ -n "$STALE" ]; then
  npm run build >/dev/null || { echo "build failed" >&2; npm run build; exit 1; }
fi

# Everything after --cli is the user's command line; Electron's own switches
# sit in front of it and are ignored by the parser in src/main/cli.ts.
exec npx electron . --cli "$@"
