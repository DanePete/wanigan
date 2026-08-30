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
#
# Electron 44 on macOS can defer app.ready indefinitely when a nested test
# runner gives it only pipes. `script` supplies a small local pseudo-terminal;
# it preserves the child exit status and keeps this real-Electron smoke test
# deterministic both in CI and from an interactive shell. Other platforms use
# the direct invocation they already supported.
if [ "$(uname -s)" = "Darwin" ] && command -v script >/dev/null 2>&1; then
  # Keep the launch boundary explicit as well as unsetting it above. Some
  # editor/Codex hosts export this development flag for every child they start;
  # Electron interprets it before Wanigan can report a useful smoke failure.
  env -u ELECTRON_RUN_AS_NODE script -q /dev/null ./node_modules/.bin/electron . --user-data-dir="$UDD"
else
  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --user-data-dir="$UDD"
fi
CODE=$?

# Electron prints the results while attached. On an early failure, the log can
# still contain the only useful diagnostic.
if [ "$CODE" -ne 0 ] && [ -s "$LOG" ]; then
  cat "$LOG"
fi
rm -rf "$UDD" "$LOG"
exit $CODE
