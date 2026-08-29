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

# Use the installed Electron directly. `npx electron` inherits npm's own
# lifecycle environment when this script is itself run by `npm test`, which can
# make Electron exit before main initializes (and before the smoke log exists).
# Keep stdout/stderr attached: on macOS, Electron can abort during bootstrap
# when both descriptors are redirected by this nested npm lifecycle.
./node_modules/.bin/electron . --user-data-dir="$UDD"
CODE=$?

# Electron prints the results while attached. On an early failure, the log can
# still contain the only useful diagnostic.
if [ "$CODE" -ne 0 ] && [ -s "$LOG" ]; then
  cat "$LOG"
fi
rm -rf "$UDD" "$LOG"
exit $CODE
