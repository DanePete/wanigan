# Feature page visual review

Goals, Runs, and Sessions at desktop (1440 × 1000) and compact (720 × 640) sizes, with empty and populated fictional data in both themes.

| Comparison | Before | After |
| --- | --- | --- |
| Compact Goals: selected goal gets the space; browsing is explicit | [Dark](before/control-populated-720x640-dark.png) · [Light](before/control-populated-720x640-light.png) | [Dark](after/control-populated-720x640-dark.png) · [Light](after/control-populated-720x640-light.png) |
| Empty Runs: one explanation and entry point | [Dark](before/runs-empty-1440x1000-dark.png) · [Light](before/runs-empty-1440x1000-light.png) | [Dark](after/runs-empty-1440x1000-dark.png) · [Light](after/runs-empty-1440x1000-light.png) |
| Populated Runs: named modes and visible filter count | [Dark](before/runs-populated-1440x1000-dark.png) · [Light](before/runs-populated-1440x1000-light.png) | [Dark](after/runs-populated-1440x1000-dark.png) · [Light](after/runs-populated-1440x1000-light.png) |
| Run preparation: task first, optional agent fields folded | [Dark](before/runs-compose-populated-1440x1000-dark.png) · [Light](before/runs-compose-populated-1440x1000-light.png) | [Dark](after/runs-compose-populated-1440x1000-dark.png) · [Light](after/runs-compose-populated-1440x1000-light.png) |
| Sessions: local conversation search, including settled conversations | [Dark](before/sessions-populated-1440x1000-dark.png) · [Light](before/sessions-populated-1440x1000-light.png) | [Dark](after/sessions-search-settled-1440x1000-dark.png) · [Light](after/sessions-search-settled-1440x1000-light.png) |
| Session details: expand the reader while preserving the terminal | [Dark](before/sessions-details-1440x1000-dark.png) · [Light](before/sessions-details-1440x1000-light.png) | [Dark](after/sessions-expanded-details-1440x1000-dark.png) · [Light](after/sessions-expanded-details-1440x1000-light.png) |
| Compact session reader | [Dark](before/sessions-details-720x640-dark.png) · [Light](before/sessions-details-720x640-light.png) | [Dark](after/sessions-expanded-details-720x640-dark.png) · [Light](after/sessions-expanded-details-720x640-light.png) |

The complete inventories and renderer checks are recorded in [before/verification.json](before/verification.json) and [after/verification.json](after/verification.json). The [source manifest](source-manifest.json) records the shared checkout's base commit, changed production source hashes, validation files, and built renderer hashes.

## Provenance and boundaries

The before renderer was built from an isolated archive of `ebad0f0`. The final after renderer was built from the shared working tree over `a5f71c3`, including the concurrent Relay changes. The after probe wrote to `/private/tmp/wanigan-feature-repro`; its complete successful output was copied into `after/`. The captured renderer index hash matches the subsequent shared-tree test build. Earlier partial after captures from an isolated archive have been replaced.

The [capture script](../../../scripts/capture-feature-pages.mjs) launches only a minimal Electron window, with a temporary profile and an explicit fictional preload contract. All projects, sessions, goals, run results, and changed-file text are invented and labeled. The terminal is a mounted renderer fixture; no PTY, provider, agent, goal, or run is launched. Guarded execution methods reject and fail the probe. No user database, real settings, credentials, or repository contents are read or changed.

These are renderer behavior checks. They do not establish native IPC, disk persistence, or real provider execution. The repository's complete `npm test` result is recorded in the [feature review](../../feature-pages-2026-09-19.md).

## Interaction checks

- Goals: unordered search and result counts preserve the selected goal and its note draft. Clear/filter recovery, compact goal selection, and resizing restore focus to visible controls.
- Runs: filtering preserves the selected inspector; clearing restores search focus. Task, repository, and optional-field drafts survive leaving preparation and switching through Compare attempts.
- Sessions: search finds open, recent, and settled conversations without switching the active session. Full-history search receives the query. Expanded details retain the terminal and draft across keyboard/native composer commands and resizing. Escape closes the history dialog before the compact picker.
- Read states: a delayed or failed first Runs read never claims zero runs. Resolving or retrying reaches one empty state.
- Launch controls: required options start open and still block launch when folded. Selecting all repositories requires a separate declaration, which changing the selection retires. Invalid budgets block launch; zero-budget copy, timeout, isolation, and approval controls remain explicit. Compact Goals and run preparation scroll to their final controls. No launch button is pressed.

The baseline has 34 screenshots; the after run has 52. Each visual state is captured in dark and light themes. The after report records five interaction groups, and fails on renderer errors or guarded execution requests. All captured pages fit their viewport width.

## Reproduce

Use Node from `.nvmrc` (`nvm use`), freeze the intended source snapshot and build it with `npm run build`, then run:

```sh
WANIGAN_FEATURE_CAPTURE_OUTPUT=/absolute/path/to/evidence/after \
WANIGAN_FEATURE_CAPTURE_SOURCE='Describe the frozen source snapshot' \
node scripts/capture-feature-pages.mjs after
```

Use `before` for the baseline capture. The script records the built renderer index hash, screenshot viewport and text, page errors, and interaction outcomes. Keep the source and output frozen during a run.
