# Demo privacy preparation

The target is a public demonstration of Wanigan with fictional information.
This change prepares the app for future LinkedIn screenshots and water-physics
video. It does not produce marketing assets or certify Wanigan as 1.0 ready.

## Findings in the previous mode

The old IPC wrapper ran real handlers, then replaced known project names,
home paths, email addresses and previously observed git authors. This left
several paths for personal information to reach the screen:

| Surface | Gap |
| --- | --- |
| Initial mode toggle | Masking was decided before the handler enabled it; the state response included the real-to-fake path map. A synthetic canary reproduces this. |
| Free text and metrics | Prompts, summaries, diffs, branch names, account labels, URLs, counts, costs and timings were still based on real work. Replacing a known name could not make them fictional. |
| Push events | Session lists, terminal bytes, hook events and alerts did not pass through the response wrapper. |
| Browser storage | Composer drafts and saved view state survived in the real window's storage. |
| Terminal display | Optional blur was a presentation effect over real terminal content. |
| Actions | Reverse mapping deliberately routed fake paths back to real repositories. Demo operations could still mutate real work or incur usage. |
| Native UI | Desktop notifications and the quit confirmation could reveal background session details. |
| Existing screenshot helpers | `scripts/shots.mjs` runs the normal app and seeds the checkout's actual path. A disposable database alone does not prevent host account discovery. Its output is QA material, not automatically safe marketing material. |

## New boundary

Each window has a fixed source for its lifetime. Main creates a demo window
with an in-memory Chromium session and its own authored sample workspace.
The live window uses the normal storage partition. Switching hides and replaces
the old window; it does not shut down existing agent processes.

`demo-workspace.ts` has no database, home-directory, filesystem, credential,
provider-discovery or network reader. A demo IPC request either receives an
authored response or a fixed refusal. It never falls through to a live handler.
Theme, motion and destination-list preferences are local to that sample
workspace. Terminal write and resize messages are refused at main's boundary.
There is no reverse mapping and no real/fake path map.

Operational producers receive no live renderer during the demo. Preload also
suppresses operational event subscriptions using a flag fixed by main when the
window is created. Only native visibility and menu navigation events remain.
This additional check protects against a future producer accidentally sending
straight to the demo window.

Desktop notifications are suppressed and currently held Notification objects
are closed. Quit confirmation retains its warning that real work will stop,
without naming or counting that work in the demo. A demo-only launch skips
account discovery and background services. Entering demo from an active workspace
leaves existing agents and background work running.

The legacy `demo_mode` preference now selects the fictional workspace. The old
blur preference may remain in the database but no longer controls privacy.
Canonical project, session and learning records are not rewritten or seeded with
sample records.

## Coverage and remaining work

| Surface | Current preparation |
| --- | --- |
| Mission | Three fictional projects, two example session states; the actual GPU orb and play controls. Companion model calls are disabled. |
| Sessions | Fictional session metadata and an explicitly labelled sample terminal transcript. No live PTY. |
| Fleet | Matching fictional sessions, attention and usage, including an unavailable-cost example. |
| Usage | Authored account identities, limits and chart data. No account refresh occurs. |
| Settings | Demo explanation, return control, demo-only theme selection and a dropdown of authored demo prompts with preview and copy. |
| Other destinations | Explicit preparation notice. They do not load real records. |

Before a full product walkthrough, add coherent fixtures for the particular
remaining surfaces to be shown: Git, Control, Learning, batches and the rest.
Keep the fixed refusal for unimplemented calls. Controls that are read-only
could gain more tailored disabled states as those demonstrations are authored.
Do not use the sample usage figures or session states as evidence of product
performance or a provider capability.

Settings → App → Demo mode also lists five preparation prompts: cart repair,
checkout accessibility, checkout documentation, session attention and account
headroom. Each names its intended coding-agent project or companion context.
Choosing a prompt only changes the preview; copying passes an allowed prompt ID
through typed IPC, and the main process writes only its authored text to the
clipboard. Browser clipboard permissions remain denied. Live demo AI and
disposable sample repositories are still being prepared. The same prompt picker
is available inside demo Settings.

The boundary covers Wanigan's demo window and new Wanigan desktop alerts.
It does not redact the operating system, other apps, previously retained OS
notification history, or separately enabled phone alerts. Returning to the real
workspace intentionally reveals real data. A full app quit ends live sessions.

## Verification

`node scripts/test-demo.cjs` is the fast synthetic-canary regression. Its state
privacy assertion failed against the previous implementation. The same authored
workspace checks run in the normal offline smoke suite through `smoke-demo.ts`.

`node scripts/probe-demo.mjs` uses the built Electron app and actual preload/IPC
in a disposable profile. It checks fictional responses, action refusal, event
suppression, browser storage separation, both themes and actual GPU water
interaction. It also checks all five prompt previews and copies through actual
IPC, rejects invalid prompt IDs, and checks clipboard failure recovery. Only
the final OS clipboard write is intercepted; the operator's clipboard is never
read or changed. It captures no screenshots or video. Transition-test live windows
are invisible and only synthetic draft canaries are asserted or printed.

Run `npm test` and `git diff --check` before handing off changes. Marketing
capture remains a separate, deferred task. Any future public capture helper
must explicitly launch the fictional demo in a disposable profile, assert the
`fictional` source and retain the sample-data label; it must not reuse normal
`shots.mjs` output without a separate privacy review.

Verification on 2026-09-10: the synthetic-canary checks and real Electron probe
passed, including mode switches, draft preservation and the prompt picker.
The final `npm test` passed type checking, renderer style, package hooks, local
installer checks and all 1,541 smoke assertions. `git diff --check` passed.
No media was captured.
