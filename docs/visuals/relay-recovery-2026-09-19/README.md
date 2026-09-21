# Checkpoint restore renderer verification

Captured 2026-09-19 at 1440 × 1000, in dark and light themes. The before bundle was frozen from `out/renderer` before rebuilding this recovery change. The after bundle was built from the updated worktree. Bundle and artifact SHA-256 identities are in [artifact-hashes.json](artifact-hashes.json).

This is a **synthetic renderer fixture**, visibly labeled in every image. It launches isolated Chromium with the preload bridge stubbed. It proves presentation and renderer bridge arguments, not native IPC, Git restoration, main-process ownership, process termination, or provider integration. No provider was called and no real files were restored.

The changed renderer forwards the preview's opaque approval token as the third argument to `checkpoints.revert`. Both versions retain the same confirmation and refusal layout. The fixture supplies the same stale-preview refusal to both builds so the pictures compare rendering; the before image is not evidence that the old main process actually refused stale work. Real Git/SQLite behavior is covered separately by the checkpoint smoke tests.

| View | Before dark | After dark | Before light | After light |
| --- | --- | --- | --- | --- |
| Restore confirmation | [Image](before/checkpoint-restore-confirmation-dark.png) | [Image](after/checkpoint-restore-confirmation-dark.png) | [Image](before/checkpoint-restore-confirmation-light.png) | [Image](after/checkpoint-restore-confirmation-light.png) |
| Stale-preview refusal | [Image](before/checkpoint-restore-stale-dark.png) | [Image](after/checkpoint-restore-stale-dark.png) | [Image](before/checkpoint-restore-stale-light.png) | [Image](after/checkpoint-restore-stale-light.png) |

The [before receipt](before/verification.json) and [after receipt](after/verification.json) each contain three passing assertions and zero probe errors. The before renderer supplied two restore arguments; the after renderer supplied the exact token as the third. Both displayed the synthetic refusal and removed the consumed approval button. Headless Chromium lacked a WebGPU adapter, so the existing orb fallback was recorded as an environment note.

Visual inspection found readable action lists, restore/cancel controls, and stale-preview feedback in both themes, with no clipped checkpoint content at the tested viewport. This change adds no layout or CSS rules.

Reproduce against a newly frozen baseline and rebuilt renderer:

```sh
source ~/.nvm/nvm.sh
nvm use
WANIGAN_RENDERER_ROOT=/absolute/path/to/frozen/renderer node scripts/probe-checkpoint-restore.mjs --before
npm run build
node scripts/probe-checkpoint-restore.mjs
```
