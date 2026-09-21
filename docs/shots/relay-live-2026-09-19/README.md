# Relay live-trial UI evidence — 2026-09-19

These screenshots record the actual before and after workspace builds for two Relay-authored UI changes: simpler model-choice wording and direct human decisions on a ready review, with an optional review agent. The screenshots do not establish model authorship, cost, quality, or accepted outcomes; the separate live-trial records carry that evidence.

## Captures

Each folder contains six screenshots at 1440 × 1000 pixels:

- `fixture-review-ready-dark.png` and `fixture-review-ready-light.png`: ready review before and after the new human decision buttons.
- `electron-composer-dark.png` and `electron-composer-light.png`: automatic model choice.
- `electron-composer-manual-dark.png` and `electron-composer-manual-light.png`: manual model choice. The longer form continues below the captured viewport using the application’s scroll area.

The before build had the earlier renderer. The after build also contains the separately in-flight **Prompt improvement** work, visible as **Improve prompt** in the composer. That control and its PromptField integration were preserved concurrent changes, not authored by these two Relay trials. Its operation was not tested by this probe.

## Provenance and limits

Review screenshots run the built production renderer in Chromium with deliberately synthetic RelayRead records and intercepted preload replies. The regression checks establish visible controls, disabled states, and the exact renderer API calls. They do not test real main-process state transitions, verification trust, persistence, or agent execution.

Composer screenshots run real Electron main/preload IPC in a freshly created temporary user-data directory, with `WANIGAN_MOCK=1` provider discovery. The probe adds this repository’s project path to the isolated database, edits the form, and captures images. It does not preview or create a Relay, start a provider, call a model, or use the live operator’s profile. The temporary profile is deleted after capture.

`verification.json` preserves each original run’s full result and SHA-256 renderer manifest. The manifests list additional state screenshots from the full temporary verification run; only the six affected views per run are archived here. Frozen renderer bundles and the remaining screenshots stay in `/private/tmp/wanigan-live-relay-ui-{before,after}/` and are not committed as evidence assets.

`runner.mjs.txt` preserves the exact executed script bytes for each run, verified against that report’s `runnerSha256`. The text extension marks this as an immutable audit attachment rather than repository executable source. Copy it to a temporary `.mjs` file to run it. The before and after runners differ only in an after-only assertion for the optional agent button’s temporary busy label. They retain their original local repository path as execution provenance. The runner uses `scripts/renderer-harness.mjs`, `scripts/electron-harness.mjs`, and the existing Relay fixture from `scripts/probe-relay-workspace.mjs`; it is an audit artifact, not a portable test-suite entry point.

## Results

Both runs passed with no renderer errors. The after run checks all three ready-review decisions dispatch `control.complete` without starting an agent; optional review dispatches `control.start` with the recorded route; pending saves and failed refreshes disable decisions; running review keeps its existing choices; and blocked, pending, failed, canceled, queued, checking, rejected, and changes-requested states expose no new decision or launch bypass. Composer checks confirm the plain-language labels and unchanged manual preview payload.

Ready and running review, plus automatic and manual composer, were visually inspected in both themes. These results concern the UI only. Main-process checks and real trial cost/acceptance evidence must be assessed separately.

## Reproduction on the recorded workspace

Use Node 22.23.2 from `.nvmrc`. The harness needs Chromium process launch and localhost binding. It creates its own isolated Electron profile and makes no model call.

```sh
source "$HOME/.nvm/nvm.sh" && nvm use
node /private/tmp/wanigan-live-relay-ui-check.mjs --phase after --out /private/tmp/wanigan-live-relay-ui-after --agent-label 'Start review agent (optional)' --composer
```

Omitting `--renderer` freezes the current `out/renderer` in the output directory before checking it. Pass `--renderer /private/tmp/wanigan-live-relay-ui-before/renderer --phase before` to replay the earlier DOM fixture build. Electron composer capture uses the current `out/main/index.js` and its current renderer, so recreating the earlier Electron composer requires its earlier complete application build; the frozen renderer alone is sufficient only for the synthetic DOM checks.
