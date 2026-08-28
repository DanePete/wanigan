#!/usr/bin/env bash
# Full batch lifecycle against the mock runner, inside the real Electron main
# process. No network, no spend. Run after any change to the batch pipeline.
set -uo pipefail
cd "$(dirname "$0")/.."

WANT="$(cat .nvmrc 2>/dev/null | tr -d 'v \n')"
if [ -n "$WANT" ] && [ -d "$HOME/.nvm/versions/node/v$WANT/bin" ]; then
  export PATH="$HOME/.nvm/versions/node/v$WANT/bin:$PATH"
fi
unset ELECTRON_RUN_AS_NODE
for v in $(env | grep -oE '^VSCODE_[A-Z_]+' || true); do unset "$v"; done

LOG="$(mktemp)"
UDD="$(mktemp -d)"
export WANIGAN_SMOKE=1 WANIGAN_MOCK=1 WANIGAN_MOCK_DELAY_MS=1000
export WANIGAN_SMOKE_LOG="$LOG"

npm run build >/dev/null 2>&1 || { echo "build failed"; npm run build; exit 1; }

# A .app bundle's stdout is not wired to this shell — results come back via $LOG.
npx electron . --user-data-dir="$UDD" >/dev/null 2>&1
CODE=$?

cat "$LOG"
rm -rf "$UDD" "$LOG"
exit $CODE
