# Relay routing choice screenshots

Captured 2026-09-19 from the real Electron app with an isolated, temporary user-data
directory, generic example intent, the built-in Claude Code profile, and the real
preload/IPC bridge. The routing suggester was disabled before interaction. No model
call or agent session ran. Temporary app data was removed after each run.

- `before-{dark,light}.png`: prior built renderer, captured before rebuilding.
- `after-auto-{cost,balanced,quality}-{dark,light}.png`: the three Auto preferences.
- `after-manual-{dark,light}.png`: Manual with immediately available stage fields.
- `after-manual-fields-{dark,light}.png`: model and effort entered explicitly.
- `after-manual-preview-{dark,light}.png`: actual Manual preview, including the
  exact `sonnet` model and `high` effort override and the no-suggestion-call label.

The screenshots use a 1440 × 1000 Electron window at device scale 2. Manual fields
and preview extend below the viewport, so additional scrolled captures show them.
The baseline, all preferences, Manual fields, and Manual preview were visually
inspected in the captured themes for legibility and clipping.

`interaction-evidence.json` records the 28 successful assertions from the isolated
UI run. It verifies real create/read IPC persistence for every choice, exact Manual
overrides, preview clearing, disabled-suggester defaults, no session launch, and
preference persistence across a view swap. This is interface/integration evidence;
it does not measure routing quality, realized savings, or a live JEV call.
