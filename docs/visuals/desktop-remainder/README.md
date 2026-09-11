# Desktop redesign: Plugins and Batches

This completes the remaining top-level desktop pages in the approved Mission Room
B direction. The shared frame and companion continue throughout the app. Plugins
and Batches now use the same typography, controls, surfaces, and motion settings
as the earlier workspace passes, with layouts suited to their different jobs.

Plugins opens on an installed library and focused inspector. Search and enablement
filters narrow the library; components open in a keyboard-accessible reader.
Catalog and Marketplaces have their own places. The inspector distinguishes local
registrations, account settings, CLI reports, missing directories, and failed reads.
Installation still requires a deliberate confirmation that names the plugin's
recorded origin and the install commands it accepts. Marketplace cancellation keeps
the source draft. Pending changes remain locked across navigation.

Batches opens on a searchable queue with progress and qualified cost figures.
Preparation has four steps—recipe, dataset, prompt, and model—with a persistent
submission review alongside. Returning to the queue keeps the draft; Discard draft
and successful submission clear it. Navigation requires fresh dataset and estimate
reads before submission. A pending submission cannot be duplicated by leaving and
returning. The dry run remains a real provider request, explicitly initiated by the
operator.

Batch detail separates results, refusals, comparison, cache observations, API
batches, activity, and configuration. Request evidence has a larger reader.
Comparison setup, judging, and golden-set management fold independently. Existing
export, retry, rescue, judge, and deletion actions remain available. Failed deletion
stays on the run; stale result and comparison reads cannot replace a newer selection.
Cache read failures remain distinct from measured zero usage.

All renderer data in these captures is fictional. The probes launch isolated
Electron windows with deterministic bridge responses. They do not submit actual
batches, install plugins, call models, export private data, or alter repositories.
The before captures use the previously staged Runs app archive.

| Workspace | Dark | Light |
| --- | --- | --- |
| Previous Plugins | [Before](before/plugins-dark.png) | [Before](before/plugins-light.png) |
| Plugin library | [After](after/plugins-dark.png) | [After](after/plugins-light.png) |
| Install review | [Consent](after/plugin-consent-dark.png) | [Consent](after/plugin-consent-light.png) |
| Marketplaces | [Sources](after/marketplaces-dark.png) | [Sources](after/marketplaces-light.png) |
| Previous Batches | [Before](before/batches-dark.png) | [Before](before/batches-light.png) |
| Batch queue | [After](after/batches-dark.png) | [After](after/batches-light.png) |
| Prepare a batch | [Start](after/batch-prepare-dark.png) | [Start](after/batch-prepare-light.png) |
| Dataset | [Dataset](after/batch-dataset-dark.png) | [Dataset](after/batch-dataset-light.png) |
| Prompt | [Prompt](after/batch-prompt-dark.png) | [Prompt](after/batch-prompt-light.png) |
| Model | [Model](after/batch-model-dark.png) | [Model](after/batch-model-light.png) |
| Cost review | [Estimate](after/batch-priced-dark.png) | [Estimate](after/batch-priced-light.png) |
| Results | [Results](after/batch-results-dark.png) | [Results](after/batch-results-light.png) |
| Request evidence | [Reader](after/batch-request-dark.png) | [Reader](after/batch-request-light.png) |
| Comparison | [Compare](after/batch-compare-dark.png) | [Compare](after/batch-compare-light.png) |
| Judge setup | [Judge](after/batch-judge-dark.png) | [Judge](after/batch-judge-light.png) |
| Refusals | [Refusals](after/batch-refusals-dark.png) | [Refusals](after/batch-refusals-light.png) |
| Cache | [Cache](after/batch-cache-dark.png) | [Cache](after/batch-cache-light.png) |

Additional captures in `after/` cover read failures, confirmed empty libraries and
queues, API batches, activity, configuration, and 960/720-pixel layouts. Motion Off
and reduced motion are respected by selection and preparation transitions. The
existing companion physics renderer is unchanged by this pass.

## Verification and build

`npm test` passed all six required steps: typecheck, **17 shared tests**, renderer
style checks, package-hook tests, local-installer fixtures, and **1,575 offline
smoke assertions**. No failures. See [test output](npm-test.log).

The [packaged renderer probe](after/verification.json) passed with no renderer
errors. It checks deliberate install consent, local/CLI provenance, reader focus,
failed actions, retained drafts, out-of-order result reads, deletion failure,
navigation during submission, empty/read-error states, and desktop widths of
1440, 960, and 720 pixels. No paid workload or real plugin installation was used.

All **13 existing workspace probes** passed in the same source snapshot:
Sessions/Changes, Fleet/Usage/Insights, Board, Review, Learning, Skills, Context,
Scout, Settings, goal planning, Runs, Schedules, and the space switcher.
[Regression results](regression/verification.json) record each exit status;
adjacent logs contain the individual checks. This pass adds one further probe for
Plugins and Batches. Existing probes use their own route-specific fixture data.

Apple silicon and Intel builds are staged at:

- `release/desktop-redesign/mac-arm64/Wanigan.app`
- `release/desktop-redesign/mac/Wanigan.app`

[Build verification](build-verification.json) confirms signatures, archive
integrity, hardened Electron fuses, and executable PTY helpers for both. The
renderer bytes match across architectures, and the companion GPU runtime is
unchanged from the preceding build. [Packaging output](package.log) records the
successful build and restoration of native modules for the host architecture.

[Source hashes](source-manifest.json) identify the isolated build. The source and
scripts match the working tree. `git diff --check` passed. No commit or push was
made. The installed app was not replaced or restarted: its live Claude child
process was still running, and a full application quit would end that process.
