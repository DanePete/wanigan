# Dock, admin bar, and Usage audit — 2026-09-19

The requested work combines an account-attribution repair with restoration of
the dock and a review of the layouts affected by that restoration. The visual
reference is the archived Fleet/Usage design, not the installed app's initial
state. Existing user preferences and live agent processes are not reset.

## Account readings

The offline reproduction exercises the real Codex reader and account environment
builder, with only the subprocess boundary replaced. Two saved accounts read
11% and 72% without an inherited `CODEX_HOME`; exporting the second directory
made both read 72%. The fix applies the existing account environment setter,
which removes the inherited variable when the selected account uses the default
directory. A regression covers that exact two-account case.

Codex now supplies its login display through `account/read`, alongside its quota
read. Explicit sign-out does not become a failed quota lookup. Cached readings
follow the configured directory and login revision; a login change during a
probe refuses the potentially mismatched result.

Shared-login labels require evidence: the same canonical configuration directory,
or the same saved Claude account and organization identifiers. Equal percentages,
labels, plans, or email addresses never establish a match. Saved metadata is
labeled **saved login**, not a live authentication check. Comparison identifiers
remain in main; the renderer receives only the related account labels and basis.
Credential file contents are not read for this comparison.

Malformed metadata is unavailable evidence. The metadata reader opens files
nonblocking before checking that the descriptor is a regular file; a named pipe
must not freeze the main process. The isolated regression reproduced a timeout
before this guard and exercises both revision and shared-login endpoints.

## UI decisions and findings

| Finding | Adjustment |
| --- | --- |
| The dock reference had been replaced by a sidebar and header view picker. | Restore registry-driven dock destinations, remembered area selection, local route buttons, and rounded workspace frame. Keep the complete destination list behind Tools. |
| Removing the header opener made the closed sidebar hard to find again. | Keep a labeled Sidebar control in the admin bar alongside dock Tools. Both share navigation state; the header provides the stable focus fallback. |
| Admin bar mixed navigation, session creation, search, attention, and Halt. | Separate project context, session/search actions, and global status controls. Preserve the deliberate Halt confirmation. |
| Board, Changes, and Context repeated the shared project selector. | Use the shared project switcher; retain repository labels and empty-project actions where needed. |
| Account labels and narrow stacked quota cards made duplicates hard to inspect. | Compare provider login, plan, quota windows, reset times, and freshness in one account table. Filter local records independently. |
| Similar percentages invited an unsupported account-switch recommendation. | Remove that recommendation; show actual shared-login evidence explicitly. |
| Older status-line observations looked like additional current account readings. | Keep them in an expandable section with their existing source and age descriptions. |
| Selecting an account could scroll the outer document and displace the dock. | Focus and scroll only the Usage pane. |
| Screen-reader-only cost labels escaped a horizontally scrolling table at 600px. | Give the table's scroll container a positioning context. |
| A shell padding rule overrode compact gutters and added extra space above sticky page titles. | Let the document pane and compact layout own their spacing. |
| Goals and Board clipped content in supported short windows. | Preserve access to the work area and supporting evidence through the appropriate scroll containers. |
| Sessions repeated New/Resume controls and gave the terminal too little height. | Consolidate duplicate actions and rebalance the session controls and open composer for short windows. |
| The restored bottom bar took more height than the user wanted. | Reduce its height, button spacing, and companion footprint, with additional trimming for short windows. |
| Choosing All spaces from a view requiring one project changed views without a cue. | State that the option opens Sessions across all projects before selection. |
| Review lines allowed pointer selection but keyboard users could only select whole hunks. | Give commentable lines native button behavior and Shift+Enter/Space range selection. |

Settings section shortcuts, search-result jumps, and keyboard category changes
were specifically tested because their source suggested a possible scrolling
problem. The problem did not reproduce at four sizes, including 900×600, so the
Settings implementation was left unchanged. A focused regression records that
behavior.

Populated Schedules were also checked at 960×560 and 900×560: agenda selection,
history, and background controls remained reachable. No layout change was
needed there. This uses the focused schedule fixture rather than the generic
empty bridge from the broad screenshot sweep.

Lower-priority audit observations remain distinct from proven regressions:
`SectionHead` could expose deliberate heading levels for screen-reader section
navigation; Learning's “Context budget” terminology overlaps the Context view;
and Insights should make its quota/burn purpose clearer alongside Usage. These
need broader semantic or product decisions, not mechanical markup replacement.

## Evidence and limits

The visual sweeps mount the production renderer with explicitly fictional bridge
fixtures. They verify layout, navigation, focus, responsive behavior, error
presentation, and provenance labels. They do not demonstrate real provider
metering or live agent behavior. Missing fixture fields discovered during the
sweep were corrected in the harness, not treated as product bugs.

- [Usage comparison screenshots](../visuals/usage-accounts-2026-09-19/)
- [Whole UI before/after sweep](../visuals/dock-ui-audit-2026-09-19/)
- [Dock navigation checks](../visuals/dock-ui-audit-2026-09-19/navigation/)
- [Settings scroll checks](../visuals/dock-ui-audit-2026-09-19/settings-scroll/after/)
- [Short Goals and Board checks](../visuals/goals-compact-2026-09-19/)
- [Service metering presentation checks](../visuals/usage-accounts-2026-09-19/service-regression/)
- [Populated Schedules checks](../visuals/dock-ui-audit-2026-09-19/schedules-regression/)
- [Keyboard review before/after](../visuals/review-keyboard-2026-09-19/)

Reproduction and verification entry points:

```sh
nvm use
node scripts/test-usage-accounts.cjs
npm run build
node scripts/probe-usage-accounts.mjs
node scripts/probe-jev-usage.mjs --out /tmp/wanigan-service-usage
node scripts/probe-dock-ui-audit.mjs
node scripts/probe-settings-scroll.mjs
node scripts/probe-goals-compact.mjs
node scripts/probe-dock-navigation.mjs
node scripts/probe-session-workspace-space.mjs
node scripts/probe-review-keyboard.mjs
node scripts/probe-schedules-workspace.mjs --out /tmp/wanigan-schedules-audit
npm test
git diff --check
```

## Final verification

- `npm test` exited successfully: all eight repository gates, 2,701 offline
  main-process smoke assertions, and the execution/recovery checks passed.
- The eight account-reader regressions cover inherited directories, saved
  identity evidence, sign-out, login changes, caching, and non-regular metadata.
- After the last composer sizing adjustment, renderer style checks, full ESLint,
  the production build, and `git diff --check` passed again. The final renderer
  probes use that exact build.
- The whole-view sweep covers all 20 registered destinations in both themes,
  with 32 desktop, compact, and short-window layouts. Focused probes cover
  account/service attribution, navigation return, project scope, drafts,
  keyboard review, Settings, Goals, Board, and Schedules.

The bottom footer is 64px high on desktop and 56px in short windows, compared
with the first restored dock's 80px. In the populated Sessions fixture, terminal
height increased from 78px to 262px at 960×800 and from 0px to 131px at 900×560.
A resized 25-line draft keeps its last line visible above Send and regains its
previous textarea height when the window expands; no agent input was sent.

The running installed app was not replaced
or restarted; these are built-source results and explicitly fictional visual
fixtures.

Build and smoke verification must remain sequential: the smoke suite's
dynamically loaded `out/` chunks belong to the build that launched it.
